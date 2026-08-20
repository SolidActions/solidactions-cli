import axios from 'axios';
import chalk from 'chalk';
import prompts from 'prompts';
import { Config, ResolvedConfig, resolveConfig, writeConfigFile, getGlobalConfigPath } from './config';
import {
    formatWorkspaceWithOrg,
    resolveWorkspaceInput,
    selectWorkspaceInteractively,
    WorkspaceLookupRecord,
    WorkspaceSelectionDependencies,
} from './workspace-lookup';
import { activeCommandIsMutating } from './mutating-commands';
import {
    decideWorkspaceGuard,
    isCwdInferredWorkspace,
    readLastUsedWorkspace,
    writeLastUsedWorkspace,
} from './workspace-guard';

// Backend (solidactions-app PR #128) returns: "Project '<slug>' not found in your active workspace '<workspace-slug>'."
// We require the literal single-quotes around the slug so plausible future error messages
// like "Project files not found ..." don't false-match.
const NOT_FOUND_IN_WORKSPACE = /Project '.+' not found in your active workspace/;

export const SANDBOX_EGRESS_MESSAGE =
    'Sandbox network egress appears to be blocking app.solidactions.com. '
    + "Allow-list app.solidactions.com in your provider's network settings, "
    + 'start a new agent session if required, then retry. '
    + 'See https://www.solidactions.com/docs/troubleshooting/#sandbox-egress';

const SANDBOX_EGRESS_PHRASES = [
    /\bhost (?:is )?not permitted\b/i,
    /\bnetwork access denied\b/i,
    /\bnetwork egress\b[\s\S]*?\b(?:blocked|disabled)\b/i,
    /\bdestination\b[\s\S]*?\bnot allowed\b/i,
];

function responseServerHeader(headers: any): string {
    if (!headers) {
        return '';
    }

    if (typeof headers.get === 'function') {
        const value = headers.get('server') ?? headers.get('Server');
        return value == null ? '' : String(value).trim();
    }

    for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() === 'server') {
            return value == null ? '' : String(value).trim();
        }
    }

    return '';
}

function flattenProxyResponseText(data: unknown): string {
    if (typeof data === 'string') {
        return data;
    }
    if (data instanceof Error) {
        return data.message;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return '';
    }

    return ['error', 'message']
        .map((field) => flattenProxyResponseText((data as Record<string, unknown>)[field]))
        .filter(Boolean)
        .join('\n');
}

/**
 * Diagnose a provider proxy's observed Cloud-host 403 without rewriting
 * SolidActions authorization errors or failures against custom hosts.
 */
export function augmentSandboxEgressMessage(error: any): any {
    const response = error?.response;
    if (response?.status !== 403 || responseServerHeader(response.headers)) {
        return error;
    }

    const data = response.data;
    const responseCode = data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>).code
        : null;
    if (responseCode != null && String(responseCode).trim() !== '') {
        return error;
    }

    const requestConfig = error.config ?? response.config;
    let hostname = '';
    try {
        hostname = new URL(requestConfig?.url, requestConfig?.baseURL).hostname;
    } catch {
        return error;
    }
    if (hostname !== 'app.solidactions.com') {
        return error;
    }

    const proxyText = flattenProxyResponseText(data).trim();
    if (!proxyText || !SANDBOX_EGRESS_PHRASES.some((phrase) => phrase.test(proxyText))) {
        return error;
    }

    error.message = SANDBOX_EGRESS_MESSAGE;
    response.data = {
        ...(data && typeof data === 'object' && !Array.isArray(data) ? data : {}),
        message: `${SANDBOX_EGRESS_MESSAGE}\n\nProvider response: ${proxyText}`,
        providerResponse: data,
    };

    return error;
}

/**
 * Inspect an axios error and, if its response message matches the new
 * workspace-not-found 404 from solidactions-app PR #128, append a
 * remediation hint. Exported for unit testing; the live interceptor
 * below calls it.
 */
export function augmentNotFoundMessage(error: any): any {
    const msg = error?.response?.data?.message;
    if (
        typeof msg === 'string'
        && NOT_FOUND_IN_WORKSPACE.test(msg)
        && !msg.includes('Did you mean to switch workspaces?')
    ) {
        const hint = "Did you mean to switch workspaces? Run 'solidactions workspace set <name> --local' to pin this directory.";
        error.response.data.message = `${msg}\n\n${hint}`;
    }
    return error;
}

/**
 * Inspect an axios error and, if it's a 403 with the app's `workspace_forbidden`
 * error code (device-flow-scoped token targeting a workspace outside its
 * scope), replace the raw server message with actionable guidance similar in
 * spirit to `workspaceSet`'s local pre-check (wording isn't kept in sync
 * verbatim) — so slug/name inputs (which can't be pre-checked locally) still
 * surface a clear message instead of a raw axios/HTTP error.
 */
export function augmentWorkspaceForbiddenMessage(error: any): any {
    if (error?.response?.status === 403 && error.response.data?.code === 'workspace_forbidden') {
        error.response.data.message =
            'This session is scoped to a limited set of workspaces. '
            + 'Re-run `solidactions login --device` to change scope.';
    }
    return error;
}

/**
 * Existing device tokens predate the coarse `databases` scope. Turn the app's
 * stable missing-ability response into a re-login instruction while preserving
 * its original message. Other ability failures retain their existing behavior.
 */
export function augmentTokenMissingAbilityMessage(error: any): any {
    const response = error?.response;
    const requiredAbility = response?.data?.required_ability;
    const isDatabaseAbility =
        requiredAbility === 'databases'
        || (typeof requiredAbility === 'string' && requiredAbility.startsWith('databases:'));

    if (
        response?.status === 403
        && response.data?.code === 'token_missing_ability'
        && isDatabaseAbility
    ) {
        const hint = 'Run `solidactions login --device` to refresh database access.';
        const message = typeof response.data.message === 'string' && response.data.message.length > 0
            ? response.data.message
            : 'This session does not have database access.';
        if (!message.includes('solidactions login --device')) {
            response.data.message = `${message}\n\n${hint}`;
        }
    }

    const isEnvRevealAbility = requiredAbility === 'env:reveal';

    if (
        response?.status === 403
        && response.data?.code === 'token_missing_ability'
        && isEnvRevealAbility
    ) {
        const hint = "The 'env:reveal' ability grants plaintext disclosure of secret values. "
            + 'Re-run `solidactions login --device` and tick "Reveal secret values" on the consent screen, '
            + 'or create an API key with the \'env:reveal\' ability checked at Settings → API keys '
            + 'and `solidactions login` with that key.';
        const message = typeof response.data.message === 'string' && response.data.message.length > 0
            ? response.data.message
            : "This session does not have the 'env:reveal' ability.";
        if (!message.includes('Settings → API keys')) {
            response.data.message = `${message}\n\n${hint}`;
        }
    }

    return error;
}

axios.interceptors.response.use(
    (response) => response,
    (error) => Promise.reject(
        augmentTokenMissingAbilityMessage(
            augmentWorkspaceForbiddenMessage(
                augmentNotFoundMessage(
                    augmentSandboxEgressMessage(error),
                ),
            ),
        ),
    ),
);

export function getApiHeaders(config: Config, contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {
        'Authorization': `Bearer ${config.apiKey}`,
        'Accept': 'application/json',
    };
    if (contentType) headers['Content-Type'] = contentType;
    if (config.workspaceId) headers['X-Workspace-Id'] = config.workspaceId;
    return headers;
}

/**
 * Best-effort lookup of the environments a project family actually has
 * (e.g. "production, dev"), for a friendlier 404 message. Returns null on
 * any failure — callers should treat that as "no extra detail available."
 */
export async function describeProjectEnvironments(config: Config, projectName: string): Promise<string | null> {
    try {
        const res = await axios.get(`${config.host}/api/v1/projects`, { headers: getApiHeaders(config) });
        const rows = res.data?.data ?? res.data ?? [];
        const hit = rows.find((p: any) => p.name === projectName || p.slug === projectName);
        const envs: string[] | undefined = hit?.environments;
        return envs?.length ? envs.join(', ') : null;
    } catch {
        return null;
    }
}

/**
 * Render a Laravel-style 422 validation error body as plain readable text —
 * never a raw JSON dump. Prefers `data.errors` (flattened, one message per
 * line, with the internal `variables.N.` index prefix stripped and the bare
 * `key` attribute renamed to `variable key` for clarity); falls back to
 * `data.message`.
 */
export function formatValidationError(data: unknown): string {
    const errors = (data as any)?.errors;
    let messages: string[] = [];

    if (errors && typeof errors === 'object' && !Array.isArray(errors)) {
        for (const value of Object.values(errors)) {
            if (Array.isArray(value)) {
                messages.push(...value.map((v) => String(v)));
            } else if (value) {
                messages.push(String(value));
            }
        }
    }

    if (messages.length === 0) {
        const message = (data as any)?.message;
        if (typeof message === 'string' && message) {
            messages = [message];
        }
    }

    if (messages.length === 0) {
        return 'Validation failed.';
    }

    return messages
        .map((msg) => msg
            .replace(/variables\.\d+\.key/gi, 'variable key')
            .replace(/variable key field/gi, 'variable key')
            .replace(/variables\.\d+\.(\w+)/gi, '$1'))
        .join('\n');
}

/**
 * Get the full resolution (config + sources + activePath). Exits if nothing resolvable.
 */
export function requireResolvedConfig(): ResolvedConfig {
    const resolved = resolveConfig();
    if (!resolved || !resolved.config.apiKey) {
        console.error(chalk.red('Not initialized. Run `solidactions login --global` first.'));
        process.exit(1);
    }
    return resolved;
}

export function requireConfig(): Config {
    return requireResolvedConfig().config;
}

/**
 * Contextual 401 message — names the host being called and where the (now
 * apparently invalid/expired) API key came from, instead of a bare
 * "Authentication failed" that gives no clue which config is at fault.
 */
export function authFailureMessage(config: Config, sources: ResolvedConfig['sources'] | null): string {
    const keySource = sources?.apiKey ?? 'config';
    return `Authentication failed against ${config.host} (key from ${keySource}). Run \`solidactions login --global\` to re-configure.`;
}

export async function ensureWorkspaceSelected(
    config: Config,
    dependencies: WorkspaceSelectionDependencies = {},
): Promise<Config> {
    if (config.workspaceId) {
        return config;
    }

    // Re-resolve so we know whether a save would be redundant (env-provided) or meaningful (file-backed).
    const resolved = resolveConfig();
    const workspaceSource = resolved?.sources.workspaceId ?? null;

    let workspaces: Array<{ id: string; name: string; slug?: string; org_name: string; role: string }>;
    try {
        const response = await axios.get(`${config.host}/api/v1/workspaces`, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
            },
        });
        const grouped = response.data.workspaces || response.data.teams || response.data.data || response.data;
        if (typeof grouped === 'object' && !Array.isArray(grouped)) {
            workspaces = [];
            for (const orgName of Object.keys(grouped)) {
                for (const ws of grouped[orgName]) {
                    workspaces.push({
                        id: ws.id,
                        name: ws.name,
                        slug: ws.slug,
                        org_name: ws.tenant_name || orgName,
                        role: ws.role,
                    });
                }
            }
        } else {
            workspaces = Array.isArray(grouped) ? grouped : [];
        }

        const scope = response.data.scope as { mode: 'all' | 'subset' | 'single'; workspace_ids: string[] } | null;
        if (scope) {
            config.scopeMode = scope.mode;
            config.scopedWorkspaceIds = scope.workspace_ids;
        }
    } catch (error: any) {
        if (error.response?.status === 401) {
            console.error(chalk.red(authFailureMessage(config, resolved?.sources ?? null)));
        } else {
            console.error(chalk.red('Failed to fetch workspaces:'), error.response?.data?.message || error.message);
        }
        process.exit(1);
    }

    if (workspaces.length === 0) {
        console.error(chalk.red('No workspaces found. Create a workspace at your SolidActions dashboard first.'));
        process.exit(1);
    }

    let selected: WorkspaceLookupRecord;

    if (workspaces.length === 1) {
        selected = workspaces[0];
        // Status text, not a command's own output — stdout is reserved for machine-parseable
        // output (e.g. `--json`), same reasoning as the workspace banner above.
        console.error(chalk.gray(`Auto-selected workspace: ${formatWorkspaceWithOrg(selected)}`));
    } else {
        if (!process.stdin.isTTY) {
            console.error(chalk.red(
                'Multiple workspaces are available and no workspace is set for this config. '
                + 'Run `solidactions workspace set <name-or-id> --local` (or --global).',
            ));
            process.exit(1);
        }

        const chosen = await selectWorkspaceInteractively(workspaces, {
            ...dependencies,
        });
        if (!chosen) {
            process.exit(1);
        }
        selected = chosen;
    }

    config.workspace = selected.slug ?? selected.name;
    config.workspaceId = selected.id;
    config.workspaceOrg = selected.org_name;

    if (workspaceSource !== 'env') {
        const targetPath = resolved?.activePath ?? getGlobalConfigPath();
        writeConfigFile(targetPath, config);
    }

    return config;
}

/**
 * Thrown by applyWorkspaceGuard when a CWD-inferred write is refused (non-TTY, no --yes)
 * or declined (user answered no to the confirm prompt). Kept as a typed error rather than
 * calling process.exit directly so the guard's decision logic stays unit-testable; the thin
 * wrapper below (requireConfigWithWorkspace) is the only place that converts it into an exit.
 */
export class WorkspaceGuardAbort extends Error {
    constructor(public readonly exitCode: number, message: string) {
        super(message);
        this.name = 'WorkspaceGuardAbort';
    }
}

export interface WorkspaceGuardIo {
    isTty?: () => boolean;
    confirm?: (message: string) => Promise<boolean>;
    warn?: (message: string) => void;
    announce?: (message: string) => void;
    homeDir?: string;
    now?: () => Date;
}

/**
 * Renders the resolved workspace for humans: `<name> — organization <org> (<id>)`.
 *
 * `workspace` (the display name/slug) and `workspaceId` are INDEPENDENT config layers.
 * Setting only SOLIDACTIONS_WORKSPACE_ID resolves the id from the environment while the
 * name is left behind by a config file that describes a DIFFERENT workspace — pairing them
 * would print a confident lie about where a write is going. When the name did not come from
 * the same layer as the id, show the id alone (#1437).
 */
function describeWorkspace(config: Config, sources: ResolvedConfig['sources']): string {
    const id = config.workspaceId ?? '';
    // A name that is merely ABSENT cannot mislead — only one carried over from another layer can.
    if (config.workspace && sources.workspace !== sources.workspaceId) {
        return id || 'workspace';
    }
    const name = config.workspace ?? (id || 'workspace');
    return `${formatWorkspaceWithOrg({ id, name, org_name: config.workspaceOrg })} (${id})`;
}

/**
 * The `prompts` question for the workspace-write confirmation. stdout is reserved for a
 * command's own machine-parseable output (see the `announce` comment in applyWorkspaceGuard
 * below), so this prompt must render to stderr — `prompts` defaults to stdout unless told
 * otherwise, which would corrupt a captured `--json` stream while stdin is still a TTY (#1437).
 */
export function buildWorkspaceConfirmPrompt(message: string): prompts.PromptObject {
    return { type: 'confirm', name: 'confirm', message, initial: false, stdout: process.stderr };
}

/**
 * Applies the CWD-inference guard to an already-resolved config, then records it as last-used.
 * Returns the config, or throws WorkspaceGuardAbort when the user declines / cannot be asked
 * (the caller is responsible for turning that into process.exit).
 */
export async function applyWorkspaceGuard(
    config: Config,
    sources: ResolvedConfig['sources'],
    options: { mutating: boolean; explicitOverride: boolean },
    io: WorkspaceGuardIo = {},
): Promise<Config> {
    const isTty = io.isTty ?? (() => !!process.stdin.isTTY);
    const warn = io.warn ?? ((message: string) => { process.stderr.write(`${message}\n`); });
    // stdout is reserved for a command's own machine-parseable output (e.g. `database
    // create --json`) — the banner and the decline message are human-facing status, so
    // they default to stderr, same as warn.
    const announce = io.announce ?? ((message: string) => { process.stderr.write(`${message}\n`); });
    const now = io.now ?? (() => new Date());

    const cwdInferred = isCwdInferredWorkspace(sources, getGlobalConfigPath());
    if (options.explicitOverride && cwdInferred) {
        // Invariant: -w always sets sources.workspaceId = 'cli', which isCwdInferredWorkspace
        // already treats as not-inferred. If this fires, resolution wiring is broken.
        throw new Error('workspace guard: explicitOverride but isCwdInferredWorkspace returned true');
    }

    const lastUsed = readLastUsedWorkspace(io.homeDir);
    const action = decideWorkspaceGuard({
        resolvedWorkspaceId: config.workspaceId,
        lastUsedWorkspaceId: lastUsed?.workspaceId,
        cwdInferred,
        mutating: options.mutating,
    });

    if (action === 'warn' || action === 'confirm') {
        const inferredFrom = sources.workspaceId as string;
        const lastLabel = lastUsed?.label ?? lastUsed?.workspaceId ?? 'unknown';
        warn(
            chalk.yellow('warn:') + ` workspace changed to ${describeWorkspace(config, sources)} `
            + `— inferred from ${inferredFrom}; last used was ${lastLabel}. `
            + `Pin it with -w ${config.workspaceId}.`,
        );
    }

    if (action === 'confirm') {
        // Consent to a workspace is exactly two things: stating it explicitly (-w /
        // SOLIDACTIONS_WORKSPACE_ID, both of which make this branch unreachable), or
        // answering the interactive prompt below. A command's OWN --yes is never
        // workspace consent — it acknowledges that command's own destructive act
        // (`database push` requires -y, `database pull --yes` means "overwrite the local
        // file"), and conflating the two made the confirmation structurally unreachable
        // on the highest-blast-radius command in the CLI (#1437).
        if (!isTty()) {
            warn(`re-run with -w ${config.workspaceId} to confirm the target workspace`);
            throw new WorkspaceGuardAbort(1, 'workspace guard: refused (non-interactive)');
        }

        const confirmFn = io.confirm ?? (async (message: string) => {
            const response = await prompts(buildWorkspaceConfirmPrompt(message));
            return !!response.confirm;
        });
        const proceed = await confirmFn(`This command WRITES to ${describeWorkspace(config, sources)}. Proceed?`);
        if (!proceed) {
            announce(chalk.gray('Cancelled.'));
            throw new WorkspaceGuardAbort(0, 'workspace guard: user declined');
        }
    }

    if (options.mutating && config.workspaceId) {
        announce(chalk.gray(`Workspace: ${describeWorkspace(config, sources)}`));
    }

    // state.json means "the workspace you last WROTE to" — that is precisely what the write
    // confirmation above compares against. A read must never consume the change that gates a
    // write, so only a mutating command records here; reads stay purely advisory.
    if (options.mutating && config.workspaceId) {
        writeLastUsedWorkspace(
            { workspaceId: config.workspaceId, label: config.workspace, at: now().toISOString() },
            io.homeDir,
        );
    }

    return config;
}

export async function requireConfigWithWorkspace(): Promise<Config> {
    const resolved = requireResolvedConfig();
    let config = resolved.config;
    const explicitOverride = resolved.sources.workspace === 'cli';

    // -w override path: source label 'cli' on the workspace field means
    // setCliWorkspaceOverride was called. workspaceId was cleared by resolveConfig
    // because we don't yet know if the input was a slug or UUID. Resolve now.
    if (explicitOverride && !config.workspaceId) {
        const ws = await resolveWorkspaceInput(config, config.workspace!);
        config = { ...config, workspace: ws.slug ?? ws.name, workspaceId: ws.id, workspaceOrg: ws.org_name };
    } else {
        config = await ensureWorkspaceSelected(config);
    }

    try {
        return await applyWorkspaceGuard(config, resolved.sources, {
            mutating: activeCommandIsMutating(),
            explicitOverride,
        });
    } catch (error) {
        if (error instanceof WorkspaceGuardAbort) {
            process.exit(error.exitCode);
        }
        throw error;
    }
}

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import prompts from 'prompts';
import {
    Config,
    ConfigSource,
    resolveConfig,
    writeConfigFile,
    removeConfigFile,
    findLocalConfigPath,
    getGlobalConfigPath,
} from '../utils/config';
import {
    decideWriteTarget,
    pathForTarget,
    ensureGitignoreCovers,
    confirmOverwrite,
    WriteTarget,
    WritePromptDependencies,
} from '../utils/config-write-target';
import {
    classifyWorkspaceInput,
    describeWorkspaceMatchFailure,
    fetchWorkspaces,
    formatWorkspaceWithOrg,
    selectWorkspaceInteractively,
    WorkspaceLookupRecord,
    WorkspaceScope,
} from '../utils/workspace-lookup';

export { selectWorkspaceInteractively } from '../utils/workspace-lookup';

export type { Config };

export const API_KEY_PROMPT = {
    type: 'password' as const,
    name: 'apiKey' as const,
    message: 'SolidActions API key',
};

interface LoginSecretOptions {
    stdin?: boolean;
}

interface LoginSecretDependencies {
    input?: NodeJS.ReadableStream;
    isTTY?: boolean;
    prompt?: () => Promise<string | undefined>;
}

async function readAll(input: NodeJS.ReadableStream): Promise<string> {
    let value = '';
    for await (const chunk of input) {
        value += chunk.toString();
    }
    return value;
}

/**
 * Resolve a login secret without requiring it in argv. The positional key is
 * retained for backwards compatibility, while new interactive documentation
 * uses the masked prompt and automation can opt into stdin explicitly.
 */
export async function resolveLoginApiKey(
    apiKey: string | undefined,
    options: LoginSecretOptions = {},
    dependencies: LoginSecretDependencies = {},
): Promise<string> {
    if (apiKey && options.stdin) {
        throw new Error('Pass the API key either as the legacy positional argument or via --stdin, not both.');
    }

    let resolved = apiKey;

    if (options.stdin) {
        resolved = await readAll(dependencies.input ?? process.stdin);
    } else if (!resolved) {
        const isTTY = dependencies.isTTY ?? process.stdin.isTTY === true;
        if (!isTTY) {
            throw new Error(
                'API key is required in non-interactive mode. Pipe it with --stdin, ' +
                'or set SOLIDACTIONS_API_KEY without running login.',
            );
        }

        const prompt = dependencies.prompt ?? (async () => {
            const response = await prompts(API_KEY_PROMPT);
            return response.apiKey as string | undefined;
        });
        resolved = await prompt();

        if (resolved === undefined) {
            throw new Error('Login cancelled.');
        }
    }

    const trimmed = resolved?.trim();
    if (!trimmed) {
        throw new Error('API key is required.');
    }

    return trimmed;
}

export function getConfig(): Config | null {
    const resolved = resolveConfig();
    return resolved ? resolved.config : null;
}

export function saveConfig(config: Config): void {
    const resolved = resolveConfig();
    const targetPath = resolved ? resolved.activePath : getGlobalConfigPath();
    writeConfigFile(targetPath, config);
}

export function clearConfig(): void {
    removeConfigFile(getGlobalConfigPath());
}


export function resolveLoginHost(options: { dev?: boolean; host?: string }): { host: string; isDefault: boolean } {
    if (options.host) {
        return { host: options.host, isDefault: false };
    }
    if (options.dev) {
        return { host: 'http://localhost:8000', isDefault: false };
    }
    return { host: 'https://app.solidactions.com', isDefault: true };
}

/**
 * Path for a timestamped backup of `targetPath`, e.g.
 * `config.json.bak-2026-07-05T12-30-00Z`. Pure — takes `now` so tests are
 * deterministic.
 */
export function backupPathFor(targetPath: string, now: Date = new Date()): string {
    const timestamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
    return `${targetPath}.bak-${timestamp}`;
}

const LOGIN_REFUSAL_MESSAGE =
    'Refusing to write config non-interactively. Pass --global to update the machine-wide config ' +
    'at ~/.solidactions/config.json (a backup is kept if one exists), or --local to write ' +
    './.solidactions/config.json for just this directory.';

export const DEVICE_LOGIN_REFUSAL_MESSAGE =
    'No TTY detected. Re-run with the config destination made explicit: '
    + 'solidactions login --device --global --workspace <name>';

export interface LoginWritePreflight {
    target: WriteTarget;
    targetPath: string;
    backupPath: string | null;
    backupCreated: boolean;
    credentialPersisted: boolean;
}

export interface LoginWritePreflightDependencies {
    isTTY?: boolean;
    destinationQuestion?: WritePromptDependencies['question'];
    overwriteQuestion?: WritePromptDependencies['question'];
}

function nearestExistingPath(startPath: string): string {
    let candidate = startPath;
    while (!fs.existsSync(candidate)) {
        const parent = path.dirname(candidate);
        if (parent === candidate) break;
        candidate = parent;
    }
    return candidate;
}

function failWritePreflight(targetPath: string, reason: string): never {
    console.error(chalk.red(
        `Cannot save configuration to ${targetPath}: ${reason}. `
        + 'Choose a writable destination with --local or --global and retry.',
    ));
    process.exit(1);
}

function assertDirectoryWritable(directoryPath: string, targetPath: string): void {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(directoryPath);
    } catch (error: any) {
        failWritePreflight(targetPath, `could not inspect ${directoryPath} (${error.message})`);
    }
    if (!stat.isDirectory()) {
        failWritePreflight(targetPath, `${directoryPath} is not a directory`);
    }

    // accessSync is authoritative for the current identity. The mode check
    // also catches deliberately read-only fixtures when tests run as root.
    if ((stat.mode & 0o222) === 0 || (stat.mode & 0o111) === 0) {
        failWritePreflight(targetPath, `${directoryPath} is not writable/searchable`);
    }
    try {
        fs.accessSync(directoryPath, fs.constants.W_OK | fs.constants.X_OK);
    } catch {
        failWritePreflight(targetPath, `${directoryPath} is not writable/searchable`);
    }
}

/**
 * Resolve and validate the device-login destination before requesting a
 * browser approval. The returned path is reused after authorization.
 */
export async function preflightDeviceLoginWrite(
    options: { local?: boolean; global?: boolean },
    dependencies: LoginWritePreflightDependencies = {},
): Promise<LoginWritePreflight> {
    const target = await decideWriteTarget(options, undefined, DEVICE_LOGIN_REFUSAL_MESSAGE, {
        isTTY: dependencies.isTTY,
        question: dependencies.destinationQuestion,
    });
    const targetPath = pathForTarget(target);

    if (fs.existsSync(targetPath)) {
        let stat: fs.Stats;
        try {
            stat = fs.statSync(targetPath);
        } catch (error: any) {
            failWritePreflight(targetPath, error.message);
        }
        if (!stat.isFile()) {
            failWritePreflight(targetPath, 'the config path is not a regular file');
        }
        try {
            fs.accessSync(targetPath, fs.constants.R_OK);
        } catch {
            failWritePreflight(targetPath, 'the existing config is not readable for backup');
        }
    }

    const existingParent = nearestExistingPath(path.dirname(targetPath));
    assertDirectoryWritable(existingParent, targetPath);

    let backupPath: string | null = null;
    if (fs.existsSync(targetPath)) {
        backupPath = backupPathFor(targetPath);
        const proceed = await confirmOverwrite(targetPath, backupPath, {
            isTTY: dependencies.isTTY,
            question: dependencies.overwriteQuestion,
        });
        if (!proceed) {
            console.log(chalk.yellow('Aborted. No changes were made and no device code was requested.'));
            process.exit(0);
        }
    }

    return {
        target,
        targetPath,
        backupPath,
        backupCreated: false,
        credentialPersisted: false,
    };
}

/**
 * Persist the approved base credential before workspace discovery. Existing
 * device-login configs are backed up exactly once.
 */
export async function persistPreflightedLoginCredential(
    config: Config,
    preflight: LoginWritePreflight,
    options: { gitignore?: boolean },
): Promise<void> {
    if (preflight.backupPath && !preflight.backupCreated) {
        fs.copyFileSync(preflight.targetPath, preflight.backupPath);
        preflight.backupCreated = true;
        console.log(chalk.gray(`Backup saved to ${preflight.backupPath}`));
    }

    writeConfigFile(preflight.targetPath, config);
    preflight.credentialPersisted = true;

    if (preflight.target === 'local') {
        const targetRoot = path.dirname(path.dirname(preflight.targetPath));
        await ensureGitignoreCovers(targetRoot, !!options.gitignore);
    }
}

export function loginHostLines(resolved: { host: string; isDefault: boolean }): string[] {
    if (resolved.isDefault) {
        return [`Logging into ${resolved.host} (SolidActions Cloud)`];
    }
    return [`Host: ${resolved.host}`];
}

/**
 * Shared tail of API-key and device login: resolve the workspace against an
 * already-fetched list, persist the final config, and print success output.
 * Device login passes its already-written, preflighted destination.
 */
export async function completeLogin(
    config: Config,
    workspaces: WorkspaceLookupRecord[],
    options: { workspace?: string; local?: boolean; global?: boolean; gitignore?: boolean },
    scope: WorkspaceScope | null = null,
    preflight: LoginWritePreflight | null = null,
    dependencies: {
        selectWorkspace?: typeof selectWorkspaceInteractively;
        overwriteQuestion?: WritePromptDependencies['question'];
    } = {},
): Promise<void> {
    // Device-flow tokens carry a scope (mode + workspace_ids) that later
    // gates `workspace set`; absent for user-scoped Sanctum PATs.
    if (scope) {
        config.scopeMode = scope.mode;
        config.scopedWorkspaceIds = scope.workspace_ids;
    }

    // A --workspace the resolver refuses (not-found, ambiguous, or org-only)
    // never reaches writeConfigFile below on an API-key login, so it must exit
    // before the destination/confirm/backup block runs — otherwise the block
    // backs up and claims to overwrite a config that was never touched
    // (app#1197 finding 1). Device login (preflight set) keeps its own
    // --workspace-refusal handling below, which persists the credential first.
    if (!preflight && options.workspace) {
        const preflightMatch = classifyWorkspaceInput(options.workspace, workspaces);
        if (preflightMatch.kind !== 'match') {
            console.error(chalk.red(describeWorkspaceMatchFailure(preflightMatch)));
            process.exit(1);
            return;
        }
    }

    // Decide the destination and confirm any destructive overwrite BEFORE
    // workspace resolution (including the interactive picker), so the y/N
    // lands before the user has done the picker work, not after (app#1197).
    // Device login has already persisted its base credential via a preflight.
    let target: WriteTarget | undefined;
    let targetPath: string | undefined;
    if (!preflight) {
        target = await decideWriteTarget({ local: options.local, global: options.global }, undefined, LOGIN_REFUSAL_MESSAGE);
        targetPath = pathForTarget(target);

        // The final config (which gains workspace/workspaceId) isn't known
        // until the workspace is chosen below, so we can't byte-compare
        // against it here. Compare credentials instead — the guard exists to
        // protect a *different* account's config from being clobbered.
        const existingRaw = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf-8') : null;
        let isDestructive = false;
        if (existingRaw !== null) {
            try {
                const existing = JSON.parse(existingRaw);
                isDestructive = existing.host !== config.host || existing.apiKey !== config.apiKey;
            } catch {
                isDestructive = true;
            }
        }

        if (isDestructive) {
            const backupPath = backupPathFor(targetPath);
            const proceed = await confirmOverwrite(targetPath, backupPath, { question: dependencies.overwriteQuestion });
            if (!proceed) {
                console.log(chalk.yellow('Aborted. No changes were made.'));
                process.exit(0);
            }
            fs.copyFileSync(targetPath, backupPath);
            console.log(chalk.gray(`Backup saved to ${backupPath}`));
        }
    }

    // Resolve the workspace. Device login has already persisted its base
    // credential; API-key login still resolves before its first write.
    if (options.workspace) {
        const result = classifyWorkspaceInput(options.workspace, workspaces);
        if (result.kind !== 'match') {
            if (preflight?.credentialPersisted) {
                writeConfigFile(preflight.targetPath, config);
                console.error(chalk.yellow(describeWorkspaceMatchFailure(result)));
                console.error(chalk.yellow(
                    `Authentication was saved to ${preflight.targetPath}.`,
                ));
                console.error(chalk.yellow(
                    'Run `solidactions workspace list`, then `solidactions workspace set <name>` to finish setup.',
                ));
            } else {
                console.error(chalk.red(describeWorkspaceMatchFailure(result)));
            }
            process.exit(1);
            return;
        }
        const match = result.workspace;
        config.workspace = match.slug ?? match.name;
        config.workspaceId = match.id;
    } else if (workspaces.length === 1) {
        const selected = workspaces[0];
        console.log(chalk.gray(`Auto-selected workspace: ${formatWorkspaceWithOrg(selected)}`));
        config.workspace = selected.slug ?? selected.name;
        config.workspaceId = selected.id;
    } else if (workspaces.length === 0) {
        console.log(chalk.yellow(
            'No workspaces found. Create one at your SolidActions dashboard, then '
            + 'run `solidactions workspace set <name>`.',
        ));
    } else if (process.stdin.isTTY) {
        const selectWorkspace = dependencies.selectWorkspace ?? selectWorkspaceInteractively;
        const selected = await selectWorkspace(workspaces);
        if (selected) {
            config.workspace = selected.slug ?? selected.name;
            config.workspaceId = selected.id;
        }
    } else {
        console.log(chalk.yellow(
            'Multiple workspaces are available, so no workspace was selected. '
            + 'Run `solidactions workspace list`, then `solidactions workspace set <name>`.',
        ));
    }

    let savedTargetPath: string;
    if (preflight) {
        savedTargetPath = preflight.targetPath;
        writeConfigFile(preflight.targetPath, config);
    } else {
        savedTargetPath = targetPath!;
        writeConfigFile(targetPath!, config);

        if (target === 'local') {
            await ensureGitignoreCovers(process.cwd(), !!options.gitignore);
        }
    }

    if (config.workspaceId) {
        console.log(chalk.green('Logged in successfully!'));
        console.log(chalk.gray(`Configuration saved to ${savedTargetPath}`));
        console.log('');
        console.log(chalk.blue('Next step — scaffold a new project (includes AI tooling):'));
        console.log(chalk.gray('  solidactions init <project-name>      Creates ./<project-name>/ with scaffold + AI skills'));
        console.log(chalk.gray('  solidactions init                     Scaffolds in the current (empty) directory'));
        console.log('');
        console.log(chalk.blue('Quick start:'));
        console.log(chalk.gray('  solidactions project deploy <name>    Deploy current directory'));
        console.log(chalk.gray('  solidactions run start <proj> <wf>    Run a workflow'));
        console.log(chalk.gray('  solidactions run list                 List recent runs'));
    } else {
        console.log(chalk.yellow(`Authentication saved to ${savedTargetPath}.`));
        if (workspaces.length > 0) {
            console.log(chalk.yellow(
                'Run `solidactions workspace list`, then `solidactions workspace set <name>` to finish setup.',
            ));
        }
    }
}

export async function login(
    apiKey: string,
    options: { dev?: boolean; host?: string; workspace?: string; local?: boolean; global?: boolean; gitignore?: boolean },
) {
    const resolved = resolveLoginHost(options);
    const host = resolved.host;

    if (!apiKey || apiKey.trim().length === 0) {
        console.error(chalk.red('Error: API key is required.'));
        console.log(chalk.gray('Generate an API key at: ') + chalk.blue(`${host}/settings/api-keys`));
        process.exit(1);
    }

    console.log(chalk.blue(`Initializing SolidActions CLI...`));
    for (const line of loginHostLines(resolved)) {
        console.log(resolved.isDefault ? chalk.yellow(line) : chalk.gray(line));
    }

    const config: Config = {
        host,
        apiKey: apiKey.trim(),
    };

    // 1. Validate the key BEFORE any disk write.
    let workspaces: WorkspaceLookupRecord[];
    let scope: WorkspaceScope | null;
    try {
        ({ workspaces, scope } = await fetchWorkspaces(config));
    } catch (e: any) {
        if (e.response?.status === 401) {
            console.error(chalk.red(`Invalid API key for ${host}.`));
        } else {
            console.error(chalk.red(`Could not reach ${host}: ${e.message}`));
        }
        process.exit(1);
        return;
    }

    await completeLogin(config, workspaces, options, scope);
}

export function logout(options: { local?: boolean; global?: boolean } = {}) {
    if (options.local && options.global) {
        console.error(chalk.red('Error: --local and --global are mutually exclusive.'));
        process.exit(1);
    }

    const globalPath = getGlobalConfigPath();
    const localPath = findLocalConfigPath(process.cwd());

    let targetPath: string | null;
    if (options.local) {
        targetPath = localPath;
        if (!targetPath) {
            console.error(chalk.red(`No local config found in ${process.cwd()} or any parent directory.`));
            process.exit(1);
        }
    } else if (options.global) {
        targetPath = globalPath;
    } else {
        targetPath = localPath ?? globalPath;
    }

    const removed = removeConfigFile(targetPath);
    if (removed) {
        console.log(chalk.green(`Logged out. Removed ${targetPath}`));
    } else {
        console.log(chalk.gray(`Not logged in (no config at ${targetPath}) — nothing to remove.`));
        process.exit(0);
    }
}

export function whoami() {
    const resolved = resolveConfig();
    if (!resolved || !resolved.config.apiKey) {
        console.log(chalk.yellow('Not initialized.'));
        console.log(chalk.gray('Run "solidactions login --global" to configure.'));
        process.exit(1);
    }

    const { config, sources } = resolved;
    const maskedKey = config.apiKey.length > 12
        ? `${config.apiKey.substring(0, 8)}...${config.apiKey.slice(-4)}`
        : config.apiKey;

    const fmt = (src: ConfigSource): string => {
        if (src === 'env') return chalk.gray('(from $SOLIDACTIONS_* env var)');
        if (src === 'cli') return chalk.gray('(from -w flag)');
        if (src === null) return chalk.gray('(unset)');
        return chalk.gray(`(from ${src})`);
    };

    const workspaceLabel = config.workspace
        ? `${config.workspace}${config.workspaceId ? ` (${config.workspaceId})` : ''}`
        : config.workspaceId
            ? `${config.workspaceId} (slug unknown — run 'workspace set <slug>' to populate)`
            : '';

    const isFileSource = (src: ConfigSource): boolean => src !== null && src !== 'env' && src !== 'cli';
    const workspaceInheritedFromOtherFile = isFileSource(sources.workspaceId) && sources.workspaceId !== sources.apiKey;

    console.log(chalk.blue('Current configuration:'));
    console.log(`  Host:        ${config.host.padEnd(50)} ${fmt(sources.host)}`);
    console.log(`  API Key:     ${maskedKey.padEnd(50)} ${fmt(sources.apiKey)}`);
    console.log(`  Workspace:   ${workspaceLabel.padEnd(50)} ${fmt(sources.workspaceId)}${workspaceInheritedFromOtherFile ? chalk.yellow(' (inherited from a different config file)') : ''}`);
}

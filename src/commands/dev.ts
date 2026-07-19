import { spawn, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import chalk from 'chalk';
import yaml from 'js-yaml';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { SolidActionsConfig } from '../utils/env';
import { Config, findLocalConfigPath, getGlobalConfigPath } from '../utils/config';

// ---------------------------------------------------------------------------
// runDev — programmatic entry point (testable, no process.exit)
// ---------------------------------------------------------------------------

/**
 * A platform variable as returned by the SA API variable-mappings endpoint.
 * Only the fields relevant to ctx.vars construction are required here.
 */
export interface PlatformVar {
    /** env_name: the env-var key (e.g. "GCAL") */
    env_name: string;
    /** Resolved runtime value (plain string or null for connections) */
    resolved_value?: string | null;
    /** Whether this mapping is backed by an OAuth connection */
    source_type?: string;
    /** Connection proxy URL (set when source_type === 'oauth_connection') */
    proxy_url?: string | null;
    /** Proxy bearer token (set when source_type === 'oauth_connection') */
    proxy_token?: string | null;
    /** Connection key (set when source_type === 'oauth_connection') */
    connection_key?: string | null;
    /** Whether this mapping is a secret — a valueless secret is not fetchable locally, unlike a plain var. */
    is_secret?: boolean;
}

/**
 * Injection seam for the SA API — real production impl uses axios, tests use
 * a real local HTTP server (no mock libraries). The seam exposes only the
 * minimum surface runDev() needs.
 */
export interface SaApiClient {
    /** Project slug (e.g. "my-project") */
    projectSlug: string;
    /** Fetch declared variable-mappings for the given env from the SA API. */
    fetchVarsAndConnections(env: string): Promise<PlatformVar[]>;
    /** Set true when the API token lacks `env:reveal` and the reveal request had to fall back. */
    revealDenied?: boolean;
}

/**
 * Build the production `SaApiClient`: fetches `variable-mappings` with
 * `reveal=true` so secret values are populated on `ctx.vars`. When the token
 * lacks the `env:reveal` ability, the API responds 403
 * `{ code: 'token_missing_ability' }` — retry once without `reveal` and mark
 * `revealDenied` so the caller can tell the user secrets were withheld.
 */
export function buildSaApiClient(config: Config, projectSlug: string): SaApiClient {
    const client: SaApiClient = {
        projectSlug,
        revealDenied: false,
        async fetchVarsAndConnections(_env: string): Promise<PlatformVar[]> {
            const axios = (await import('axios')).default;
            const { getApiHeaders } = await import('../utils/api');
            const base = `${config.host}/api/v1/projects/${projectSlug}/variable-mappings?resolve_oauth=true`;
            try {
                const response = await axios.get(`${base}&reveal=true`, { headers: getApiHeaders(config) });
                return response.data || [];
            } catch (e: any) {
                if (e?.response?.status === 403 && e.response.data?.code === 'token_missing_ability') {
                    client.revealDenied = true;
                    const response = await axios.get(base, { headers: getApiHeaders(config) });
                    return response.data || [];
                }
                throw e;
            }
        },
    };
    return client;
}

/** Structured return value of runDev — never calls process.exit. */
export interface RunDevResult {
    stdout: string;
    stderr: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result: any; // InvokeResult from @solidactions/sdk
}

/**
 * Context passed to dev-shim.mjs via SOLIDACTIONS_DEV_SHIM_CONTEXT env var
 * as a JSON string. Every field must be JSON-serialisable.
 */
export interface DevShimContext {
    /** Absolute path to the user's workflow entry file (.ts). */
    entryPath: string;
    /** JSON-serialised workflow input (e.g. '{"n":2}'). */
    input: string;
    /** ctx.vars built from platform vars + overrides. */
    vars: Record<string, string | { key: string; proxyUrl: string; proxyToken: string }>;
    /** baseUrl of the mock server started by the parent. */
    mockBaseUrl: string;
    /** API key for the mock server. */
    mockApiKey: string;
    /** Pre-generated run UUID. */
    runUuid: string;
    /** workerSessionId for ctx.run. */
    workerSessionId: string;
    /** Path to the private temp file the shim writes its result JSON to. */
    resultPath: string;
}

/** Result the shim writes to the result temp file. */
export interface DevShimResult {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result: any;
}

export interface RunDevOptions {
    /** Absolute or cwd-relative path to the workflow entry file. */
    entry: string;
    /** JSON-serialised input for the workflow (e.g. '{"n":2}'). */
    input: string;
    /**
     * Environment name to resolve platform variables for (e.g. 'staging').
     * When omitted, NO platform fetch happens and `ctx.vars` starts empty `{}`
     * (it is NOT populated from the host `process.env`). Use {@link varsOverride}
     * to inject explicit local values in that case.
     */
    env?: string;
    /**
     * SA API client injection seam.  If omitted (and {@link env} is set),
     * runDev() builds a real client from the CLI's resolved config.
     */
    api?: SaApiClient;
    /**
     * Local var overrides (key→value).  When a key also exists as a platform
     * var, a warning is emitted to stderr:
     *   "override shadows platform var: <KEY>"
     */
    varsOverride?: Record<string, string>;
}

/**
 * Refuse to run `dev --env` against a config the user did not choose.
 *
 * `dev --env` builds its API client from `resolveConfig(process.cwd())`, which
 * falls back to the GLOBAL `~/.solidactions/config.json` when no project-local
 * `.solidactions/config.json` is reachable. That global config typically points
 * at PRODUCTION, so a workflow run from outside its project's `.solidactions`
 * tree used to silently fetch vars from — and target — the wrong tenant, with
 * no diagnostic beyond a bare 404 (issue #30).
 *
 * Two situations are refused:
 *   1. No project-local config above the cwd — the run WOULD fall back to the
 *      global config.
 *   2. The entry file's project-local config is NOT the one the cwd resolves to
 *      — the run would target a different project's account.
 *
 * Explicit `SOLIDACTIONS_HOST` / `SOLIDACTIONS_API_KEY` env overrides are a
 * deliberate choice of target and are always allowed through.
 */
export function assertProjectLocalConfig(entryPath: string, env: string): void {
    if (process.env.SOLIDACTIONS_HOST || process.env.SOLIDACTIONS_API_KEY) {
        return;
    }

    const entryLocal = findLocalConfigPath(path.dirname(path.resolve(entryPath)));
    const cwdLocal = findLocalConfigPath(process.cwd());

    if (!cwdLocal) {
        const found = entryLocal
            ? `The workflow's own project config is ${entryLocal}.\n`
            : '';
        throw new Error(
            `no project-local .solidactions/config.json found from ${process.cwd()}.\n`
            + `Refusing to run --env ${env} against the global config ${getGlobalConfigPath()}, `
            + 'which usually points at production.\n'
            + found
            + 'Fix: cd into the project directory before running `solidactions dev`, '
            + 'or run `solidactions init` there to create a project-local config.',
        );
    }

    if (entryLocal && entryLocal !== cwdLocal) {
        throw new Error(
            `config mismatch: the workflow's project config is ${entryLocal}, `
            + `but this directory resolves to ${cwdLocal}.\n`
            + `Refusing to run --env ${env} against a config from a different project.\n`
            + 'Fix: cd into the workflow\'s project directory before running `solidactions dev`.',
        );
    }
}

/**
 * Resolve the SA project slug for a workflow entry file and a target env.
 *
 * Walks up from the entry file to the project root (the directory containing
 * `solidactions.yaml`), reads the declared `project:` name, and applies the
 * SAME env→slug rule used by `deploy`: production keeps the bare name, every
 * other environment appends `-<env>` (e.g. `sdk-test` → `sdk-test-dev`).
 *
 * Throws when the project root or the `project:` field cannot be found, so the
 * caller surfaces a clear error instead of fetching against a bogus slug.
 */
export function resolveProjectSlug(entryPath: string, env: string): string {
    const root = findSolidActionsRoot(path.resolve(entryPath));
    if (!root) {
        throw new Error(`could not find solidactions.yaml in any parent of ${entryPath}`);
    }
    const configPath = path.join(root, 'solidactions.yaml');
    const config = yaml.load(fs.readFileSync(configPath, 'utf8')) as SolidActionsConfig | null;
    const projectName = config?.project;
    if (!projectName || typeof projectName !== 'string') {
        throw new Error(`solidactions.yaml at ${configPath} is missing a top-level "project:" name`);
    }
    return env === 'production' ? projectName : `${projectName}-${env}`;
}

/**
 * Walk up from a starting path looking for the directory that holds
 * `solidactions.yaml` (the project root). Returns null if none is found.
 */
function findSolidActionsRoot(startPath: string): string | null {
    let dir = fs.existsSync(startPath) && fs.statSync(startPath).isDirectory()
        ? startPath
        : path.dirname(startPath);
    for (let i = 0; i < 10; i++) {
        if (fs.existsSync(path.join(dir, 'solidactions.yaml'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/**
 * Run the user workflow entry by spawning `npx tsx dist/commands/dev-shim.mjs`.
 *
 * WHY THE CHILD PROCESS (not in-process import):
 *   The CLI tsconfig compiles "module": "commonjs", so tsc rewrites await import(x)
 *   to require(x) in every .ts file it compiles. tsx's CJS hook does NOT remap
 *   .js→.ts in require() calls. A hand-written .mjs shim bypasses tsc entirely,
 *   so its import() stays a real ESM dynamic import. When tsx loads .mjs, it uses
 *   the ESM loader, which DOES remap .js→.ts for all transitive imports.
 *
 * SECRETS: context is passed as a JSON env var — OAuth proxyToken values never
 * touch disk. The result uses a private temp file (mode 0o600, UUID name).
 */
async function runDevViaShim(
    entryPath: string,
    input: string,
    vars: Record<string, string | { key: string; proxyUrl: string; proxyToken: string }>,
    mockBaseUrl: string,
    runUuid: string,
    workerSessionId: string,
    stdoutLines: string[],
    stderrLines: string[],
): Promise<{ result: any }> {
    const shimPath = path.resolve(__dirname, 'dev-shim.mjs');

    // Private temp file for the result (mode 0o600, UUID name).
    const resultPath = path.join(os.tmpdir(), `sa-dev-result-${runUuid}-${randomUUID()}.json`);

    // Write placeholder so the shim can overwrite it.
    fs.writeFileSync(resultPath, '', { mode: 0o600 });

    const shimCtx: DevShimContext = {
        entryPath,
        input,
        vars,
        mockBaseUrl,
        mockApiKey: 'local-dev',
        runUuid,
        workerSessionId,
        resultPath,
    };

    try {
        // Use async spawn (NOT spawnSync): the SDK mock backend runs in THIS
        // process's event loop, and the shim makes HTTP calls back to it
        // (run-row creation, step/sleep/recv routes). spawnSync would block the
        // parent's event loop, deadlocking the mock server — so we await an
        // async child and pump its stdout/stderr while the loop stays live.
        let timedOut = false;
        const spawnError = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
            const child = spawn(
                'npx',
                ['tsx', shimPath],
                {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: {
                        ...process.env,
                        SOLIDACTIONS_DEV_SHIM_CONTEXT: JSON.stringify(shimCtx),
                    },
                },
            );

            let stdoutBuf = '';
            let stderrBuf = '';
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => { stdoutBuf += chunk; });
            child.stderr.on('data', (chunk: string) => { stderrBuf += chunk; });

            const timer = setTimeout(() => {
                timedOut = true;
                child.kill('SIGKILL');
            }, 120_000);

            child.on('error', (e: NodeJS.ErrnoException) => {
                clearTimeout(timer);
                if (stdoutBuf.trim()) { stdoutLines.push(stdoutBuf.trimEnd()); }
                if (stderrBuf.trim()) { stderrLines.push(stderrBuf.trimEnd()); }
                resolve(e);
            });

            child.on('close', () => {
                clearTimeout(timer);
                if (stdoutBuf.trim()) { stdoutLines.push(stdoutBuf.trimEnd()); }
                if (stderrBuf.trim()) { stderrLines.push(stderrBuf.trimEnd()); }
                resolve(undefined);
            });
        });

        if (spawnError) {
            const code = spawnError.code;
            const msg = code === 'ENOENT'
                ? 'npx not found. Make sure Node.js is installed.'
                : `Failed to spawn tsx shim: ${spawnError.message}`;
            return {
                result: { status: 'failed', error: { message: msg, name: 'Error' }, phase: 'run' },
            };
        }

        let resultContent = '';
        try {
            resultContent = fs.readFileSync(resultPath, 'utf8');
        } catch {
            // shim crashed before writing — stderr already captured above
            return {
                result: {
                    status: 'failed',
                    error: { message: 'dev-shim did not write a result file (check stderr above)', name: 'Error' },
                    phase: 'run',
                },
            };
        }

        if (!resultContent.trim()) {
            const msg = timedOut
                ? 'dev-shim timed out after 120s'
                : 'dev-shim wrote an empty result file (check stderr above)';
            return {
                result: {
                    status: 'failed',
                    error: { message: msg, name: 'Error' },
                    phase: 'run',
                },
            };
        }

        const shimResult: DevShimResult = JSON.parse(resultContent);
        return { result: shimResult.result };
    } finally {
        // Clean up result temp file on all exit paths.
        try { fs.unlinkSync(resultPath); } catch { /* ignore */ }
    }
}

/**
 * Run a workflow entry file in local-dev mode:
 *   1. Fetch declared vars + connections from the platform (via api seam).
 *   2. Apply any varsOverride, warning when a key shadows a platform var.
 *   3. Spin up an SDK mock backend (createMockServer) for durable-primitive support.
 *   4. import() the workflow module to populate the registry.
 *   5. invoke() the first registered workflow descriptor.
 *   6. Return { stdout, stderr, result }.
 *
 * Never calls process.exit; never lets exceptions escape (returns failed result).
 */
export async function runDev(opts: RunDevOptions): Promise<RunDevResult> {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    function out(msg: string) {
        stdoutLines.push(msg);
    }
    function err(msg: string) {
        stderrLines.push(msg);
    }

    // 1. Determine the API client (only when an env was requested). With no
    //    --env, we run fully locally: NO platform fetch, ctx.vars starts empty.
    let apiClient: SaApiClient | undefined;
    if (opts.env) {
        if (opts.api) {
            apiClient = opts.api;
        } else {
            // Refuse BEFORE any config resolution / network work when the only
            // reachable config is the global (usually production) one — see #30.
            assertProjectLocalConfig(opts.entry, opts.env);
            // Production path: build from CLI config.
            // Lazy-import to keep tests fast (no config resolution needed).
            const { requireConfigWithWorkspace } = await import('../utils/api');
            const config = await requireConfigWithWorkspace();
            // Real project resolution: read the project name from the workflow
            // file's solidactions.yaml and apply the deploy env→slug rule.
            const projectSlug = resolveProjectSlug(opts.entry, opts.env);
            apiClient = buildSaApiClient(config, projectSlug);
        }
    }

    // 2. Fetch vars from platform (only when an env + client are present).
    let platformVars: PlatformVar[] = [];
    if (apiClient && opts.env) {
        try {
            platformVars = await apiClient.fetchVarsAndConnections(opts.env);
        } catch (e: any) {
            let msg = `failed to fetch platform vars: ${e?.message ?? e}`;
            if (e?.response?.status === 404 && opts.env !== 'production') {
                msg += `\nThe '${opts.env}' environment project doesn't exist — staging/dev environments require a paid plan. On the free plan, use --env production.`;
            }
            err(msg);
        }
    }

    // 3. Build ctx.vars from platform vars. A declared mapping is only readable
    //    on ctx.vars when it is an OAuth connection (with proxy fields) OR has a
    //    non-null resolved_value. Mappings with no value in this env are DROPPED
    //    — and must NOT be counted in the summary (BUG #1). A dropped SECRET is
    //    reported separately (it's genuinely unavailable to local dev, not
    //    merely "unset" — the platform never resolves secret values to the CLI).
    const vars: Record<string, string | { key: string; proxyUrl: string; proxyToken: string }> = {};
    let connectionCount = 0;
    let droppedCount = 0;
    let droppedSecretCount = 0;
    for (const pv of platformVars) {
        if (pv.source_type === 'oauth_connection' && pv.proxy_url && pv.proxy_token && pv.connection_key) {
            vars[pv.env_name] = {
                key: pv.connection_key,
                proxyUrl: pv.proxy_url,
                proxyToken: pv.proxy_token,
            };
            connectionCount++;
        } else if (pv.resolved_value != null) {
            vars[pv.env_name] = pv.resolved_value;
        } else if (pv.is_secret) {
            droppedSecretCount++;
        } else {
            droppedCount++;
        }
    }

    // 4. Apply overrides, warning on shadows.
    if (opts.varsOverride) {
        for (const [key, value] of Object.entries(opts.varsOverride)) {
            if (key in vars) {
                err(`override shadows platform var: ${key}`);
            }
            vars[key] = value;
        }
    }

    // 5. Print summary line. Report what is ACTUALLY readable on ctx.vars — the
    //    plain-var count is the number of plain vars actually placed in `vars`
    //    (total keys minus connection entries), never the raw mapping count.
    if (opts.env) {
        const plainVarCount = Object.keys(vars).length - connectionCount;
        let summary = `Loaded ${plainVarCount} vars + ${connectionCount} connections from ${apiClient!.projectSlug} / env ${opts.env}`;
        if (droppedCount > 0) {
            summary += ` (${droppedCount} declared ${droppedCount === 1 ? 'var' : 'vars'} had no value in this env and ${droppedCount === 1 ? 'was' : 'were'} skipped)`;
        }
        if (droppedSecretCount > 0) {
            if (apiClient!.revealDenied) {
                summary += ` — ${droppedSecretCount} secret ${droppedSecretCount === 1 ? 'var' : 'vars'} unavailable: your API key lacks the 'env:reveal' ability. Mint a key with env:reveal, or set a test value with \`solidactions env set\`.`;
            } else {
                summary += ` (${droppedSecretCount} secret ${droppedSecretCount === 1 ? 'var is' : 'vars are'} not available to local dev — set a test value in your dev environment with \`solidactions env set\`, or pass values via \`-i\`.)`;
            }
        }
        out(summary);
    } else {
        out('Loaded 0 platform vars (no --env) — running locally');
    }

    // 6. Spin up SDK mock backend.
    // Require createMockServer from the SDK's testing subpath.
    //
    // CRITICAL: root the require at the ENTRY FILE, not at __filename. The
    // workflow module's own `import '@solidactions/sdk'` resolves the SDK
    // relative to the entry file's project (e.g. examples/sdk-test/sdk), and
    // it registers its workflow into THAT copy's registry singleton. If we
    // resolved the SDK from the CLI's own node_modules instead (a different,
    // npm-linked copy), we'd read an empty registry. Resolving from the entry's
    // directory guarantees we hit the same SDK instance the workflow used.
    const entryPath = path.resolve(opts.entry);
    const _require = createRequire(entryPath);
    // Resolve via the installed (or linked) @solidactions/sdk package.
    let sdkTestingMain: string;
    try {
        sdkTestingMain = _require.resolve('@solidactions/sdk/testing');
    } catch (e: any) {
        if (e.code === 'MODULE_NOT_FOUND') {
            err('Dependencies not installed — run `npm install` in the project directory first.');
            return {
                stdout: stdoutLines.join('\n'),
                stderr: stderrLines.join('\n'),
                result: { status: 'failed', error: e, phase: 'setup' },
            };
        }
        throw e;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { createMockServer } = _require(sdkTestingMain) as { createMockServer: (port?: number) => Promise<{ baseUrl: string; stop: () => Promise<void> }> };

    const mockServer = await createMockServer();

    // Pre-generate run IDs so they can be passed to the shim (for .ts entries)
    // or used in-process (for .js/.mjs entries).
    const runUuid = randomUUID();
    const workerSessionId = randomUUID();

    try {
        // 7. Load and invoke the workflow.
        //
        // For .ts entries: spawn `npx tsx dist/commands/dev-shim.mjs`. The .mjs shim
        // is NOT compiled by tsc, so its import() stays a real ESM dynamic import.
        // tsx's ESM loader remaps .js-extension imports to .ts files, fixing the
        // Cannot-find-module bug on multi-file NodeNext projects.
        //
        // The shim creates the run-row (it has the descriptor name) and invokes.
        // stdio: pipe — child stdout/stderr are captured into stdoutLines/stderrLines.
        //
        // For .js/.mjs entries: original in-process import path (no change).
        const isTs = /\.(ts|tsx|mts|cts)$/.test(entryPath);

        if (isTs) {
            const shimInvokeResult = await runDevViaShim(
                entryPath,
                opts.input,
                vars,
                mockServer.baseUrl,
                runUuid,
                workerSessionId,
                stdoutLines,
                stderrLines,
            );
            return {
                stdout: stdoutLines.join('\n'),
                stderr: stderrLines.join('\n'),
                result: shimInvokeResult.result,
            };
        }

        // JS/MJS path: in-process import (original behaviour, no change).
        // 8. Import the workflow entry file. Prefer the module's default export
        //    (a WorkflowDescriptor returned by defineWorkflow) so that repeated
        //    runDev() calls in the same test process don't need to clear and
        //    re-register from a cached module (cached CJS modules don't re-run
        //    their top-level code). If no default export, fall back to the registry.
        const mod = await import(entryPath);
        let descriptor: { name?: string; run: Function } | undefined;

        if (mod?.default && typeof mod.default?.run === 'function') {
            // Module exported a WorkflowDescriptor as its default — use it directly.
            descriptor = mod.default;
        } else {
            // Fall back: read from the SDK registry (populated by defineWorkflow side-effects).
            const sdkMain = _require.resolve('@solidactions/sdk');
            const registryPath = path.resolve(sdkMain, '..', 'invoke', 'registry.js');
            const registry = _require(registryPath) as {
                __getRegisteredWorkflows: () => Array<{ name?: string; run: Function }>;
            };
            const all = registry.__getRegisteredWorkflows();
            descriptor = all[0];
        }

        if (!descriptor) {
            err('runDev: no workflows registered after importing the file.');
            return {
                stdout: stdoutLines.join('\n'),
                stderr: stderrLines.join('\n'),
                result: { status: 'failed', error: new Error('no workflow registered'), phase: 'run' },
            };
        }

        // 9. Build InvokeCtx.
        const ctx = {
            input: JSON.parse(opts.input || '{}'),
            vars: Object.freeze(vars),
            run: {
                triggerId: 'local-dev',
                runUuid,
                runSecret: 'local-dev',
                workerSessionId,
            },
            app: {
                appVersion: '0',
                appId: 'local-dev',
                tenantId: 'local-dev',
            },
            api: {
                url: mockServer.baseUrl,
                key: 'local-dev',
            },
            mode: 'local' as const,
        };

        // 10. Create the run-row BEFORE invoking. invoke() itself never creates
        //    the durable run record — the production launcher (SolidActions.run
        //    → #initOneShotStatusRow) does that first, and step/sleep/recv
        //    sub-routes (`/runs/status/<id>/...`) 404 ("Workflow not found")
        //    against an absent row. A no-step workflow (the echo fixture) never
        //    hits those routes so it survives without this; any workflow with a
        //    runStep does not. Mirror #initOneShotStatusRow's CREATE shape.
        const sdkMainForInvoke = _require.resolve('@solidactions/sdk');
        const httpClientPath = path.resolve(sdkMainForInvoke, '..', 'http_client.js');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { HttpClient } = _require(httpClientPath) as { HttpClient: new (cfg: { baseUrl: string; apiKey: string }, logger?: unknown) => { post: (path: string, body: unknown) => Promise<unknown> } };
        try {
            const client = new HttpClient({ baseUrl: ctx.api.url, apiKey: ctx.api.key });
            await client.post('/runs/status', {
                workflowUUID: ctx.run.runUuid,
                status: 'PENDING',
                workflowName: descriptor.name ?? '',
                workflowClassName: '',
                workflowConfigName: '',
                output: null,
                error: null,
                authenticatedUser: '',
                assumedRole: '',
                authenticatedRoles: [],
                request: {},
                executorId: String(ctx.run.triggerId),
                applicationVersion: ctx.app.appVersion,
                applicationID: ctx.app.appId,
                createdAt: Date.now(),
                priority: 0,
                ownerXid: randomUUID(),
                options: {},
            });
        } catch (e: any) {
            // Best-effort, symmetric with #initOneShotStatusRow's swallow.
            err(`failed to create local run-row: ${e?.message ?? e}`);
        }

        // 11. Invoke via internal SDK path (invoke() is not in the public index).
        const invokePath = path.resolve(sdkMainForInvoke, '..', 'invoke', 'invoke.js');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { invoke } = _require(invokePath) as { invoke: (wf: any, ctx: any) => Promise<any> };
        const result = await invoke(descriptor, ctx);

        return {
            stdout: stdoutLines.join('\n'),
            stderr: stderrLines.join('\n'),
            result,
        };
    } finally {
        await mockServer.stop();
    }
}

interface DevOptions {
    input?: string;
    env?: string;
}

/**
 * Env var set on the tsx re-exec child so it does NOT re-exec again. Without
 * this guard the `--env` path would fork itself forever.
 */
const TSX_REEXEC_GUARD = 'SOLIDACTIONS_DEV_TSX_REEXEC';

/**
 * Detect whether the current Node process already has a TypeScript loader
 * registered (tsx / ts-node). When true, `await import('<file>.ts')` works
 * in-process and we can run `runDev` directly without re-exec.
 *
 * NOTE: Boolean(process._preload_modules) is intentionally NOT used here —
 * an empty array is truthy, causing a false positive that always skips the
 * re-exec path even when no TypeScript loader is active.
 */
function hasTsLoader(): boolean {
    if (process.env[TSX_REEXEC_GUARD] === '1') {
        return true;
    }
    const execArgv = process.execArgv.join(' ');
    if (/tsx|ts-node/.test(execArgv)) {
        return true;
    }
    // Check _preload_modules for tsx/ts-node entries (non-empty array check).
    const preload = (process as { _preload_modules?: unknown[] })._preload_modules;
    if (Array.isArray(preload) && preload.length > 0) {
        return preload.some((m) => typeof m === 'string' && /tsx|ts-node/i.test(m));
    }
    return false;
}

/**
 * Re-exec the CLI under `npx tsx` so that `runDev`'s `await import()` of a
 * `.ts` workflow file resolves against tsx's TypeScript loader. The child runs
 * the SAME command (`dev <file> [--env <env>] --input <json>`) with the re-exec
 * guard set, so it falls straight through to {@link runDev}.
 *
 * tsx is resolved via `npx`; the child's cwd is the project root so its
 * node_modules tsx is preferred. `env` is optional — when omitted the child
 * runs the bare local path (no platform fetch, empty ctx.vars).
 */
function reexecUnderTsx(file: string, env: string | undefined, input: string, projectDir: string): number {
    // dist/src/commands/dev.js → CLI entry is dist/index.js (two dirs up).
    const cliEntry = path.resolve(__dirname, '..', 'index.js');
    const args = ['tsx', cliEntry, 'dev', file, '--input', input];
    if (env) {
        args.push('--env', env);
    }
    const result = spawnSync(
        'npx',
        args,
        {
            stdio: 'inherit',
            cwd: projectDir,
            env: { ...process.env, [TSX_REEXEC_GUARD]: '1' },
        },
    );
    if (result.error) {
        const code = (result.error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            console.error(chalk.red('npx not found. Make sure Node.js is installed.'));
        } else {
            console.error(chalk.red(`Failed to start tsx loader: ${result.error.message}`));
        }
        return 1;
    }
    return result.status ?? 1;
}

/**
 * Handler for `solidactions dev <file> [--env <env>]`: run the workflow LOCALLY
 * through the in-process invoke() engine.
 *
 * With `--env`: pulls declared variable-mappings from the SA API and builds
 * `ctx.vars` for the chosen environment. WITHOUT `--env`: NO platform fetch and
 * `ctx.vars` starts empty `{}` — the host `process.env` is NEVER leaked into the
 * workflow. Either way the workflow runs against the SDK mock backend via
 * {@link runDev}. `.ts` entries are loaded by re-exec'ing under `npx tsx`.
 */
export async function dev(file: string, options: DevOptions): Promise<void> {
    const env = options.env;
    const input = options.input || '{}';

    const filePath = path.resolve(file);
    if (!fs.existsSync(filePath)) {
        console.error(chalk.red(`File not found: ${filePath}`));
        process.exit(1);
    }

    try {
        JSON.parse(input);
    } catch {
        console.error(chalk.red('Invalid JSON input. Use -i \'{"key": "value"}\''));
        process.exit(1);
    }

    // .ts entry under plain node has no loader — re-exec under tsx, then return.
    if (!hasTsLoader() && /\.(ts|tsx|mts|cts)$/.test(filePath)) {
        const projectDir = findProjectRoot(filePath) ?? process.cwd();
        // Surface a clear slug-resolution error here (before forking) rather
        // than letting the child fail with an opaque exit code. Only relevant
        // when an env was requested (bare runs do no platform fetch).
        if (env) {
            try {
                resolveProjectSlug(filePath, env);
            } catch (err: any) {
                console.error(chalk.red(`Failed: ${err.message}`));
                process.exit(1);
            }
        }
        process.exit(reexecUnderTsx(file, env, input, projectDir));
    }

    // In-process path (already under a TS loader, or a .js/.mjs entry).
    let result;
    try {
        result = await runDev({ entry: filePath, input, env });
    } catch (err: any) {
        console.error(chalk.red(`Failed: ${err.message}`));
        process.exit(1);
    }

    if (result.stdout) {
        console.log(result.stdout);
    }
    if (result.stderr) {
        console.error(chalk.yellow(result.stderr));
    }

    const r = result.result;
    if (r.status === 'completed') {
        console.log(chalk.green('✓ completed'));
        console.log(chalk.gray('Output:'), JSON.stringify(r.output));
        process.exit(0);
    }

    if (r.status === 'suspended') {
        console.log(chalk.yellow(`Workflow suspended: ${r.reason ?? 'unknown'}`));
        process.exit(0);
    }
    if (r.status === 'cancelled') {
        console.log(chalk.yellow('Workflow cancelled'));
        process.exit(1);
    }

    // failed
    console.error(chalk.red(`✗ failed (${r.phase ?? 'run'}):`), r.error?.message ?? String(r.error));
    process.exit(1);
}

function findProjectRoot(startPath: string): string | null {
    let dir = path.dirname(startPath);
    for (let i = 0; i < 10; i++) {
        if (fs.existsSync(path.join(dir, 'package.json'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';

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
}

/** Structured return value of runDev — never calls process.exit. */
export interface RunDevResult {
    stdout: string;
    stderr: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result: any; // InvokeResult from @solidactions/sdk
}

export interface RunDevOptions {
    /** Absolute or cwd-relative path to the workflow entry file. */
    entry: string;
    /** JSON-serialised input for the workflow (e.g. '{"n":2}'). */
    input: string;
    /** Environment name to resolve variables for (e.g. 'staging'). */
    env: string;
    /**
     * SA API client injection seam.  If omitted, runDev() builds a real client
     * from the CLI's resolved config.
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

    // 1. Determine the API client.
    let apiClient: SaApiClient;
    if (opts.api) {
        apiClient = opts.api;
    } else {
        // Production path: build from CLI config.
        // Lazy-import to keep tests fast (no config resolution needed).
        const { requireConfigWithWorkspace } = await import('../utils/api');
        const { getApiHeaders } = await import('../utils/api');
        const axios = (await import('axios')).default;
        const config = await requireConfigWithWorkspace();
        const projectSlug = opts.env === 'production' ? 'unknown' : `unknown-${opts.env}`;
        apiClient = {
            projectSlug,
            async fetchVarsAndConnections(env: string): Promise<PlatformVar[]> {
                const slug = env === 'production' ? projectSlug : `${projectSlug}-${env}`;
                const response = await axios.get(
                    `${config.host}/api/v1/projects/${slug}/variable-mappings?resolve_oauth=true`,
                    { headers: getApiHeaders(config) },
                );
                return response.data || [];
            },
        };
    }

    // 2. Fetch vars from platform.
    let platformVars: PlatformVar[] = [];
    try {
        platformVars = await apiClient.fetchVarsAndConnections(opts.env);
    } catch (e: any) {
        err(`failed to fetch platform vars: ${e?.message ?? e}`);
    }

    // 3. Build ctx.vars from platform vars.
    const vars: Record<string, string | { key: string; proxyUrl: string; proxyToken: string }> = {};
    let connectionCount = 0;
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
        }
    }
    const varCount = platformVars.length - connectionCount;

    // 4. Apply overrides, warning on shadows.
    if (opts.varsOverride) {
        for (const [key, value] of Object.entries(opts.varsOverride)) {
            if (key in vars) {
                err(`override shadows platform var: ${key}`);
            }
            vars[key] = value;
        }
    }

    // 5. Print summary line.
    out(`Loaded ${varCount} vars + ${connectionCount} connections from ${apiClient.projectSlug} / env ${opts.env}`);

    // 6. Spin up SDK mock backend.
    // Require createMockServer from the SDK's testing subpath.
    // createRequire(__filename) works in CJS (the CLI target). In ESM this would
    // use import.meta.url, but tsconfig compiles to CommonJS so __filename is available.
    const _require = createRequire(__filename);
    // Resolve via the installed (or linked) @solidactions/sdk package.
    const sdkTestingMain = _require.resolve('@solidactions/sdk/testing');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { createMockServer } = _require(sdkTestingMain) as { createMockServer: (port?: number) => Promise<{ baseUrl: string; stop: () => Promise<void> }> };

    const mockServer = await createMockServer();

    try {
        // 7. Import the workflow entry file. Prefer the module's default export
        //    (a WorkflowDescriptor returned by defineWorkflow) so that repeated
        //    runDev() calls in the same test process don't need to clear and
        //    re-register from a cached module (cached CJS modules don't re-run
        //    their top-level code). If no default export, fall back to the registry.
        const entryPath = path.resolve(opts.entry);
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

        // 8. Build InvokeCtx.
        const runUuid = randomUUID();
        const ctx = {
            input: JSON.parse(opts.input || '{}'),
            vars: Object.freeze(vars),
            run: {
                triggerId: 'local-dev',
                runUuid,
                runSecret: 'local-dev',
                workerSessionId: randomUUID(),
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

        // 9. Invoke via internal SDK path (invoke() is not in the public index).
        const sdkMainForInvoke = _require.resolve('@solidactions/sdk');
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
}

export async function dev(file: string, options: DevOptions) {
    // Resolve the workflow file path
    const filePath = path.resolve(file);
    if (!fs.existsSync(filePath)) {
        console.error(chalk.red(`File not found: ${filePath}`));
        process.exit(1);
    }

    // Find the project root (directory containing package.json)
    const projectDir = findProjectRoot(filePath);
    if (!projectDir) {
        console.error(chalk.red('Could not find package.json in parent directories.'));
        process.exit(1);
    }

    // Check that @solidactions/sdk is installed
    const sdkPath = path.join(projectDir, 'node_modules', '@solidactions', 'sdk');
    if (!fs.existsSync(sdkPath)) {
        console.error(chalk.red('@solidactions/sdk is not installed in this project.'));
        console.log(chalk.gray('Run: npm install @solidactions/sdk'));
        process.exit(1);
    }

    // Check that the testing export exists
    const testingPath = path.join(sdkPath, 'dist', 'src', 'testing');
    if (!fs.existsSync(testingPath)) {
        console.error(chalk.red('@solidactions/sdk version does not include testing utilities.'));
        console.log(chalk.gray('Update to the latest SDK version: npm install @solidactions/sdk@latest'));
        process.exit(1);
    }

    // Load .env file from project root
    const envPath = path.join(projectDir, '.env');
    if (fs.existsSync(envPath)) {
        dotenv.config({ path: envPath });
        console.log(chalk.gray(`Loaded .env from ${projectDir}`));
    }

    // Validate input JSON if provided
    const input = options.input || '{}';
    try {
        JSON.parse(input);
    } catch {
        console.error(chalk.red('Invalid JSON input. Use -i \'{"key": "value"}\''));
        process.exit(1);
    }

    // Write temp bootstrap file
    const bootstrapPath = path.join(projectDir, '.solidactions-dev-bootstrap.mjs');
    const bootstrapContent = generateBootstrap(filePath, input);

    try {
        fs.writeFileSync(bootstrapPath, bootstrapContent);

        console.log(chalk.blue('SolidActions local dev mode'));
        console.log(chalk.gray(`File:  ${path.relative(projectDir, filePath)}`));
        console.log(chalk.gray(`Input: ${input}`));
        console.log(chalk.gray('---'));

        // Spawn npx tsx with the bootstrap file
        const child = spawn('npx', ['tsx', bootstrapPath], {
            stdio: 'inherit',
            cwd: projectDir,
        });

        child.on('error', (err) => {
            cleanup(bootstrapPath);
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                console.error(chalk.red('npx not found. Make sure Node.js is installed.'));
            } else {
                console.error(chalk.red(`Failed to start: ${err.message}`));
            }
            process.exit(1);
        });

        child.on('exit', (code) => {
            cleanup(bootstrapPath);
            process.exit(code ?? 1);
        });

        // Also clean up on signals
        process.on('SIGINT', () => {
            cleanup(bootstrapPath);
            child.kill('SIGINT');
        });
        process.on('SIGTERM', () => {
            cleanup(bootstrapPath);
            child.kill('SIGTERM');
        });

    } catch (err: any) {
        cleanup(bootstrapPath);
        console.error(chalk.red(`Failed: ${err.message}`));
        process.exit(1);
    }
}

function generateBootstrap(workflowFile: string, input: string): string {
    // Use forward slashes for the import path (works cross-platform in ESM)
    const importPath = workflowFile.replace(/\\/g, '/');

    return `// Auto-generated by solidactions dev - do not commit
import { createMockServer } from '@solidactions/sdk/testing';
import { SolidActions } from '@solidactions/sdk';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const server = await createMockServer();

process.env.SOLIDACTIONS_API_URL = server.baseUrl;
process.env.SOLIDACTIONS_API_KEY ??= 'local-dev';
process.env.SOLIDACTIONS_RUN_ID ??= randomUUID();
process.env.STEPS_TRIGGER_ID ??= 'local-dev';
process.env.SOLIDACTIONS__APPID ??= 'local-dev';
process.env.SOLIDACTIONS__APPVERSION ??= '0';
process.env.WORKFLOW_INPUT = ${JSON.stringify(input)};

// Import the workflow file — pure modules only populate the registry (no top-level run())
await import(${JSON.stringify(importPath)});

// Access the SDK-internal registry via createRequire (bypasses the exports map which
// intentionally does not re-export __getRegisteredWorkflows as a public API — but the
// bootstrap is a CLI-internal glue layer that IS allowed to use these internals).
// The require() resolution path: find the @solidactions/sdk package root by resolving
// the public entry point, then navigate to the registry sibling.
const _require = createRequire(import.meta.url);
const sdkMain = _require.resolve('@solidactions/sdk');
// sdkMain = .../node_modules/@solidactions/sdk/dist/src/index.js
// registry = .../node_modules/@solidactions/sdk/dist/src/invoke/registry.js
const registryPath = resolve(sdkMain, '..', 'invoke', 'registry.js');
const { __getRegisteredWorkflows, __getRegisteredWorkflow } = _require(registryPath);

// Select and run: mirror the SDK launcher's selectWorkflow logic
const all = __getRegisteredWorkflows();
let descriptor;
if (all.length === 1) {
  descriptor = all[0];
} else if (all.length === 0) {
  console.error('solidactions dev: no workflows registered after importing the file.');
  console.error('Make sure the file calls defineWorkflow(...) or SolidActions.registerWorkflow(...).');
  process.exit(1);
} else {
  // Multiple registrations: use WORKFLOW_ID env or fall back to first
  const workflowId = process.env.WORKFLOW_ID;
  const hit = workflowId ? __getRegisteredWorkflow(workflowId) : undefined;
  descriptor = hit ?? all[0];
  if (workflowId && !hit) {
    console.warn('solidactions dev: WORKFLOW_ID "' + workflowId + '" not found; running first registered workflow: ' + (all[0].name ?? '<unnamed>'));
  } else if (!workflowId && all.length > 1) {
    console.warn('solidactions dev: multiple workflows registered; running first: ' + (all[0].name ?? '<unnamed>') + '. Set WORKFLOW_ID env var to select a specific one.');
  }
}

// SolidActions.run() executes the workflow body via the one-shot invoke() engine
// and calls process.exit() when done.
await SolidActions.run(descriptor);
`;
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

function cleanup(filePath: string) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch {
        // Ignore cleanup errors
    }
}

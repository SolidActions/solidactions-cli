/**
 * F-C4 — flag & default consistency.
 *
 *  - Every environment flag is reachable as `-e, --env` (some commands only
 *    had the long `--environment` form).
 *  - `--environment` still parses as a hidden alias on `project logs` and
 *    `run list` (backward compat for existing scripts).
 *  - `schedule set` no longer registers a `-w` short flag for `--workflow`
 *    (it collided with the global `-w, --workspace` override).
 *  - `env delete` gains `-e, --env <environment>` (default: dev).
 *  - `login --workspace` is no longer swallowed by the global `-w` override
 *    (same class of bug: a subcommand option's long name collided with a
 *    parent option's long name, so commander routed the value to the parent
 *    instead — found live during the Task 10 smoke, not by the plan's
 *    original spec; the global flag's long form was renamed to
 *    `--workspace-override` to disambiguate, short form `-w` unaffected).
 *
 * Test-double policy: spawns the real built CLI binary (dist/index.js) as a
 * subprocess against a real in-process HTTP server (Node's http.createServer)
 * standing in for the SolidActions API — no mock/spy/stub libraries. Matches
 * the spawnSync-against-dist pattern in tests/dev.test.ts.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as childProcess from 'child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

interface CapturedRequest {
    method: string | undefined;
    url: string | undefined;
    body: string;
    headers: http.IncomingHttpHeaders;
}

let stubServer: http.Server;
let stubPort: number;
let lastCapture: CapturedRequest | null = null;
let allCaptures: CapturedRequest[] = [];

beforeAll(async () => {
    if (!fs.existsSync(CLI_BINARY)) {
        throw new Error(`CLI not built — run \`npm run build\` first (expected: ${CLI_BINARY})`);
    }

    stubServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            lastCapture = { method: req.method, url: req.url, body, headers: req.headers };
            allCaptures.push(lastCapture);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (req.url?.startsWith('/api/v1/projects/resolve/build-log') || req.url?.match(/\/build-log/)) {
                res.end(JSON.stringify({ build_log: 'log output' }));
            } else if (req.url?.match(/^\/api\/v1\/runs\/[^/]+$/)) {
                // Single-run status lookup (used by `run start --wait` polling).
                res.end(JSON.stringify({ status: 'completed' }));
            } else if (req.url?.startsWith('/api/v1/runs')) {
                res.end(JSON.stringify({ data: [] }));
            } else if (req.url?.includes('/schedules')) {
                res.end(JSON.stringify({ schedule: {} }));
            } else if (req.url?.includes('/variable-mappings')) {
                res.end(JSON.stringify([]));
            } else if (req.url?.includes('/api/v1/workspaces')) {
                res.end(JSON.stringify({ data: [{ id: 'ws-login-1', name: 'Login Target', slug: 'login-target' }] }));
            } else {
                res.end(JSON.stringify({}));
            }
        });
    });

    await new Promise<void>((resolve) => {
        stubServer.listen(0, '127.0.0.1', () => {
            stubPort = (stubServer.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => {
    return new Promise<void>((resolve, reject) => {
        stubServer.close((err) => (err ? reject(err) : resolve()));
    });
});

let tmpHomes: string[] = [];

afterEach(() => {
    for (const home of tmpHomes) fs.rmSync(path.dirname(home), { recursive: true, force: true });
    tmpHomes = [];
    allCaptures = [];
});

/** Fresh $HOME with a valid global config pointed at the stub server. */
function tmpHomeWithConfig(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-flag-test-'));
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    writeGlobal(home, { host: `http://127.0.0.1:${stubPort}`, apiKey: 'test-key', workspaceId: 'ws-1' });
    tmpHomes.push(home);
    return home;
}

interface CliResult {
    stdout: string;
    stderr: string;
    status: number | null;
}

/**
 * Spawn the built CLI as a real subprocess. Uses async `spawn` (not
 * `spawnSync`) — spawnSync blocks this process's event loop until the
 * child exits, which would prevent the in-process stub HTTP server (running
 * on this same event loop) from ever accepting the child's connection.
 */
function runCli(args: string[], home: string): Promise<CliResult> {
    return new Promise((resolve, reject) => {
        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], {
            env: { ...process.env, HOME: home },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`CLI timed out. stdout so far: ${stdout} stderr so far: ${stderr}`));
        }, 15_000);
        child.on('close', (status) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, status });
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

function runCliHelp(args: string[]): Promise<CliResult> {
    return runCli(args, os.homedir());
}

describe('flag consistency (F-C4)', () => {
    it('project logs: -e/--env parses and is sent as the resolve query param', async () => {
        const home = tmpHomeWithConfig();
        const result = await runCli(['project', 'logs', 'my-project', '--env', 'production'], home);

        expect(result.stderr).not.toMatch(/unknown option/);
        expect(lastCapture?.url).toContain('/api/v1/projects/resolve/build-log');
        expect(lastCapture?.url).toContain('environment=production');
        expect(result.status).toBe(0);
    });

    it('project logs: the hidden --environment alias still parses (backward compat)', async () => {
        const home = tmpHomeWithConfig();
        const result = await runCli(['project', 'logs', 'my-project', '--environment', 'staging'], home);

        expect(result.stderr).not.toMatch(/unknown option/);
        expect(lastCapture?.url).toContain('environment=staging');
        expect(result.status).toBe(0);
    });

    it('run list: -e/--env parses', async () => {
        const home = tmpHomeWithConfig();
        const result = await runCli(['run', 'list', '--env', 'dev'], home);

        expect(result.stderr).not.toMatch(/unknown option/);
        expect(lastCapture?.url).toContain('environment=dev');
        expect(result.status).toBe(0);
    });

    it('run list: the hidden --environment alias still parses (backward compat)', async () => {
        const home = tmpHomeWithConfig();
        const result = await runCli(['run', 'list', '--environment', 'dev'], home);

        expect(result.stderr).not.toMatch(/unknown option/);
        expect(lastCapture?.url).toContain('environment=dev');
        expect(result.status).toBe(0);
    });

    // This is the MUTATION GUARDIAN for FIX 2: restore `-w, --wait` on the
    // run-start command and THIS test fails (verified by mutation). The two
    // behavioral tests below cannot catch that mutation on their own — see the
    // note on the `-w <value>` test for why the value-bearing path is identical
    // under both spellings.
    it('run start: --help lists no -w short flag for --wait (freed up for the global -w/--workspace-override)', async () => {
        const result = await runCliHelp(['run', 'start', '--help']);
        expect(result.stdout).not.toMatch(/-w,\s*--wait/);
        expect(result.stdout).toMatch(/--wait/);
    });

    it('project deploy: --no-git-metadata help accurately describes remote repository provenance', async () => {
        const result = await runCliHelp(['project', 'deploy', '--help']);

        expect(result.stdout).toMatch(/sanitized remote repository (?:URL|identity)/i);
        expect(result.stdout).toMatch(/credentials (?:are )?stripped/i);
        expect(result.stdout).not.toMatch(/remote hostname\)/i);
    });

    it('run start: --wait (long form) waits for completion and reports success', async () => {
        const home = tmpHomeWithConfig();
        const result = await runCli(['run', 'start', 'my-project', 'my-workflow', '--wait'], home);

        expect(result.stderr).not.toMatch(/unknown option/);
        expect(result.stdout).toContain('Workflow completed successfully!');
        expect(result.status).toBe(0);
    });

    it('run start: -w <value> routes to the global workspace-override (resolves the workspace, does NOT engage --wait)', async () => {
        // Locks in the end-to-end behavior of the value-bearing form: `-w
        // login-target` resolves to ws-login-1 (via GET /api/v1/workspaces) and
        // stamps it on the trigger request, and does NOT wait.
        //
        // NOTE: this is NOT the mutation guardian for FIX 2 — mutation-testing
        // showed the value-bearing `-w <value>` path behaves IDENTICALLY under
        // both `--wait` (fixed) and `-w, --wait` (old): commander's global
        // `-w, --workspace-override <value>` always shadows the subcommand's
        // boolean `-w`, so `-w login-target` routes to the override and never
        // engages wait in either build. The `--help` test above is what pins
        // the short-flag removal. This test guards the global-override
        // integration path against unrelated regressions.
        const home = tmpHomeWithConfig();
        const result = await runCli(['run', 'start', 'my-project', 'my-workflow', '-w', 'login-target'], home);

        expect(result.stderr).not.toMatch(/unknown option/);
        expect(result.stderr).not.toMatch(/argument missing/);
        expect(result.status).toBe(0);

        // --wait must NOT have engaged.
        expect(result.stdout).not.toMatch(/Waiting for completion/);

        // The trigger request must carry the RESOLVED override workspace, not the default.
        const trigger = allCaptures.find((c) => c.method === 'POST' && /\/workflows\/.+\/trigger$/.test(c.url ?? ''));
        expect(trigger).toBeDefined();
        expect(trigger?.headers['x-workspace-id']).toBe('ws-login-1');
    });

    it('schedule set: --help lists no -w short flag (freed up for the global -w/--workspace override)', async () => {
        const result = await runCliHelp(['schedule', 'set', '--help']);
        expect(result.stdout).not.toMatch(/-w,\s*--workflow/);
        expect(result.stdout).toMatch(/--workflow <name>/);
    });

    it('schedule set: --workflow (long form) sets the workflow name', async () => {
        const home = tmpHomeWithConfig();
        const result = await runCli(['schedule', 'set', 'my-project', '0 9 * * *', '--workflow', 'my-flow', '--yes'], home);

        expect(result.stderr).not.toMatch(/unknown option/);
        expect(result.stdout).toContain('Workflow: my-flow');
        expect(result.status).toBe(0);
    });

    it('env delete: -e/--env is accepted and scopes the request to the environment slug (default: dev)', async () => {
        const home = tmpHomeWithConfig();
        const result = await runCli(['env', 'delete', 'my-project', 'MY_KEY', '--env', 'staging'], home);

        expect(result.stderr).not.toMatch(/unknown option/);
        expect(lastCapture?.url).toContain('/api/v1/projects/my-project-staging/variable-mappings');
    });

    it('env delete: defaults to dev when -e/--env is omitted', async () => {
        const home = tmpHomeWithConfig();
        await runCli(['env', 'delete', 'my-project', 'MY_KEY'], home);

        expect(lastCapture?.url).toContain('/api/v1/projects/my-project-dev/variable-mappings');
    });

    it('login --workspace is NOT swallowed by the global -w/--workspace-override flag (found live during Task 10 smoke)', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-flag-login-test-'));
        const home = path.join(root, 'home');
        fs.mkdirSync(home, { recursive: true });
        tmpHomes.push(home);

        const result = await runCli(
            ['login', 'some-token', '--global', '--host', `http://127.0.0.1:${stubPort}`, '--workspace', 'Login Target'],
            home,
        );

        expect(result.stderr).not.toMatch(/unknown option/);
        expect(result.status).toBe(0);

        const config = JSON.parse(fs.readFileSync(path.join(home, '.solidactions', 'config.json'), 'utf8'));
        expect(config.workspaceId).toBe('ws-login-1');
    });
});

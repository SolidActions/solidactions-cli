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
}

let stubServer: http.Server;
let stubPort: number;
let lastCapture: CapturedRequest | null = null;

beforeAll(async () => {
    if (!fs.existsSync(CLI_BINARY)) {
        throw new Error(`CLI not built — run \`npm run build\` first (expected: ${CLI_BINARY})`);
    }

    stubServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            lastCapture = { method: req.method, url: req.url, body };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (req.url?.startsWith('/api/v1/projects/resolve/build-log') || req.url?.match(/\/build-log/)) {
                res.end(JSON.stringify({ build_log: 'log output' }));
            } else if (req.url?.startsWith('/api/v1/runs')) {
                res.end(JSON.stringify({ data: [] }));
            } else if (req.url?.includes('/schedules')) {
                res.end(JSON.stringify({ schedule: {} }));
            } else if (req.url?.includes('/variable-mappings')) {
                res.end(JSON.stringify([]));
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
});

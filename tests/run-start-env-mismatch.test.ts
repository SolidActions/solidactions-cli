/**
 * Cleanroom-agent finding: a project deployed to `production` only, then
 * `run start <proj> <wf>` (no -e, defaults to `dev`) printed a bare
 * "Project or workflow not found." — misleading, since the project DOES
 * exist, just not in `dev`. The 404 branch now claims a missing environment
 * only when the project family genuinely lacks it, and otherwise prints the
 * server's own message.
 *
 * Test-double policy: real in-process HTTP server (Node's http.createServer)
 * stubbing the trigger endpoint (404) and GET /api/v1/projects (the family
 * lookup), the real built CLI spawned against it, a real temp HOME.
 * No mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as http from 'http';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpEnv, writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

let server: http.Server;
let port: number;
let requests: Array<{ method: string; path: string }> = [];

beforeAll(async () => {
    server = http.createServer((req, res) => {
        requests.push({ method: req.method || '', path: req.url || '' });

        if (req.method === 'POST' && req.url?.match(/\/api\/v1\/projects\/.+\/workflows\/.+\/trigger/)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'Not found.' }));
            return;
        }
        if (req.method === 'GET' && req.url === '/api/v1/projects') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [{ name: 'myproject', slug: 'myproject', environments: ['production'] }] }));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: `unhandled ${req.method} ${req.url}` }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => {
        port = (server.address() as any).port;
        resolve();
    }));
});

afterAll(() => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))));

beforeEach(() => { requests = []; });

interface CliResult {
    stdout: string;
    stderr: string;
    status: number | null;
}

function runCli(args: string[], home: string, cwd: string): Promise<CliResult> {
    return new Promise((resolve, reject) => {
        const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home };
        delete childEnv.SOLIDACTIONS_HOST;
        delete childEnv.SOLIDACTIONS_API_KEY;
        delete childEnv.SOLIDACTIONS_WORKSPACE_ID;

        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], { cwd, env: childEnv });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });

        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`CLI timed out. stdout: ${stdout} stderr: ${stderr}`));
        }, 15_000);

        child.on('close', (status) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, status });
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

describe('run start — env-mismatch not-found (cleanroom finding)', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'sk_test', workspaceId: 'ws-1' });
    });
    afterEach(() => env.cleanup());

    it('names the existing environments instead of a bare "not found" when the project exists only in a different environment', async () => {
        // No -e passed → defaults to dev, but the project only exists in production.
        const result = await runCli(['run', 'start', 'myproject', 'my-workflow'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('exists in: production');
        expect(result.stderr).toContain('myproject');
    });

    it('prints the server message (never a missing-environment hint) when the family lookup finds no such project', async () => {
        const result = await runCli(['run', 'start', 'no-such-project', 'my-workflow'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Failed: 404 Not found.');
        expect(result.stderr).not.toMatch(/has no .* environment/);
    });
});

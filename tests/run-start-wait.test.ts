/**
 * Spawned tests for `run start --wait` terminal statuses (cli#99): every
 * terminal status stops the poll with its own message and exit code.
 *
 * Same pattern as tests/connection-list.test.ts: a real in-process HTTP
 * server, a real temp HOME, the real built CLI, async spawn (the CLI polls
 * while the test process hosts the server). No mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

let server: http.Server;
let port: number;
let runBody: object = { status: 'completed' };
let triggerPaths: string[] = [];

beforeAll(async () => {
    server = http.createServer((request, response) => {
        if (request.method === 'POST') {
            triggerPaths.push(request.url ?? '');
            response.writeHead(202, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ deferred: true, run: { id: 77 } }));
        } else {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(runBody));
        }
    });

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => {
    return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
});

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

        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], {
            cwd,
            env: childEnv,
        });
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
        }, 20_000);

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

describe('run start --wait terminal statuses (cli#99)', () => {
    let root: string;
    let home: string;
    let cwd: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-run-start-wait-'));
        home = path.join(root, 'home');
        cwd = path.join(root, 'work');
        fs.mkdirSync(home, { recursive: true });
        fs.mkdirSync(cwd, { recursive: true });
        writeGlobal(home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            workspaceId: 'workspace-1',
        });
        runBody = { status: 'completed' };
        triggerPaths = [];
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('a cancelled run stops the poll with exit 1, not the timeout line', async () => {
        runBody = { status: 'cancelled' };

        const result = await runCli(['run', 'start', 'my-app', 'hello', '-e', 'production', '--wait'], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Workflow was cancelled.');
        expect(result.stdout + result.stderr).not.toContain('It may still be running');
    });

    it('a failed run with an admission reason explains why it never started', async () => {
        runBody = { status: 'failed', admission_denied_reason: 'ttl_expired', error: null };

        const result = await runCli(['run', 'start', 'my-app', 'hello', '-e', 'production', '--wait'], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Run never started: it waited for a free run slot longer than its time limit');
    });

    it('a completed run exits 0 with the success line', async () => {
        runBody = { status: 'completed' };

        const result = await runCli(['run', 'start', 'my-app', 'hello', '-e', 'production', '--wait'], home, cwd);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Workflow completed successfully!');
        expect(triggerPaths).toHaveLength(1);
        expect(triggerPaths[0]).toBe('/api/v1/projects/my-app/workflows/hello/trigger');
    });
});

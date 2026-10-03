/**
 * `workspace list` with a rejected key (cli#156): the failure names the host
 * that refused it, the way every other command's 401 does, and never prints the
 * host's userinfo. A real in-process HTTP server, a real temp HOME, the real
 * built CLI; no mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as http from 'http';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpEnv, writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

let respondWith = { status: 401, body: { message: 'Unauthenticated.' } as unknown };
let server: http.Server;
let port: number;

beforeAll(async () => {
    server = http.createServer((request, response) => {
        request.resume();
        response.writeHead(respondWith.status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(respondWith.body));
    });
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
}));

interface CliResult {
    stdout: string;
    stderr: string;
    status: number | null;
}

function runCli(args: string[], home: string, cwd: string): Promise<CliResult> {
    return new Promise((resolve, reject) => {
        const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1' };
        delete childEnv.SOLIDACTIONS_HOST;
        delete childEnv.SOLIDACTIONS_API_KEY;
        delete childEnv.SOLIDACTIONS_WORKSPACE_ID;

        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], { cwd, env: childEnv });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });

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

function failureLines(stderr: string): string[] {
    return stderr
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.includes('AGENT NOTE') && !line.startsWith('Workspace:'));
}

describe('workspace list failures', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();
    });
    afterEach(() => env.cleanup());

    it('a 401 prints the host line without userinfo and exits 1', async () => {
        respondWith = { status: 401, body: { message: 'Unauthenticated.' } };
        writeGlobal(env.home, { host: `http://user:secret@127.0.0.1:${port}`, apiKey: 'test-key' });

        const result = await runCli(['workspace', 'list'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(failureLines(result.stderr)).toEqual([
            `Authentication failed against http://127.0.0.1:${port}. Run "solidactions login --global" to re-configure.`,
        ]);
        expect(result.stderr).not.toContain('secret');
        expect(result.stdout).not.toContain('Your workspaces');
    });

    it('another HTTP failure prints the one-line "Failed: <status> <message>" and exits 1', async () => {
        respondWith = { status: 500, body: { message: 'Workspace directory unavailable.' } };
        writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'test-key' });

        const result = await runCli(['workspace', 'list'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(failureLines(result.stderr)).toEqual(['Failed: 500 Workspace directory unavailable.']);
    });

    it('a connection failure keeps a one-line "Connection failed: <reason>" and exits 1', async () => {
        writeGlobal(env.home, { host: 'http://127.0.0.1:1', apiKey: 'test-key' });

        const result = await runCli(['workspace', 'list'], env.home, env.cwd);

        expect(result.status).toBe(1);
        const lines = failureLines(result.stderr);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^Connection failed: /);
    });
});

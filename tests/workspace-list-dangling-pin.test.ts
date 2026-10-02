/**
 * `solidactions workspace list` calls out a pinned workspace the server's list
 * does not contain (cli#113): no "← current" on any row, and a closing warning
 * naming the pin, where it came from and how to fix it.
 *
 * A real in-process HTTP server, a real temp HOME, the real built CLI. No
 * mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as http from 'http';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpEnv, writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

const WORKSPACES_PAYLOAD = {
    workspaces: {
        t1: [{ id: 'ws-1', slug: 'acme-north-ws', name: 'Main', role: 'admin', tenant_name: 'Acme' }],
    },
};

let server: http.Server;
let port: number;

beforeAll(async () => {
    server = http.createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(WORKSPACES_PAYLOAD));
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

describe('solidactions workspace list with a pin the list does not contain', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();
    });
    afterEach(() => env.cleanup());

    const baseConfig = () => ({ host: `http://127.0.0.1:${port}`, apiKey: 'sk_test_dangling_pin' });

    it('lists the real workspaces, marks none current and ends with a warning naming the pin, its config file and the fix', async () => {
        const globalPath = writeGlobal(env.home, { ...baseConfig(), workspace: 'gone-ws', workspaceId: 'ws-9' });

        const result = await runCli(['workspace', 'list'], env.home, env.cwd);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Main');
        expect(result.stdout).not.toContain('← current');
        const warning = result.stdout.slice(result.stdout.indexOf('warn:'));
        expect(warning).toContain('gone-ws');
        expect(warning).toContain('ws-9');
        expect(warning).toContain(globalPath);
        expect(warning).toContain('workspace set');
        expect(result.stdout.trimEnd().endsWith('(or --global).')).toBe(true);
    });

    it('marks the pinned workspace current and prints no warning when the pin is in the list', async () => {
        writeGlobal(env.home, { ...baseConfig(), workspace: 'acme-north-ws', workspaceId: 'ws-1' });

        const result = await runCli(['workspace', 'list'], env.home, env.cwd);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('← current');
        expect(result.stdout).not.toContain('warn:');
    });

    it('prints no warning when nothing is pinned', async () => {
        writeGlobal(env.home, baseConfig());

        const result = await runCli(['workspace', 'list'], env.home, env.cwd);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Main');
        expect(result.stdout).not.toContain('← current');
        expect(result.stdout).not.toContain('warn:');
    });
});

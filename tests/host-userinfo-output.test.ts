/**
 * A host configured with userinfo (`http://user:pass@host`) must never reach the
 * terminal (cli#163): `whoami`, the mutation banner and the SOLIDACTIONS_DEBUG
 * dump each printed it raw. A real in-process HTTP server, a real temp HOME, the
 * real built CLI; no mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as http from 'http';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpEnv, writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

let server: http.Server;
let port: number;

beforeAll(async () => {
    server = http.createServer((request, response) => {
        request.resume();
        response.writeHead(200, { 'Content-Type': 'application/json' });
        if (request.method === 'GET' && request.url === '/api/v1/workspaces') {
            response.end(JSON.stringify({
                workspaces: { Org: [{ id: 'ws-1', slug: 'ws-1', name: 'WS', tenant_name: 'Org' }] },
                scope: null,
            }));
        } else if (request.method === 'GET' && /^\/api\/v1\/projects\/[^/]+$/.test(request.url ?? '')) {
            response.end(JSON.stringify({ slug: 'foo' }));
        } else {
            response.end(JSON.stringify({}));
        }
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

function runCli(
    args: string[],
    home: string,
    cwd: string,
    extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
    return new Promise((resolve, reject) => {
        const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1' };
        delete childEnv.SOLIDACTIONS_HOST;
        delete childEnv.SOLIDACTIONS_API_KEY;
        delete childEnv.SOLIDACTIONS_WORKSPACE_ID;
        Object.assign(childEnv, extraEnv);

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

describe('a host with userinfo never reaches the terminal (cli#163)', () => {
    let env: ReturnType<typeof makeTmpEnv>;
    const shownHost = () => `http://127.0.0.1:${port}`;

    beforeEach(() => {
        env = makeTmpEnv();
        writeGlobal(env.home, {
            host: `http://someuser:somepass@127.0.0.1:${port}`,
            apiKey: 'test-key-0123456789',
            workspaceId: 'ws-1',
            workspace: 'ws-1',
            workspaceOrg: 'Org',
        });
    });
    afterEach(() => env.cleanup());

    it('whoami refuses a host with userinfo', async () => {
        const result = await runCli(['whoami'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`error: the host "${shownHost()}"`);
        expect(result.stderr).toContain('contains a username/password');
        expect(result.stdout + result.stderr).not.toContain('somepass');
        expect(result.stdout + result.stderr).not.toContain('someuser');
    });

    it('the mutation path refuses a host with userinfo', async () => {
        const result = await runCli(
            ['env', 'set', 'foo', 'K', 'v', '-e', 'production', '--yes'],
            env.home,
            env.cwd,
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`error: the host "${shownHost()}"`);
        expect(result.stderr).toContain('contains a username/password');
        expect(result.stdout + result.stderr).not.toContain('somepass');
        expect(result.stdout + result.stderr).not.toContain('someuser');
    });

    it('the SOLIDACTIONS_DEBUG dump shows the host without userinfo', async () => {
        const result = await runCli(['whoami'], env.home, env.cwd, { SOLIDACTIONS_DEBUG: '1' });

        expect(result.status).toBe(1);
        const debugLine = result.stderr.split('\n').find((line) => line.includes('host:')) ?? '';
        expect(debugLine).toContain(shownHost());
        expect(result.stdout + result.stderr).not.toContain('somepass');
        expect(result.stdout + result.stderr).not.toContain('someuser');
    });
});

describe('a malformed host with userinfo never reaches the terminal (cli#163)', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();
        writeGlobal(env.home, {
            host: 'http://someuser:somepass@localhost:invalid-port',
            apiKey: 'test-key-0123456789',
            workspaceId: 'ws-1',
            workspace: 'ws-1',
            workspaceOrg: 'Org',
        });
    });
    afterEach(() => env.cleanup());

    it('whoami refuses a malformed host with userinfo', async () => {
        const result = await runCli(['whoami'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('error: the host "http://localhost:invalid-port"');
        expect(result.stderr).toContain('contains a username/password');
        expect(result.stdout + result.stderr).not.toContain('somepass');
        expect(result.stdout + result.stderr).not.toContain('someuser');
    });

    it('the SOLIDACTIONS_DEBUG dump shows the host without userinfo', async () => {
        const result = await runCli(['whoami'], env.home, env.cwd, { SOLIDACTIONS_DEBUG: '1' });

        expect(result.status).toBe(1);
        const debugLine = result.stderr.split('\n').find((line) => line.includes('host:')) ?? '';
        expect(debugLine).toContain('http://localhost:invalid-port');
        expect(result.stdout + result.stderr).not.toContain('somepass');
        expect(result.stdout + result.stderr).not.toContain('someuser');
    });
});

/**
 * `login` honours SOLIDACTIONS_HOST and refuses a disagreeing --host (cli#170).
 *
 * A dev-stack token was once sent to the production cloud because `login`
 * ignored SOLIDACTIONS_HOST. These spawned-binary tests prove the fix: every
 * child env routes all non-local traffic through an in-process proxy that
 * records `request` AND `connect` events, so any attempt to reach the cloud
 * (or any other non-local host) is observable as a proxy hit.
 *
 * Real in-process HTTP servers, a real temp HOME, the real built CLI;
 * no mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpEnv } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

const WORKSPACES_BODY = {
    workspaces: {
        Org: [{ id: 'ws-1', slug: 'ws-1', name: 'WS', tenant_name: 'Org' }],
    },
    scope: null,
};

let api: http.Server;
let apiPort: number;
let apiRequests: string[];

let proxy: http.Server;
let proxyPort: number;
let proxyRequests: string[];
let proxyConnects: string[];

beforeAll(async () => {
    apiRequests = [];
    api = http.createServer((request, response) => {
        request.resume();
        apiRequests.push(`${request.method} ${request.url}`);
        if (request.method === 'GET' && request.url === '/api/v1/workspaces') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(WORKSPACES_BODY));
            return;
        }
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ message: 'Not found.' }));
    });
    await new Promise<void>((resolve) => {
        api.listen(0, '127.0.0.1', () => {
            apiPort = (api.address() as { port: number }).port;
            resolve();
        });
    });

    proxyRequests = [];
    proxyConnects = [];
    proxy = http.createServer((request, response) => {
        request.resume();
        proxyRequests.push(`${request.method} ${request.url}`);
        response.writeHead(502, { 'Content-Type': 'text/plain' });
        response.end('blocked by test proxy');
    });
    proxy.on('connect', (request: http.IncomingMessage, socket: net.Socket) => {
        proxyConnects.push(`CONNECT ${request.url}`);
        socket.write('HTTP/1.1 502 Blocked\r\n\r\n');
        socket.destroy();
    });
    await new Promise<void>((resolve) => {
        proxy.listen(0, '127.0.0.1', () => {
            proxyPort = (proxy.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => Promise.all([
    new Promise<void>((resolve, reject) => {
        api.close((error) => (error ? reject(error) : resolve()));
    }),
    new Promise<void>((resolve, reject) => {
        proxy.close((error) => (error ? reject(error) : resolve()));
    }),
]));

interface CliResult {
    stdout: string;
    stderr: string;
    status: number | null;
}

function runCli(
    args: string[],
    home: string,
    cwd: string,
    options: { extraEnv?: NodeJS.ProcessEnv; stdin?: string } = {},
): Promise<CliResult> {
    return new Promise((resolve, reject) => {
        const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1' };
        delete childEnv.SOLIDACTIONS_HOST;
        delete childEnv.SOLIDACTIONS_API_KEY;
        delete childEnv.SOLIDACTIONS_WORKSPACE_ID;
        const proxyUrl = `http://127.0.0.1:${proxyPort}`;
        childEnv.HTTPS_PROXY = proxyUrl;
        childEnv.https_proxy = proxyUrl;
        childEnv.HTTP_PROXY = proxyUrl;
        childEnv.http_proxy = proxyUrl;
        childEnv.NO_PROXY = '127.0.0.1,localhost';
        childEnv.no_proxy = '127.0.0.1,localhost';
        Object.assign(childEnv, options.extraEnv);

        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], { cwd, env: childEnv });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        if (options.stdin !== undefined && child.stdin) {
            child.stdin.write(options.stdin);
            child.stdin.end();
        }

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

function configPathFor(home: string): string {
    return path.join(home, '.solidactions', 'config.json');
}

function readConfigHost(home: string): string | undefined {
    const file = configPathFor(home);
    if (!fs.existsSync(file)) {
        return undefined;
    }
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { host?: string }).host;
}

const apiUrl = () => `http://127.0.0.1:${apiPort}`;

describe('login honours SOLIDACTIONS_HOST (cli#170)', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();
        apiRequests = [];
        proxyRequests = [];
        proxyConnects = [];
    });
    afterEach(() => env.cleanup());

    it('uses SOLIDACTIONS_HOST for login without ever touching the proxy', async () => {
        const result = await runCli(['login', '--stdin', '--global'], env.home, env.cwd, {
            extraEnv: { SOLIDACTIONS_HOST: apiUrl() },
            stdin: 'sk-test',
        });

        expect(result.status).toBe(0);
        expect(proxyRequests).toEqual([]);
        expect(proxyConnects).toEqual([]);
        expect(apiRequests).toContain('GET /api/v1/workspaces');
        expect(result.stdout).toContain(`Host: ${apiUrl()}`);
        expect(readConfigHost(env.home)).toBe(apiUrl());
    });

    it('refuses a --host that disagrees with SOLIDACTIONS_HOST before any request', async () => {
        const result = await runCli(
            ['login', '--stdin', '--global', '--host', 'https://other.example'],
            env.home,
            env.cwd,
            { extraEnv: { SOLIDACTIONS_HOST: apiUrl() }, stdin: 'sk-test' },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('https://other.example');
        expect(result.stderr).toContain(`SOLIDACTIONS_HOST=${apiUrl()}`);
        expect(proxyRequests).toEqual([]);
        expect(proxyConnects).toEqual([]);
        expect(apiRequests).toEqual([]);
        expect(fs.existsSync(configPathFor(env.home))).toBe(false);
    });

    it('treats a trailing-slash difference as the same host', async () => {
        const result = await runCli(
            ['login', '--stdin', '--global', '--host', apiUrl()],
            env.home,
            env.cwd,
            { extraEnv: { SOLIDACTIONS_HOST: `${apiUrl()}/` }, stdin: 'sk-test' },
        );

        expect(result.status).toBe(0);
        expect(proxyRequests).toEqual([]);
        expect(proxyConnects).toEqual([]);
        expect(readConfigHost(env.home)).toBe(apiUrl());
    });

    it('strips the trailing slash from a bare SOLIDACTIONS_HOST', async () => {
        const result = await runCli(['login', '--stdin', '--global'], env.home, env.cwd, {
            extraEnv: { SOLIDACTIONS_HOST: `${apiUrl()}/` },
            stdin: 'sk-test',
        });

        expect(result.status).toBe(0);
        expect(apiRequests.length).toBeGreaterThan(0);
        for (const seen of apiRequests) {
            expect(seen).toBe('GET /api/v1/workspaces');
        }
        expect(proxyRequests).toEqual([]);
        expect(proxyConnects).toEqual([]);
        expect(readConfigHost(env.home)).toBe(apiUrl());
    });

    it('compares ports literally (cli#124)', async () => {
        const result = await runCli(
            ['login', '--stdin', '--global', '--host', 'https://example.com:443'],
            env.home,
            env.cwd,
            { extraEnv: { SOLIDACTIONS_HOST: 'https://example.com' }, stdin: 'sk-test' },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('disagrees');
        expect(proxyRequests).toEqual([]);
        expect(proxyConnects).toEqual([]);
        expect(apiRequests).toEqual([]);
        expect(fs.existsSync(configPathFor(env.home))).toBe(false);
    });

    it('refuses --dev when SOLIDACTIONS_HOST is set', async () => {
        const result = await runCli(['login', '--stdin', '--global', '--dev'], env.home, env.cwd, {
            extraEnv: { SOLIDACTIONS_HOST: apiUrl() },
            stdin: 'sk-test',
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('--dev (http://localhost:8000)');
        expect(proxyRequests).toEqual([]);
        expect(proxyConnects).toEqual([]);
        expect(apiRequests).toEqual([]);
        expect(fs.existsSync(configPathFor(env.home))).toBe(false);
    });

    it('refuses a disagreeing --host for login --device before any request', async () => {
        const result = await runCli(
            ['login', '--device', '--global', '--host', 'https://other.example'],
            env.home,
            env.cwd,
            { extraEnv: { SOLIDACTIONS_HOST: apiUrl() } },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('https://other.example');
        expect(result.stderr).toContain(`SOLIDACTIONS_HOST=${apiUrl()}`);
        expect(proxyRequests).toEqual([]);
        expect(proxyConnects).toEqual([]);
        expect(apiRequests).toEqual([]);
        expect(fs.existsSync(configPathFor(env.home))).toBe(false);
    });

    it('rejects SOLIDACTIONS_HOST="/" as not a usable host (ruling 9)', async () => {
        const result = await runCli(['login', '--stdin', '--global'], env.home, env.cwd, {
            extraEnv: { SOLIDACTIONS_HOST: '/' },
            stdin: 'sk-test',
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('SOLIDACTIONS_HOST="/"');
        expect(result.stderr).toContain('not a usable host');
        expect(proxyRequests).toEqual([]);
        expect(proxyConnects).toEqual([]);
        expect(apiRequests).toEqual([]);
        expect(fs.existsSync(configPathFor(env.home))).toBe(false);
    });

    it('rejects SOLIDACTIONS_HOST="///" as not a usable host (ruling 9)', async () => {
        const result = await runCli(['login', '--stdin', '--global'], env.home, env.cwd, {
            extraEnv: { SOLIDACTIONS_HOST: '///' },
            stdin: 'sk-test',
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('SOLIDACTIONS_HOST="///"');
        expect(result.stderr).toContain('not a usable host');
        expect(proxyRequests).toEqual([]);
        expect(proxyConnects).toEqual([]);
        expect(apiRequests).toEqual([]);
        expect(fs.existsSync(configPathFor(env.home))).toBe(false);
    });

    it('rejects --host / with no env set (ruling 9)', async () => {
        const result = await runCli(
            ['login', '--stdin', '--global', '--host', '/'],
            env.home,
            env.cwd,
            { stdin: 'sk-test' },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('--host');
        expect(result.stderr).toContain('not a usable host');
        expect(proxyRequests).toEqual([]);
        expect(proxyConnects).toEqual([]);
        expect(apiRequests).toEqual([]);
        expect(fs.existsSync(configPathFor(env.home))).toBe(false);
    });

    it('rejects SOLIDACTIONS_HOST="/" for login --device (ruling 9)', async () => {
        const result = await runCli(['login', '--device', '--global'], env.home, env.cwd, {
            extraEnv: { SOLIDACTIONS_HOST: '/' },
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('SOLIDACTIONS_HOST="/"');
        expect(result.stderr).toContain('not a usable host');
        expect(proxyRequests).toEqual([]);
        expect(proxyConnects).toEqual([]);
        expect(apiRequests).toEqual([]);
        expect(fs.existsSync(configPathFor(env.home))).toBe(false);
    });
});


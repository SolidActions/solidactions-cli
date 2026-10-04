/**
 * cli#195: a host with userinfo (`user:pass@`) is refused with one clear
 * line — config resolution, `whoami` and `login` all refuse before any
 * request or config write, and the username/password values never reach
 * the terminal. Spawned-binary tests plus pure `hostHasUserinfo` cases.
 *
 * A real in-process HTTP server, real temp HOME configs, the real built
 * CLI; no mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hostHasUserinfo } from '../src/utils/host-display';
import { makeTmpEnv, writeGlobal, writeLocal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

const UNAME = 'uname-SECRET';
const PASSWORD = 'pw-SECRET';

let server: http.Server;
let port: number;
let requests: string[];

const WORKSPACES_BODY = {
    workspaces: {
        Org: [{ id: 'ws-1', slug: 'ws-1', name: 'WS', tenant_name: 'Org' }],
    },
    scope: null,
};

beforeAll(async () => {
    requests = [];
    server = http.createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
            requests.push(`${request.method} ${request.url}`);
            const json = (status: number, payload: unknown) => {
                response.writeHead(status, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(payload));
            };
            if (request.method === 'POST' && request.url === '/mcp') {
                json(200, {
                    jsonrpc: '2.0',
                    id: 1,
                    result: { isError: false, content: [{ type: 'text', text: '{"folders":[],"docs":[]}' }] },
                });
                return;
            }
            if (request.method === 'GET' && request.url === '/api/v1/projects') {
                json(200, { data: [] });
                return;
            }
            if (request.method === 'GET' && request.url === '/api/v1/workspaces') {
                json(200, WORKSPACES_BODY);
                return;
            }
            json(404, { message: 'Not found.' });
        });
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
    options: { extraEnv?: NodeJS.ProcessEnv; stdin?: string } = {},
): Promise<CliResult> {
    return new Promise((resolve, reject) => {
        const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1' };
        delete childEnv.SOLIDACTIONS_HOST;
        delete childEnv.SOLIDACTIONS_API_KEY;
        delete childEnv.SOLIDACTIONS_WORKSPACE_ID;
        delete childEnv.DEBUG;
        delete childEnv.NODE_DEBUG;
        delete childEnv.FORCE_COLOR;
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

function globalConfigPath(home: string): string {
    return path.join(home, '.solidactions', 'config.json');
}

describe('hostHasUserinfo', () => {
    it.each([
        'http://127.0.0.1:8002',
        'http://localhost:8000',
        'https://app.solidactions.com',
        'localhost:8000',
        'http://h/path@x',
    ])('returns false for %s', (host) => {
        expect(hostHasUserinfo(host)).toBe(false);
    });

    it.each([
        'http://u:p@h',
        'http://u@h',
        'http://u:p@h:bad-port',
        'u:secret@host',
    ])('returns true for %s', (host) => {
        expect(hostHasUserinfo(host)).toBe(true);
    });
});

describe('a host with userinfo is refused (cli#195)', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    const userinfoHost = () => `http://${UNAME}:${PASSWORD}@127.0.0.1:${port}`;
    const shownHost = () => `http://127.0.0.1:${port}`;
    const globalPath = () => globalConfigPath(env.home);

    const writeUserinfoGlobal = () => {
        writeGlobal(env.home, { host: userinfoHost(), apiKey: 'sk-test-x', workspaceId: 'ws-1', workspace: 'ws-1' });
    };

    const expectNoSecrets = (result: CliResult) => {
        expect(result.stdout).not.toContain(PASSWORD);
        expect(result.stderr).not.toContain(PASSWORD);
        expect(result.stdout).not.toContain(UNAME);
        expect(result.stderr).not.toContain(UNAME);
    };

    beforeEach(() => {
        env = makeTmpEnv();
        requests = [];
    });
    afterEach(() => env.cleanup());

    it('refuses a global-config userinfo host for project list before any request', async () => {
        writeUserinfoGlobal();

        const result = await runCli(['project', 'list'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            `error: the host "${shownHost()}" (from ${globalPath()}) contains a username/password; remove "user:pass@" — the CLI authenticates with your API key.`,
        );
        expectNoSecrets(result);
        expect(requests).toEqual([]);
    });

    it('refuses a global-config userinfo host for doc pull without creating the destination', async () => {
        writeUserinfoGlobal();
        const out = path.join(env.cwd, 'out');

        const result = await runCli(['doc', 'pull', 'Some/Folder', out], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            `error: the host "${shownHost()}" (from ${globalPath()}) contains a username/password; remove "user:pass@" — the CLI authenticates with your API key.`,
        );
        expectNoSecrets(result);
        expect(requests).toEqual([]);
        expect(fs.existsSync(out)).toBe(false);
    });

    it('refuses a global-config userinfo host for whoami', async () => {
        writeUserinfoGlobal();

        const result = await runCli(['whoami'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            `error: the host "${shownHost()}" (from ${globalPath()}) contains a username/password; remove "user:pass@" — the CLI authenticates with your API key.`,
        );
        expectNoSecrets(result);
        expect(requests).toEqual([]);
    });

    it('names the project-local config file as the source', async () => {
        writeGlobal(env.home, { host: shownHost(), apiKey: 'sk-test-x', workspaceId: 'ws-1', workspace: 'ws-1' });
        const localFile = writeLocal(env.cwd, { host: userinfoHost(), apiKey: 'sk-test-x', workspaceId: 'ws-1' });

        const result = await runCli(['project', 'list'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            `error: the host "${shownHost()}" (from ${localFile}) contains a username/password; remove "user:pass@" — the CLI authenticates with your API key.`,
        );
        expectNoSecrets(result);
        expect(requests).toEqual([]);
    });

    it('names $SOLIDACTIONS_HOST as the source for an env host', async () => {
        const result = await runCli(['project', 'list'], env.home, env.cwd, {
            extraEnv: {
                SOLIDACTIONS_HOST: userinfoHost(),
                SOLIDACTIONS_API_KEY: 'sk-test-x',
                SOLIDACTIONS_WORKSPACE_ID: 'ws-1',
            },
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            `error: the host "${shownHost()}" (from $SOLIDACTIONS_HOST) contains a username/password; remove "user:pass@" — the CLI authenticates with your API key.`,
        );
        expectNoSecrets(result);
        expect(requests).toEqual([]);
    });

    it('refuses a username-only host', async () => {
        writeGlobal(env.home, { host: `http://${UNAME}@127.0.0.1:${port}`, apiKey: 'sk-test-x', workspaceId: 'ws-1' });

        const result = await runCli(['project', 'list'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('contains a username/password');
        expectNoSecrets(result);
        expect(requests).toEqual([]);
    });

    it('login --host refuses userinfo without writing config', async () => {
        const result = await runCli(
            ['login', '--stdin', '--global', '--host', userinfoHost()],
            env.home,
            env.cwd,
            { stdin: 'sk-test-x' },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            `error: --host "${shownHost()}" contains a username/password; remove "user:pass@" — the CLI authenticates with your API key.`,
        );
        expectNoSecrets(result);
        expect(requests).toEqual([]);
        expect(fs.existsSync(globalPath())).toBe(false);
    });

    it('login refuses a SOLIDACTIONS_HOST with userinfo without writing config', async () => {
        const result = await runCli(['login', '--stdin', '--global'], env.home, env.cwd, {
            extraEnv: { SOLIDACTIONS_HOST: userinfoHost() },
            stdin: 'sk-test-x',
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            `error: SOLIDACTIONS_HOST "${shownHost()}" contains a username/password; remove "user:pass@" — the CLI authenticates with your API key.`,
        );
        expectNoSecrets(result);
        expect(requests).toEqual([]);
        expect(fs.existsSync(globalPath())).toBe(false);
    });

    it('login refuses env userinfo before the --dev disagreement', async () => {
        const result = await runCli(['login', '--stdin', '--global', '--dev'], env.home, env.cwd, {
            extraEnv: { SOLIDACTIONS_HOST: userinfoHost() },
            stdin: 'sk-test-x',
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            `error: SOLIDACTIONS_HOST "${shownHost()}" contains a username/password; remove "user:pass@" — the CLI authenticates with your API key.`,
        );
        expectNoSecrets(result);
        expect(requests).toEqual([]);
    });

    it('login --device refuses a SOLIDACTIONS_HOST with userinfo', async () => {
        const result = await runCli(['login', '--device', '--global'], env.home, env.cwd, {
            extraEnv: { SOLIDACTIONS_HOST: userinfoHost() },
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            `error: SOLIDACTIONS_HOST "${shownHost()}" contains a username/password; remove "user:pass@" — the CLI authenticates with your API key.`,
        );
        expectNoSecrets(result);
        expect(requests).toEqual([]);
    });

    it('control: a plain host runs project list normally', async () => {
        writeGlobal(env.home, { host: shownHost(), apiKey: 'sk-test-x', workspaceId: 'ws-1', workspace: 'ws-1' });

        const result = await runCli(['project', 'list'], env.home, env.cwd);

        expect(result.status).toBe(0);
        expect(requests).toContain('GET /api/v1/projects');
    });
});

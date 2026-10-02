/**
 * Spawned end-to-end tests for the cli#124 credential-pair rule.
 *
 * Two real in-process HTTP servers stand in for two hosts: `good` (the host
 * the global config names) and `wrong` (the host a folder config names). Each
 * records every request's URL and Authorization header. The real built CLI
 * (`dist/index.js`) runs with a temp HOME and a temp cwd. No mock/spy/stub
 * libraries. Never prints an API key: assertions check for the key's absence
 * and for the redacted bearer the server sees.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeGlobal, writeLocal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

interface RecordedRequest {
    url: string | undefined;
    authorization: string | string[] | undefined;
}

interface StubServer {
    server: http.Server;
    url: string;
    requests: RecordedRequest[];
    handler: (url: string | undefined) => { status: number; body: object };
}

function startStub(): Promise<StubServer> {
    const stub: StubServer = {
        server: null as unknown as http.Server,
        url: '',
        requests: [],
        handler: () => ({ status: 200, body: { data: [] } }),
    };
    stub.server = http.createServer((req, res) => {
        stub.requests.push({ url: req.url, authorization: req.headers.authorization });
        const { status, body } = stub.handler(req.url);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    });
    return new Promise((resolve) => {
        stub.server.listen(0, '127.0.0.1', () => {
            const port = (stub.server.address() as { port: number }).port;
            stub.url = `http://127.0.0.1:${port}`;
            resolve(stub);
        });
    });
}

interface CliResult {
    stdout: string;
    stderr: string;
    status: number | null;
}

function runCli(args: string[], home: string, cwd: string, extraEnv: Record<string, string> = {}): Promise<CliResult> {
    return new Promise((resolve, reject) => {
        const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home };
        delete childEnv.SOLIDACTIONS_HOST;
        delete childEnv.SOLIDACTIONS_API_KEY;
        delete childEnv.SOLIDACTIONS_WORKSPACE_ID;
        Object.assign(childEnv, extraEnv);

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

const GLOBAL_KEY = 'sk_global_secret';
const ENV_KEY = 'sk_env_secret';

function workspacesPayload(): object {
    return {
        workspaces: {
            Org: [{ id: 'ws-1', slug: 'ws-one', name: 'One', tenant_name: 'Org' }],
        },
    };
}

describe('credential pair end to end (cli#124)', () => {
    let good: StubServer;
    let wrong: StubServer;
    let root: string;
    let home: string;
    let cwd: string;

    beforeAll(async () => {
        good = await startStub();
        wrong = await startStub();
    });

    afterAll(async () => {
        await new Promise<void>((resolve, reject) => {
            good.server.close((e) => (e ? reject(e) : resolve()));
        });
        await new Promise<void>((resolve, reject) => {
            wrong.server.close((e) => (e ? reject(e) : resolve()));
        });
    });

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-cred-pair-'));
        home = path.join(root, 'home');
        cwd = path.join(root, 'work');
        fs.mkdirSync(home, { recursive: true });
        fs.mkdirSync(cwd, { recursive: true });
        good.requests.length = 0;
        wrong.requests.length = 0;
        good.handler = () => ({ status: 200, body: { data: [] } });
        wrong.handler = () => ({ status: 200, body: { data: [] } });
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('refuses a local host-only file instead of sending the global key there', async () => {
        writeGlobal(home, { host: good.url, apiKey: GLOBAL_KEY, workspaceId: 'ws-1' });
        writeLocal(cwd, { host: wrong.url });

        const result = await runCli(['connection', 'list'], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Refusing to send the API key');
        expect(result.stderr).toContain(wrong.url);
        expect(wrong.requests).toHaveLength(0);
        expect(result.stdout).not.toContain(GLOBAL_KEY);
        expect(result.stderr).not.toContain(GLOBAL_KEY);
    });

    it('whoami refuses on stderr without printing the key', async () => {
        writeGlobal(home, { host: good.url, apiKey: GLOBAL_KEY, workspaceId: 'ws-1' });
        writeLocal(cwd, { host: wrong.url });

        const result = await runCli(['whoami'], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Refusing to send the API key');
        expect(result.stdout).not.toContain('sk_global');
        expect(result.stderr).not.toContain('sk_global');
    });

    it('refuses SOLIDACTIONS_HOST alone without calling that host', async () => {
        writeGlobal(home, { host: good.url, apiKey: GLOBAL_KEY, workspaceId: 'ws-1' });

        const result = await runCli(['connection', 'list'], home, cwd, { SOLIDACTIONS_HOST: wrong.url });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Refusing to send the API key');
        expect(wrong.requests).toHaveLength(0);
    });

    it('refuses an env key alone when a folder config names another host, calling neither host (PM ruling 1)', async () => {
        writeGlobal(home, { host: good.url, apiKey: GLOBAL_KEY, workspaceId: 'ws-1' });
        writeLocal(cwd, { host: wrong.url });

        const result = await runCli(['connection', 'list'], home, cwd, { SOLIDACTIONS_API_KEY: ENV_KEY });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('SOLIDACTIONS_HOST');
        expect(wrong.requests).toHaveLength(0);
        expect(good.requests).toHaveLength(0);
        expect(result.stdout).not.toContain(ENV_KEY);
        expect(result.stderr).not.toContain(ENV_KEY);
    });

    it('refuses an env key alone against a folder host with no global config at all (PM ruling 10)', async () => {
        writeLocal(cwd, { host: wrong.url });

        const result = await runCli(['connection', 'list'], home, cwd, {
            SOLIDACTIONS_API_KEY: ENV_KEY,
            SOLIDACTIONS_WORKSPACE_ID: 'ws-1',
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('SOLIDACTIONS_HOST');
        expect(wrong.requests).toHaveLength(0);
        expect(result.stdout).not.toContain(ENV_KEY);
        expect(result.stderr).not.toContain(ENV_KEY);
    });

    it('sends an env key alone to the global host when no folder names one (PM ruling 10)', async () => {
        writeGlobal(home, { host: good.url, apiKey: GLOBAL_KEY });

        const result = await runCli(['connection', 'list'], home, cwd, {
            SOLIDACTIONS_API_KEY: ENV_KEY,
            SOLIDACTIONS_WORKSPACE_ID: 'ws-1',
        });

        expect(result.status).toBe(0);
        expect(good.requests.length).toBeGreaterThan(0);
        expect(good.requests[0].authorization).toBe(`Bearer ${ENV_KEY}`);
        expect(result.stdout).not.toContain(ENV_KEY);
        expect(result.stderr).not.toContain(ENV_KEY);
    });

    it('auto-select persists only the workspace pin, never host or key', async () => {
        const globalFile = writeGlobal(home, { host: good.url, apiKey: GLOBAL_KEY });
        const localFile = writeLocal(cwd, {});
        good.handler = (url) => {
            if (url === '/api/v1/workspaces') return { status: 200, body: workspacesPayload() };
            return { status: 200, body: { data: [] } };
        };

        const result = await runCli(['connection', 'list'], home, cwd);

        expect(result.status).toBe(0);
        const local = JSON.parse(fs.readFileSync(localFile, 'utf-8'));
        expect(local.workspace).toBe('ws-one');
        expect(local.workspaceId).toBe('ws-1');
        expect(local.workspaceOrg).toBe('Org');
        expect(local).not.toHaveProperty('apiKey');
        expect(local).not.toHaveProperty('host');
        expect(JSON.parse(fs.readFileSync(globalFile, 'utf-8'))).toEqual({ host: good.url, apiKey: GLOBAL_KEY });
    });

    it('auto-select writes scope only into the key file, never into a local pin file', async () => {
        const localFile = writeLocal(cwd, {});
        writeGlobal(home, { host: good.url, apiKey: GLOBAL_KEY });
        good.handler = (url) => {
            if (url === '/api/v1/workspaces') {
                return {
                    status: 200,
                    body: {
                        workspaces: { Org: [{ id: 'ws-1', slug: 'ws-one', name: 'One', tenant_name: 'Org' }] },
                        scope: { mode: 'single', workspace_ids: ['ws-1'] },
                    },
                };
            }
            return { status: 200, body: { data: [] } };
        };

        const result = await runCli(['connection', 'list'], home, cwd);

        expect(result.status).toBe(0);
        const local = JSON.parse(fs.readFileSync(localFile, 'utf-8'));
        expect(local.workspace).toBe('ws-one');
        expect(local.workspaceId).toBe('ws-1');
        expect(local).not.toHaveProperty('scopeMode');
        expect(local).not.toHaveProperty('scopedWorkspaceIds');
        expect(local).not.toHaveProperty('apiKey');
        expect(local).not.toHaveProperty('host');
    });

    it('a workspace-pin-only local file still uses the global credentials', async () => {
        writeGlobal(home, { host: good.url, apiKey: GLOBAL_KEY, workspaceId: 'ws-1' });
        writeLocal(cwd, { workspace: 'ws-one', workspaceId: 'ws-1' });

        const result = await runCli(['connection', 'list'], home, cwd);

        expect(result.status).toBe(0);
        expect(good.requests.length).toBeGreaterThan(0);
        const apiCall = good.requests.find((r) => r.url === '/api/v1/connections');
        expect(apiCall?.authorization).toBe(`Bearer ${GLOBAL_KEY}`);
        expect(result.stdout).not.toContain(GLOBAL_KEY);
        expect(result.stderr).not.toContain(GLOBAL_KEY);
    });
});

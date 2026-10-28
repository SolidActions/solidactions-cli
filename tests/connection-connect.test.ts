/**
 * Contract tests for `solidactions connection connect`.
 *
 * Test-double policy: the command talks to a real in-process HTTP server and
 * reads a real temporary CLI config. No mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

interface CapturedRequest {
    method: string | undefined;
    url: string | undefined;
    headers: http.IncomingHttpHeaders;
    body: unknown;
}

let server: http.Server;
let port: number;
let requests: CapturedRequest[] = [];
let handler: (request: http.IncomingMessage, body: unknown) => { status: number; payload: unknown } =
    () => ({ status: 200, payload: {} });

beforeAll(async () => {
    server = http.createServer((request, response) => {
        let raw = '';
        request.on('data', (chunk) => {
            raw += chunk;
        });
        request.on('end', () => {
            let body: unknown;
            try {
                body = raw === '' ? undefined : JSON.parse(raw);
            } catch {
                body = raw;
            }
            requests.push({
                method: request.method,
                url: request.url,
                headers: request.headers,
                body,
            });
            const answer = handler(request, body);
            response.writeHead(answer.status, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(answer.payload));
        });
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

function connectLink201(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: '01JBTEST',
        status: 'requested',
        mode: 'connect',
        platform: 'gmail',
        platform_name: 'Gmail',
        name: 'gmail-main',
        bindings: [{ project: 'newsletter', var: 'GMAIL_KEY' }],
        expires_at: '2026-10-29T19:00:00Z',
        url: 'https://app.solidactions.com/connect/token-abc',
        text: 'Connect Gmail for this workspace:\n  https://app.solidactions.com/connect/token-abc\nThe link works for 24 hours and once. Request id: 01JBTEST (expires 2026-10-29 19:00 UTC).',
        requested_by: { type: 'user', label: 'CLI (Pat Doe)' },
        requested_at: '2026-10-28T19:00:00Z',
        connection: null,
        connected_by: null,
        connected_at: null,
        ...overrides,
    };
}

describe('connectionConnect', () => {
    let root: string;
    let home: string;
    let cwd: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-connection-connect-'));
        home = path.join(root, 'home');
        cwd = path.join(root, 'work');
        fs.mkdirSync(home, { recursive: true });
        fs.mkdirSync(cwd, { recursive: true });
        writeGlobal(home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            workspaceId: 'workspace-1',
        });
        requests = [];
        handler = () => ({ status: 200, payload: {} });
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('mints a connect request with bindings and prints the server text plus the wait command', async () => {
        const link = connectLink201();
        handler = () => ({ status: 201, payload: link });
        const result = await runCli(
            ['connection', 'connect', 'gmail', '--name', 'gmail-main', '--bind', 'newsletter:GMAIL_KEY', '--bind', 'crm-dev:GMAIL_KEY'],
            home,
            cwd,
        );

        expect(result.status).toBe(0);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ method: 'POST', url: '/api/v1/connections/requests' });
        expect(requests[0].headers.authorization).toBe(('Bear' + 'er test-key'));
        expect(requests[0].headers['x-workspace-id']).toBe('workspace-1');
        expect(requests[0].body).toEqual({
            platform: 'gmail',
            name: 'gmail-main',
            mode: 'connect',
            bindings: [
                { project: 'newsletter', var: 'GMAIL_KEY' },
                { project: 'crm-dev', var: 'GMAIL_KEY' },
            ],
        });
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('Connect Gmail for this workspace:');
        expect(result.stdout).toContain('https://app.solidactions.com/connect/token-abc');
        expect(result.stdout).toContain('When it is done, run:');
        expect(result.stdout).toContain('  solidactions connection wait 01JBTEST');
    });

    it('sends an empty bindings array when no --bind is given', async () => {
        handler = () => ({ status: 201, payload: connectLink201({ bindings: [] }) });
        const result = await runCli(['connection', 'connect', 'gmail', '--name', 'gmail-main'], home, cwd);

        expect(result.status).toBe(0);
        expect(requests).toHaveLength(1);
        expect(requests[0].body).toEqual({
            platform: 'gmail',
            name: 'gmail-main',
            mode: 'connect',
            bindings: [],
        });
        expect(result.stderr).toBe('');
    });

    it('mints a reconnect request without listing connections when the platform is given', async () => {
        handler = () => ({ status: 201, payload: connectLink201({ mode: 'reconnect' }) });
        const result = await runCli(['connection', 'connect', 'gmail', '--reconnect', 'gmail-main'], home, cwd);

        expect(result.status).toBe(0);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ method: 'POST', url: '/api/v1/connections/requests' });
        expect(requests[0].body).toEqual({
            platform: 'gmail',
            name: 'gmail-main',
            mode: 'reconnect',
            bindings: [],
        });
        expect(result.stderr).toBe('');
    });

    it('looks up the platform from the connection list for --reconnect without a platform', async () => {
        handler = (request) => {
            if (request.url === '/api/v1/connections' && request.method === 'GET') {
                return {
                    status: 200,
                    payload: {
                        data: [
                            { name: 'gmail-other', provider: 'slack' },
                            { name: 'gmail-main', provider: 'gmail' },
                        ],
                    },
                };
            }
            return { status: 201, payload: connectLink201({ mode: 'reconnect' }) };
        };
        const result = await runCli(['connection', 'connect', '--reconnect', 'gmail-main'], home, cwd);

        expect(result.status).toBe(0);
        expect(requests).toHaveLength(2);
        expect(requests[0]).toMatchObject({ method: 'GET', url: '/api/v1/connections' });
        expect(requests[1]).toMatchObject({ method: 'POST', url: '/api/v1/connections/requests' });
        expect(requests[1].body).toEqual({
            platform: 'gmail',
            name: 'gmail-main',
            mode: 'reconnect',
            bindings: [],
        });
        expect(result.stderr).toBe('');
    });

    it('treats a malformed connection list as no match with one line', async () => {
        handler = (request) => {
            if (request.url === '/api/v1/connections' && request.method === 'GET') {
                return { status: 200, payload: { data: {} } };
            }
            return { status: 201, payload: connectLink201() };
        };
        const result = await runCli(['connection', 'connect', '--reconnect', 'gmail-main'], home, cwd);

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ method: 'GET', url: '/api/v1/connections' });
        expect(result.stderr.trim().split('\n')).toHaveLength(1);
        expect(result.stderr).toContain('No connection named gmail-main');
        expect(result.stdout).toBe('');
    });

    it('refuses --reconnect for an unknown name with one line pointing at connection list', async () => {
        handler = (request) => {
            if (request.url === '/api/v1/connections' && request.method === 'GET') {
                return { status: 200, payload: { data: [{ name: 'gmail-main', provider: 'gmail' }] } };
            }
            return { status: 201, payload: connectLink201() };
        };
        const result = await runCli(['connection', 'connect', '--reconnect', 'missing-one'], home, cwd);

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ method: 'GET', url: '/api/v1/connections' });
        const lines = result.stderr.trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('No connection named missing-one');
        expect(lines[0]).toContain('solidactions connection list');
        expect(result.stdout).toBe('');
    });

    it.each([
        ['a --bind without a colon', 'PROJECT:VAR', ['connection', 'connect', 'gmail', '--name', 'x', '--bind', 'newsletter']],
        ['a --bind without a project', 'PROJECT:VAR', ['connection', 'connect', 'gmail', '--name', 'x', '--bind', ':GMAIL_KEY']],
        [
            'eleven --bind options',
            'at most 10',
            ['connection', 'connect', 'gmail', '--name', 'x', ...Array.from({ length: 11 }, () => ['--bind', 'p:V']).flat()],
        ],
        ['--name together with --reconnect', 'not both', ['connection', 'connect', 'gmail', '--name', 'a', '--reconnect', 'b']],
        ['a missing --name', '--name NAME is required', ['connection', 'connect', 'gmail']],
        ['a missing platform', 'give the platform', ['connection', 'connect', '--name', 'gmail-main']],
    ])('refuses %s locally with one stderr line and zero requests', async (_label, expected, args) => {
        const result = await runCli(args, home, cwd);

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(0);
        expect(result.stderr.trim().split('\n')).toHaveLength(1);
        expect(result.stderr).toContain(expected);
        expect(result.stdout).toBe('');
    });

    it('renders a 422 name_taken failure as one exact line', async () => {
        handler = () => ({
            status: 422,
            payload: { code: 'name_taken', message: 'gmail-main already exists in this workspace (status error); use reconnect' },
        });
        const result = await runCli(['connection', 'connect', 'gmail', '--name', 'gmail-main'], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toBe('Failed: 422 gmail-main already exists in this workspace (status error); use reconnect\n');
        expect(result.stdout).toBe('');
    });

    it('renders a 429 too_many_open_requests failure as one exact line', async () => {
        handler = () => ({
            status: 429,
            payload: { code: 'too_many_open_requests', message: 'This workspace already has 10 open connect links.' },
        });
        const result = await runCli(['connection', 'connect', 'gmail', '--name', 'gmail-main'], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toBe('Failed: 429 This workspace already has 10 open connect links.\n');
        expect(result.stdout).toBe('');
    });

    it('names the host on a 401', async () => {
        handler = () => ({ status: 401, payload: { message: 'Unauthenticated.' } });
        const result = await runCli(['connection', 'connect', 'gmail', '--name', 'gmail-main'], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Authentication failed against');
        expect(result.stderr).toContain(`127.0.0.1:${port}`);
        expect(result.stdout).toBe('');
    });

    it('strips terminal control sequences from the printed server text and id', async () => {
        handler = () => ({
            status: 201,
            payload: connectLink201({
                id: '01JB\u001b[2JTEST',
                text: 'open this: https://app.solidactions.com/connect/token-abc \u001b]52;c;ZXZpbA==\u0007 done',
            }),
        });
        const result = await runCli(['connection', 'connect', 'gmail', '--name', 'gmail-main'], home, cwd);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).not.toContain('\u001b');
        expect(result.stdout).not.toContain('\u0007');
        expect(result.stdout).toContain('  solidactions connection wait 01JB[2JTEST');
    });

    it('renders a fallback text when the server sends no text', async () => {
        const link = connectLink201({ text: undefined, bindings: [] });
        delete (link as Record<string, unknown>).text;
        handler = () => ({ status: 201, payload: link });
        const result = await runCli(['connection', 'connect', 'gmail', '--name', 'gmail-main'], home, cwd);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('Connect link: https://app.solidactions.com/connect/token-abc');
        expect(result.stdout).toContain('Request id: 01JBTEST (expires 2026-10-29 19:00 UTC)');
        expect(result.stdout).toContain('  solidactions connection wait 01JBTEST');
    });

    it('fails loudly when the server answers without a connect link', async () => {
        handler = () => ({ status: 201, payload: {} });
        const result = await runCli(['connection', 'connect', 'gmail', '--name', 'gmail-main'], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toBe('Failed: the server answered without a connect link.\n');
        expect(result.stdout).toBe('');
    });

    it('fails loudly without a stack when the server answers a non-string id', async () => {
        handler = () => ({ status: 201, payload: { id: 7, url: 'https://x/connect/t' } });
        const result = await runCli(['connection', 'connect', 'gmail', '--name', 'gmail-main'], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toBe('Failed: the server answered without a connect link.\n');
        expect(result.stderr).not.toContain('    at ');
        expect(result.stdout).toBe('');
    });

    it('omits the expiry parenthesis when the server sends no expires_at', async () => {
        handler = () => ({ status: 201, payload: { id: '01JBNOEXP', url: 'https://x/connect/t' } });
        const result = await runCli(['connection', 'connect', 'gmail', '--name', 'gmail-main'], home, cwd);

        expect(result.status).toBe(0);
        expect(result.stderr).not.toContain('    at ');
        expect(result.stdout).toContain('Connect link: https://x/connect/t');
        expect(result.stdout).toContain('Request id: 01JBNOEXP.');
        expect(result.stdout).not.toContain('expires');
        expect(result.stdout).toContain('  solidactions connection wait 01JBNOEXP');
    });

    it('renders a 403 forbidden without a login hint', async () => {
        handler = () => ({
            status: 403,
            payload: { code: 'forbidden', message: 'You cannot build automations in this workspace.' },
        });
        const result = await runCli(['connection', 'connect', 'gmail', '--name', 'gmail-main'], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toBe('Failed: 403 You cannot build automations in this workspace.\n');
        expect(result.stdout).toBe('');
    });

    it('prints one Connection failed line with no stack when the server is unreachable', async () => {
        const lonely = http.createServer((_request, response) => {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end('{}');
        });
        await new Promise<void>((resolve) => {
            lonely.listen(0, '127.0.0.1', () => resolve());
        });
        const lonelyPort = (lonely.address() as { port: number }).port;
        await new Promise<void>((resolve, reject) => {
            lonely.close((error) => (error ? reject(error) : resolve()));
        });
        writeGlobal(home, {
            host: `http://127.0.0.1:${lonelyPort}`,
            apiKey: 'test-key',
            workspaceId: 'workspace-1',
        });
        const result = await runCli(['connection', 'connect', 'gmail', '--name', 'gmail-main'], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stderr.trim().startsWith('Connection failed:')).toBe(true);
        expect(result.stderr.trim().split('\n')).toHaveLength(1);
        expect(result.stderr).not.toContain('    at ');
        expect(result.stderr).not.toContain('AxiosError');
        expect(result.stdout).toBe('');
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
        delete childEnv.DEBUG;
        delete childEnv.NODE_DEBUG;
        delete childEnv.FORCE_COLOR;
        delete childEnv.SOLIDACTIONS_TEST_HOOKS;

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

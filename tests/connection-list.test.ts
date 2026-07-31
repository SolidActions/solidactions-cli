/**
 * Contract tests for `solidactions connection list`.
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

let server: http.Server;
let port: number;
let responseBody: object = { data: [] };
let capturedRequest: {
    method: string | undefined;
    url: string | undefined;
    headers: http.IncomingHttpHeaders;
} | null = null;

beforeAll(async () => {
    server = http.createServer((request, response) => {
        capturedRequest = {
            method: request.method,
            url: request.url,
            headers: request.headers,
        };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(responseBody));
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

describe('connectionList', () => {
    let root: string;
    let home: string;
    let cwd: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-connection-list-'));
        home = path.join(root, 'home');
        cwd = path.join(root, 'work');
        fs.mkdirSync(home, { recursive: true });
        fs.mkdirSync(cwd, { recursive: true });
        writeGlobal(home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            workspaceId: 'workspace-1',
        });
        capturedRequest = null;
        responseBody = { data: [] };
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('GETs the workspace connections endpoint and renders the connection summary table', async () => {
        responseBody = {
            data: [
                {
                    id: 'connection-1',
                    name: 'Primary Gmail',
                    provider: 'gmail',
                    broker: 'pica',
                    status: 'connected',
                    error_message: null,
                    last_used_at: '2026-07-30T15:04:05.000000Z',
                    created_at: '2026-07-29T10:00:00.000000Z',
                    connection_key: 'must-not-print',
                },
                {
                    id: 'connection-2',
                    name: 'Team Slack',
                    provider: 'slack',
                    broker: 'pica',
                    status: 'error',
                    error_message: 'Refresh token expired\nReconnect this account before trying again.',
                    last_used_at: null,
                    created_at: '2026-07-29T11:00:00.000000Z',
                    cached_access_token: 'must-not-print-either',
                },
            ],
        };

        const result = await runCli(['connection', 'list'], home, cwd);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(capturedRequest).toMatchObject({
            method: 'GET',
            url: '/api/v1/connections',
        });
        expect(capturedRequest?.headers.authorization).toBe('Bearer test-key');
        expect(capturedRequest?.headers['x-workspace-id']).toBe('workspace-1');

        const rendered = result.stdout;
        expect(rendered).toContain('NAME');
        expect(rendered).toContain('PROVIDER');
        expect(rendered).toContain('STATUS');
        expect(rendered).toContain('LAST USED');
        expect(rendered).toContain('Primary Gmail');
        expect(rendered).toContain('gmail');
        expect(rendered).toContain('connected');
        expect(rendered).toContain('2026-07-30T15:04:05.000000Z');
        expect(rendered).toContain('Team Slack');
        expect(rendered).toContain('error — Refresh token expired\\nReconnect');
        expect(rendered).toContain('…');
        expect(rendered).not.toContain('trying again.');
        expect(rendered).not.toContain('must-not-print');
    });

    it('reports an empty workspace without rendering a table', async () => {
        const result = await runCli(['connection', 'list'], home, cwd);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout.trim()).toBe('No connections found.');
    });
});

describe('connection command registration', () => {
    it('registers singular `connection list` in the real built CLI', () => {
        expect(fs.existsSync(CLI_BINARY)).toBe(true);

        const topLevel = childProcess.spawnSync(process.execPath, [CLI_BINARY, '--help'], {
            encoding: 'utf8',
            timeout: 15_000,
        });
        expect(topLevel.status).toBe(0);
        expect(topLevel.stdout).toMatch(/^\s+connection\s+\S/m);

        const list = childProcess.spawnSync(process.execPath, [CLI_BINARY, 'connection', 'list', '--help'], {
            encoding: 'utf8',
            timeout: 15_000,
        });
        expect(list.status).toBe(0);
        expect(list.stdout).toContain('Usage: solidactions connection list [options]');
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

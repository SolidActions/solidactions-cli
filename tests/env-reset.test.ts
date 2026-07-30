/**
 * Contract tests for `env reset`.
 *
 * Test-double policy: the real compiled CLI talks to a real in-process HTTP
 * server and reads a real temporary CLI config. No mock/spy/stub libraries.
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

beforeAll(async () => {
    server = http.createServer((request, response) => {
        let rawBody = '';
        request.on('data', (chunk) => {
            rawBody += chunk;
        });
        request.on('end', () => {
            requests.push({
                method: request.method,
                url: request.url,
                headers: request.headers,
                body: rawBody ? JSON.parse(rawBody) : null,
            });

            if (request.method === 'GET' && request.url?.endsWith('/variable-mappings')) {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify([
                    {
                        id: 17,
                        env_name: 'GMAIL_TOKEN',
                        source_type: 'local',
                    },
                ]));
                return;
            }

            if (request.method === 'POST' && request.url?.endsWith('/variable-mappings/17/reset')) {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({
                    message: 'Variable mapping reset successfully.',
                    mapping: {
                        id: 17,
                        env_name: 'GMAIL_TOKEN',
                        source_type: 'oauth_connection',
                        source: 'oauth_connection',
                        oauth_connection_id: 'connection-1',
                        oauth_connection_name: 'Primary Gmail',
                    },
                }));
                return;
            }

            response.writeHead(404, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ message: `Unhandled ${request.method} ${request.url}` }));
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

describe('env reset', () => {
    let root: string;
    let home: string;
    let cwd: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-env-reset-'));
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
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('defaults to dev and performs the exact lookup-then-reset contract', async () => {
        const result = await runCli(['env', 'reset', 'mail-worker', 'GMAIL_TOKEN'], home, cwd);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(requests).toEqual([
            expect.objectContaining({
                method: 'GET',
                url: '/api/v1/projects/mail-worker-dev/variable-mappings',
                body: null,
            }),
            expect.objectContaining({
                method: 'POST',
                url: '/api/v1/projects/mail-worker-dev/variable-mappings/17/reset',
                body: {},
            }),
        ]);
        expect(requests[0].headers.authorization).toBe('Bearer test-key');
        expect(requests[0].headers['x-workspace-id']).toBe('workspace-1');
        expect(result.stdout).toContain('GMAIL_TOKEN');
        expect(result.stdout).toContain('oauth_connection');
        expect(result.stdout).toContain('Primary Gmail');
    });

    it('uses the shared environment slug convention', async () => {
        const staging = await runCli([
            'env',
            'reset',
            'mail-worker',
            'GMAIL_TOKEN',
            '--env',
            'staging',
        ], home, cwd);
        const production = await runCli([
            'env',
            'reset',
            'mail-worker',
            'GMAIL_TOKEN',
            '--env',
            'production',
        ], home, cwd);

        expect(staging.status).toBe(0);
        expect(production.status).toBe(0);
        expect(requests.map((request) => request.url)).toEqual([
            '/api/v1/projects/mail-worker-staging/variable-mappings',
            '/api/v1/projects/mail-worker-staging/variable-mappings/17/reset',
            '/api/v1/projects/mail-worker/variable-mappings',
            '/api/v1/projects/mail-worker/variable-mappings/17/reset',
        ]);
    });

    it('errors clearly and does not POST when the key has no mapping', async () => {
        const result = await runCli(['env', 'reset', 'mail-worker', 'MISSING_KEY'], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('MISSING_KEY');
        expect(result.stderr).toContain('no variable mapping');
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
            method: 'GET',
            url: '/api/v1/projects/mail-worker-dev/variable-mappings',
        });
    });

    it('rejects excess positional arguments before making an API request', async () => {
        const result = await runCli([
            'env',
            'reset',
            'mail-worker',
            'GMAIL_TOKEN',
            'extra',
        ], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('too many arguments');
        expect(result.stderr).toContain("Expected 2 arguments but got 3");
        expect(requests).toHaveLength(0);
    });

    it('is registered with project, key, and environment help', async () => {
        const result = await runCli(['env', 'reset', '--help'], home, cwd);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('Usage: solidactions env reset [options] <project> <KEY>');
        expect(result.stdout).toContain('-e, --env <environment>');
        expect(requests).toHaveLength(0);
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

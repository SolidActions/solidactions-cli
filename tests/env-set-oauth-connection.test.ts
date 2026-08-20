/**
 * Contract tests for `env set --oauth-connection`.
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
const OAUTH_MODE_ERROR = '--oauth-connection binds a project key; give <project> <KEY> and no value';

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

            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({
                env_name: 'GMAIL_TOKEN',
                source_type: 'oauth_connection',
                oauth_connection_name: 'Primary Gmail',
            }));
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

describe('env set --oauth-connection', () => {
    let root: string;
    let home: string;
    let cwd: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-env-oauth-'));
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

    it('binds a project key by connection name through the single mapping endpoint', async () => {
        const result = await runCli([
            'env',
            'set',
            'mail-worker',
            'GMAIL_TOKEN',
            '--oauth-connection',
            'Primary Gmail',
        ], home, cwd);

        expect(result.status).toBe(0);
        // env set is a mutating command — requireConfigWithWorkspace() always announces
        // the resolved workspace on stderr, first, even on success (#1437).
        expect(result.stderr).toBe('Workspace: workspace-1 (workspace-1)\n');
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
            method: 'POST',
            url: '/api/v1/projects/mail-worker-dev/variable-mappings',
            body: {
                project_key: 'GMAIL_TOKEN',
                oauth_connection_name: 'Primary Gmail',
            },
        });
        expect(requests[0].headers.authorization).toBe('Bearer test-key');
        expect(requests[0].headers['x-workspace-id']).toBe('workspace-1');
        expect(result.stdout).toContain('GMAIL_TOKEN');
        expect(result.stdout).toContain('Primary Gmail');
    });

    it('uses the shared environment suffix convention', async () => {
        const staging = await runCli([
            'env',
            'set',
            'mail-worker',
            'GMAIL_TOKEN',
            '--oauth-connection',
            'Primary Gmail',
            '--env',
            'staging',
        ], home, cwd);
        const production = await runCli([
            'env',
            'set',
            'mail-worker',
            'GMAIL_TOKEN',
            '--oauth-connection',
            'Primary Gmail',
            '--env',
            'production',
        ], home, cwd);

        expect(staging.status).toBe(0);
        expect(production.status).toBe(0);
        expect(requests.map((request) => request.url)).toEqual([
            '/api/v1/projects/mail-worker-staging/variable-mappings',
            '/api/v1/projects/mail-worker/variable-mappings',
        ]);
    });

    it('rejects a literal value before config or network work', async () => {
        fs.rmSync(path.join(home, '.solidactions'), { recursive: true, force: true });

        const result = await runCli([
            'env',
            'set',
            'mail-worker',
            'GMAIL_TOKEN',
            'literal-value',
            '--oauth-connection',
            'Primary Gmail',
        ], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(OAUTH_MODE_ERROR);
        expect(result.stderr).not.toContain('Not logged in');
        expect(requests).toHaveLength(0);
    });

    it('rejects --global before config or network work', async () => {
        fs.rmSync(path.join(home, '.solidactions'), { recursive: true, force: true });

        const result = await runCli([
            'env',
            'set',
            'GMAIL_TOKEN',
            'unused',
            '--global',
            '--oauth-connection',
            'Primary Gmail',
        ], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(OAUTH_MODE_ERROR);
        expect(result.stderr).not.toContain('Not logged in');
        expect(requests).toHaveLength(0);
    });

    it('applies the existing project env-key validation', async () => {
        const result = await runCli([
            'env',
            'set',
            'mail-worker',
            'not-valid!',
            '--oauth-connection',
            'Primary Gmail',
        ], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Invalid variable name "not-valid!"');
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

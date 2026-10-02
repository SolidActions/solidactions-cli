/**
 * A 404 names a missing environment only when the project family genuinely
 * lacks it (the `project view` pattern): when the family includes the
 * requested environment, the server's own resource-not-found message is
 * printed instead (a missing workflow or variable, not a missing
 * environment).
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

interface FamilyRow {
    name: string;
    slug: string;
    environments: string[];
    environment_details: Array<{ environment: string; slug: string }>;
}

let server: http.Server;
let port: number;
let familyRows: FamilyRow[] = [];

function json(response: http.ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
}

beforeAll(async () => {
    server = http.createServer((request, response) => {
        request.resume();
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname;

        if (request.method === 'GET' && pathname === '/api/v1/projects') {
            json(response, 200, { data: familyRows });
            return;
        }
        // Slug resolution: every candidate the tests use exists.
        if (request.method === 'GET' && (pathname === '/api/v1/projects/my-app' || pathname === '/api/v1/projects/my-app-dev')) {
            json(response, 200, { slug: pathname.split('/').pop() });
            return;
        }
        // run start: the workflow does not exist on an existing production project.
        if (request.method === 'POST' && pathname === '/api/v1/projects/my-app/workflows/hello/trigger') {
            json(response, 404, { message: 'Workflow "hello" not found.' });
            return;
        }
        if (request.method === 'POST' && pathname === '/api/v1/projects/my-app-dev/workflows/hello/trigger') {
            json(response, 404, { message: 'Workflow "hello" not found.' });
            return;
        }
        // env reset: the mapping exists, but the reset target is gone.
        if (request.method === 'GET' && pathname === '/api/v1/projects/my-app-dev/variable-mappings') {
            json(response, 200, [{ id: 7, env_name: 'FOO' }]);
            return;
        }
        if (request.method === 'POST' && pathname === '/api/v1/projects/my-app-dev/variable-mappings/7/reset') {
            json(response, 404, { message: 'Variable mapping 7 not found.' });
            return;
        }
        json(response, 500, { message: `Unexpected ${request.method} ${pathname}` });
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

describe('404s against an existing environment name the missing resource', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'test-key', workspaceId: 'workspace-1' });
        familyRows = [
            {
                name: 'my-app',
                slug: 'my-app',
                environments: ['production', 'dev'],
                environment_details: [
                    { environment: 'production', slug: 'my-app' },
                    { environment: 'dev', slug: 'my-app-dev' },
                ],
            },
        ];
    });
    afterEach(() => env.cleanup());

    it('run start with an existing production project and a missing workflow prints the server message, not a missing-environment hint', async () => {
        const result = await runCli(['run', 'start', 'my-app', 'hello', '-e', 'production'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Workflow "hello" not found.');
        expect(result.stderr).not.toMatch(/has no .* environment/);
    });

    it('run start still hints at the missing environment when the family excludes it', async () => {
        familyRows = [
            {
                name: 'my-app',
                slug: 'my-app',
                environments: ['production'],
                environment_details: [{ environment: 'production', slug: 'my-app' }],
            },
        ];

        const result = await runCli(['run', 'start', 'my-app', 'hello', '-e', 'dev'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('has no dev environment (exists in: production)');
    });

    it('env reset with an existing environment and a missing variable prints the server message, not a missing-environment hint', async () => {
        const result = await runCli(['env', 'reset', 'my-app', 'FOO', '-e', 'dev'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Variable mapping 7 not found.');
        expect(result.stderr).not.toMatch(/has no .* environment/);
    });
});

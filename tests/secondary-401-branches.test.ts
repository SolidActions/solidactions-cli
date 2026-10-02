/**
 * Early and secondary requests print the shared host-naming 401 line:
 * the crew-name lookup (before the command's own request), the env-push
 * write after a successful read, and the deploy project-existence precheck.
 *
 * A real in-process HTTP server, a real temp HOME, the real built CLI. No
 * mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpEnv, writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

let server: http.Server;
let port: number;

function json(response: http.ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
}

beforeAll(async () => {
    server = http.createServer((request, response) => {
        request.resume();
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname;

        // Crew-name lookup rejects the key.
        if (request.method === 'GET' && pathname === '/api/v1/crews') {
            json(response, 401, { message: 'Unauthenticated.' });
            return;
        }
        // env push: the read succeeds, the write rejects the key.
        if (request.method === 'GET' && pathname === '/api/v1/projects/my-app-dev/variable-mappings') {
            json(response, 200, []);
            return;
        }
        if (request.method === 'POST' && pathname === '/api/v1/projects/my-app-dev/variable-mappings/bulk') {
            json(response, 401, { message: 'Unauthenticated.' });
            return;
        }
        // Slug resolution succeeds so each command reaches its second request.
        if (request.method === 'GET' && (pathname === '/api/v1/projects/my-app-dev' || pathname === '/api/v1/projects/my-app')) {
            json(response, 200, { slug: pathname.split('/').pop() });
            return;
        }
        // Deploy project-existence precheck rejects the key.
        if (request.method === 'GET' && pathname === '/api/v1/projects/deploy-app') {
            json(response, 401, { message: 'Unauthenticated.' });
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

function expectedAuthLine(): string {
    return `Authentication failed against http://127.0.0.1:${port}. Run "solidactions login --global" to re-configure.`;
}

describe('early and secondary 401s name the host', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'test-key', workspaceId: 'workspace-1' });
    });
    afterEach(() => env.cleanup());

    it('crew env list names the host when the crew-name lookup rejects the key', async () => {
        const result = await runCli(['crew', 'env', 'list', 'marketing'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedAuthLine());
    });

    it('env push names the host when the write rejects the key after a successful read', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-env-push-401-'));
        fs.writeFileSync(path.join(dir, 'solidactions.yaml'), ['project: demo', 'workflows: []', 'env:', '  - MY_VAR'].join('\n'));
        fs.writeFileSync(path.join(dir, '.env.dev'), 'MY_VAR=fine\n');

        const result = await runCli(['env', 'push', 'my-app', dir, '-e', 'dev', '--yes'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedAuthLine());
    });

    it('deploy names the host when the project-existence precheck rejects the key', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-deploy-401-'));

        const result = await runCli(['project', 'deploy', 'deploy-app', dir, '-e', 'dev'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedAuthLine());
        expect(result.stderr).not.toContain('Failed to check project existence');
    });
});

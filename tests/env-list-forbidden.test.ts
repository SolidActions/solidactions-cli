/**
 * Failure-shape tests for `solidactions env list` (cli#114): an API failure
 * prints one line — the server's message when it sent one, else the status
 * alone — never the raw body. The header prints only after a request succeeds.
 *
 * Same pattern as tests/connection-list.test.ts: a real in-process HTTP
 * server, a real temp HOME, the real built CLI. No mock/spy/stub libraries.
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
let responseStatus = 200;
let responseBody: unknown = { data: [] };
let responseContentType = 'application/json';

function laravelForbiddenBody(): object {
    return {
        message: 'This action is unauthorized.',
        exception: 'Symfony\\Component\\HttpKernel\\Exception\\AccessDeniedHttpException',
        file: '/var/www/html/vendor/laravel/framework/src/Illuminate/Foundation/Exceptions/Handler.php',
        line: 772,
        trace: Array.from({ length: 50 }, (_, i) => ({ file: `/vendor/f${i}.php`, line: i })),
    };
}

beforeAll(async () => {
    server = http.createServer((request, response) => {
        const payload = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
        response.writeHead(responseStatus, { 'Content-Type': responseContentType });
        response.end(payload);
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

describe('env list failures print one line (cli#114)', () => {
    let root: string;
    let home: string;
    let cwd: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-env-list-forbidden-'));
        home = path.join(root, 'home');
        cwd = path.join(root, 'work');
        fs.mkdirSync(home, { recursive: true });
        fs.mkdirSync(cwd, { recursive: true });
        writeGlobal(home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            workspaceId: 'workspace-1',
        });
        responseStatus = 200;
        responseBody = { data: [] };
        responseContentType = 'application/json';
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('renders a 403 as one line with the server message, never the raw body', async () => {
        responseStatus = 403;
        responseBody = laravelForbiddenBody();

        const result = await runCli(['env', 'list'], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stderr.trim()).toBe('Failed: 403 This action is unauthorized.');
        expect(result.stdout).not.toContain('Global variables:');
        expect(result.stdout + result.stderr).not.toContain('vendor');
    });

    it('renders a project 403 as one line without the project header', async () => {
        responseStatus = 403;
        responseBody = laravelForbiddenBody();

        const result = await runCli(['env', 'list', 'my-app', '-e', 'production'], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stderr.trim()).toBe('Failed: 403 This action is unauthorized.');
        expect(result.stdout).not.toContain('Variables for project');
        expect(result.stdout + result.stderr).not.toContain('vendor');
    });

    it('renders an HTML 500 body as the status alone', async () => {
        responseStatus = 500;
        responseBody = '<html>boom</html>';
        responseContentType = 'text/html';

        const result = await runCli(['env', 'list'], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stderr.trim()).toBe('Failed: 500');
    });

    it('prints the header after a successful request', async () => {
        responseStatus = 200;
        responseBody = { data: [] };

        const result = await runCli(['env', 'list'], home, cwd);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Global variables:');
        expect(result.stdout).toContain('No global variables found.');
        expect(result.stdout.indexOf('Global variables:')).toBeLessThan(
            result.stdout.indexOf('No global variables found.'),
        );
    });

    it('names the host on a 401 (PM ruling 7)', async () => {
        responseStatus = 401;
        responseBody = { message: 'Unauthenticated.' };

        const result = await runCli(['env', 'list'], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stderr.trim()).toBe(
            `Authentication failed against http://127.0.0.1:${port}. Run "solidactions login --global" to re-configure.`,
        );
    });
});

/**
 * Contract tests for `connection connect` and `connection wait` with an older
 * token that lacks the `connections:request` ability: the server 403 must
 * surface the re-login hint, not an authentication failure.
 *
 * Test-double policy: the commands talk to a real in-process HTTP server and
 * read a real temporary CLI config. No mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');
const OLD_TOKEN_MESSAGE = "This API key does not have the 'connections:request' ability.";

let server: http.Server;
let port: number;
let requests: { method: string | undefined; url: string | undefined }[] = [];

beforeAll(async () => {
    server = http.createServer((request, response) => {
        request.resume();
        request.on('end', () => {
            requests.push({ method: request.method, url: request.url });
            response.writeHead(403, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({
                code: 'token_missing_ability',
                message: OLD_TOKEN_MESSAGE,
                required_ability: 'connections:request',
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

describe('connect link commands with an older token', () => {
    let root: string;
    let home: string;
    let cwd: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-connect-link-old-token-'));
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

    it('connect with an older token points at login --device, not an authentication failure', async () => {
        const result = await runCli(['connection', 'connect', 'gmail', '--name', 'gmail-main'], home, cwd);

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        expect(result.stderr).toContain('Failed: 403');
        expect(result.stderr).toContain(OLD_TOKEN_MESSAGE);
        expect(result.stderr).toContain('solidactions login --device');
        expect(result.stderr).not.toContain('Authentication failed');
        expect(result.stdout).toBe('');
    });

    it('wait with an older token points at login --device after exactly 1 request', async () => {
        const result = await runCli(['connection', 'wait', '01JBTEST'], home, cwd);

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ method: 'GET', url: '/api/v1/connections/requests/01JBTEST' });
        expect(result.stderr).toContain('Failed: 403');
        expect(result.stderr).toContain(OLD_TOKEN_MESSAGE);
        expect(result.stderr).toContain('solidactions login --device');
        expect(result.stderr).not.toContain('Authentication failed');
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

/**
 * `-w <workspace>` with a rejected key (cli#181): the workspace lookup behind the
 * flag printed `Failed to list workspaces: Unauthenticated.` with no host. It now
 * prints the same one-line, host-naming 401 every other command prints, and never
 * the host's userinfo. A real in-process HTTP server, a real temp HOME, the real
 * built CLI; no mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as http from 'http';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpEnv, writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

let server: http.Server;
let port: number;

beforeAll(async () => {
    server = http.createServer((request, response) => {
        request.resume();
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ message: 'Unauthenticated.' }));
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

function runCli(args: string[], home: string, cwd: string): Promise<CliResult> {
    return new Promise((resolve, reject) => {
        const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1' };
        delete childEnv.SOLIDACTIONS_HOST;
        delete childEnv.SOLIDACTIONS_API_KEY;
        delete childEnv.SOLIDACTIONS_WORKSPACE_ID;

        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], { cwd, env: childEnv });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });

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

describe('-w <workspace> with a rejected key', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();
    });
    afterEach(() => env.cleanup());

    it('prints the one-line 401 naming the host, not "Failed to list workspaces"', async () => {
        writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'made-up-key' });

        const result = await runCli(['-w', 'some-workspace', 'project', 'list'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            `Authentication failed against http://127.0.0.1:${port}. Run "solidactions login --global" to re-configure.`,
        );
        expect(result.stdout + result.stderr).not.toContain('Failed to list workspaces');
    });

    it('refuses a host with userinfo and never prints it', async () => {
        writeGlobal(env.home, { host: `http://someuser:somepass@127.0.0.1:${port}`, apiKey: 'made-up-key' });

        const result = await runCli(['-w', 'some-workspace', 'project', 'list'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`error: the host "http://127.0.0.1:${port}"`);
        expect(result.stderr).toContain('contains a username/password');
        expect(result.stdout + result.stderr).not.toContain('somepass');
        expect(result.stdout + result.stderr).not.toContain('someuser');
    });
});

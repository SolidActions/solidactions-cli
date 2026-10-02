/**
 * Every command prints ONE line when the API refuses it (cli#156): the server's
 * message, never the raw body (a debug-mode Laravel body carries a stack trace
 * and file paths), and a 401 names the host that refused the key.
 *
 * A real in-process HTTP server, a real temp HOME, the real built CLI. No
 * mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as http from 'http';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authFailedLine } from '../src/utils/api';
import { makeTmpEnv, writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

const LARAVEL_DEBUG_BODY = {
    message: 'This action is unauthorized.',
    exception: 'Symfony\\Component\\HttpKernel\\Exception\\AccessDeniedHttpException',
    file: '/var/www/html/vendor/laravel/framework/src/Illuminate/Auth/Access/Gate.php',
    line: 321,
    trace: Array.from({ length: 50 }, (_, i) => ({
        file: `/var/www/html/vendor/laravel/framework/src/Frame${i}.php`,
        line: i,
        function: 'handle',
    })),
};

let respondWith = { status: 403, body: LARAVEL_DEBUG_BODY as unknown };
let server: http.Server;
let port: number;

beforeAll(async () => {
    server = http.createServer((request, response) => {
        request.resume();
        response.writeHead(respondWith.status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(respondWith.body));
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

/** The failure lines on stderr: the AGENT NOTE and Workspace banner lines are not the command's own output. */
function failureLines(stderr: string): string[] {
    return stderr
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.includes('AGENT NOTE') && !line.startsWith('Workspace:'));
}

describe('authFailedLine', () => {
    it('names the host and strips userinfo from it', () => {
        const line = authFailedLine('https://u:p@host.example');

        expect(line).toContain('https://host.example');
        expect(line).not.toContain('u:p');
        expect(line).toBe('Authentication failed against https://host.example. Run "solidactions login --global" to re-configure.');
    });

    it('shows a host that is not a URL as configured', () => {
        expect(authFailedLine('not a url')).toBe('Authentication failed against not a url. Run "solidactions login --global" to re-configure.');
    });
});

describe('API failures print one line', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'test-key', workspaceId: 'workspace-1' });
    });
    afterEach(() => env.cleanup());

    // env pull (a deliberate two-line 403 naming env:reveal) and crew env list (a crew-lookup
    // message) keep their own 403 wording and are covered by their own tests.
    const cases: Array<[string, () => string[]]> = [
        ['env reset', () => ['env', 'reset', 'my-app', 'FOO', '-e', 'production']],
        ['webhook list', () => ['webhook', 'list', 'my-app', '-e', 'production']],
        ['run list', () => ['run', 'list']],
        ['schedule list', () => ['schedule', 'list', 'my-app', '-e', 'production']],
        ['project list', () => ['project', 'list']],
        ['env map', () => ['env', 'map', 'my-app', 'FOO', 'GLOBAL_FOO', '--yes']],
        ['run view', () => ['run', 'view', '7']],
        ['oauth-action list', () => ['oauth-action', 'list', 'github']],
        ['oauth-action platforms', () => ['oauth-action', 'platforms']],
        ['oauth-action search', () => ['oauth-action', 'search', 'github', 'issues']],
        ['project logs', () => ['project', 'logs', 'my-app']],
        ['schedule delete', () => ['schedule', 'delete', 'my-app', 'sched-1', '-e', 'production', '--yes']],
        ['run start', () => ['run', 'start', 'my-app', 'my-workflow', '-e', 'production']],
        ['schedule enable', () => ['schedule', 'enable', 'my-app', 'sched-1', '-e', 'production']],
        ['env delete', () => ['env', 'delete', 'my-app', 'FOO', '-e', 'production', '--yes']],
    ];

    it.each(cases)('%s: a 403 with a stack-trace body is one "Failed: 403 <message>" line', async (_name, argsFor) => {
        respondWith = { status: 403, body: LARAVEL_DEBUG_BODY };

        const result = await runCli(argsFor(), env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(failureLines(result.stderr)).toEqual(['Failed: 403 This action is unauthorized.']);
        expect(result.stderr).not.toContain('vendor');
        expect(result.stdout).not.toContain('vendor');
    });

    it('run list: a 401 names the host that refused the key', async () => {
        respondWith = { status: 401, body: { message: 'Unauthenticated.' } };

        const result = await runCli(['run', 'list'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(failureLines(result.stderr)).toEqual([
            `Authentication failed against http://127.0.0.1:${port}. Run "solidactions login --global" to re-configure.`,
        ]);
    });
});

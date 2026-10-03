/**
 * `env set` prints the global-scope note in global mode only, before the API
 * call (fix round 1: rewritten as a spawned-binary test per PM ruling 14 —
 * no axios mocks, no console/process.exit spies).
 *
 * The built binary runs against a real in-process HTTP server with a real
 * temp HOME. No mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as http from 'http';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GLOBAL_ENV_SCOPE_NOTE } from '../src/commands/env-set';
import { makeTmpEnv, writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

let server: http.Server;
let port: number;
let seenPaths: string[] = [];
/** The child's stdout as it streams, so the server can observe ordering. */
let streamedStdout = '';
/**
 * Whether the global-scope note was already in the child's streamed stdout
 * when the first API request arrived (null until the first request).
 */
let noteSeenAtFirstRequest: boolean | null = null;

beforeAll(async () => {
    server = http.createServer((request, response) => {
        request.resume();
        seenPaths.push(`${request.method} ${request.url ?? ''}`);
        const json = (status: number, body: unknown) => {
            response.writeHead(status, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(body));
        };
        if (request.method === 'GET' && request.url === '/api/v1/variables') {
            // The first request the CLI sends: hold its response until the
            // note has streamed through the child's stdout (correct code:
            // near-instant, since the note prints before the request). The
            // timeout below fails the test instead of hanging it.
            const startedAt = Date.now();
            const answer = () => {
                if (streamedStdout.includes('creating a GLOBAL variable')) {
                    noteSeenAtFirstRequest = true;
                    json(200, { data: [] });
                    return true;
                }
                return false;
            };
            if (!answer()) {
                const timer = setInterval(() => {
                    if (answer() || Date.now() - startedAt > 5000) {
                        clearInterval(timer);
                        if (noteSeenAtFirstRequest !== true) {
                            noteSeenAtFirstRequest = false;
                            json(200, { data: [] });
                        }
                    }
                }, 25);
            }
        } else if (request.method === 'POST' && request.url === '/api/v1/variables') {
            json(200, { key: 'MY_GLOBAL' });
        } else if (request.method === 'GET' && request.url === '/api/v1/projects/my-project-dev') {
            json(200, { slug: 'my-project-dev', name: 'my-project' });
        } else if (
            request.method === 'GET' &&
            request.url === '/api/v1/projects/my-project-dev/variable-mappings'
        ) {
            json(200, []);
        } else if (
            request.method === 'POST' &&
            request.url === '/api/v1/projects/my-project-dev/variable-mappings/bulk'
        ) {
            json(200, { created: 1, updated: 0 });
        } else {
            json(404, { message: 'Not found.' });
        }
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
            streamedStdout += chunk;
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

describe('GLOBAL_ENV_SCOPE_NOTE content', () => {
    it('explains the scope, the YAML invisibility, and both remedies', () => {
        expect(GLOBAL_ENV_SCOPE_NOTE).toContain('creating a GLOBAL variable');
        expect(GLOBAL_ENV_SCOPE_NOTE).toContain('NOT visible');
        expect(GLOBAL_ENV_SCOPE_NOTE).toContain('solidactions env map');
        expect(GLOBAL_ENV_SCOPE_NOTE).toContain('solidactions env set <project> KEY value');
    });
});

describe('env set prints the note in global mode only, before the API call', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        seenPaths = [];
        streamedStdout = '';
        noteSeenAtFirstRequest = null;
        env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'test-key', workspaceId: 'workspace-1' });
    });

    afterEach(() => {
        env.cleanup();
    });

    it('2-arg global form prints the note, then checks and creates, and still succeeds', async () => {
        const result = await runCli(['env', 'set', 'MY_GLOBAL', 'value', '--global', '-y'], env.home, env.cwd);

        expect(result.status).toBe(0);
        // The note the old test pinned (printed before the try that performs
        // the existence check and create, so before any HTTP call).
        expect(result.stdout).toContain('creating a GLOBAL variable');
        expect(result.stdout).toContain('created successfully');
        // Observed, not assumed: the note was already in the child's
        // streamed stdout when the first API request arrived.
        expect(noteSeenAtFirstRequest).toBe(true);
        // Existence check first, then the create — the note precedes both.
        expect(seenPaths).toEqual(['GET /api/v1/variables', 'POST /api/v1/variables']);
    });

    it('3-arg project form prints no note', async () => {
        const result = await runCli(['env', 'set', 'my-project', 'MY_KEY', 'value'], env.home, env.cwd);

        expect(result.status).toBe(0);
        expect(result.stdout).not.toContain('creating a GLOBAL variable');
        expect(result.stdout).toContain('created in project');
        expect(seenPaths).toEqual([
            'GET /api/v1/projects/my-project-dev',
            'GET /api/v1/projects/my-project-dev/variable-mappings',
            'POST /api/v1/projects/my-project-dev/variable-mappings/bulk',
        ]);
    });
});

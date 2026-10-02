/**
 * Task 4 (cli#161): every command resolves a mixed-case project argument by
 * its canonical slug. The built binary runs against one real in-process HTTP
 * server that knows a project named `CliTrustSmoke` (slug `clitrustsmoke`)
 * and records every request path. Real temp HOME, real stdout/stderr/exit
 * status. No mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as http from 'http';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpEnv, writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

let server: http.Server;
let port: number;
let seenPaths: string[] = [];
/** Case 8: the token may not read projects (every project GET is 403). */
let projectsReadForbidden = false;
/** Case 9: the projects list holds two case variants. */
let ambiguousList = false;

function json(response: http.ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
}

beforeAll(async () => {
    server = http.createServer((request, response) => {
        request.resume();
        seenPaths.push(request.url ?? '');
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname;

        if (projectsReadForbidden && request.method === 'GET' && pathname.startsWith('/api/v1/projects')) {
            json(response, 403, { message: 'Forbidden.' });
            return;
        }
        if (request.method === 'POST' && pathname === '/api/v1/projects/clitrustsmoke/workflows/hello/trigger') {
            json(response, 202, { run: { id: 1 } });
            return;
        }
        if (request.method === 'POST' && pathname === '/api/v1/projects/my-app/workflows/hello/trigger') {
            json(response, 202, { run: { id: 1 } });
            return;
        }
        if (request.method === 'GET' && pathname === '/api/v1/projects') {
            json(response, 200, {
                data: ambiguousList
                    ? [
                        { name: 'Main-App', slug: 'Main-App', environment: 'production' },
                        { name: 'MAIN-APP', slug: 'MAIN-APP', environment: 'production' },
                    ]
                    : [{ name: 'CliTrustSmoke', slug: 'clitrustsmoke', environment: 'production' }],
            });
            return;
        }
        if (request.method === 'GET' && pathname === '/api/v1/projects/CliTrustSmoke') {
            json(response, 404, { message: 'Not found.' });
            return;
        }
        if (request.method === 'GET' && pathname === '/api/v1/projects/clitrustsmoke') {
            if (url.searchParams.get('include') === 'deployment') {
                json(response, 200, { slug: 'clitrustsmoke', name: 'CliTrustSmoke', status: 'active' });
            } else {
                json(response, 200, { slug: 'clitrustsmoke', name: 'CliTrustSmoke' });
            }
            return;
        }
        if (request.method === 'GET' && pathname === '/api/v1/projects/clitrustsmoke/webhooks') {
            json(response, 200, { data: [{ workflow_name: 'hello', webhook_secret: 's3cr3t' }] });
            return;
        }
        if (request.method === 'GET' && pathname === '/api/v1/projects/clitrustsmoke/variable-mappings') {
            json(response, 200, []);
            return;
        }
        if (request.method === 'GET' && pathname === '/api/v1/projects/clitrustsmoke/schedules') {
            json(response, 200, []);
            return;
        }
        if (request.method === 'GET' && pathname === '/api/v1/runs') {
            if (url.searchParams.get('project') === 'CliTrustSmoke') {
                json(response, 200, { data: [] });
            } else {
                json(response, 200, { error: 'project_not_found', message: 'Project not found.', data: [] });
            }
            return;
        }
        json(response, 404, { message: 'Not found.' });
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

function runsRequests(): string[] {
    return seenPaths.filter((p) => p.startsWith('/api/v1/runs'));
}

describe('mixed-case project arguments resolve by the canonical slug', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        seenPaths = [];
        projectsReadForbidden = false;
        ambiguousList = false;
        env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'test-key', workspaceId: 'workspace-1' });
    });

    afterEach(() => {
        env.cleanup();
    });

    it('run start uses the canonical slug for the trigger', async () => {
        const result = await runCli(['run', 'start', 'CliTrustSmoke', 'hello', '-e', 'production'], env.home, env.cwd);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Run ID: 1');
        expect(seenPaths).toContain('/api/v1/projects/clitrustsmoke/workflows/hello/trigger');
    });

    it('webhook secret uses the canonical slug', async () => {
        const result = await runCli(['webhook', 'secret', 'CliTrustSmoke', '-e', 'production'], env.home, env.cwd);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('s3cr3t');
        expect(seenPaths.some((p) => p.startsWith('/api/v1/projects/clitrustsmoke/webhooks'))).toBe(true);
    });

    it('env list uses the canonical slug', async () => {
        const result = await runCli(['env', 'list', 'CliTrustSmoke', '-e', 'production'], env.home, env.cwd);
        expect(result.status).toBe(0);
        expect(seenPaths).toContain('/api/v1/projects/clitrustsmoke/variable-mappings');
    });

    it('schedule list uses the canonical slug', async () => {
        const result = await runCli(['schedule', 'list', 'CliTrustSmoke', '-e', 'production'], env.home, env.cwd);
        expect(result.status).toBe(0);
        expect(seenPaths).toContain('/api/v1/projects/clitrustsmoke/schedules');
    });

    it('project view uses the canonical slug', async () => {
        const result = await runCli(['project', 'view', 'CliTrustSmoke', '-e', 'production'], env.home, env.cwd);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('clitrustsmoke');
        expect(seenPaths.some((p) => p.startsWith('/api/v1/projects/clitrustsmoke?'))).toBe(true);
    });

    it('run list with the exact name lists without a lookup', async () => {
        const result = await runCli(['run', 'list', 'CliTrustSmoke'], env.home, env.cwd);
        expect(result.status).toBe(0);
        expect(runsRequests()).toHaveLength(1);
        expect(runsRequests()[0]).toContain('project=CliTrustSmoke');
    });

    it('run list with the slug retries once with the exact name', async () => {
        const result = await runCli(['run', 'list', 'clitrustsmoke'], env.home, env.cwd);
        expect(result.status).toBe(0);
        expect(runsRequests()).toHaveLength(2);
        expect(runsRequests()[1]).toContain('project=CliTrustSmoke');
        expect(seenPaths).toContain('/api/v1/projects');
    });

    it('a typo still prints the not-found message (exit 1), not a stack trace', async () => {
        const result = await runCli(['run', 'start', 'NoSuchApp', 'hello', '-e', 'production'], env.home, env.cwd);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Project or workflow not found.');
    });

    it('a 403 on the project read falls back to the command route (PM ruling 3)', async () => {
        projectsReadForbidden = true;
        const result = await runCli(['run', 'start', 'my-app', 'hello', '-e', 'production'], env.home, env.cwd);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Run ID: 1');
        expect(seenPaths).toContain('/api/v1/projects/my-app/workflows/hello/trigger');
    });

    it('an ambiguous case-insensitive match refuses and names both projects (PM ruling 4)', async () => {
        ambiguousList = true;
        const result = await runCli(['run', 'list', 'main-app'], env.home, env.cwd);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Main-App');
        expect(result.stderr).toContain('MAIN-APP');
        expect(result.stderr).toContain('exact name or slug');
        expect(runsRequests()).toHaveLength(1);
    });
});

describe('local input validation fails before any HTTP (fix round 1)', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        seenPaths = [];
        env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'test-key', workspaceId: 'workspace-1' });
    });

    afterEach(() => {
        env.cleanup();
    });

    it('project view with an invalid environment refuses locally', async () => {
        const result = await runCli(['project', 'view', 'foo', '-e', 'qa'], env.home, env.cwd);
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/production.*staging.*dev/i);
        expect(seenPaths).toEqual([]);
    });

    it('project view with a punctuation-only name refuses locally', async () => {
        const result = await runCli(['project', 'view', '!!!', '-e', 'production'], env.home, env.cwd);
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/letter or number/i);
        expect(seenPaths).toEqual([]);
    });

    it('schedule set with an invalid environment refuses locally', async () => {
        const result = await runCli(['schedule', 'set', 'foo', '* * * * *', '-e', 'prod'], env.home, env.cwd);
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/production.*staging.*dev/i);
        expect(seenPaths).toEqual([]);
    });

    it('schedule set with a punctuation-only name refuses locally', async () => {
        const result = await runCli(['schedule', 'set', '!!!', '* * * * *', '-e', 'production'], env.home, env.cwd);
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/letter or number/i);
        expect(seenPaths).toEqual([]);
    });

    it('schedule enable with an invalid environment refuses locally', async () => {
        const result = await runCli(['schedule', 'enable', 'foo', '42', '-e', 'qa'], env.home, env.cwd);
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/production.*staging.*dev/i);
        expect(seenPaths).toEqual([]);
    });

    it('schedule enable with a punctuation-only name refuses locally', async () => {
        const result = await runCli(['schedule', 'enable', '!!!', '42', '-e', 'production'], env.home, env.cwd);
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/letter or number/i);
        expect(seenPaths).toEqual([]);
    });
});

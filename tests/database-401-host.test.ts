/**
 * Database commands name the host on a 401 (cli#186).
 *
 * `safeDatabaseRequestError` (src/utils/database-data-plane.ts) and the
 * `database export` handlers (`operation`, `startExport`) must surface the
 * shared host-naming 401 line, never the raw body; other statuses keep their
 * old text. The server routes `POST /api/v1/databases` by `body.operation`
 * from a per-test map and records the operations it saw. A real in-process
 * HTTP server, a real temp HOME, the real built CLI; no mock/spy/stub
 * libraries.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpEnv, writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

let server: http.Server;
let port: number;

// Per-test answers by operation; reset per test. Anything unmapped answers 200.
let answers: Record<string, { status: number; body: object }> = {};
let showKind: 'duckdb' | 'libsql' = 'duckdb';
let seenOperations: string[] = [];

function duckdbRecord(): object {
    return { database: { name: 'main', kind: 'duckdb', status: 'ready', size_bytes: 1, deleted_at: null, purge_at: null } };
}

function libsqlRecord(): object {
    return { database: { name: 'main', kind: 'libsql', status: 'ready', size_bytes: 1, deleted_at: null, purge_at: null } };
}

beforeAll(async () => {
    server = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        request.on('end', () => {
            const json = (status: number, payload: unknown) => {
                response.writeHead(status, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(payload));
            };
            if (request.method === 'POST' && request.url === '/api/v1/databases') {
                let operation: string = '';
                try {
                    operation = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.operation ?? '';
                } catch { /* ignore */ }
                seenOperations.push(operation);
                const mapped = answers[operation];
                if (mapped !== undefined) {
                    json(mapped.status, mapped.body);
                    return;
                }
                if (operation === 'show') {
                    json(200, showKind === 'duckdb' ? duckdbRecord() : libsqlRecord());
                    return;
                }
                if (operation === 'list') {
                    json(200, { databases: [] });
                    return;
                }
                json(200, {});
                return;
            }
            json(404, { message: 'not found' });
        });
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
        delete childEnv.DEBUG;
        delete childEnv.NODE_DEBUG;
        delete childEnv.FORCE_COLOR;

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

function unauthorized(): { status: number; body: object } {
    return { status: 401, body: { code: 'unauthenticated', message: 'RAW-401' } };
}

describe('database commands name the host on a 401', () => {
    let env: ReturnType<typeof makeTmpEnv>;
    const expectedLine = () =>
        `Authentication failed against http://127.0.0.1:${port}. Run "solidactions login --global" to re-configure.`;

    beforeEach(() => {
        env = makeTmpEnv();
        answers = {};
        showKind = 'duckdb';
        seenOperations = [];
        writeGlobal(env.home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'sk-test-x',
            workspaceId: 'ws-1',
            workspace: 'ws-1',
        });
    });
    afterEach(() => env.cleanup());

    it('database list names the host when list is refused', async () => {
        answers = { list: unauthorized() };

        const result = await runCli(['database', 'list'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedLine());
        expect(result.stderr).not.toContain('RAW-401');
        expect(result.stderr).not.toContain('Database request failed.');
        expect(result.stderr).not.toContain('Run solidactions login to authenticate again');
        expect(seenOperations).toContain('list');
    });

    it('database list --json names the host and prints nothing to stdout', async () => {
        answers = { list: unauthorized() };

        const result = await runCli(['database', 'list', '--json'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedLine());
        expect(result.stderr).not.toContain('RAW-401');
        expect(result.stdout).toBe('');
        expect(seenOperations).toContain('list');
    });

    it('database show names the host when show is refused', async () => {
        answers = { show: unauthorized() };

        const result = await runCli(['database', 'show', 'main'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedLine());
        expect(result.stderr).not.toContain('RAW-401');
        expect(result.stderr).not.toContain('Database request failed.');
        expect(result.stderr).not.toContain('Run solidactions login to authenticate again');
        expect(seenOperations).toContain('show');
    });

    it('database dump names the host when dump is refused, writing no dump file', async () => {
        showKind = 'libsql';
        answers = { dump: unauthorized() };
        const dumpFile = path.join(env.cwd, 'main.sql');

        const result = await runCli(['database', 'dump', 'main', dumpFile], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedLine());
        expect(result.stderr).not.toContain('RAW-401');
        expect(result.stderr).not.toContain('Database request failed.');
        expect(result.stderr).not.toContain('Run solidactions login to authenticate again');
        expect(seenOperations).toContain('dump');
        expect(fs.existsSync(dumpFile)).toBe(false);
    });

    it('database export names the host when export is refused', async () => {
        answers = { export: unauthorized() };

        const result = await runCli(['database', 'export', 'main', '--no-wait'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedLine());
        expect(result.stderr).not.toContain('RAW-401');
        expect(result.stderr).not.toContain('Database request failed.');
        expect(result.stderr).not.toContain('Run solidactions login to authenticate again');
        expect(seenOperations).toContain('export');
    });

    it('database export --resume names the host when export_status is refused', async () => {
        answers = { export_status: unauthorized() };

        const result = await runCli(['database', 'export', 'main', '--resume', 'exp-1'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedLine());
        expect(result.stderr).not.toContain('RAW-401');
        expect(result.stderr).not.toContain('Database request failed.');
        expect(result.stderr).not.toContain('Run solidactions login to authenticate again');
        expect(seenOperations).toContain('export_status');
    });

    it('a 403 keeps the server text and no host-naming 401 line', async () => {
        answers = { list: { status: 403, body: { code: 'forbidden', message: 'Not allowed here.' } } };

        const result = await runCli(['database', 'list'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Not allowed here.');
        expect(result.stderr).not.toContain('Authentication failed');
        expect(seenOperations).toContain('list');
    });
});

/**
 * Commands that wrote their own 401 text (cli#181 audit): `skill dev --crew`
 * and `skill exec --crew` (the crew-variables fetch), and `crew env
 * map-database` (the variable write and the preceding database-list step).
 * Each now prints the one-line, host-naming 401 and never the host's userinfo.
 * A real in-process HTTP server, a real temp HOME, the real built CLI; no
 * mock/spy/stub libraries.
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

// What POST /api/v1/databases (the database-list step) answers; reset per test.
let databaseListStatus = 200;

/** Minimal server-stored skill bundle for the skill-exec crew-variables path. */
const SKILL_BUNDLE = {
    identifier: 'my-skill',
    properties: { name: 'my-skill', description: 'test skill' },
    body: 'test body',
    reference: {},
    doc_id: 1,
    active_snapshot_revision_id: 2,
};

beforeAll(async () => {
    server = http.createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
            const json = (status: number, payload: unknown) => {
                response.writeHead(status, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(payload));
            };
            if (request.method === 'POST' && request.url === '/mcp') {
                json(200, {
                    jsonrpc: '2.0',
                    id: 1,
                    result: { isError: false, content: [{ type: 'text', text: JSON.stringify(SKILL_BUNDLE) }] },
                });
                return;
            }
            if (request.method === 'POST' && request.url === '/api/v1/databases') {
                if (databaseListStatus === 401) {
                    json(401, { message: 'Unauthenticated.' });
                    return;
                }
                json(200, { databases: [{ id: 'db-1', name: 'main', status: 'ready', deleted_at: null }] });
                return;
            }
            // The crew-variables resolve and the variable write are the calls under test.
            json(401, { message: 'Unauthenticated.' });
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

describe('one-line 401 at the commands that wrote their own text', () => {
    let env: ReturnType<typeof makeTmpEnv>;
    const expectedLine = () =>
        `Authentication failed against http://127.0.0.1:${port}. Run "solidactions login --global" to re-configure.`;

    beforeEach(() => {
        env = makeTmpEnv();
        databaseListStatus = 200;
        writeGlobal(env.home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'made-up-key',
            workspaceId: 'ws-1',
        });
    });
    afterEach(() => env.cleanup());

    it('skill dev --crew prints the host-naming 401 when the crew variables are refused', async () => {
        const skillDir = path.join(env.cwd, 'my-skill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: my-skill\n---\n');

        const result = await runCli(
            ['skill', 'dev', skillDir, '--crew', '7', '--', 'node', '-e', '0'],
            env.home,
            env.cwd,
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedLine());
        expect(result.stderr).not.toContain('failed to resolve crew variables');
    });

    it('crew env map-database prints the host-naming 401 when the variable write is refused', async () => {
        const result = await runCli(
            ['crew', 'env', 'map-database', '7', 'DB_MAIN', 'main'],
            env.home,
            env.cwd,
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedLine());
        expect(result.stderr).not.toContain('Request failed with status code 401');
    });

    it('crew env map-database prints the host-naming 401 when the database list is refused', async () => {
        databaseListStatus = 401;

        const result = await runCli(
            ['crew', 'env', 'map-database', '7', 'DB_MAIN', 'main'],
            env.home,
            env.cwd,
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedLine());
        expect(result.stderr).not.toContain('Database request failed');
    });

    it('skill exec --crew prints the host-naming 401 when the crew variables are refused', async () => {
        const result = await runCli(
            ['skill', 'exec', 'my-skill', '--crew', '7', '--target', 'host', '--', 'node', '-e', '0'],
            env.home,
            env.cwd,
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedLine());
        expect(result.stderr).not.toContain('failed to resolve crew variables');
    });
});

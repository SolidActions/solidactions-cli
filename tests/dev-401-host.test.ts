/**
 * `dev` names the host on a 401 (cli#187).
 *
 * When the platform-vars fetch or a database-credential mint fails with 401,
 * `dev --env` must stop before invoking the workflow and print the shared
 * host-naming 401 line; other failures keep today's text. Each case builds a
 * temp project folder (solidactions.yaml, project-local .solidactions/config.json
 * with a plain host, an entry copied from fixtures/, node_modules symlinked for
 * @solidactions/sdk) and spawns the real built CLI. No mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpEnv, writeLocal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');
const ECHO_FIXTURE = path.resolve(__dirname, '../fixtures/echo.ts');
const ECHO_DB_FIXTURE = path.resolve(__dirname, '../fixtures/echo-db.ts');

let server: http.Server;
let port: number;

// Per-test platform answers; reset per test.
let mappingsStatus = 200;
let mappingsBody: unknown = [];
let databasesStatus = 200;
let databasesBody: object = {};

const DB_MAPPING = {
    env_name: 'APP_DB',
    source_type: 'workspace_database',
    resolved_value: null,
    workspace_database_name: 'orders',
};

beforeAll(async () => {
    server = http.createServer((request, response) => {
        request.resume();
        request.on('end', () => {
            const json = (status: number, payload: unknown) => {
                response.writeHead(status, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(payload));
            };
            if (request.method === 'GET' && request.url?.includes('/variable-mappings')) {
                json(mappingsStatus, mappingsBody);
                return;
            }
            if (request.method === 'POST' && request.url === '/api/v1/databases') {
                json(databasesStatus, databasesBody);
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

function runDevCli(args: string[], home: string, cwd: string): Promise<CliResult> {
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
        }, 90_000);

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

/** Project roots created outside the cleaned test tree; removed in afterEach. */
const projectRoots: string[] = [];

/** A temp project folder: solidactions.yaml, package.json, symlinked node_modules, entry, local config. */
function makeProject(entryFixture: string): { root: string; entry: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-dev-401-'));
    projectRoots.push(root);
    fs.writeFileSync(path.join(root, 'solidactions.yaml'), 'project: my-proj\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'my-proj', type: 'module' }) + '\n');
    fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(root, 'node_modules'), 'dir');
    const entry = path.join(root, 'entry.ts');
    fs.copyFileSync(entryFixture, entry);
    writeLocal(root, {
        host: `http://127.0.0.1:${port}`,
        apiKey: 'sk-test-x',
        workspaceId: 'ws-1',
    });
    return { root, entry };
}

describe('dev names the host on a 401', () => {
    let env: ReturnType<typeof makeTmpEnv>;
    const expectedLine = () =>
        `Authentication failed against http://127.0.0.1:${port}. Run "solidactions login --global" to re-configure.`;

    beforeEach(() => {
        env = makeTmpEnv();
        mappingsStatus = 200;
        mappingsBody = [];
        databasesStatus = 200;
        databasesBody = {};
    });
    afterEach(() => {
        for (const root of projectRoots.splice(0)) {
            fs.rmSync(root, { recursive: true, force: true });
        }
        env.cleanup();
    });

    it('names the host when the platform-vars fetch is refused', async () => {
        mappingsStatus = 401;
        mappingsBody = { message: 'RAW-401' };
        const { root, entry } = makeProject(ECHO_FIXTURE);

        const result = await runDevCli(['dev', entry, '--env', 'production', '--input', '{"n":1}'], env.home, root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedLine());
        expect(result.stderr).not.toContain('failed to fetch platform vars');
        expect(result.stderr).not.toContain('Request failed with status code 401');
        expect(result.stderr).not.toContain('✗ failed');
        expect(result.stdout).not.toContain('✓ completed');
        expect(result.stdout).not.toContain('Output:');
    }, 150_000);

    it('names the host when a database credential mint is refused, without running', async () => {
        mappingsStatus = 200;
        mappingsBody = [DB_MAPPING];
        databasesStatus = 401;
        databasesBody = { code: 'unauthenticated', message: 'RAW-401' };
        const { root, entry } = makeProject(ECHO_DB_FIXTURE);

        const result = await runDevCli(['dev', entry, '--env', 'production', '--input', '{"n":1}'], env.home, root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedLine());
        expect(result.stderr).not.toContain('failed to resolve database');
        expect(result.stderr).not.toContain('RAW-401');
        expect(result.stdout).not.toContain('✓ completed');
        expect(result.stdout).not.toContain('Output:');
    }, 150_000);

    it('keeps the 404 text and free-plan hint on staging', async () => {
        mappingsStatus = 404;
        mappingsBody = { message: 'nope' };
        const { root, entry } = makeProject(ECHO_FIXTURE);

        const result = await runDevCli(['dev', entry, '--env', 'staging', '--input', '{"n":1}'], env.home, root);

        expect(result.stderr).toContain('failed to fetch platform vars');
        expect(result.stderr).toContain("staging/dev environments require a paid plan");
        // The run continues after the warning, as before: exit 0 with the workflow's output.
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('✓ completed');
        expect(result.stdout).toContain('Output:');
    }, 150_000);
});

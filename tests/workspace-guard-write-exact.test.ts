/**
 * Regression contract for app#1481: the workspace guard's mutating/read-only classification
 * must be WRITE-EXACT for flag-sensitive commands, not path-only.
 *
 * `database pull` is classified MUTATING by path alone (because `--writable` opens a live
 * write REPL), but plain `database pull` only performs a server READ and writes a local file.
 * Before the fix, a fresh install running plain `database pull` would (a) print the
 * "about to write to" no-baseline warning — a lie, since it's a read — and (b) record the
 * state.json baseline, silently consuming the protection the very next REAL write should
 * have triggered.
 *
 * This defect lives in the wiring between commander's parsed flags and the classifier
 * (src/index.ts's preAction hook -> setActiveCommandPath -> isMutatingCommand), which
 * cannot be observed by calling applyWorkspaceGuard directly with an injected `mutating`
 * boolean (see tests/workspace-guard-wiring.test.ts) or `io` hooks. These tests spawn the
 * real compiled CLI against a real in-process http.Server and a real temp HOME/CWD — no
 * mocks/spies/stubs/fakes.
 *
 * Uses ASYNC child_process.spawn (not spawnSync), following tests/connection-list.test.ts
 * and tests/database-lifecycle-commands.test.ts: spawnSync blocks this process's event loop
 * for the whole child lifetime, which would deadlock any test where the child actually needs
 * a response from the in-process fake server (the server's own request handler runs on this
 * same blocked event loop). tests/workspace-guard-yes-not-consent.test.ts gets away with
 * spawnSync only because it asserts the guard aborts BEFORE the command ever contacts the
 * server; these tests let a command through past the guard, so they must not block the loop
 * the server depends on.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpEnv, writeGlobal, writeLocal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

let server: http.Server;
let port: number;
let requests: string[] = [];

beforeAll(async () => {
    server = http.createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        // The workspace guard runs, and any warn/state.json write happens, entirely before
        // this server is ever contacted — so its response only needs to let the CLI's own
        // HTTP client fail fast and exit, not actually succeed. Assertions below are on the
        // guard's stderr output and on state.json, never on command exit status.
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ message: 'stub: not exercised by these tests' }));
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

beforeEach(() => {
    requests = [];
});

let env: ReturnType<typeof makeTmpEnv>;

afterEach(() => {
    env?.cleanup();
});

function stateFilePath(home: string): string {
    return path.join(home, '.solidactions', 'state.json');
}

function setUpFreshHome(): void {
    env = makeTmpEnv();
    writeGlobal(env.home, {
        host: `http://127.0.0.1:${port}`,
        apiKey: 'test-key',
    });
    // No `workspace`/`workspaceId` on the global file: the local one below is the only
    // source for those, which makes resolution CWD-inferred (isCwdInferredWorkspace).
    writeLocal(env.cwd, { workspace: 'my-ws', workspaceId: 'ws-abc-123' });
}

interface CliResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

function run(args: string[]): Promise<CliResult> {
    return new Promise((resolve, reject) => {
        const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: env.home };
        delete childEnv.SOLIDACTIONS_HOST;
        delete childEnv.SOLIDACTIONS_API_KEY;
        delete childEnv.SOLIDACTIONS_WORKSPACE_ID;

        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], {
            cwd: env.cwd,
            env: childEnv,
        });
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
            resolve({ status, stdout, stderr });
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

describe('database pull is write-exact under the workspace guard (app#1481)', () => {
    it('plain `database pull` on a fresh HOME does not warn and does not record a state.json baseline', async () => {
        setUpFreshHome();

        const result = await run(['database', 'pull', 'mydb']);

        expect(result.stderr).not.toContain('about to write to');
        expect(result.stderr).not.toContain('warn:');
        expect(fs.existsSync(stateFilePath(env.home))).toBe(false);
    });

    it('`database pull --writable` on a fresh HOME warns with the no-baseline line and records state.json', async () => {
        setUpFreshHome();

        const result = await run(['database', 'pull', 'mydb', '--writable']);

        expect(result.stderr).toContain('warn:');
        expect(result.stderr).toContain('about to write to');
        expect(result.stderr).toContain('no previously recorded workspace to compare against');

        expect(fs.existsSync(stateFilePath(env.home))).toBe(true);
        const recorded = JSON.parse(fs.readFileSync(stateFilePath(env.home), 'utf-8'));
        expect(recorded.workspaceId).toBe('ws-abc-123');
    });

    it('a plain pull does not consume the no-baseline warning: a real write right after it still warns', async () => {
        setUpFreshHome();

        const readResult = await run(['database', 'pull', 'mydb']);
        expect(readResult.stderr).not.toContain('warn:');
        expect(fs.existsSync(stateFilePath(env.home))).toBe(false);

        // Same HOME, same CWD, no baseline consumed by the read above: a real write must
        // still see "no baseline" and warn — not silently proceed as if a baseline existed.
        const writeResult = await run(['project', 'create', 'my-project']);

        expect(writeResult.stderr).toContain('warn:');
        expect(writeResult.stderr).toContain('about to write to');
        expect(writeResult.stderr).toContain('no previously recorded workspace to compare against');
        expect(fs.existsSync(stateFilePath(env.home))).toBe(true);
    });
});

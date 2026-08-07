/**
 * Cleanroom-agent finding: a project deployed to `production` only, then
 * `run start <proj> <wf>` (no -e, defaults to `dev`) prints a bare
 * "Project or workflow not found." — misleading, since the project DOES
 * exist, just not in `dev`. F-C4 already added
 * `describeProjectEnvironments(config, projectName)` and wired better
 * 404 messages into env-list/set/delete; this wires the same helper into
 * `run start`.
 *
 * Test-double policy: real in-process HTTP server (Node's http.createServer)
 * stubbing the trigger endpoint (404) and GET /api/v1/projects (used by
 * describeProjectEnvironments). No mock/spy/stub libraries. Matches the
 * pattern in env-set-global-guard.test.ts.
 */
import * as http from 'http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/commands/run-start';
import { makeTmpEnv, writeGlobal } from './helpers';

class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

function patchProcessExit(): () => void {
    const orig = process.exit.bind(process);
    (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };
    return () => { (process as any).exit = orig; };
}

function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    return { lines, restore: () => { console.error = orig; } };
}

let server: http.Server;
let port: number;
let requests: Array<{ method: string; path: string }> = [];

beforeAll(async () => {
    server = http.createServer((req, res) => {
        requests.push({ method: req.method || '', path: req.url || '' });

        if (req.method === 'POST' && req.url?.match(/\/api\/v1\/projects\/.+\/workflows\/.+\/trigger/)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'Not found.' }));
            return;
        }
        if (req.method === 'GET' && req.url === '/api/v1/projects') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [{ name: 'myproject', slug: 'myproject', environments: ['production'] }] }));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: `unhandled ${req.method} ${req.url}` }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => {
        port = (server.address() as any).port;
        resolve();
    }));
});

afterAll(() => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))));

beforeEach(() => { requests = []; });

describe('run start — env-mismatch not-found (cleanroom finding)', () => {
    it('names the existing environments instead of a bare "not found" when the project exists only in a different environment', async () => {
        const env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'sk_test', workspaceId: 'ws-1' });
        const restoreExit = patchProcessExit();
        const { lines, restore: restoreErr } = captureStderr();

        try {
            let caught: ProcessExitError | null = null;
            try {
                // No -e passed → defaults to dev, but the project only exists in production.
                await run('myproject', 'my-workflow', {});
            } catch (e) {
                if (e instanceof ProcessExitError) caught = e;
                else throw e;
            }

            expect(caught?.code).toBe(1);
            const text = lines.join('\n');
            expect(text).toContain('exists in: production');
            expect(text).toContain('myproject');
        } finally {
            restoreExit();
            restoreErr();
            env.cleanup();
        }
    });

    it('falls back to the bare "not found" message when the project truly does not exist (describeProjectEnvironments finds nothing)', async () => {
        const env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'sk_test', workspaceId: 'ws-1' });
        const restoreExit = patchProcessExit();
        const { lines, restore: restoreErr } = captureStderr();

        try {
            let caught: ProcessExitError | null = null;
            try {
                await run('no-such-project', 'my-workflow', {});
            } catch (e) {
                if (e instanceof ProcessExitError) caught = e;
                else throw e;
            }

            expect(caught?.code).toBe(1);
            expect(lines.join('\n')).toContain('Project or workflow not found.');
        } finally {
            restoreExit();
            restoreErr();
            env.cleanup();
        }
    });
});

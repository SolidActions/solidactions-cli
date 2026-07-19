/**
 * #31: `env delete` gained a `--env` flag for symmetry with `env set`, so a
 * dev/staging environment-scoped project variable can be deleted from the CLI
 * (previously you had to hit the API directly). These tests lock in that the
 * flag selects the same `<project>-<env>` slug `env set` uses, and that
 * `--env production` targets the bare project name.
 *
 * Test-double policy: real in-process HTTP server (Node's http.createServer) —
 * no mock/spy/stub libraries. Matches env-set-global-guard.test.ts.
 */
import * as http from 'http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { envDelete } from '../src/commands/env-delete';
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

let server: http.Server;
let port: number;
let requests: Array<{ method: string; path: string }> = [];

beforeAll(async () => {
    server = http.createServer((req, res) => {
        req.on('data', () => { /* drain */ });
        req.on('end', () => {
            requests.push({ method: req.method || '', path: req.url || '' });

            // GET variable-mappings → one mapping so delete has an id to target.
            if (req.method === 'GET' && req.url?.match(/\/variable-mappings$/)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify([{ id: 42, env_name: 'API_KEY', is_yaml_declared: false }]));
                return;
            }
            if (req.method === 'DELETE' && req.url?.match(/\/variable-mappings\/42$/)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({}));
                return;
            }
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: `unhandled ${req.method} ${req.url}` }));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => {
        port = (server.address() as any).port;
        resolve();
    }));
});

afterAll(() => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))));

beforeEach(() => { requests = []; });

describe('envDelete — --env flag (#31)', () => {
    it('--env staging targets the <project>-staging slug (symmetric with env set)', async () => {
        const env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'sk_test', workspaceId: 'ws-1' });
        const restoreExit = patchProcessExit();
        try {
            let caught: ProcessExitError | null = null;
            try { await envDelete('myproject', 'API_KEY', { yes: true, env: 'staging' }); }
            catch (e) { if (e instanceof ProcessExitError) caught = e; else throw e; }

            expect(caught).toBeNull();
            expect(requests.some((r) => r.method === 'GET' && r.path.includes('/projects/myproject-staging/variable-mappings'))).toBe(true);
            expect(requests.some((r) => r.method === 'DELETE' && r.path.includes('/projects/myproject-staging/variable-mappings/42'))).toBe(true);
        } finally { restoreExit(); env.cleanup(); }
    });

    it('defaults to the -dev slug when --env is omitted', async () => {
        const env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'sk_test', workspaceId: 'ws-1' });
        const restoreExit = patchProcessExit();
        try {
            let caught: ProcessExitError | null = null;
            try { await envDelete('myproject', 'API_KEY', { yes: true }); }
            catch (e) { if (e instanceof ProcessExitError) caught = e; else throw e; }

            expect(caught).toBeNull();
            expect(requests.some((r) => r.path.includes('/projects/myproject-dev/variable-mappings'))).toBe(true);
        } finally { restoreExit(); env.cleanup(); }
    });

    it('--env production targets the bare project name (no env suffix)', async () => {
        const env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'sk_test', workspaceId: 'ws-1' });
        const restoreExit = patchProcessExit();
        try {
            let caught: ProcessExitError | null = null;
            try { await envDelete('myproject', 'API_KEY', { yes: true, env: 'production' }); }
            catch (e) { if (e instanceof ProcessExitError) caught = e; else throw e; }

            expect(caught).toBeNull();
            expect(requests.some((r) => r.path.includes('/projects/myproject/variable-mappings'))).toBe(true);
            expect(requests.some((r) => r.path.includes('/projects/myproject-production/'))).toBe(false);
        } finally { restoreExit(); env.cleanup(); }
    });
});

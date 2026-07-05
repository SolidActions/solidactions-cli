/**
 * Jordan Wall #4 (Sweep C, → 1.23.0): `env set` used to silently fall through
 * to GLOBAL scope when no project arg was given, so a typo'd
 * `env set KEY VALUE` (meant for a project) wrote a global var the workflow
 * never reads. Global writes now require an explicit --global.
 *
 * Test-double policy: real in-process HTTP server (Node's http.createServer)
 * for the "valid call" paths — no mock/spy/stub libraries. Matches the
 * pattern in skill-push.test.ts / dev.test.ts. The guard-rejection paths need
 * no server at all: they must fail before any config/network work.
 */
import * as http from 'http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { envSet } from '../src/commands/env-set';
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
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string) => { lines.push(String(chunk)); return true; };
    return { lines, restore: () => { (process.stderr as any).write = orig; } };
}

let server: http.Server;
let port: number;
let requests: Array<{ method: string; path: string; body: any }> = [];

beforeAll(async () => {
    server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            let body: any = null;
            try { body = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }
            requests.push({ method: req.method || '', path: req.url || '', body });

            if (req.method === 'GET' && req.url?.startsWith('/api/v1/variables')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ data: [] }));
                return;
            }
            if (req.method === 'POST' && req.url === '/api/v1/variables') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({}));
                return;
            }
            if (req.method === 'POST' && req.url?.match(/\/api\/v1\/projects\/.+\/variable-mappings\/bulk/)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ created: 1, updated: 0 }));
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

describe('envSet — --global guard (Jordan Wall #4)', () => {
    it('2-arg call without --global hard-errors naming both correct forms, before any network call', async () => {
        const restoreExit = patchProcessExit();
        const { lines, restore: restoreErr } = captureStderr();
        try {
            let caught: ProcessExitError | null = null;
            try { await envSet('KEY', 'value'); }
            catch (e) { if (e instanceof ProcessExitError) caught = e; else throw e; }

            expect(caught?.code).toBe(1);
            expect(requests.length).toBe(0); // guard fires before requireConfigWithWorkspace/network
            const out = lines.join('');
            expect(out).toContain('solidactions env set KEY VALUE --global');
            expect(out).toContain('solidactions env set <project> KEY VALUE');
        } finally { restoreExit(); restoreErr(); }
    });

    it('2-arg call with options.global undefined (commander default) still errors', async () => {
        const restoreExit = patchProcessExit();
        const { restore: restoreErr } = captureStderr();
        try {
            let caught: ProcessExitError | null = null;
            try { await envSet('KEY', 'value', undefined, {}); }
            catch (e) { if (e instanceof ProcessExitError) caught = e; else throw e; }
            expect(caught?.code).toBe(1);
        } finally { restoreExit(); restoreErr(); }
    });

    it('3-arg project-mode call (no --global) is unaffected by the guard and proceeds', async () => {
        const env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'sk_test', workspaceId: 'ws-1' });
        const restoreExit = patchProcessExit();
        try {
            let caught: ProcessExitError | null = null;
            try { await envSet('myproject', 'KEY', 'value', { yes: true }); }
            catch (e) { if (e instanceof ProcessExitError) caught = e; else throw e; }
            // envSet does not process.exit on success — no exit should have been thrown.
            expect(caught).toBeNull();
            expect(requests.some((r) => r.method === 'POST' && r.path.includes('/variable-mappings/bulk'))).toBe(true);
        } finally { restoreExit(); env.cleanup(); }
    });

    it('2-arg call WITH --global proceeds to global mode', async () => {
        const env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'sk_test', workspaceId: 'ws-1' });
        const restoreExit = patchProcessExit();
        try {
            let caught: ProcessExitError | null = null;
            try { await envSet('KEY', 'value', undefined, { global: true, yes: true }); }
            catch (e) { if (e instanceof ProcessExitError) caught = e; else throw e; }
            expect(caught).toBeNull();
            expect(requests.some((r) => r.method === 'POST' && r.path === '/api/v1/variables')).toBe(true);
        } finally { restoreExit(); env.cleanup(); }
    });

    it('3-arg project call PLUS --global is rejected as ambiguous', async () => {
        const restoreExit = patchProcessExit();
        const { lines, restore: restoreErr } = captureStderr();
        try {
            let caught: ProcessExitError | null = null;
            try { await envSet('myproject', 'KEY', 'value', { global: true }); }
            catch (e) { if (e instanceof ProcessExitError) caught = e; else throw e; }
            expect(caught?.code).toBe(1);
            expect(requests.length).toBe(0);
            expect(lines.join('')).toContain('--global does not take a project argument');
        } finally { restoreExit(); restoreErr(); }
    });
});

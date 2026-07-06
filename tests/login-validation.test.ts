/**
 * F-C2 — `solidactions login` must validate the API key (via a real request
 * to GET /api/v1/workspaces) and resolve --workspace BEFORE writing anything
 * to disk. Previously login() wrote the config unconditionally and printed
 * "Logged in successfully!" even for a bad key or an unreachable host, and a
 * non-interactive --workspace was silently ignored.
 *
 * Test-double policy: real in-process HTTP server (Node's http.createServer)
 * stubs GET /api/v1/workspaces; ProcessExitError-throw pattern for
 * process.exit (see tests/login-overwrite-guard.test.ts); real tmp $HOME via
 * tests/helpers.ts makeTmpEnv(). No mock/spy/stub libraries.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { login } from '../src/commands/login';
import { makeTmpEnv, writeGlobal } from './helpers';

class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

let stubServer: http.Server;
let stubPort: number;
let nextStatus = 200;
let nextBody: any = { data: [] };

beforeAll(async () => {
    stubServer = http.createServer((_req, res) => {
        res.writeHead(nextStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(nextBody));
    });
    await new Promise<void>((resolve) => {
        stubServer.listen(0, '127.0.0.1', () => {
            stubPort = (stubServer.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => {
    return new Promise<void>((resolve, reject) => {
        stubServer.close((err) => (err ? reject(err) : resolve()));
    });
});

describe('login — validates before writing (F-C2)', () => {
    let env: ReturnType<typeof makeTmpEnv>;
    let originalIsTTY: boolean | undefined;
    let originalExit: typeof process.exit;
    let originalLog: typeof console.log;
    let originalError: typeof console.error;
    let logLines: string[];
    let errorLines: string[];
    let writeCount: number;
    let originalWriteFileSync: typeof fs.writeFileSync;

    const HOST = () => `http://127.0.0.1:${stubPort}`;

    beforeEach(() => {
        env = makeTmpEnv();
        nextStatus = 200;
        nextBody = { data: [] };

        originalIsTTY = process.stdin.isTTY;
        Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });

        originalExit = process.exit;
        (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };

        logLines = [];
        originalLog = console.log;
        console.log = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };

        errorLines = [];
        originalError = console.error;
        console.error = (...args: unknown[]) => { errorLines.push(args.map(String).join(' ')); };

        writeCount = 0;
        originalWriteFileSync = fs.writeFileSync;
        (fs as any).writeFileSync = (...args: Parameters<typeof fs.writeFileSync>) => {
            const target = String(args[0]);
            if (target.includes('config.json')) writeCount++;
            return originalWriteFileSync.apply(fs, args as any);
        };
    });

    afterEach(() => {
        Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
        (process as any).exit = originalExit;
        console.log = originalLog;
        console.error = originalError;
        (fs as any).writeFileSync = originalWriteFileSync;
        env.cleanup();
    });

    it('bad key: 401 from the server aborts before any write', async () => {
        const globalPath = writeGlobal(env.home, { host: 'http://old.example', apiKey: 'old-key' });
        const before = fs.readFileSync(globalPath, 'utf-8');
        writeCount = 0;
        nextStatus = 401;
        nextBody = { message: 'Unauthenticated.' };

        let caught: ProcessExitError | null = null;
        try {
            await login('bad-key', { global: true, host: HOST() });
        } catch (e) {
            if (e instanceof ProcessExitError) caught = e;
            else throw e;
        }

        expect(caught?.code).toBe(1);
        expect(writeCount).toBe(0);
        expect(fs.readFileSync(globalPath, 'utf-8')).toBe(before);
        const out = [...logLines, ...errorLines].join(' ');
        expect(out).toContain('Invalid API key');
        expect(out).not.toContain('Logged in successfully');
    });

    it('unreachable host aborts before any write', async () => {
        const globalPath = writeGlobal(env.home, { host: 'http://old.example', apiKey: 'old-key' });
        const before = fs.readFileSync(globalPath, 'utf-8');
        writeCount = 0;

        let caught: ProcessExitError | null = null;
        try {
            await login('some-key', { global: true, host: 'http://127.0.0.1:1' });
        } catch (e) {
            if (e instanceof ProcessExitError) caught = e;
            else throw e;
        }

        expect(caught?.code).toBe(1);
        expect(writeCount).toBe(0);
        expect(fs.readFileSync(globalPath, 'utf-8')).toBe(before);
        const out = [...logLines, ...errorLines].join(' ');
        expect(out).toContain('Could not reach');
    });

    it('--workspace resolves non-interactively (no TTY prompt) and writes the config ONCE with the matched workspaceId', async () => {
        nextStatus = 200;
        nextBody = { data: [{ id: 'ws-1', name: "Peter's Team", slug: 'peters-team' }] };

        await login('good-key', { global: true, host: HOST(), workspace: "Peter's Team" });

        expect(writeCount).toBe(1);
        const globalPath = path.join(env.home, '.solidactions', 'config.json');
        const config = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
        expect(config.workspaceId).toBe('ws-1');
        expect(config.workspace).toBe('peters-team');
        const out = logLines.join(' ');
        expect(out).toContain('Logged in successfully!');
    });

    it('--workspace with no match errors before writing', async () => {
        const globalPath = path.join(env.home, '.solidactions', 'config.json');
        nextStatus = 200;
        nextBody = { data: [{ id: 'ws-1', name: 'Some Other Team', slug: 'some-other-team' }] };

        let caught: ProcessExitError | null = null;
        try {
            await login('good-key', { global: true, host: HOST(), workspace: 'Nonexistent Team' });
        } catch (e) {
            if (e instanceof ProcessExitError) caught = e;
            else throw e;
        }

        expect(caught?.code).toBe(1);
        expect(writeCount).toBe(0);
        expect(fs.existsSync(globalPath)).toBe(false);
        const out = errorLines.join(' ');
        expect(out).toContain('Nonexistent Team');
    });

    it('non-interactive, no --workspace: writes the config ONCE without a workspaceId and warns', async () => {
        nextStatus = 200;
        nextBody = { data: [{ id: 'ws-1', name: 'Some Workspace', slug: 'some-workspace' }] };

        let caught: ProcessExitError | null = null;
        try {
            await login('good-key', { global: true, host: HOST() });
        } catch (e) {
            if (e instanceof ProcessExitError) caught = e;
            else throw e;
        }

        expect(caught).toBeNull();
        expect(writeCount).toBe(1);
        const globalPath = path.join(env.home, '.solidactions', 'config.json');
        const config = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
        expect(config.workspaceId).toBeUndefined();
        const out = logLines.join(' ');
        expect(out).toContain('No workspace set');
        expect(out).toContain('Logged in successfully!');
    });
});

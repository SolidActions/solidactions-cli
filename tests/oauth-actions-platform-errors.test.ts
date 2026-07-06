/**
 * oauth-actions: distinguish an unknown platform (404, forward-compatible
 * with the app-side `platform_unknown` error code) from a known platform
 * with zero matching actions (200, empty array) — both `list` and `search`
 * previously printed the same "No actions found." for both cases. Also
 * covers the new `oauth-actions platforms` subcommand.
 *
 * Test-double policy: real in-process HTTP server (Node's http.createServer),
 * ProcessExitError-throw pattern for process.exit, real console.log/error
 * capture. No mock/spy/stub libraries. Matches the pattern in
 * output-polish.test.ts and run-start-env-mismatch.test.ts.
 */
import * as http from 'http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { oauthActionsList } from '../src/commands/oauth-actions-list';
import { oauthActionsSearch } from '../src/commands/oauth-actions-search';
import { oauthActionsPlatforms } from '../src/commands/oauth-actions-platforms';
import { makeTmpEnv, writeGlobal } from './helpers';

class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

let stubServer: http.Server;
let stubPort: number;
let nextStatus = 200;
let nextBody: unknown = { oauth_actions: [] };

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

describe('oauth-actions: unknown platform vs. 0 matches', () => {
    let env: ReturnType<typeof makeTmpEnv>;
    let originalExit: typeof process.exit;
    let logLines: string[];
    let errLines: string[];
    let stdoutChunks: string[];
    let originalLog: typeof console.log;
    let originalErr: typeof console.error;
    let originalStdoutWrite: typeof process.stdout.write;

    beforeEach(() => {
        env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${stubPort}`, apiKey: 'k', workspaceId: 'ws-1' });
        nextStatus = 200;
        nextBody = { oauth_actions: [] };
        originalExit = process.exit;
        (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };
        logLines = [];
        originalLog = console.log;
        console.log = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };
        errLines = [];
        originalErr = console.error;
        console.error = (...args: unknown[]) => { errLines.push(args.map(String).join(' ')); };
        stdoutChunks = [];
        originalStdoutWrite = process.stdout.write.bind(process.stdout);
        (process.stdout as any).write = (chunk: any) => { stdoutChunks.push(String(chunk)); return true; };
    });

    afterEach(() => {
        process.exit = originalExit;
        console.log = originalLog;
        console.error = originalErr;
        process.stdout.write = originalStdoutWrite;
        env.cleanup();
    });

    it('list: known platform with 0 matches prints "No actions found." and exits 0', async () => {
        nextStatus = 200;
        nextBody = { oauth_actions: [] };

        await oauthActionsList('gmail', {});

        expect(logLines.some((l) => l.includes('No actions found'))).toBe(true);
        expect(errLines.join('\n')).not.toContain('Unknown platform');
    });

    it('list: unknown platform (404, platform_unknown) prints "Unknown platform" and exits non-zero', async () => {
        nextStatus = 404;
        nextBody = { error: 'Unknown platform', code: 'platform_unknown', platform: 'not-a-platform' };

        let caught: ProcessExitError | null = null;
        try {
            await oauthActionsList('not-a-platform', {});
        } catch (e) {
            if (e instanceof ProcessExitError) caught = e;
            else throw e;
        }

        expect(caught?.code).toBe(1);
        expect(errLines.join('\n')).toContain('Unknown platform "not-a-platform"');
        expect(errLines.join('\n')).toContain('oauth-actions platforms');
        expect(logLines.some((l) => l.includes('No actions found'))).toBe(false);
    });

    it('search: known platform with 0 matches prints "No actions found." and exits 0', async () => {
        nextStatus = 200;
        nextBody = { oauth_actions: [] };

        await oauthActionsSearch('gmail', 'send', {});

        expect(logLines.some((l) => l.includes('No actions found'))).toBe(true);
        expect(errLines.join('\n')).not.toContain('Unknown platform');
    });

    it('search: unknown platform (404, platform_unknown) prints "Unknown platform" and exits non-zero', async () => {
        nextStatus = 404;
        nextBody = { error: 'Unknown platform', code: 'platform_unknown', platform: 'not-a-platform' };

        let caught: ProcessExitError | null = null;
        try {
            await oauthActionsSearch('not-a-platform', 'send', {});
        } catch (e) {
            if (e instanceof ProcessExitError) caught = e;
            else throw e;
        }

        expect(caught?.code).toBe(1);
        expect(errLines.join('\n')).toContain('Unknown platform "not-a-platform"');
        expect(errLines.join('\n')).toContain('oauth-actions platforms');
    });

    it('list/search: a genuine 404 that is NOT platform_unknown still falls through to the generic "Failed: 404" path', async () => {
        nextStatus = 404;
        nextBody = { message: 'Not found.' };

        let caught: ProcessExitError | null = null;
        try {
            await oauthActionsList('gmail', {});
        } catch (e) {
            if (e instanceof ProcessExitError) caught = e;
            else throw e;
        }

        expect(caught?.code).toBe(1);
        expect(errLines.join('\n')).not.toContain('Unknown platform');
        expect(errLines.join('\n')).toContain('Failed: 404');
    });

    it('platforms: lists available platform slugs from GET /api/v1/oauth-actions/platforms', async () => {
        nextStatus = 200;
        nextBody = { platforms: ['gmail', 'slack', 'hubspot'] };

        await oauthActionsPlatforms({});

        expect(logLines).toContain('gmail');
        expect(logLines).toContain('slack');
        expect(logLines).toContain('hubspot');
    });

    it('platforms --json: emits the raw platform array as JSON', async () => {
        nextStatus = 200;
        nextBody = { platforms: ['gmail', 'slack'] };

        await oauthActionsPlatforms({ json: true });

        const parsed = JSON.parse(stdoutChunks.join(''));
        expect(parsed).toEqual(['gmail', 'slack']);
    });
});

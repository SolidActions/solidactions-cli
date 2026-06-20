/**
 * Tests for `solidactions project create`
 *
 * Uses a real in-process HTTP server to stub the /api/v1/projects endpoint.
 * No mocks/stubs/spies — follows the pattern from skill-list.test.ts.
 */

import * as http from 'http';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { projectCreateWithConfig } from '../src/commands/project-create';
import type { Config } from '../src/utils/config';

// ---------------------------------------------------------------------------
// Stub API server
// ---------------------------------------------------------------------------

interface CapturedRequest {
    method: string | undefined;
    path: string | undefined;
    headers: http.IncomingHttpHeaders;
    body: any;
}

let stubServer: http.Server;
let stubPort: number;
let lastCapture: CapturedRequest | null = null;
let allCaptures: CapturedRequest[] = [];

// Each entry: { status, body }. Dequeued per request; defaults to 201 success.
let responseQueue: Array<{ status: number; body: object }> = [];

function nextResponse(req: CapturedRequest): { status: number; body: object } {
    if (responseQueue.length > 0) return responseQueue.shift()!;
    // Default: echo back a created project.
    const slug = req.body?.slug ?? 'echo-slug';
    return { status: 201, body: { slug, name: req.body?.name, environment: req.body?.environment } };
}

beforeAll(async () => {
    stubServer = http.createServer((req, res) => {
        let rawBody = '';
        req.on('data', (chunk) => { rawBody += chunk; });
        req.on('end', () => {
            let parsedBody: any = null;
            try { parsedBody = JSON.parse(rawBody); } catch { /* ignore */ }

            const capture: CapturedRequest = {
                method: req.method,
                path: req.url,
                headers: req.headers,
                body: parsedBody,
            };
            lastCapture = capture;
            allCaptures.push(capture);

            const { status, body } = nextResponse(capture);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        });
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

beforeEach(() => {
    lastCapture = null;
    allCaptures = [];
    responseQueue = [];
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubConfig(workspaceId = 'ws-test-uuid'): Config {
    return {
        host: `http://127.0.0.1:${stubPort}`,
        apiKey: 'test-api-key',
        workspaceId,
    };
}

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
    console.error = (...args: any[]) => { lines.push(args.map(String).join(' ')); };
    return { lines, restore: () => { console.error = orig; } };
}

function captureStdout(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: any[]) => { lines.push(args.map(String).join(' ')); };
    return { lines, restore: () => { console.log = orig; } };
}

/** Run the command, swallowing the process.exit throw and returning its code. */
async function runCreate(name: string, options: any, config: Config = stubConfig()): Promise<{ code: number | undefined; stdout: string[]; stderr: string[] }> {
    const restoreExit = patchProcessExit();
    const out = captureStdout();
    const err = captureStderr();
    let code: number | undefined = 0;
    try {
        try {
            await projectCreateWithConfig(name, options, config);
        } catch (e) {
            if (e instanceof ProcessExitError) code = e.code;
            else throw e;
        }
    } finally {
        restoreExit();
        out.restore();
        err.restore();
    }
    return { code, stdout: out.lines, stderr: err.lines };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('projectCreateWithConfig', () => {
    it('POSTs to /api/v1/projects with name, slug and default production environment', async () => {
        const { code } = await runCreate('My Project', {});

        expect(code).toBe(0);
        expect(lastCapture).not.toBeNull();
        expect(lastCapture!.method).toBe('POST');
        expect(lastCapture!.path).toBe('/api/v1/projects');
        expect(lastCapture!.body.name).toBe('My Project');
        // production root → no environment suffix on the slug
        expect(lastCapture!.body.slug).toBe('my-project');
        expect(lastCapture!.body.environment).toBe('production');
    });

    it('sends Authorization and X-Workspace-Id headers', async () => {
        await runCreate('foo', {});
        expect(lastCapture!.headers['authorization']).toBe('Bearer test-api-key');
        expect(lastCapture!.headers['x-workspace-id']).toBe('ws-test-uuid');
    });

    it('appends the environment suffix to the slug for non-production envs', async () => {
        await runCreate('My Project', { env: 'dev' });
        expect(lastCapture!.body.environment).toBe('dev');
        expect(lastCapture!.body.slug).toBe('my-project-dev');
    });

    it('normalizes the slug: trims and collapses separators', async () => {
        await runCreate('  My  Project!  ', {});
        expect(lastCapture!.body.slug).toBe('my-project');
    });

    it('collapses existing repeated hyphens in the slug', async () => {
        await runCreate('my--project', {});
        expect(lastCapture!.body.slug).toBe('my-project');
    });

    it('rejects an all-punctuation name without sending a request', async () => {
        const { code, stderr } = await runCreate('!!!', {});
        expect(code).not.toBe(0);
        expect(stderr.join('\n').toLowerCase()).toContain('invalid project name');
        expect(allCaptures).toHaveLength(0);
    });

    it('rejects a name with no Latin alphanumerics (e.g. non-Latin script)', async () => {
        const { code, stderr } = await runCreate('你好', {});
        expect(code).not.toBe(0);
        expect(stderr.join('\n').toLowerCase()).toContain('invalid project name');
        expect(allCaptures).toHaveLength(0);
    });

    it('does NOT upload any source / does not call the deploy endpoint', async () => {
        await runCreate('foo', {});
        // Exactly one request, and it is the create POST (never .../deploy)
        expect(allCaptures).toHaveLength(1);
        expect(allCaptures[0].path).toBe('/api/v1/projects');
    });

    it('prints a success message including the project name', async () => {
        const { stdout } = await runCreate('foo', {});
        expect(stdout.join('\n').toLowerCase()).toContain('created');
        expect(stdout.join('\n')).toContain('foo');
    });

    it('on 401 prints an auth error and exits non-zero', async () => {
        responseQueue = [{ status: 401, body: { message: 'Unauthenticated.' } }];
        const { code, stderr } = await runCreate('foo', {});
        expect(code).not.toBe(0);
        expect(stderr.join('\n').toLowerCase()).toContain('auth');
    });

    it('on 422 (already exists) prints the server message and exits non-zero', async () => {
        responseQueue = [{ status: 422, body: { message: 'A project with this slug already exists.' } }];
        const { code, stderr } = await runCreate('foo', {});
        expect(code).not.toBe(0);
        expect(stderr.join('\n')).toContain('already exists');
    });

    it('on a 500 with no message body still fails cleanly (falls back to axios error text)', async () => {
        responseQueue = [{ status: 500, body: {} }];
        const { code, stderr } = await runCreate('foo', {});
        expect(code).not.toBe(0);
        const text = stderr.join('\n');
        expect(text).toContain('Failed to create project');
        // No "undefined" leaking into the message when the body has no `message`.
        expect(text.toLowerCase()).not.toContain('undefined');
    });

    it('on a network/connection failure prints "Connection failed" and exits non-zero', async () => {
        // Port 1 is unbound → ECONNREFUSED, no response object on the error.
        const badConfig: Config = { host: 'http://127.0.0.1:1', apiKey: 'k', workspaceId: 'ws' };
        const { code, stderr } = await runCreate('foo', {}, badConfig);
        expect(code).not.toBe(0);
        expect(stderr.join('\n')).toContain('Connection failed');
        expect(allCaptures).toHaveLength(0);
    });

    it('creates exactly one project for -e dev (no production shell)', async () => {
        const { code, stdout } = await runCreate('foo', { env: 'dev' });

        // Exactly one POST — no implicit production root created alongside it.
        expect(allCaptures).toHaveLength(1);
        expect(allCaptures[0].method).toBe('POST');
        expect(allCaptures[0].path).toBe('/api/v1/projects');
        expect(allCaptures[0].body.name).toBe('foo');
        expect(allCaptures[0].body.environment).toBe('dev');

        expect(code).toBe(0);
        // Success message mentions the created project.
        const text = stdout.join('\n');
        expect(text.toLowerCase()).toContain('created');
        expect(text).toContain('foo');
    });
});

/**
 * Free-plan environment fallback (billing v0.5): the app gates staging/dev
 * environment projects behind Pro+. `project deploy`'s env-project
 * auto-create call can now receive a 422
 * `{ message, errors, error: { code: 'plan_limit_reached', limit: 'multi_env', plan, max } }`
 * from a free-plan tenant. `deploy` defaults to env 'dev', so this needs a
 * graceful fallback instead of a dead-end.
 *
 * `isPlanLimitReachedError` and `handlePlanLimitReached` are the two
 * exported, independently-testable units behind that fallback (deploy()
 * itself is not unit-tested anywhere in this suite — its archive/upload/poll
 * pipeline is event-driven and fire-and-forget past `archive.finalize()`,
 * so existing deploy tests only exercise its extracted pure helpers, e.g.
 * shouldPrintWorkspaceMismatch in deploy-workspace-warning.test.ts. This
 * file follows that same convention).
 *
 * Test-double policy: real in-process HTTP server (Node's http.createServer)
 * for the one network call handlePlanLimitReached can make (production
 * project creation) — no mock/spy/stub libraries. `prompts.inject()` is the
 * `prompts` package's own built-in test-injection API (not a mock of our
 * code), matching how the package is meant to be tested.
 */
import * as http from 'http';
import prompts from 'prompts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    isPlanLimitReachedError,
    handlePlanLimitReached,
    PLAN_LIMIT_NON_INTERACTIVE_HINT,
} from '../src/commands/deploy';

class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

function makePlanLimitError(): any {
    const err: any = new Error('Request failed with status code 422');
    err.response = {
        status: 422,
        data: {
            message: 'Your plan only supports a production environment. Upgrade to add staging or dev environments.',
            errors: { environment: ['plan_limit_reached'] },
            error: { code: 'plan_limit_reached', limit: 'multi_env', plan: 'free', max: 1 },
        },
    };
    return err;
}

// ---------------------------------------------------------------------------
// isPlanLimitReachedError — pure predicate
// ---------------------------------------------------------------------------

describe('isPlanLimitReachedError', () => {
    it('is true for the exact plan_limit_reached/multi_env 422 shape', () => {
        expect(isPlanLimitReachedError(makePlanLimitError())).toBe(true);
    });

    it('is false for a generic 422 (e.g. duplicate project name) — non-plan errors are unaffected', () => {
        const err: any = new Error('Request failed with status code 422');
        err.response = { status: 422, data: { message: "A project named 'foo' already exists in workspace 'acme'." } };
        expect(isPlanLimitReachedError(err)).toBe(false);
    });

    it('is false for a 422 with an unrelated error.code', () => {
        const err: any = new Error('422');
        err.response = { status: 422, data: { message: 'nope', error: { code: 'validation_failed', limit: 'multi_env' } } };
        expect(isPlanLimitReachedError(err)).toBe(false);
    });

    it("is false for a 422 plan_limit_reached with a different limit (not 'multi_env')", () => {
        const err: any = new Error('422');
        err.response = { status: 422, data: { message: 'nope', error: { code: 'plan_limit_reached', limit: 'workflows' } } };
        expect(isPlanLimitReachedError(err)).toBe(false);
    });

    it('is false for a 404', () => {
        const err: any = new Error('404');
        err.response = { status: 404, data: { message: 'not found' } };
        expect(isPlanLimitReachedError(err)).toBe(false);
    });

    it('is false when there is no response body at all (network error)', () => {
        const err: any = new Error('Network error');
        expect(isPlanLimitReachedError(err)).toBe(false);
    });
});

describe('PLAN_LIMIT_NON_INTERACTIVE_HINT', () => {
    it('points at -e production and mentions upgrading', () => {
        expect(PLAN_LIMIT_NON_INTERACTIVE_HINT).toContain('-e production');
        expect(PLAN_LIMIT_NON_INTERACTIVE_HINT).toContain('upgrade');
    });
});

// ---------------------------------------------------------------------------
// handlePlanLimitReached — the interactive/non-interactive fallback
// ---------------------------------------------------------------------------

let server: http.Server;
let port: number;
let createRequests: Array<{ body: any }> = [];

beforeAll(async () => {
    server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            let body: any = null;
            try { body = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }
            if (req.method === 'POST' && req.url === '/api/v1/projects') {
                createRequests.push({ body });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ slug: body?.slug ?? 'unknown', name: body?.name }));
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

beforeEach(() => { createRequests = []; });

describe('handlePlanLimitReached', () => {
    let originalIsTTY: boolean | undefined;
    let originalExit: typeof process.exit;
    let originalError: typeof console.error;
    let errorLines: string[];

    beforeEach(() => {
        originalIsTTY = process.stdin.isTTY;
        originalExit = process.exit;
        (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };
        errorLines = [];
        originalError = console.error;
        console.error = (...args: unknown[]) => { errorLines.push(args.map(String).join(' ')); };
    });

    afterEach(() => {
        Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
        (process as any).exit = originalExit;
        console.error = originalError;
    });

    // Computed lazily (not at describe-collection time) because `port` isn't
    // assigned until the async beforeAll above has run.
    const config = () => ({ host: `http://127.0.0.1:${port}`, apiKey: 'test-key', workspaceId: 'ws-1' });

    it('non-interactive (no TTY): exits 1 with the server message + hint, WITHOUT prompting (no injected answer needed)', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });

        let caught: ProcessExitError | null = null;
        try {
            await handlePlanLimitReached(config(), 'my-project', makePlanLimitError(), true, 'my-project');
        } catch (e) {
            if (e instanceof ProcessExitError) caught = e;
            else throw e;
        }

        expect(caught?.code).toBe(1);
        const out = errorLines.join('\n');
        expect(out).toContain('Your plan only supports a production environment');
        expect(out).toContain(PLAN_LIMIT_NON_INTERACTIVE_HINT);
        // No network call was made — non-interactive path never attempts production creation.
        expect(createRequests).toHaveLength(0);
    }, 5_000);

    it('interactive, answers yes, production already exists: returns the cached production slug (no network call)', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        prompts.inject([true]);

        const slug = await handlePlanLimitReached(config(), 'my-project', makePlanLimitError(), true, 'my-project-prod-slug');

        expect(slug).toBe('my-project-prod-slug');
        expect(createRequests).toHaveLength(0);
    });

    it('interactive, answers yes, production does not exist yet: creates it and returns the server-echoed slug', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        prompts.inject([true]);

        const slug = await handlePlanLimitReached(config(), 'my-project', makePlanLimitError(), false, null);

        expect(slug).toBe('my-project');
        expect(createRequests).toHaveLength(1);
        expect(createRequests[0].body).toMatchObject({ name: 'my-project', environment: 'production' });
    });

    it('interactive, answers no: exits 1 with the hint, no project is created', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        prompts.inject([false]);

        let caught: ProcessExitError | null = null;
        try {
            await handlePlanLimitReached(config(), 'my-project', makePlanLimitError(), true, 'my-project');
        } catch (e) {
            if (e instanceof ProcessExitError) caught = e;
            else throw e;
        }

        expect(caught?.code).toBe(1);
        expect(errorLines.join('\n')).toContain(PLAN_LIMIT_NON_INTERACTIVE_HINT);
        expect(createRequests).toHaveLength(0);
    });
});

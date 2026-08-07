/**
 * Proxy-contract assertion test (Task 5.1 — the latent-bug catcher).
 *
 * Mirrors the ProxyController required-header validation:
 *   - 400 if X-OAuth-Connection-Key is missing
 *   - 400 if X-OAuth-Action-Id is missing
 *   - 200 if both headers + Authorization Bearer are present
 *
 * Takes the snippet that buildSnippet() emits, evaluates it against a stub
 * server to confirm:
 *   A) new ctx.vars snippet → 200 accepted
 *   B) old X-SA-Connection snippet → 400 rejected
 */

import * as http from 'http';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildSnippet } from '../src/commands/oauth-action-view';

// ---------------------------------------------------------------------------
// Stub HTTP server that mirrors ProxyController's header validation
// ---------------------------------------------------------------------------

let server: http.Server;
let port: number;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const connectionKey = req.headers['x-oauth-connection-key'];
        const actionId = req.headers['x-oauth-action-id'];
        const auth = req.headers['authorization'];

        if (!connectionKey || connectionKey === '') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing X-OAuth-Connection-Key header' }));
            return;
        }

        if (!actionId || actionId === '') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing X-OAuth-Action-Id header' }));
            return;
        }

        if (!auth || !String(auth).startsWith('Bearer ')) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing or malformed Authorization header' }));
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as any).port;
            resolve();
        });
    });
});

afterAll(() => {
    return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
    });
});

// ---------------------------------------------------------------------------
// Helpers to evaluate a buildSnippet() template against fixture ctx.vars
// ---------------------------------------------------------------------------

interface CtxVars {
    proxyUrl: string;
    proxyToken: string;
    key: string;
}

/**
 * Takes the raw snippet string (which uses template-literal syntax with
 * `ctx.vars.<VAR>.*` references), substitutes concrete fixture values,
 * then evaluates the resulting fetch call and returns the HTTP response status.
 *
 * The snippet uses JS template literals, so we wrap it in an async function,
 * replace the ctx.vars references with fixture values, and run it via Function().
 *
 * This is intentionally NOT using real network calls to the SA API — it
 * evaluates the snippet's headers against our stub server that mirrors
 * ProxyController's validation logic.
 */
async function runSnippetAgainstStub(snippet: string, varName: string, vars: CtxVars): Promise<{ status: number; body: any }> {
    // Replace ctx.vars.<varName>.proxyUrl, .proxyToken, .key with fixture values
    const rewritten = snippet
        .replace(new RegExp(`ctx\\.vars\\.${varName}\\.proxyUrl`, 'g'), JSON.stringify(vars.proxyUrl))
        .replace(new RegExp(`ctx\\.vars\\.${varName}\\.proxyToken`, 'g'), JSON.stringify(vars.proxyToken))
        .replace(new RegExp(`ctx\\.vars\\.${varName}\\.key`, 'g'), JSON.stringify(vars.key));

    // Extract the fetch() call and replace the outer async function skeleton
    // buildSnippet emits: const res = await fetch(...); const data = await res.json();
    // We wrap it in an async function and return { status, body }
    const fn = new Function('fetch', `
        return (async () => {
            ${rewritten.replace('const data = await res.json();', '')}
            const data = await res.json().catch(() => null);
            return { status: res.status, body: data };
        })();
    `);

    // Polyfill fetch for Node <18 via the built-in global (Node 18+ has it).
    const fetchImpl = globalThis.fetch;
    return fn(fetchImpl) as Promise<{ status: number; body: any }>;
}

/**
 * Evaluates the legacy (X-SA-Connection) snippet shape against the stub.
 * The old snippet uses process.env variables, so we inject them and execute
 * in the same manner.
 */
async function runLegacySnippetAgainstStub(snippet: string, platformEnv: string, stubBaseUrl: string): Promise<{ status: number; body: any }> {
    const rewritten = snippet
        .replace('process.env.SA_PROXY_URL', JSON.stringify(stubBaseUrl))
        .replace('process.env.SA_PROXY_TOKEN', JSON.stringify('tok_fixture'))
        .replace(new RegExp(`process\\.env\\.${platformEnv}`, 'g'), JSON.stringify('conn_key_fixture'));

    const fn = new Function('fetch', `
        return (async () => {
            ${rewritten.replace('const data = await res.json();', '')}
            const data = await res.json().catch(() => null);
            return { status: res.status, body: data };
        })();
    `);

    const fetchImpl = globalThis.fetch;
    return fn(fetchImpl) as Promise<{ status: number; body: any }>;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GMAIL_ACTION = {
    platform: 'gmail',
    method: 'POST',
    path: '/gmail/v1/users/me/messages/send',
    title: 'Send Message',
    action_id: 'conn_mod_def::AAA::BBB',
    io_schema: {
        ioExample: {
            input: {
                body: { raw: 'x' },
            },
        },
    },
};

// ---------------------------------------------------------------------------
// The latent-bug catcher tests
// ---------------------------------------------------------------------------

describe('proxy-contract: new ctx.vars snippet → 200 accepted', () => {
    it('new snippet with X-OAuth-Connection-Key + X-OAuth-Action-Id + Authorization → 200', async () => {
        const snippet = buildSnippet(GMAIL_ACTION, 'GMAIL');
        const stubBaseUrl = `http://127.0.0.1:${port}`;

        const result = await runSnippetAgainstStub(snippet, 'GMAIL', {
            proxyUrl: stubBaseUrl,
            proxyToken: 'tok_fixture',
            key: 'conn_key_fixture',
        });

        expect(result.status).toBe(200);
        expect(result.body).toEqual({ ok: true });
    });
});

describe('proxy-contract: old X-SA-Connection snippet → 400 rejected (the latent bug)', () => {
    it('legacy snippet using X-SA-Connection header → 400 because X-OAuth-Connection-Key is missing', async () => {
        const legacySnippet = buildSnippet(GMAIL_ACTION, 'GMAIL', true /* legacyEnv */);
        const stubBaseUrl = `http://127.0.0.1:${port}`;

        const result = await runLegacySnippetAgainstStub(legacySnippet, 'GMAIL', stubBaseUrl);

        expect(result.status).toBe(400);
        expect(result.body?.error).toContain('X-OAuth-Connection-Key');
    });
});

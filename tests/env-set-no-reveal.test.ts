import * as http from 'http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { envSet } from '../src/commands/env-set';
import { makeTmpEnv, writeGlobal } from './helpers';

// Regression test for #1252: `env set` used to GET
// `/variable-mappings?reveal=true` purely to read `has_value` for the
// overwrite-confirmation prompt, which forced env:edit-only tokens (the
// CLI's primary `login --device` token) to also need env:reveal, 403'ing
// on every write. This test stands up a real HTTP server that emulates the
// server's ability gate: it 403s a reveal=true mapping GET and 200s a
// plain one.

class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

let server: http.Server;
let port: number;
let requestUrls: string[] = [];
let bulkRequests: Array<{ url: string; body: any }> = [];
let mappingHasValue = false;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        requestUrls.push(req.url!);

        if (req.method === 'GET' && req.url?.match(/\/api\/v1\/projects\/.+\/variable-mappings/)) {
            if (req.url.includes('reveal=true')) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    code: 'token_missing_ability',
                    message: "This API key does not have the 'env:reveal' ability.",
                    required_ability: 'env:reveal',
                }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify([
                { env_name: 'API_KEY', value: null, has_value: mappingHasValue },
            ]));
            return;
        }

        if (req.method === 'POST' && req.url?.match(/\/api\/v1\/projects\/.+\/variable-mappings\/bulk/)) {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                bulkRequests.push({ url: req.url!, body: JSON.parse(body) });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ created: 0, updated: 1 }));
            });
            return;
        }

        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: `Unexpected ${req.method} ${req.url}` }));
    });
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
}));

beforeEach(() => {
    requestUrls = [];
    bulkRequests = [];
    mappingHasValue = false;
});

describe('env set does not require env:reveal', () => {
    it('succeeds for an env:edit-only token and posts the bulk upsert', async () => {
        const env = makeTmpEnv();
        writeGlobal(env.home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            workspaceId: 'ws-1',
        });

        try {
            await envSet('my-project', 'API_KEY', 'secret-value', { yes: false, env: 'dev' });
        } finally {
            env.cleanup();
        }

        expect(bulkRequests).toHaveLength(1);
        expect(bulkRequests[0].body).toMatchObject({
            variables: [{ key: 'API_KEY', value: 'secret-value' }],
        });
    });

    it('never requests reveal on the mappings GET (regression guard)', async () => {
        const env = makeTmpEnv();
        writeGlobal(env.home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            workspaceId: 'ws-1',
        });

        try {
            await envSet('my-project', 'API_KEY', 'secret-value', { yes: false, env: 'dev' });
        } finally {
            env.cleanup();
        }

        const mappingsGetUrls = requestUrls.filter((url) => url.match(/variable-mappings(\?|$)/));
        expect(mappingsGetUrls.length).toBeGreaterThan(0);
        for (const url of mappingsGetUrls) {
            expect(url).not.toMatch(/reveal/);
        }
    });

    it('still refuses to overwrite without -y in non-TTY mode, using the masked has_value field', async () => {
        mappingHasValue = true;

        const env = makeTmpEnv();
        writeGlobal(env.home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            workspaceId: 'ws-1',
        });

        const originalIsTTY = process.stdin.isTTY;
        Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
        const originalExit = process.exit;
        const originalError = console.error;
        const lines: string[] = [];
        (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };
        console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };

        try {
            await expect(envSet('my-project', 'API_KEY', 'new-value', { yes: false, env: 'dev' }))
                .rejects.toMatchObject({ code: 1 });
            expect(lines.join('\n')).toContain('Pass -y / --yes to overwrite without confirmation.');
            expect(bulkRequests).toHaveLength(0);
        } finally {
            Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
            (process as any).exit = originalExit;
            console.error = originalError;
            env.cleanup();
        }
    });
});

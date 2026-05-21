/**
 * T6.1 — solidactions dev pulls platform vars and runs invoke()
 *
 * Test-double policy: a real in-process HTTP server (Node's http.createServer)
 * mirrors the SA API's variable-mappings endpoint. No mock/spy/stub libraries.
 * Matches the pattern used in proxy-contract.test.ts (Task 5.1).
 */

import * as http from 'http';
import * as path from 'path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { runDev, type SaApiClient, type PlatformVar } from '../src/commands/dev';

// ---------------------------------------------------------------------------
// Real local HTTP server that serves fixture variable-mappings responses.
// The SA API route is GET /api/v1/projects/:slug/variable-mappings?resolve_oauth=true
// We don't need routing precision — any request returns the fixture payload.
// ---------------------------------------------------------------------------

/** Fixture platform vars returned by the fake SA API. */
const FIXTURE_VARS: PlatformVar[] = [
    { env_name: 'X', resolved_value: 'platform-x', source_type: 'plain' },
    { env_name: 'Y', resolved_value: 'platform-y', source_type: 'plain' },
];

let saServer: http.Server;
let saPort: number;

beforeAll(async () => {
    saServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(FIXTURE_VARS));
    });

    await new Promise<void>((resolve) => {
        saServer.listen(0, '127.0.0.1', () => {
            saPort = (saServer.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => {
    return new Promise<void>((resolve, reject) => {
        saServer.close((err) => (err ? reject(err) : resolve()));
    });
});

// ---------------------------------------------------------------------------
// Thin real SA API client that fetches from our local stub server.
// No mock libraries — this is a real HTTP client hitting a real HTTP server.
// ---------------------------------------------------------------------------

function fakeSAApi(): SaApiClient {
    return {
        projectSlug: 'test-project-staging',
        async fetchVarsAndConnections(_env: string): Promise<PlatformVar[]> {
            return new Promise((resolve, reject) => {
                const req = http.get(`http://127.0.0.1:${saPort}/api/v1/projects/test-project/variable-mappings`, (res) => {
                    let body = '';
                    res.on('data', (chunk) => { body += chunk; });
                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(body));
                        } catch (e) {
                            reject(e);
                        }
                    });
                });
                req.on('error', reject);
            });
        },
    };
}

// ---------------------------------------------------------------------------
// Entry file for the fixture workflow (relative to CLI root).
// ---------------------------------------------------------------------------
const ECHO_FIXTURE = path.resolve(__dirname, '../fixtures/echo.ts');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runDev', () => {
    it('pulls vars from platform, prints summary, runs invoke', async () => {
        const out = await runDev({
            entry: ECHO_FIXTURE,
            input: '{"n":2}',
            env: 'staging',
            api: fakeSAApi(),
        });

        // Summary line printed to stdout
        expect(out.stdout).toMatch(/Loaded \d+ vars \+ \d+ connections from .* \/ env staging/);

        // Workflow result: echo doubles the input
        expect(out.result).toEqual({ status: 'completed', output: 4 });
    }, 20_000);

    it('warns when an override shadows a platform var', async () => {
        const out = await runDev({
            entry: ECHO_FIXTURE,
            input: '{}',
            env: 'staging',
            varsOverride: { X: '1' },
            api: fakeSAApi(),
        });

        // Shadow warning emitted to stderr
        expect(out.stderr).toMatch(/override shadows platform var: X/);
    }, 20_000);
});

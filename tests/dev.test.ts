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

/**
 * Fixture platform vars returned by the fake SA API.
 *
 * Two mappings carry a value (X, Y) and two are declared-but-valueless in this
 * env (Z = null, W = absent). The valueless ones are DROPPED from ctx.vars and
 * must NOT be counted in the summary line (BUG #1) — only 2 vars are loadable.
 */
const FIXTURE_VARS: PlatformVar[] = [
    { env_name: 'X', resolved_value: 'platform-x', source_type: 'plain' },
    { env_name: 'Y', resolved_value: 'platform-y', source_type: 'plain' },
    { env_name: 'Z', resolved_value: null, source_type: 'plain' },
    { env_name: 'W', source_type: 'plain' },
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
// Entry files for the fixture workflows (relative to CLI root).
// ---------------------------------------------------------------------------
const ECHO_FIXTURE = path.resolve(__dirname, '../fixtures/echo.ts');
const ECHO_VARS_FIXTURE = path.resolve(__dirname, '../fixtures/echo-vars.ts');
const BOOM_FIXTURE = path.resolve(__dirname, '../fixtures/boom.ts');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runDev', () => {
    it('pulls vars from platform, prints the actually-loaded count, runs invoke', async () => {
        const out = await runDev({
            entry: ECHO_FIXTURE,
            input: '{"n":2}',
            env: 'staging',
            api: fakeSAApi(),
        });

        // BUG #1: the count must be what is ACTUALLY readable on ctx.vars (X, Y =
        // 2), NOT the raw mapping count (4). Z (null) + W (absent) are dropped.
        expect(out.stdout).toMatch(
            /Loaded 2 vars \+ 0 connections from .* \/ env staging/,
        );

        // And the dropped mappings are honestly disclosed.
        expect(out.stdout).toMatch(
            /2 declared vars had no value in this env and were skipped/,
        );

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

    it('without --env: ctx.vars is empty (no host process.env leak) and the run completes', async () => {
        // BUG #2: the bare form must NOT fetch the platform AND must NOT dump the
        // host process.env into ctx.vars. The echo-vars fixture returns the keys
        // present on ctx.vars — it must be an empty array.
        const out = await runDev({
            entry: ECHO_VARS_FIXTURE,
            input: '{}',
            // no env, no api
        });

        // Honest local-mode summary line (no platform fetch happened).
        expect(out.stdout).toMatch(/Loaded 0 platform vars \(no --env\) — running locally/);

        // The run completed and returned a real result.
        expect(out.result.status).toBe('completed');

        // ctx.vars had ZERO keys — in particular none of the host env leaked in.
        const keys = out.result.output as string[];
        expect(keys).toEqual([]);
        expect(keys).not.toContain('HOME');
        expect(keys).not.toContain('PATH');
        expect(keys).not.toContain('SSH_AUTH_SOCK');
    }, 20_000);

    it('a failing workflow yields a non-completed result (so the command exits non-zero)', async () => {
        // BUG #2 (silent exit-0): the bare path must surface failure, not swallow
        // it. invoke() maps a thrown error to { status: 'failed', phase: 'run' }.
        const out = await runDev({
            entry: BOOM_FIXTURE,
            input: '{}',
            // no env, no api
        });

        expect(out.result.status).not.toBe('completed');
        expect(out.result.status).toBe('failed');
    }, 20_000);
});

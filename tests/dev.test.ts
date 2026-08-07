/**
 * T6.1 — solidactions dev pulls platform vars and runs invoke()
 *
 * Test-double policy: a real in-process HTTP server (Node's http.createServer)
 * mirrors the SA API's variable-mappings endpoint. No mock/spy/stub libraries.
 * Matches the pattern used in proxy-contract.test.ts (Task 5.1).
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as childProcess from 'child_process';
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

    // -----------------------------------------------------------------------
    // F-C6 — dev-mode composition
    // -----------------------------------------------------------------------

    it('reports a dropped secret var distinctly from a dropped plain var ("not available to local dev", not "had no value")', async () => {
        const out = await runDev({
            entry: ECHO_FIXTURE,
            input: '{"n":1}',
            env: 'staging',
            api: {
                projectSlug: 'test-project-staging',
                async fetchVarsAndConnections(): Promise<PlatformVar[]> {
                    return [
                        { env_name: 'SECRET_VAR', resolved_value: null, is_secret: true, source_type: 'plain' },
                    ];
                },
            },
        });

        expect(out.stdout).toMatch(/1 secret var is not available to local dev/);
        expect(out.stdout).not.toMatch(/had no value/);
    }, 20_000);

    it('prints an npm-install hint (not a raw stack trace) when the SDK cannot be resolved', async () => {
        // A fixture entry OUTSIDE this repo's tree has no node_modules ancestor
        // containing @solidactions/sdk, so require.resolve(...) genuinely fails —
        // mirrors a freshly-scaffolded project before `npm install`.
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-dev-no-modules-'));
        const entry = path.join(tmpDir, 'entry.ts');
        fs.writeFileSync(entry, 'export default {};');

        try {
            const out = await runDev({ entry, input: '{}' });
            expect(out.stderr).toMatch(/npm install/);
            expect(out.result.status).toBe('failed');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }, 20_000);
});

// ---------------------------------------------------------------------------
// Multi-file NodeNext fixture — .js-extension relative imports
// ---------------------------------------------------------------------------

const MULTI_FILE_FIXTURE = path.resolve(__dirname, '../fixtures/multi-file/entry.ts');
const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

describe('solidactions dev — multi-file NodeNext project', () => {
    beforeAll(() => {
        if (!fs.existsSync(CLI_BINARY)) {
            throw new Error(
                `CLI not built — run \`npm run build\` first (expected: ${CLI_BINARY})`,
            );
        }
    });

    it('resolves .js-extension imports, exits 0, and prints correct output', () => {
        // Spawn the built CLI binary under plain `node` (NOT tsx) to exercise the
        // real code path. The bug manifests because hasTsLoader() returns true due
        // to Boolean(process._preload_modules) being truthy for an empty array,
        // so the re-exec under tsx is skipped and runDev() runs in-process in a
        // plain CJS node process. When it calls await import(entry.ts), Node.js
        // uses native ESM (because the fixture has "type":"module") and cannot
        // remap the .js extension import to the real double.ts file.
        //
        // Spawning with `npx tsx` would mask the bug (tsx ESM loader remaps .js).
        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_BINARY, 'dev', MULTI_FILE_FIXTURE, '--input', '{"n":3}'],
            {
                encoding: 'utf8',
                env: { ...process.env },
                timeout: 30_000,
            },
        );

        // Must NOT contain the module-resolution error.
        expect(result.stderr ?? '').not.toMatch(/Cannot find module/);
        expect(result.stderr ?? '').not.toMatch(/MODULE_NOT_FOUND/);

        // Must exit 0 (workflow completed).
        expect(result.status).toBe(0);

        // Must print the completion line.
        expect(result.stdout ?? '').toMatch(/completed/);

        // Must print the correct output: double(3) = 6.
        // The CLI prints: Output: <json>
        expect(result.stdout ?? '').toMatch(/Output:.*6/);
    }, 35_000);
});

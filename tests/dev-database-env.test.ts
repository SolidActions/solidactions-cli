/**
 * #140 — `solidactions dev <file> --env <env>` resolves MAPPED WORKSPACE
 * DATABASE credentials, not just plain vars and OAuth connections.
 *
 * The contract under test:
 *   - a `workspace_database` mapping lands on `ctx.vars` as the SDK's
 *     `DatabaseVar` — `{name, url, token, readOnly}` — which is what a DEPLOYED
 *     workflow sees. The platform injects RuntimeEnvBuilder's
 *     `{url, token, name, read_only}` JSON string into the sandbox env and the
 *     SDK's context-adapter parses it; `dev` builds ctx.vars itself and never
 *     runs that adapter, so the CLI must do the conversion or a local workflow
 *     gets a string where a deployed one gets an object;
 *   - it is reported in the summary line and is NEVER counted as a dropped
 *     "declared var had no value in this env" (its resolved_value is always
 *     null on the mappings endpoint by design);
 *   - a mint is attempted as `write` (parity with RuntimeEnvBuilder's
 *     WriteFuse authorization, and what drizzle-kit migrations need) and only
 *     downgrades to `read` on a WRITE-AUTHORITY refusal;
 *   - every failure warns and lets the run continue.
 *
 * Test-double policy: a real in-process HTTP server for the control plane; the
 * SaApiClient seam is a plain object. No mock/spy/stub libraries.
 */

import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';
import { describe, expect, it, afterEach } from 'vitest';
import {
    buildSaApiClient,
    runDev,
    type MappedDatabaseCredential,
    type PlatformVar,
    type SaApiClient,
} from '../src/commands/dev';
import { Config } from '../src/utils/config';

const ECHO_DB_FIXTURE = path.resolve(__dirname, '../fixtures/echo-db.ts');

const DB_MAPPING: PlatformVar = {
    env_name: 'APP_DB',
    source_type: 'workspace_database',
    resolved_value: null,
    workspace_database_name: 'orders',
};

let server: http.Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function startServer(handler: http.RequestListener): Promise<string> {
    return new Promise((resolve) => {
        server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server!.address() as AddressInfo;
            resolve(`http://127.0.0.1:${port}`);
        });
    });
}

function cfg(host: string): Config {
    return { host, apiKey: 'test-api-key', workspaceId: 'ws-123' } as Config;
}

/** A seam client serving the given mappings, with a scripted credential mint. */
function fakeApi(
    vars: PlatformVar[],
    resolve?: (name: string) => Promise<MappedDatabaseCredential>,
): SaApiClient {
    const client: SaApiClient = {
        projectSlug: 'my-proj',
        async fetchVarsAndConnections(): Promise<PlatformVar[]> {
            return vars;
        },
    };
    if (resolve) client.resolveDatabaseCredential = resolve;
    return client;
}

function readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
    });
}

// ---------------------------------------------------------------------------
// runDev integration
// ---------------------------------------------------------------------------

describe('runDev with a mapped workspace database', () => {
    it('injects the RuntimeEnvBuilder envelope on ctx.vars and reports it in the summary', async () => {
        const out = await runDev({
            entry: ECHO_DB_FIXTURE,
            input: '{}',
            env: 'staging',
            api: fakeApi([DB_MAPPING], async (name) => ({
                url: 'libsql://orders-acme.turso.io',
                token: 'mint-token',
                name,
                read_only: false,
            })),
        });

        // The workflow read a DatabaseVar OBJECT — not a JSON string it had to
        // parse — with the SDK's camelCased `readOnly`, exactly as deployed.
        expect(out.result).toEqual({
            status: 'completed',
            output: {
                present: true,
                url: 'libsql://orders-acme.turso.io',
                token: 'mint-token',
                name: 'orders',
                readOnly: false,
            },
        });

        // Counted as a database, NOT as a plain var and NOT as a dropped one.
        expect(out.stdout).toMatch(
            /Loaded 0 vars \+ 0 connections from my-proj \/ env staging \+ 1 database/,
        );
        expect(out.stdout).not.toMatch(/had no value in this env/);
    }, 20_000);

    it('warns — and keeps running — when the mint fails', async () => {
        const out = await runDev({
            entry: ECHO_DB_FIXTURE,
            input: '{}',
            env: 'staging',
            api: fakeApi([DB_MAPPING], async () => {
                throw Object.assign(new Error('This database is not ready for direct access.'), {
                    code: 'database_not_ready',
                });
            }),
        });

        expect(out.stderr).toMatch(
            /APP_DB: failed to resolve database 'orders': This database is not ready for direct access\./,
        );
        expect(out.stdout).not.toMatch(/\+ 1 database/);
        // The run itself still completes — a database failure is not fatal.
        expect(out.result.status).toBe('completed');
        expect(out.result.output).toMatchObject({ present: false });
    }, 20_000);

    it('warns that writes will fail when the credential comes back read-only', async () => {
        const out = await runDev({
            entry: ECHO_DB_FIXTURE,
            input: '{}',
            env: 'staging',
            api: fakeApi([DB_MAPPING], async (name) => ({
                url: 'libsql://orders-acme.turso.io',
                token: 'ro-token',
                name,
                read_only: true,
            })),
        });

        expect(out.stderr).toMatch(
            /APP_DB: database 'orders' resolved READ-ONLY — writes \(including drizzle-kit migrations\) will fail\./,
        );
        expect(out.result.output).toMatchObject({ readOnly: true });
    }, 20_000);

    it('names the variable when the mapping points at a database that no longer exists', async () => {
        const out = await runDev({
            entry: ECHO_DB_FIXTURE,
            input: '{}',
            env: 'staging',
            api: fakeApi([{ ...DB_MAPPING, workspace_database_broken: true }], async () => {
                throw new Error('must not be called');
            }),
        });

        // It must name the REAL fix — the solidactions.yaml declaration synced
        // by `project deploy` — never `env map`, which maps global variables
        // and has no --database flag.
        expect(out.stderr).toContain('APP_DB: mapped database no longer exists.');
        expect(out.stderr).toContain('solidactions.yaml');
        expect(out.stderr).toContain('solidactions project deploy <project> <path>');
        expect(out.stderr).not.toMatch(/\bsolidactions env map\b/);
        expect(out.result.status).toBe('completed');
    }, 20_000);
});

// ---------------------------------------------------------------------------
// The production client's mint, against a real control-plane server
// ---------------------------------------------------------------------------

describe('runDev with a YAML-declared database that does not exist', () => {
    // A typo'd or not-yet-created database name never becomes a
    // `workspace_database` mapping: the platform keeps the YAML declaration and
    // flags yaml_default_not_found, leaving source_type an ordinary valueless
    // var. Before #140's review round that landed in the generic
    // "declared var had no value in this env and was skipped" bucket, which
    // names neither the variable's real problem nor the missing database.
    const TYPO_MAPPING: PlatformVar = {
        env_name: 'APP_DB',
        source_type: 'local',
        resolved_value: null,
        yaml_default_workspace_database_name: 'ordrs',
        yaml_default_not_found: true,
    };

    it('names the variable AND the missing database, never the generic skipped bucket', async () => {
        const out = await runDev({
            entry: ECHO_DB_FIXTURE,
            input: '{}',
            env: 'staging',
            api: fakeApi([TYPO_MAPPING], async () => {
                throw new Error('must not mint for a database that was never found');
            }),
        });

        expect(out.stderr).toContain(
            "APP_DB: mapped database not found — check the database name in solidactions.yaml: "
            + "no database named 'ordrs' exists in this workspace.",
        );
        expect(out.stderr).toContain('`solidactions database create ordrs`');

        // The generic bucket must NOT claim it.
        expect(out.stdout).not.toMatch(/had no value in this env/);
        // And it is disclosed on the summary line rather than passing silently.
        expect(out.stdout).toMatch(/1 declared database was not found in this workspace/);

        // The run still completes — a bad name is not fatal to the whole run.
        expect(out.result.status).toBe('completed');
    }, 20_000);

    it('is not counted as a resolved database', async () => {
        const out = await runDev({
            entry: ECHO_DB_FIXTURE,
            input: '{}',
            env: 'staging',
            api: fakeApi([TYPO_MAPPING]),
        });
        expect(out.stdout).not.toMatch(/\+ 1 database\b/);
    }, 20_000);

    it('does not swallow an ordinary valueless var that declares no database', async () => {
        // Same yaml_default_not_found flag, but the unresolved default is a
        // GLOBAL key, not a database — that must stay in the skipped bucket.
        const out = await runDev({
            entry: ECHO_DB_FIXTURE,
            input: '{}',
            env: 'staging',
            api: fakeApi([{
                env_name: 'SOME_VAR',
                source_type: 'local',
                resolved_value: null,
                yaml_default_not_found: true,
            }]),
        });

        expect(out.stdout).toMatch(/1 declared var had no value in this env/);
        expect(out.stderr).not.toMatch(/mapped database not found/);
    }, 20_000);
});

describe('buildSaApiClient.resolveDatabaseCredential', () => {
    it('mints write mode and returns the RuntimeEnvBuilder envelope', async () => {
        const bodies: any[] = [];
        const host = await startServer(async (req, res) => {
            bodies.push(await readBody(req));
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({
                url: 'libsql://orders-acme.turso.io',
                token: 'write-token',
                mode: 'write',
                expires_at: '2026-08-31T00:10:00Z',
            }));
        });

        const client = buildSaApiClient(cfg(host), 'my-proj');
        const credential = await client.resolveDatabaseCredential!('orders');

        expect(bodies).toEqual([{ operation: 'access', name: 'orders', mode: 'write' }]);
        expect(credential).toEqual({
            url: 'libsql://orders-acme.turso.io',
            token: 'write-token',
            name: 'orders',
            read_only: false,
        });
    });

    it('downgrades to read-only when the write mint is refused for lack of write authority', async () => {
        const modes: string[] = [];
        const host = await startServer(async (req, res) => {
            const body = await readBody(req);
            modes.push(body.mode);
            res.setHeader('content-type', 'application/json');
            if (body.mode === 'write') {
                res.statusCode = 409;
                res.end(JSON.stringify({
                    code: 'writes_exhausted',
                    message: 'This organization has spent its monthly write budget.',
                }));
                return;
            }
            res.end(JSON.stringify({
                url: 'libsql://orders-acme.turso.io',
                token: 'read-token',
                mode: 'read',
                expires_at: '2026-08-31T00:10:00Z',
            }));
        });

        const client = buildSaApiClient(cfg(host), 'my-proj');
        const credential = await client.resolveDatabaseCredential!('orders');

        expect(modes).toEqual(['write', 'read']);
        expect(credential.read_only).toBe(true);
        expect(credential.token).toBe('read-token');
    });

    it.each([
        ['token_missing_ability', 403, 'The token is missing the databases:edit ability.'],
        ['storage_exhausted', 403, 'This organization is over its storage pool.'],
        ['forbidden', 403, 'You do not have permission to manage workspace databases.'],
    ])('downgrades to read-only on the %s write refusal', async (code, status, message) => {
        // Every code in WRITE_AUTHORITY_REFUSAL_CODES means "no WRITE authority
        // here", not "this database is unreachable" — so each must fall back to
        // a read mint rather than failing the run. writes_exhausted is covered
        // by the test above; these are the remaining three.
        const modes: string[] = [];
        const host = await startServer(async (req, res) => {
            const body = await readBody(req);
            modes.push(body.mode);
            res.setHeader('content-type', 'application/json');
            if (body.mode === 'write') {
                res.statusCode = status as number;
                res.end(JSON.stringify({ code, message }));
                return;
            }
            res.end(JSON.stringify({
                url: 'libsql://orders-acme.turso.io',
                token: 'read-token',
                mode: 'read',
                expires_at: '2026-08-31T00:10:00Z',
            }));
        });

        const client = buildSaApiClient(cfg(host), 'my-proj');
        const credential = await client.resolveDatabaseCredential!('orders');

        expect(modes).toEqual(['write', 'read']);
        expect(credential.read_only).toBe(true);
        expect(credential.token).toBe('read-token');
    });

    it('does NOT retry as read when the refusal is about the database itself', async () => {
        // A second mint would fail the same way, burn another attempt against
        // the control plane's 20/min limit, and replace the accurate error.
        const modes: string[] = [];
        const host = await startServer(async (req, res) => {
            const body = await readBody(req);
            modes.push(body.mode);
            res.statusCode = 404;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ code: 'database_not_found', message: 'Database not found.' }));
        });

        const client = buildSaApiClient(cfg(host), 'my-proj');
        await expect(client.resolveDatabaseCredential!('orders')).rejects.toThrow(/Database not found\./);
        expect(modes).toEqual(['write']);
    });
});

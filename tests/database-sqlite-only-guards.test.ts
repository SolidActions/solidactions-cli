import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';
import { databasePushWithConfig } from '../src/commands/database-push';

interface Config { host: string; apiKey: string; workspaceId: string; }
const CONFIG: Config = { host: 'https://app.example.test', apiKey: 'pat', workspaceId: 'ws' };
const DUCKDB_SHOW = { database: { id: 'db-1', name: 'orders', kind: 'duckdb', status: 'ready', size_bytes: 1, deleted_at: null, purge_at: null } };
const KIND_MISMATCH_MESSAGE = '"orders" is an analytical database — use `database ingest` to load data and `database query` to read it';

async function loadDatabaseCommands(): Promise<Record<string, unknown>> {
    const moduleUrl = pathToFileURL(path.resolve(__dirname, '../src/commands/database.ts')).href;
    return await import(moduleUrl) as Record<string, unknown>;
}

function harness() {
    const calls: Array<Record<string, unknown>> = [];
    return {
        calls,
        dependencies: {
            post: async (_url: string, body: Record<string, unknown>) => {
                calls.push(body);
                return { data: DUCKDB_SHOW };
            },
            stdout: () => undefined,
            stderr: () => undefined,
            isTTY: true,
        },
    };
}

// A filesystem stub that throws the moment any of its methods is touched —
// used to prove a guard refuses before any local file or temp-file work,
// not merely before the matching network call.
function forbiddenFilesystem(): unknown {
    return new Proxy({}, {
        get(_target, property) {
            throw new Error(`FILESYSTEM_TOUCHED: ${String(property)}`);
        },
    });
}

describe('SQLite-only verbs refuse an analytical name', () => {
    it('exec refuses with the read-only teaching message and never mints access', async () => {
        const module = await loadDatabaseCommands();
        const databaseExecWithConfig = module.databaseExecWithConfig as Function;
        const test = harness();

        await expect(databaseExecWithConfig('orders', 'delete from t', { yes: true }, CONFIG, test.dependencies))
            .rejects.toMatchObject({
                code: 'read_only',
                message: "read-only: this is an analytical database — load data with `solidactions database ingest` or your workflow's ingest step",
            });
        expect(test.calls).toEqual([{ operation: 'show', name: 'orders' }]);
    });

    it('dump refuses with the kind_mismatch hint', async () => {
        const module = await loadDatabaseCommands();
        const databaseDumpWithConfig = module.databaseDumpWithConfig as Function;
        const test = harness();

        await expect(databaseDumpWithConfig('orders', undefined, { yes: true }, CONFIG, test.dependencies))
            .rejects.toMatchObject({
                code: 'kind_mismatch',
                message: KIND_MISMATCH_MESSAGE,
            });
    });

    it('pull refuses with the kind_mismatch hint, never mints access, and touches no file', async () => {
        const module = await loadDatabaseCommands();
        const databasePullWithConfig = module.databasePullWithConfig as Function;
        const test = harness();

        await expect(databasePullWithConfig('orders', undefined, { yes: true }, CONFIG, {
            ...test.dependencies,
            filesystem: forbiddenFilesystem(),
        })).rejects.toMatchObject({
            code: 'kind_mismatch',
            message: KIND_MISMATCH_MESSAGE,
        });
        expect(test.calls).toEqual([{ operation: 'show', name: 'orders' }]);
    });

    it('push refuses with the kind_mismatch hint and performs no bulk-load request', async () => {
        const test = harness();

        await expect(databasePushWithConfig('orders', '/tmp/does-not-matter.db', { yes: true }, CONFIG, test.dependencies))
            .rejects.toMatchObject({
                code: 'kind_mismatch',
                message: KIND_MISMATCH_MESSAGE,
            });
        // Only the guard's own `show` ran — no `bulk_load_prepare` was ever
        // sent, and the (nonexistent) source file was never normalized.
        expect(test.calls).toEqual([{ operation: 'show', name: 'orders' }]);
    });

    it('import refuses with the kind_mismatch hint', async () => {
        const module = await loadDatabaseCommands();
        const databaseImportWithConfig = module.databaseImportWithConfig as Function;
        const test = harness();

        await expect(databaseImportWithConfig('orders', '/tmp/does-not-matter.sql', { yes: true }, CONFIG, test.dependencies))
            .rejects.toMatchObject({ code: 'kind_mismatch' });
    });
});

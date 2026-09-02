import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';

interface Config { host: string; apiKey: string; workspaceId: string; }
const CONFIG: Config = { host: 'https://app.example.test', apiKey: 'pat', workspaceId: 'ws' };
const DUCKDB_SHOW = { database: { id: 'db-1', name: 'orders', kind: 'duckdb', status: 'ready', size_bytes: 1, deleted_at: null, purge_at: null } };

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
                message: '"orders" is an analytical database — use `database ingest` to load data and `database query` to read it',
            });
    });

    it('import refuses with the kind_mismatch hint', async () => {
        const module = await loadDatabaseCommands();
        const databaseImportWithConfig = module.databaseImportWithConfig as Function;
        const test = harness();

        await expect(databaseImportWithConfig('orders', '/tmp/does-not-matter.sql', { yes: true }, CONFIG, test.dependencies))
            .rejects.toMatchObject({ code: 'kind_mismatch' });
    });
});

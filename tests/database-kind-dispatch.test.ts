import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it, vi } from 'vitest';

interface Config { host: string; apiKey: string; workspaceId: string; }
const CONFIG: Config = { host: 'https://app.example.test', apiKey: 'pat', workspaceId: 'ws' };

async function loadDatabaseCommands(): Promise<Record<string, unknown>> {
    const moduleUrl = pathToFileURL(path.resolve(__dirname, '../src/commands/database.ts')).href;
    return await import(moduleUrl) as Record<string, unknown>;
}

function harness(responses: Record<string, unknown>) {
    const calls: Array<Record<string, unknown>> = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const sleeps: number[] = [];
    return {
        calls,
        stdout,
        stderr,
        sleeps,
        dependencies: {
            post: async (_url: string, body: Record<string, unknown>) => {
                calls.push(body);
                const response = responses[body.operation as string];
                if (typeof response === 'function') return (response as Function)(calls.length);
                return { data: response };
            },
            stdout: (line: string) => stdout.push(line),
            stderr: (line: string) => stderr.push(line),
            isTTY: true,
            sleep: async (ms: number) => { sleeps.push(ms); },
        },
    };
}

const DUCKDB_ROW = { database: { id: 'db-1', name: 'orders', kind: 'duckdb', status: 'ready', size_bytes: 1, deleted_at: null, purge_at: null } };
const LIBSQL_ROW = { database: { id: 'db-2', name: 'app', kind: 'libsql', status: 'ready', size_bytes: 1, deleted_at: null, purge_at: null } };

describe('kind-dispatched schema', () => {
    it('reads analytical schema from the API operation without a data-plane mint', async () => {
        const module = await loadDatabaseCommands();
        const databaseSchemaWithConfig = module.databaseSchemaWithConfig as Function;
        const test = harness({
            show: DUCKDB_ROW,
            schema: { tables: [{ name: 'orders', columns: [{ name: 'id', type: 'BIGINT' }], row_count: 1500000, last_loaded_at: '2026-09-01T00:00:00Z' }] },
        });

        await databaseSchemaWithConfig('orders', { json: true }, CONFIG, test.dependencies);

        expect(test.calls).toEqual([
            { operation: 'show', name: 'orders' },
            { operation: 'schema', name: 'orders' },
        ]);
        expect(JSON.parse(test.stdout.join('\n'))).toEqual({
            tables: [{ name: 'orders', columns: [{ name: 'id', type: 'BIGINT' }], row_count: 1500000, last_loaded_at: '2026-09-01T00:00:00Z' }],
        });
    });

    it('still reads libsql schema through the existing data-plane path', async () => {
        const module = await loadDatabaseCommands();
        const databaseSchemaWithConfig = module.databaseSchemaWithConfig as Function;
        const test = harness({
            show: LIBSQL_ROW,
            access: { url: 'libsql://app.example.test', token: 'tok', mode: 'read', expires_at: '2026-09-01T00:10:00Z' },
        });
        (test.dependencies as any).loadClient = async () => ({
            createClient: () => ({
                execute: async (sql: string) => {
                    if (sql.includes('sqlite_master') && sql.includes("type = 'table'")) {
                        return { columns: ['name', 'sql'], rows: [] };
                    }
                    if (sql.includes('sqlite_master') && sql.includes("type = 'index'")) {
                        return { columns: ['name', 'tbl_name', 'sql'], rows: [] };
                    }
                    return { columns: [], rows: [] };
                },
                close: () => undefined,
            }),
        });

        await databaseSchemaWithConfig('app', { json: true }, CONFIG, test.dependencies);

        expect(test.calls.map((c) => c.operation)).toEqual(['show', 'access']);
    });
});

describe('kind-dispatched query', () => {
    it('queries analytical databases via the API operation with row_limit from --limit', async () => {
        const module = await loadDatabaseCommands();
        const databaseQueryWithConfig = module.databaseQueryWithConfig as Function;
        const test = harness({
            show: DUCKDB_ROW,
            query: { columns: ['day', 'total'], rows: [['2026-01-01', 12.5]], truncated: false, elapsed_ms: 143 },
        });

        await databaseQueryWithConfig('orders', 'select 1', { json: true, limit: 1000 }, CONFIG, test.dependencies);

        expect(test.calls).toEqual([
            { operation: 'show', name: 'orders' },
            { operation: 'query', name: 'orders', sql: 'select 1', row_limit: 1000 },
        ]);
        expect(JSON.parse(test.stdout.join('\n'))).toEqual({
            columns: ['day', 'total'], rows: [['2026-01-01', 12.5]], truncated: false, elapsed_ms: 143,
        });
    });

    it('omits row_limit entirely when --limit is not given', async () => {
        const module = await loadDatabaseCommands();
        const databaseQueryWithConfig = module.databaseQueryWithConfig as Function;
        const test = harness({
            show: DUCKDB_ROW,
            query: { columns: ['n'], rows: [[1]], truncated: false, elapsed_ms: 5 },
        });

        await databaseQueryWithConfig('orders', 'select 1', { json: true }, CONFIG, test.dependencies);

        expect(test.calls).toEqual([
            { operation: 'show', name: 'orders' },
            { operation: 'query', name: 'orders', sql: 'select 1' },
        ]);
    });

    it('renders NULL and a JSON/STRUCT cell legibly in the human table, not as the string "null" or "[object Object]"', async () => {
        const module = await loadDatabaseCommands();
        const databaseQueryWithConfig = module.databaseQueryWithConfig as Function;
        const test = harness({
            show: DUCKDB_ROW,
            query: { columns: ['note', 'tags'], rows: [[null, { a: 1 }]], truncated: false, elapsed_ms: 5 },
        });

        await databaseQueryWithConfig('orders', 'select 1', {}, CONFIG, test.dependencies);

        const output = test.stdout.join('\n');
        expect(output).toContain('NULL');
        expect(output).not.toMatch(/\bnull\b/);
        expect(output).toContain('{"a":1}');
        expect(output).not.toContain('[object Object]');
    });

    it('rejects a --limit outside 1..10000 before making a request', async () => {
        const module = await loadDatabaseCommands();
        const databaseQueryWithConfig = module.databaseQueryWithConfig as Function;
        const test = harness({ show: DUCKDB_ROW });

        await expect(databaseQueryWithConfig('orders', 'select 1', { json: true, limit: 10001 }, CONFIG, test.dependencies))
            .rejects.toMatchObject({ code: 'invalid_limit' });
        expect(test.calls).toEqual([{ operation: 'show', name: 'orders' }]);
    });

    it('rejects a non-numeric --limit (parseInt NaN) as invalid_limit instead of silently passing it through', async () => {
        // `--limit abc` parses via `parseInt(value, 10)` in index.ts, producing NaN. NaN
        // fails both `< 1` and `> 10000`, so the naive range guard let it through, where it
        // would serialize as `row_limit: null` and surface as a generic server 422.
        const module = await loadDatabaseCommands();
        const databaseQueryWithConfig = module.databaseQueryWithConfig as Function;
        const test = harness({ show: DUCKDB_ROW });

        await expect(databaseQueryWithConfig('orders', 'select 1', { json: true, limit: Number.NaN }, CONFIG, test.dependencies))
            .rejects.toMatchObject({ code: 'invalid_limit' });
        expect(test.calls).toEqual([{ operation: 'show', name: 'orders' }]);
    });

    it('retries through a waking response and prints the eventual result', async () => {
        const module = await loadDatabaseCommands();
        const databaseQueryWithConfig = module.databaseQueryWithConfig as Function;
        let queryAttempt = 0;
        const test = harness({
            show: DUCKDB_ROW,
            query: () => {
                queryAttempt += 1;
                if (queryAttempt === 1) {
                    return { data: { code: 'waking', message: 'orders is waking up — retry shortly', retry_after_ms: 5 } };
                }
                return { data: { columns: ['n'], rows: [[1]], truncated: false, elapsed_ms: 12 } };
            },
        });

        await databaseQueryWithConfig('orders', 'select 1', { json: true }, CONFIG, test.dependencies);

        expect(queryAttempt).toBe(2);
        expect(test.sleeps).toEqual([5]);
        expect(JSON.parse(test.stdout.join('\n'))).toEqual({ columns: ['n'], rows: [[1]], truncated: false, elapsed_ms: 12 });
    });

    it('passes a server error through verbatim instead of retrying', async () => {
        const module = await loadDatabaseCommands();
        const databaseQueryWithConfig = module.databaseQueryWithConfig as Function;
        const test = harness({
            show: DUCKDB_ROW,
            query: () => {
                const error: any = new Error('Request failed with status code 408');
                error.response = { status: 408, data: { code: 'query_timeout', timeout_ms: 60000 } };
                throw error;
            },
        });

        await expect(databaseQueryWithConfig('orders', 'select 1', { json: true }, CONFIG, test.dependencies))
            .rejects.toMatchObject({ code: 'query_timeout', status: 408 });
        expect(test.calls.map((c) => c.operation)).toEqual(['show', 'query']);
    });

    it('still runs libsql queries through the existing data-plane path', async () => {
        const module = await loadDatabaseCommands();
        const databaseQueryWithConfig = module.databaseQueryWithConfig as Function;
        const test = harness({
            show: LIBSQL_ROW,
            access: { url: 'libsql://app.example.test', token: 'tok', mode: 'read', expires_at: '2026-09-01T00:10:00Z' },
        });
        (test.dependencies as any).loadClient = async () => ({
            createClient: () => ({
                execute: async () => ({ columns: ['id'], rows: [[1]] }),
                close: () => undefined,
            }),
        });

        await databaseQueryWithConfig('app', 'select 1', { json: true }, CONFIG, test.dependencies);

        expect(test.calls.map((c) => c.operation)).toEqual(['show', 'access']);
    });
});

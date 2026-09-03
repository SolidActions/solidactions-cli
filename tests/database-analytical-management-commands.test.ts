import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';

interface Config { host: string; apiKey: string; workspaceId: string; }
const CONFIG: Config = { host: 'https://app.example.test', apiKey: 'pat', workspaceId: 'ws' };

const DUCKDB_SHOW = { database: { id: 'db-1', name: 'orders', kind: 'duckdb', status: 'ready', size_bytes: 2048, deleted_at: null, purge_at: null } };
const LIBSQL_SHOW = { database: { id: 'db-2', name: 'app', kind: 'libsql', status: 'ready', size_bytes: 1, deleted_at: null, purge_at: null } };
const KIND_MISMATCH = (verb: string) => `"app" is not an analytical database — \`database ${verb}\` only works on analytical (duckdb) databases.`;

async function loadDatabaseCommands(): Promise<Record<string, unknown>> {
    const moduleUrl = pathToFileURL(path.resolve(__dirname, '../src/commands/database.ts')).href;
    return await import(moduleUrl) as Record<string, unknown>;
}

function harness(responses: Record<string, unknown | ((attempt: number) => unknown)>) {
    const calls: Array<Record<string, unknown>> = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const sleeps: number[] = [];
    const attempts: Record<string, number> = {};
    return {
        calls,
        stdout,
        stderr,
        sleeps,
        dependencies: {
            post: async (_url: string, body: Record<string, unknown>) => {
                calls.push(body);
                const operation = body.operation as string;
                attempts[operation] = (attempts[operation] ?? 0) + 1;
                const response = responses[operation];
                return typeof response === 'function' ? { data: (response as Function)(attempts[operation]) } : { data: response };
            },
            stdout: (line: string) => stdout.push(line),
            stderr: (line: string) => stderr.push(line),
            isTTY: true,
            sleep: async (ms: number) => { sleeps.push(ms); },
            confirm: async () => true,
        },
    };
}

function httpError(status: number, code: string, message: string): unknown {
    const error: any = new Error(`Request failed with status code ${status}`);
    error.response = { status, data: { code, message } };
    return error;
}

describe('drop-table', () => {
    it('looks up the kind, confirms, then drops the table with the exact request body', async () => {
        const module = await loadDatabaseCommands();
        const databaseDropTableWithConfig = module.databaseDropTableWithConfig as Function;
        const test = harness({
            show: DUCKDB_SHOW,
            drop_table: { database: { id: 'db-1', name: 'orders', kind: 'duckdb', status: 'ready', size_bytes: 1024, deleted_at: null, purge_at: null } },
        });

        await databaseDropTableWithConfig('orders', 'events', { yes: true, json: true }, CONFIG, test.dependencies);

        expect(test.calls).toEqual([
            { operation: 'show', name: 'orders' },
            { operation: 'drop_table', name: 'orders', table: 'events' },
        ]);
        expect(JSON.parse(test.stdout.join('\n')).database.size_bytes).toBe(1024);
    });

    it('prompts before dropping and cancels without sending drop_table when declined', async () => {
        const module = await loadDatabaseCommands();
        const databaseDropTableWithConfig = module.databaseDropTableWithConfig as Function;
        const test = harness({ show: DUCKDB_SHOW });
        test.dependencies.confirm = async () => false;

        await databaseDropTableWithConfig('orders', 'events', {}, CONFIG, test.dependencies);

        expect(test.calls).toEqual([{ operation: 'show', name: 'orders' }]);
        expect(test.stdout).toEqual(['Cancelled.']);
    });

    it('requires --yes in JSON mode instead of prompting', async () => {
        const module = await loadDatabaseCommands();
        const databaseDropTableWithConfig = module.databaseDropTableWithConfig as Function;
        const test = harness({ show: DUCKDB_SHOW });

        await expect(databaseDropTableWithConfig('orders', 'events', { json: true }, CONFIG, test.dependencies))
            .rejects.toMatchObject({ code: 'confirmation_required' });
        expect(test.calls).toEqual([{ operation: 'show', name: 'orders' }]);
    });

    it('surfaces reserved_table verbatim', async () => {
        const module = await loadDatabaseCommands();
        const databaseDropTableWithConfig = module.databaseDropTableWithConfig as Function;
        const test = harness({ show: DUCKDB_SHOW });
        test.dependencies.post = async (_url: string, body: Record<string, unknown>) => {
            test.calls.push(body);
            if (body.operation === 'show') return { data: DUCKDB_SHOW };
            throw httpError(400, 'reserved_table', 'Reserved table names cannot be dropped.');
        };

        await expect(databaseDropTableWithConfig('orders', '_internal', { yes: true }, CONFIG, test.dependencies))
            .rejects.toMatchObject({ code: 'reserved_table', message: 'Reserved table names cannot be dropped.', status: 400 });
    });

    it('surfaces table_not_found verbatim', async () => {
        const module = await loadDatabaseCommands();
        const databaseDropTableWithConfig = module.databaseDropTableWithConfig as Function;
        const test = harness({ show: DUCKDB_SHOW });
        test.dependencies.post = async (_url: string, body: Record<string, unknown>) => {
            test.calls.push(body);
            if (body.operation === 'show') return { data: DUCKDB_SHOW };
            throw httpError(404, 'table_not_found', 'Table "missing" does not exist.');
        };

        await expect(databaseDropTableWithConfig('orders', 'missing', { yes: true }, CONFIG, test.dependencies))
            .rejects.toMatchObject({ code: 'table_not_found', message: 'Table "missing" does not exist.', status: 404 });
    });

    it('rides out a waking admission response before dropping the table', async () => {
        const module = await loadDatabaseCommands();
        const databaseDropTableWithConfig = module.databaseDropTableWithConfig as Function;
        const test = harness({
            show: DUCKDB_SHOW,
            drop_table: (attempt: number) => (attempt === 1
                ? { code: 'waking', message: 'orders is waking up — retry shortly', retry_after_ms: 5 }
                : { database: { id: 'db-1', name: 'orders', kind: 'duckdb', status: 'ready', size_bytes: 1024, deleted_at: null, purge_at: null } }),
        });

        await databaseDropTableWithConfig('orders', 'events', { yes: true, json: true }, CONFIG, test.dependencies);

        expect(test.calls.filter((c) => c.operation === 'drop_table')).toHaveLength(2);
        expect(test.sleeps).toEqual([5]);
    });

    it('refuses a libsql database before any drop_table request', async () => {
        const module = await loadDatabaseCommands();
        const databaseDropTableWithConfig = module.databaseDropTableWithConfig as Function;
        const test = harness({ show: LIBSQL_SHOW });

        await expect(databaseDropTableWithConfig('app', 'events', { yes: true }, CONFIG, test.dependencies))
            .rejects.toMatchObject({ code: 'kind_mismatch', message: KIND_MISMATCH('drop-table') });
        expect(test.calls).toEqual([{ operation: 'show', name: 'app' }]);
    });
});

describe('optimize', () => {
    it('starts (or reuses) the optimize operation with the exact request body', async () => {
        const module = await loadDatabaseCommands();
        const databaseOptimizeWithConfig = module.databaseOptimizeWithConfig as Function;
        const test = harness({
            show: DUCKDB_SHOW,
            optimize: { operation_id: 'op-1', state: 'running', started_at: 'now' },
        });

        await databaseOptimizeWithConfig('orders', {}, CONFIG, test.dependencies);

        expect(test.calls).toEqual([
            { operation: 'show', name: 'orders' },
            { operation: 'optimize', name: 'orders' },
        ]);
    });

    it('renders a running operation that predates the call as already running, not an error', async () => {
        const module = await loadDatabaseCommands();
        const databaseOptimizeWithConfig = module.databaseOptimizeWithConfig as Function;
        const test = harness({
            show: DUCKDB_SHOW,
            optimize: { operation_id: 'op-1', state: 'running', started_at: new Date(Date.now() - 60_000).toISOString() },
        });

        await databaseOptimizeWithConfig('orders', {}, CONFIG, test.dependencies);

        expect(test.stdout.join('\n')).toMatch(/already running/i);
    });

    it('renders a running operation started by this same call as started, not already running', async () => {
        // C-1: the server returns an identical `{state: 'running', started_at}` body for a
        // freshly-dispatched optimize and for one already in flight (Appendix A.7) — the CLI
        // must not claim "already running" for the one it just started.
        const module = await loadDatabaseCommands();
        const databaseOptimizeWithConfig = module.databaseOptimizeWithConfig as Function;
        const test = harness({
            show: DUCKDB_SHOW,
            optimize: { operation_id: 'op-1', state: 'running', started_at: new Date().toISOString() },
        });

        await databaseOptimizeWithConfig('orders', {}, CONFIG, test.dependencies);

        expect(test.stdout.join('\n')).toMatch(/optimize started/i);
        expect(test.stdout.join('\n')).not.toMatch(/already running/i);
    });

    it('rides out a waking admission response on the initial call', async () => {
        const module = await loadDatabaseCommands();
        const databaseOptimizeWithConfig = module.databaseOptimizeWithConfig as Function;
        const test = harness({
            show: DUCKDB_SHOW,
            optimize: (attempt: number) => (attempt === 1
                ? { code: 'waking', message: 'orders is waking up — retry shortly', retry_after_ms: 5 }
                : { operation_id: 'op-1', state: 'running', started_at: 'now' }),
        });

        await databaseOptimizeWithConfig('orders', {}, CONFIG, test.dependencies);

        expect(test.calls.filter((c) => c.operation === 'optimize')).toHaveLength(2);
        expect(test.sleeps).toEqual([5]);
    });

    describe('--wait', () => {
        it('polls optimize_status until done and prints files before/after', async () => {
            const module = await loadDatabaseCommands();
            const databaseOptimizeWithConfig = module.databaseOptimizeWithConfig as Function;
            const test = harness({
                show: DUCKDB_SHOW,
                optimize: { operation_id: 'op-1', state: 'running', started_at: 'now' },
                optimize_status: (attempt: number) => (attempt < 2
                    ? { operation_id: 'op-1', state: 'running', started_at: 'now' }
                    : { operation_id: 'op-1', state: 'done', files_before: 412, files_after: 9, finished_at: 'later' }),
            });

            await databaseOptimizeWithConfig('orders', { wait: true }, CONFIG, test.dependencies);

            expect(test.calls.filter((c) => c.operation === 'optimize_status')).toHaveLength(2);
            expect(test.stdout.join('\n')).toMatch(/412.*9/);
        });

        it('exits non-zero on a failed optimize', async () => {
            const module = await loadDatabaseCommands();
            const databaseOptimizeWithConfig = module.databaseOptimizeWithConfig as Function;
            const test = harness({
                show: DUCKDB_SHOW,
                optimize: { operation_id: 'op-1', state: 'running', started_at: 'now' },
                optimize_status: { operation_id: 'op-1', state: 'failed', error_code: 'optimize_failed', message: 'boom', finished_at: 'later' },
            });

            await expect(databaseOptimizeWithConfig('orders', { wait: true }, CONFIG, test.dependencies))
                .rejects.toMatchObject({ code: 'optimize_failed', message: 'boom' });
        });

        it('exits non-zero when the deadline passes while still running', async () => {
            const module = await loadDatabaseCommands();
            const databaseOptimizeWithConfig = module.databaseOptimizeWithConfig as Function;
            const test = harness({
                show: DUCKDB_SHOW,
                optimize: { operation_id: 'op-1', state: 'running', started_at: 'now' },
                optimize_status: { operation_id: 'op-1', state: 'running', started_at: 'now' },
            });
            // now() call order: (1) the pre-request `requestedAt` capture
            // (C-1's already-running-vs-just-started heuristic; unused here
            // since the timeout throws first), (2) the initial optimize
            // call's unused wake-wait deadline, (3) the --wait poll deadline
            // (= 0 here), (4) the first loop check (1_000, under deadline ->
            // one poll happens), (5) the second loop check (950_000, past
            // the deadline -> loop stops and the timeout is thrown).
            const timestamps = [0, 0, 0, 1_000, 950_000];
            let nowCalls = 0;
            (test.dependencies as any).now = () => timestamps[Math.min(nowCalls++, timestamps.length - 1)];

            await expect(databaseOptimizeWithConfig('orders', { wait: true }, CONFIG, test.dependencies))
                .rejects.toMatchObject({ code: 'optimize_timeout' });
            expect(test.calls.filter((c) => c.operation === 'optimize_status')).toHaveLength(1);
        });
    });

    it('refuses a libsql database before any optimize request', async () => {
        const module = await loadDatabaseCommands();
        const databaseOptimizeWithConfig = module.databaseOptimizeWithConfig as Function;
        const test = harness({ show: LIBSQL_SHOW });

        await expect(databaseOptimizeWithConfig('app', {}, CONFIG, test.dependencies))
            .rejects.toMatchObject({ code: 'kind_mismatch', message: KIND_MISMATCH('optimize') });
        expect(test.calls).toEqual([{ operation: 'show', name: 'app' }]);
    });
});

describe('connect', () => {
    const CONNECT_RESPONSE = {
        external_read: false,
        cli: { query: 'solidactions database query orders "select …"', ingest: 'solidactions database ingest orders data.parquet --table events' },
        mcp: 'databases_query(name="orders", sql=…)',
        yaml: 'env:\n  - ORDERS_DB: {database: "orders"}',
    };

    it('prints the A.8 shape and the coming-later line, with the exact request body', async () => {
        const module = await loadDatabaseCommands();
        const databaseConnectWithConfig = module.databaseConnectWithConfig as Function;
        const test = harness({ show: DUCKDB_SHOW, connect: CONNECT_RESPONSE });

        await databaseConnectWithConfig('orders', {}, CONFIG, test.dependencies);

        expect(test.calls).toEqual([
            { operation: 'show', name: 'orders' },
            { operation: 'connect', name: 'orders' },
        ]);
        const output = test.stdout.join('\n');
        expect(output).toContain('solidactions database query orders');
        expect(output).toContain('solidactions database ingest orders data.parquet --table events');
        expect(output).toContain('databases_query(name="orders"');
        expect(output).toMatch(/coming later/i);
    });

    it('renders with no credential field — only the A.8 keys are present', async () => {
        const module = await loadDatabaseCommands();
        const databaseConnectWithConfig = module.databaseConnectWithConfig as Function;
        const test = harness({ show: DUCKDB_SHOW, connect: CONNECT_RESPONSE });

        await databaseConnectWithConfig('orders', { json: true }, CONFIG, test.dependencies);

        const parsed = JSON.parse(test.stdout.join('\n'));
        expect(Object.keys(parsed).sort()).toEqual(['cli', 'external_read', 'mcp', 'yaml']);
        expect(JSON.stringify(parsed)).not.toMatch(/password|credential|connection_?string|secret|token/i);
    });

    it('refuses a libsql database before any connect request', async () => {
        const module = await loadDatabaseCommands();
        const databaseConnectWithConfig = module.databaseConnectWithConfig as Function;
        const test = harness({ show: LIBSQL_SHOW });

        await expect(databaseConnectWithConfig('app', {}, CONFIG, test.dependencies))
            .rejects.toMatchObject({ code: 'kind_mismatch', message: KIND_MISMATCH('connect') });
        expect(test.calls).toEqual([{ operation: 'show', name: 'app' }]);
    });
});

describe('wake', () => {
    it('reports active with the exact request body when already awake', async () => {
        const module = await loadDatabaseCommands();
        const databaseWakeWithConfig = module.databaseWakeWithConfig as Function;
        const test = harness({ show: DUCKDB_SHOW, wake: { activity: 'active' } });

        await databaseWakeWithConfig('orders', {}, CONFIG, test.dependencies);

        expect(test.calls).toEqual([
            { operation: 'show', name: 'orders' },
            { operation: 'wake', name: 'orders' },
        ]);
        expect(test.stdout.join('\n')).toMatch(/orders is active/i);
    });

    it('polls until active', async () => {
        const module = await loadDatabaseCommands();
        const databaseWakeWithConfig = module.databaseWakeWithConfig as Function;
        const test = harness({
            show: DUCKDB_SHOW,
            wake: (attempt: number) => (attempt === 1
                ? { code: 'waking', message: 'orders is waking up — retry shortly', retry_after_ms: 5 }
                : { activity: 'active' }),
        });

        await databaseWakeWithConfig('orders', {}, CONFIG, test.dependencies);

        expect(test.calls.filter((c) => c.operation === 'wake')).toHaveLength(2);
        expect(test.stdout.join('\n')).toMatch(/orders is active/i);
    });

    it('refuses a libsql database before any wake request', async () => {
        const module = await loadDatabaseCommands();
        const databaseWakeWithConfig = module.databaseWakeWithConfig as Function;
        const test = harness({ show: LIBSQL_SHOW });

        await expect(databaseWakeWithConfig('app', {}, CONFIG, test.dependencies))
            .rejects.toMatchObject({ code: 'kind_mismatch', message: KIND_MISMATCH('wake') });
        expect(test.calls).toEqual([{ operation: 'show', name: 'app' }]);
    });
});

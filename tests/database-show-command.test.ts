import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';

interface Config {
    host: string;
    apiKey: string;
    workspaceId: string;
}

const CONFIG: Config = {
    host: 'https://app.example.test',
    apiKey: 'control-plane-pat',
    workspaceId: 'workspace-1700',
};

const ANALYTICAL_ROW = {
    id: 'db-orders',
    name: 'orders',
    kind: 'duckdb',
    status: 'ready',
    activity: 'active',
    size_bytes: 1_288_490_188,
    size_limit_bytes: 2_147_483_648,
    over_cap: false,
    table_count: 3,
    last_loaded_at: '2026-09-01T12:00:00Z',
    last_optimized_at: '2026-08-30T04:00:00Z',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-09-01T12:00:00Z',
    deleted_at: null,
    purge_at: null,
};

const STANDARD_ROW = {
    id: 'db-app',
    name: 'app',
    kind: 'libsql',
    status: 'ready',
    size_bytes: 4096,
    created_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
    purge_at: null,
};

async function loadDatabaseCommands(): Promise<Record<string, unknown>> {
    const moduleUrl = pathToFileURL(path.resolve(__dirname, '../src/commands/database.ts')).href;
    return await import(moduleUrl) as Record<string, unknown>;
}

function harness(responseData: unknown) {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const stdout: string[] = [];
    return {
        calls,
        stdout,
        dependencies: {
            post: async (url: string, body: Record<string, unknown>) => {
                calls.push({ url, body });
                return { data: responseData };
            },
            stdout: (line: string) => stdout.push(line),
            stderr: () => undefined,
            isTTY: true,
        },
    };
}

describe('database show', () => {
    it('requests the show operation and renders analytical fields', async () => {
        const module = await loadDatabaseCommands();
        const databaseShowWithConfig = module.databaseShowWithConfig as Function;
        const test = harness({ database: ANALYTICAL_ROW });

        await databaseShowWithConfig('orders', {}, CONFIG, test.dependencies);

        expect(test.calls).toEqual([
            { url: 'https://app.example.test/api/v1/databases', body: { operation: 'show', name: 'orders' } },
        ]);
        const output = test.stdout.join('\n');
        expect(output).toContain('Kind: Analytical · DuckDB (Beta)');
        expect(output).toContain('Activity: active');
        expect(output).toContain('1.2 GiB of 2.0 GiB');
        expect(output).toContain('Tables: 3');
        expect(output).toContain('Last loaded: 2026-09-01T12:00:00Z');
        expect(output).toContain('Last optimized: 2026-08-30T04:00:00Z');
    });

    it('renders a standard row without analytical fields', async () => {
        const module = await loadDatabaseCommands();
        const databaseShowWithConfig = module.databaseShowWithConfig as Function;
        const test = harness({ database: STANDARD_ROW });

        await databaseShowWithConfig('app', {}, CONFIG, test.dependencies);

        const output = test.stdout.join('\n');
        expect(output).toContain('Kind: libsql');
        expect(output).not.toContain('Activity:');
        expect(output).not.toContain('Tables:');
    });

    it('prints the show response unchanged as JSON', async () => {
        const module = await loadDatabaseCommands();
        const databaseShowWithConfig = module.databaseShowWithConfig as Function;
        const test = harness({ database: ANALYTICAL_ROW });

        await databaseShowWithConfig('orders', { json: true }, CONFIG, test.dependencies);

        expect(JSON.parse(test.stdout.join('\n'))).toEqual({ database: ANALYTICAL_ROW });
    });
});

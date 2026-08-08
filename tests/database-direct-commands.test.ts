import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it, vi } from 'vitest';

interface Config {
    host: string;
    apiKey: string;
    workspaceId: string;
}

interface PostCall {
    url: string;
    body: Record<string, unknown>;
    options: { headers: Record<string, string> };
}

const CONFIG: Config = {
    host: 'https://app.example.test',
    apiKey: 'control-plane-pat',
    workspaceId: 'workspace-1146',
};

const ACCESS = {
    url: 'libsql://physical-db.sentinel.invalid?connection=full-url-sentinel',
    token: 'ephemeral-database-token-sentinel',
    mode: 'read' as const,
    expires_at: '2026-08-07T12:10:00Z',
};

async function loadDatabaseCommands(): Promise<Record<string, unknown>> {
    const moduleUrl = pathToFileURL(path.resolve(__dirname, '../src/commands/database.ts')).href;

    try {
        return await import(moduleUrl) as Record<string, unknown>;
    } catch {
        return {};
    }
}

async function requireExport(name: string): Promise<Function> {
    const module = await loadDatabaseCommands();
    expect(module[name], `${name} export`).toBeTypeOf('function');
    return module[name] as Function;
}

function directHarness(
    execute: (statement: unknown) => Promise<unknown>,
    options: { isTTY?: boolean; confirmation?: boolean | undefined } = {},
) {
    const events: string[] = [];
    const posts: PostCall[] = [];
    const clientConfigs: Array<Record<string, unknown>> = [];
    const statements: unknown[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const confirm = vi.fn(async () => Object.prototype.hasOwnProperty.call(options, 'confirmation')
        ? options.confirmation
        : true);
    const close = vi.fn(async () => {
        events.push('close');
    });

    const client = {
        execute: async (statement: unknown) => {
            events.push('execute');
            statements.push(statement);
            return execute(statement);
        },
        close,
    };

    const dependencies = {
        loadClient: async () => {
            events.push('load');
            return {
                createClient: (config: Record<string, unknown>) => {
                    events.push('create');
                    clientConfigs.push(config);
                    return client;
                },
            };
        },
        post: async (
            url: string,
            body: Record<string, unknown>,
            postOptions: { headers: Record<string, string> },
        ) => {
            events.push('mint');
            posts.push({ url, body, options: postOptions });
            return {
                data: {
                    ...ACCESS,
                    mode: body.mode,
                },
            };
        },
        stdout: (line: string) => stdout.push(line),
        stderr: (line: string) => stderr.push(line),
        confirm,
        isTTY: options.isTTY ?? true,
    };

    return {
        events,
        posts,
        clientConfigs,
        statements,
        stdout,
        stderr,
        confirm,
        close,
        dependencies,
    };
}

function statementSql(statement: unknown): string {
    if (typeof statement === 'string') return statement;
    if (statement && typeof statement === 'object' && typeof (statement as any).sql === 'string') {
        return (statement as any).sql;
    }
    return '';
}

function expectSingleAccessPost(test: ReturnType<typeof directHarness>, mode: 'read' | 'write'): void {
    expect(test.posts).toEqual([{
        url: 'https://app.example.test/api/v1/databases',
        body: { operation: 'access', name: 'Analytics', mode },
        options: {
            headers: {
                Accept: 'application/json',
                Authorization: 'Bearer control-plane-pat',
                'Content-Type': 'application/json',
                'X-Workspace-Id': 'workspace-1146',
            },
        },
    }]);
}

function expectEphemeralClient(test: ReturnType<typeof directHarness>): void {
    expect(test.clientConfigs).toEqual([{
        url: ACCESS.url,
        authToken: ACCESS.token,
        intMode: 'string',
    }]);
    expect(test.close).toHaveBeenCalledOnce();
    expect(test.events[0]).toBe('load');
    expect(test.events.indexOf('load')).toBeLessThan(test.events.indexOf('mint'));
}

describe('database schema direct action', () => {
    it('mints once for read access and returns catalog, safely quoted PRAGMA metadata, and numeric PK order', async () => {
        const databaseSchemaWithConfig = await requireExport('databaseSchemaWithConfig');
        const tableName = 'odd"table';
        const tableSql = 'CREATE TABLE "odd""table" (tenant_id INTEGER, item_id INTEGER, body BLOB, PRIMARY KEY (tenant_id, item_id))';
        const indexSql = 'CREATE INDEX idx_odd_body ON "odd""table" (body)';
        const test = directHarness(async (statement) => {
            const sql = statementSql(statement);
            if (/type\s*=\s*'table'/i.test(sql)) {
                return { columns: ['name', 'sql'], rows: [[tableName, tableSql]] };
            }
            if (/type\s*=\s*'index'/i.test(sql)) {
                return { columns: ['name', 'tbl_name', 'sql'], rows: [['idx_odd_body', tableName, indexSql]] };
            }
            if (sql === 'PRAGMA table_info("odd""table")') {
                return {
                    columns: ['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk'],
                    rows: [
                        ['0', 'tenant_id', 'INTEGER', '1', null, '1'],
                        ['1', 'item_id', 'INTEGER', '1', null, '2'],
                        ['2', 'body', 'BLOB', '0', "x'00ff'", '0'],
                    ],
                };
            }
            throw new Error(`Unexpected direct SQL: ${sql}`);
        });

        await databaseSchemaWithConfig('Analytics', { json: true }, CONFIG, test.dependencies);

        expectSingleAccessPost(test, 'read');
        expectEphemeralClient(test);
        expect(test.statements.map(statementSql)).toEqual(expect.arrayContaining([
            expect.stringMatching(/sqlite_master.*type\s*=\s*'table'/i),
            expect.stringMatching(/sqlite_master.*type\s*=\s*'index'/i),
            'PRAGMA table_info("odd""table")',
        ]));
        expect(JSON.stringify(test.posts)).not.toContain('sqlite_master');
        expect(JSON.stringify(test.posts)).not.toContain('PRAGMA');
        expect(JSON.parse(test.stdout.join('\n'))).toEqual({
            database: 'Analytics',
            tables: [{
                name: tableName,
                sql: tableSql,
                columns: [
                    { name: 'tenant_id', type: 'INTEGER', notnull: true, default: null, pk: 1 },
                    { name: 'item_id', type: 'INTEGER', notnull: true, default: null, pk: 2 },
                    { name: 'body', type: 'BLOB', notnull: false, default: "x'00ff'", pk: 0 },
                ],
                indexes: [{ name: 'idx_odd_body', sql: indexSql }],
            }],
        });
        expect(test.stderr).toEqual([]);
    });
});

describe('database query direct action', () => {
    it('fails the native support gate before requesting read access', async () => {
        const databaseQueryWithConfig = await requireExport('databaseQueryWithConfig');
        const test = directHarness(async () => ({ columns: [], rows: [] }));
        test.dependencies.loadClient = async () => {
            test.events.push('load');
            throw new Error('NATIVE_BINDING_FAILURE_SENTINEL');
        };

        await expect(databaseQueryWithConfig(
            'Analytics',
            'SELECT 1',
            { json: true },
            CONFIG,
            test.dependencies,
        )).rejects.toMatchObject({ code: 'database_client_unsupported' });

        expect(test.events).toEqual(['load']);
        expect(test.posts).toEqual([]);
        expect(test.clientConfigs).toEqual([]);
        expect(test.stdout).toEqual([]);
        expect(test.stderr).toEqual([]);
    });

    it('uses one read credential, preserves positional duplicate columns, and normalizes JSON cells', async () => {
        const databaseQueryWithConfig = await requireExport('databaseQueryWithConfig');
        const sql = 'SELECT 7 AS duplicate, 8 AS duplicate, big_value, payload, nullable FROM metrics';
        const test = directHarness(async () => ({
            columns: ['duplicate', 'duplicate', 'big_value', 'payload', 'nullable'],
            rows: [[7n, 8n, 9_223_372_036_854_775_807n, new Uint8Array([0x00, 0xff, 0x10]), null]],
        }));

        await databaseQueryWithConfig('Analytics', sql, { json: true }, CONFIG, test.dependencies);

        expectSingleAccessPost(test, 'read');
        expectEphemeralClient(test);
        expect(test.statements).toEqual([sql]);
        expect(JSON.stringify(test.posts)).not.toContain(sql);
        expect(JSON.parse(test.stdout.join('\n'))).toEqual({
            columns: ['duplicate', 'duplicate', 'big_value', 'payload', 'nullable'],
            rows: [['7', '8', '9223372036854775807', { base64: 'AP8Q' }, null]],
            row_count: 1,
        });
        expect(test.stderr).toEqual([]);
    });

    it('renders the same positional result as a human table with stable bigint, blob, and null cells', async () => {
        const databaseQueryWithConfig = await requireExport('databaseQueryWithConfig');
        const test = directHarness(async () => ({
            columns: ['id', 'payload', 'nullable'],
            rows: [[9_223_372_036_854_775_807n, new Uint8Array([0x00, 0xff, 0x10]), null]],
        }));

        await databaseQueryWithConfig('Analytics', 'SELECT id, payload, nullable FROM metrics', {}, CONFIG, test.dependencies);

        const output = test.stdout.join('\n');
        expect(output).toMatch(/id/i);
        expect(output).toMatch(/payload/i);
        expect(output).toContain('9223372036854775807');
        expect(output).toContain('<blob 3 bytes>');
        expect(output).toContain('NULL');
        expect(test.stderr).toEqual([]);
    });

    it('sends even obvious write SQL through a read-authorized direct client, leaving authorization to the server', async () => {
        const databaseQueryWithConfig = await requireExport('databaseQueryWithConfig');
        const sql = 'DELETE FROM events WHERE id = 42';
        const test = directHarness(async () => ({ columns: [], rows: [] }));

        await databaseQueryWithConfig('Analytics', sql, { json: true }, CONFIG, test.dependencies);

        expectSingleAccessPost(test, 'read');
        expect(test.statements).toEqual([sql]);
        expect(JSON.stringify(test.posts)).not.toContain(sql);
    });
});

describe('database exec direct action', () => {
    it('uses one write credential and returns affected counts plus positional returned rows as JSON', async () => {
        const databaseExecWithConfig = await requireExport('databaseExecWithConfig');
        const sql = 'INSERT INTO events (body) VALUES (\'hello\') RETURNING id, body';
        const test = directHarness(async () => ({
            columns: ['id', 'body'],
            rows: [[9_223_372_036_854_775_807n, 'hello']],
            rowsAffected: 1,
            lastInsertRowid: 9_223_372_036_854_775_807n,
        }));

        await databaseExecWithConfig('Analytics', sql, { yes: true, json: true }, CONFIG, test.dependencies);

        expect(test.confirm).not.toHaveBeenCalled();
        expectSingleAccessPost(test, 'write');
        expectEphemeralClient(test);
        expect(test.statements).toEqual([sql]);
        expect(JSON.stringify(test.posts)).not.toContain(sql);
        expect(JSON.parse(test.stdout.join('\n'))).toEqual({
            columns: ['id', 'body'],
            rows: [['9223372036854775807', 'hello']],
            row_count: 1,
            rows_affected: 1,
            last_insert_rowid: '9223372036854775807',
        });
        expect(test.stderr).toEqual([]);
    });

    it('confirms in a TTY before minting, then reports affected count and returned rows in human output', async () => {
        const databaseExecWithConfig = await requireExport('databaseExecWithConfig');
        const test = directHarness(async () => ({
            columns: ['id'],
            rows: [[12n]],
            rowsAffected: 1,
            lastInsertRowid: 12n,
        }));

        await databaseExecWithConfig('Analytics', 'UPDATE events SET seen = 1 RETURNING id', {}, CONFIG, test.dependencies);

        expect(test.confirm).toHaveBeenCalledOnce();
        expect(test.confirm.mock.calls[0][0]).toMatch(/Analytics/);
        expect(test.events.indexOf('mint')).toBeGreaterThan(test.events.indexOf('load'));
        const output = test.stdout.join('\n');
        expect(output).toMatch(/1\s+row.*affected|rows affected.*1/i);
        expect(output).toContain('id');
        expect(output).toContain('12');
        expect(test.stderr).toEqual([]);
    });

    it.each([
        ['decline', false],
        ['EOF', undefined],
    ])('treats interactive %s as cancellation before native load, mint, or client creation', async (_label, answer) => {
        const databaseExecWithConfig = await requireExport('databaseExecWithConfig');
        const test = directHarness(async () => ({ columns: [], rows: [] }), { confirmation: answer });

        await databaseExecWithConfig('Analytics', 'DROP TABLE events', {}, CONFIG, test.dependencies);

        expect(test.confirm).toHaveBeenCalledOnce();
        expect(test.events).toEqual([]);
        expect(test.posts).toEqual([]);
        expect(test.clientConfigs).toEqual([]);
        expect(test.statements).toEqual([]);
        expect(test.stdout.join('\n')).toMatch(/cancelled/i);
        expect(test.stderr).toEqual([]);
    });

    it.each([
        ['JSON', { json: true }, true],
        ['non-interactive', {}, false],
    ])('requires --yes in %s mode without prompting, loading, minting, or creating a client', async (_label, options, isTTY) => {
        const databaseExecWithConfig = await requireExport('databaseExecWithConfig');
        const test = directHarness(async () => ({ columns: [], rows: [] }), { isTTY });

        await expect(databaseExecWithConfig('Analytics', 'DROP TABLE events', options, CONFIG, test.dependencies))
            .rejects.toMatchObject({ code: 'confirmation_required' });

        expect(test.confirm).not.toHaveBeenCalled();
        expect(test.events).toEqual([]);
        expect(test.posts).toEqual([]);
        expect(test.clientConfigs).toEqual([]);
        expect(test.statements).toEqual([]);
        expect(test.stdout).toEqual([]);
        expect(test.stderr).toEqual([]);
    });
});

describe('database direct command error boundary', () => {
    it.each([
        ['databaseSchemaWithConfig', ['Analytics', { json: true }]],
        ['databaseQueryWithConfig', ['Analytics', 'SELECT * FROM events', { json: true }]],
        ['databaseExecWithConfig', ['Analytics', 'DELETE FROM events', { yes: true, json: true }]],
    ])('scrubs direct failures from %s output, errors, and snapshots', async (exportName, argumentsBeforeConfig) => {
        const handler = await requireExport(exportName);
        const failure = [
            'DIRECT_FAILURE_SENTINEL',
            ACCESS.url,
            'physical-db.sentinel.invalid',
            ACCESS.token,
        ].join(' ');
        const test = directHarness(async () => {
            throw new Error(failure);
        });

        let caught: any;
        try {
            await handler(...argumentsBeforeConfig, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        const publicSurface = {
            error: { code: caught?.code, message: caught?.message },
            stdout: test.stdout,
            stderr: test.stderr,
        };
        expect(publicSurface).toMatchInlineSnapshot(`
          {
            "error": {
              "code": "upstream_unavailable",
              "message": "Database operation failed.",
            },
            "stderr": [],
            "stdout": [],
          }
        `);
        expect(test.close).toHaveBeenCalledOnce();

        const rendered = `${String(caught)}\n${JSON.stringify(caught)}\n${JSON.stringify(publicSurface)}`;
        for (const sentinel of ['DIRECT_FAILURE_SENTINEL', ACCESS.url, 'physical-db.sentinel.invalid', ACCESS.token]) {
            expect(rendered).not.toContain(sentinel);
        }
    });
});

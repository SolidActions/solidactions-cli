import * as readline from 'readline';
import { requireConfigWithWorkspace } from '../utils/api';
import { Config } from '../utils/config';
import {
    DatabaseClient,
    DatabaseClientDependencies,
    DatabaseOperationError,
    DatabaseRequestDependencies,
    DatabaseResultSet,
    formatDatabaseTableValue,
    normalizeDatabaseValue,
    requestDatabaseOperation,
    withDatabaseClient,
} from '../utils/database-data-plane';
import { renderTable } from '../utils/table';

export interface DatabaseRecord {
    name: string;
    status: string;
    deleted_at: string | null;
    purge_at: string | null;
    size_bytes: number;
}

interface DatabaseListResponse {
    databases: DatabaseRecord[];
    quota: {
        used: number;
        limit: number;
    };
}

interface DatabaseMutationResponse {
    database: DatabaseRecord;
}

interface DatabaseListOptions {
    json?: boolean;
}

interface DatabaseCreateOptions {
    from?: string;
    json?: boolean;
}

interface DatabaseDeleteOptions {
    yes?: boolean;
    json?: boolean;
}

interface DatabaseUndeleteOptions {
    json?: boolean;
}

interface DatabaseSchemaOptions {
    json?: boolean;
}

interface DatabaseQueryOptions {
    json?: boolean;
}

interface DatabaseExecOptions {
    yes?: boolean;
    json?: boolean;
}

export interface DatabaseCommandDependencies extends DatabaseClientDependencies {
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
    confirm?: (message: string) => Promise<boolean | undefined>;
    isTTY?: boolean;
    importDatabase?: (name: string, file: string) => Promise<void>;
}

interface ResolvedCommandDependencies {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
    confirm: (message: string) => Promise<boolean>;
    isTTY: boolean;
    importDatabase: (name: string, file: string) => Promise<void>;
    post: DatabaseCommandDependencies['post'];
    loadClient: DatabaseCommandDependencies['loadClient'];
}

function defaultConfirmation(message: string): Promise<boolean> {
    const input = readline.createInterface({ input: process.stdin, output: process.stdout });

    return new Promise((resolve) => {
        let settled = false;
        const finish = (confirmed: boolean) => {
            if (settled) return;
            settled = true;
            resolve(confirmed);
        };

        input.once('close', () => finish(false));
        input.question(`${message} [y/N] `, (answer) => {
            finish(/^y(?:es)?$/i.test(answer.trim()));
            input.close();
        });
    });
}

async function unavailableImportHandoff(name: string, _file: string): Promise<void> {
    throw new DatabaseOperationError(
        'import_failed',
        `Database "${name}" was created, but SQL import is not available yet. The database remains in place.`,
    );
}

function resolveDependencies(dependencies: DatabaseCommandDependencies): ResolvedCommandDependencies {
    return {
        stdout: dependencies.stdout ?? ((line) => console.log(line)),
        stderr: dependencies.stderr ?? ((line) => console.error(line)),
        confirm: async (message) => (await (dependencies.confirm ?? defaultConfirmation)(message)) === true,
        isTTY: dependencies.isTTY ?? process.stdin.isTTY === true,
        importDatabase: dependencies.importDatabase ?? unavailableImportHandoff,
        post: dependencies.post,
        loadClient: dependencies.loadClient,
    };
}

function requestDependencies(dependencies: ResolvedCommandDependencies): DatabaseRequestDependencies {
    return { post: dependencies.post };
}

function clientDependencies(dependencies: ResolvedCommandDependencies): DatabaseClientDependencies {
    return {
        post: dependencies.post,
        loadClient: dependencies.loadClient,
    };
}

function stableDatabaseRecord(database: DatabaseRecord | null | undefined): DatabaseRecord {
    if (
        !database
        || typeof database.name !== 'string'
        || typeof database.status !== 'string'
        || typeof database.size_bytes !== 'number'
        || (database.deleted_at !== null && typeof database.deleted_at !== 'string')
        || (database.purge_at !== null && typeof database.purge_at !== 'string')
    ) {
        throw new DatabaseOperationError('upstream_unavailable', 'The database response was invalid.');
    }

    return {
        name: database.name,
        status: database.status,
        deleted_at: database.deleted_at,
        purge_at: database.purge_at,
        size_bytes: database.size_bytes,
    };
}

function stableDatabaseResponse(data: DatabaseMutationResponse): DatabaseMutationResponse {
    return { database: stableDatabaseRecord(data?.database) };
}

function stableListResponse(data: DatabaseListResponse): DatabaseListResponse {
    if (
        !data
        || !Array.isArray(data.databases)
        || typeof data.quota?.used !== 'number'
        || typeof data.quota?.limit !== 'number'
    ) {
        throw new DatabaseOperationError('upstream_unavailable', 'The database response was invalid.');
    }

    return {
        databases: data.databases.map(stableDatabaseRecord),
        quota: {
            used: data.quota.used,
            limit: data.quota.limit,
        },
    };
}

function databaseRows(databases: DatabaseRecord[]): string[][] {
    return databases.map((database) => [
        database.name,
        database.status,
        String(database.size_bytes),
        database.deleted_at ?? '-',
        database.purge_at ?? '-',
    ]);
}

function renderDatabaseTable(databases: DatabaseRecord[]): string {
    return renderTable(
        ['NAME', 'STATUS', 'SIZE (BYTES)', 'DELETED AT', 'PURGE AT'],
        databaseRows(databases),
    ).join('\n');
}

function renderMutation(
    operation: 'create' | 'delete' | 'undelete',
    database: DatabaseRecord,
): string {
    const verb = operation === 'create'
        ? 'created'
        : operation === 'delete'
            ? 'deleted'
            : 'restored';

    return `Database "${database.name}" ${verb}.\n${renderDatabaseTable([database])}`;
}

function writeJson(stdout: (line: string) => void, data: unknown): void {
    stdout(JSON.stringify(data, null, 2));
}

interface StableDirectResult {
    columns: string[];
    rows: unknown[][];
    rowsAffected: number;
    lastInsertRowid: unknown;
}

interface DatabaseSchemaColumn {
    name: string;
    type: string;
    notnull: boolean;
    default: unknown;
    pk: number;
}

interface DatabaseSchemaIndex {
    name: string;
    sql: string | null;
}

interface DatabaseSchemaTable {
    name: string;
    sql: string;
    columns: DatabaseSchemaColumn[];
    indexes: DatabaseSchemaIndex[];
}

interface DatabaseSchemaResponse {
    database: string;
    tables: DatabaseSchemaTable[];
}

const TABLE_CATALOG_SQL = "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name";
const INDEX_CATALOG_SQL = "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name";

function isDirectValue(value: unknown): boolean {
    return value === null
        || typeof value === 'string'
        || (typeof value === 'number' && Number.isFinite(value))
        || typeof value === 'bigint'
        || value instanceof ArrayBuffer
        || ArrayBuffer.isView(value);
}

function stableLastInsertRowid(value: unknown): string | number | bigint | null {
    if (value === undefined || value === null) {
        return null;
    }

    if (typeof value === 'bigint') {
        return value;
    }

    if (typeof value === 'number' && Number.isSafeInteger(value)) {
        return value;
    }

    if (typeof value === 'string' && /^-?\d+$/.test(value)) {
        return value;
    }

    throw new Error('Invalid last insert row ID.');
}

function stableDirectResult(result: DatabaseResultSet): StableDirectResult {
    if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) {
        throw new Error('Invalid database result.');
    }

    if (!result.columns.every((column) => typeof column === 'string')) {
        throw new Error('Invalid database result columns.');
    }

    const rows = result.rows.map((row) => {
        if (
            row === null
            || typeof row !== 'object'
            || !Number.isSafeInteger(row.length)
            || row.length !== result.columns.length
        ) {
            throw new Error('Invalid database result row.');
        }

        const positional = Array.from({ length: row.length }, (_, index) => row[index]);
        if (!positional.every(isDirectValue)) {
            throw new Error('Invalid database result value.');
        }

        return positional;
    });

    if (
        result.rowsAffected !== undefined
        && (!Number.isSafeInteger(result.rowsAffected) || result.rowsAffected < 0)
    ) {
        throw new Error('Invalid affected row count.');
    }

    return {
        columns: [...result.columns],
        rows,
        rowsAffected: result.rowsAffected ?? 0,
        lastInsertRowid: stableLastInsertRowid(result.lastInsertRowid),
    };
}

function sqliteInteger(value: unknown): number {
    if (
        (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint')
        || String(value).trim() === ''
    ) {
        throw new Error('Invalid SQLite integer.');
    }

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error('Invalid SQLite integer.');
    }

    return parsed;
}

function sqliteBoolean(value: unknown): boolean {
    const parsed = sqliteInteger(value);
    if (parsed !== 0 && parsed !== 1) {
        throw new Error('Invalid SQLite boolean.');
    }

    return parsed === 1;
}

function requiredString(value: unknown): string {
    if (typeof value !== 'string') {
        throw new Error('Invalid database metadata.');
    }

    return value;
}

function nullableString(value: unknown): string | null {
    if (value === null || typeof value === 'string') {
        return value;
    }

    throw new Error('Invalid database metadata.');
}

function quotePragmaIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

function normalizedRows(result: StableDirectResult): unknown[][] {
    return result.rows.map((row) => row.map(normalizeDatabaseValue));
}

function renderDirectTable(result: StableDirectResult): string {
    return renderTable(
        result.columns,
        result.rows.map((row) => row.map(formatDatabaseTableValue)),
    ).join('\n');
}

async function readDatabaseSchema(client: DatabaseClient, database: string): Promise<DatabaseSchemaResponse> {
    const tablesResult = stableDirectResult(await client.execute(TABLE_CATALOG_SQL));
    const indexesResult = stableDirectResult(await client.execute(INDEX_CATALOG_SQL));
    const indexesByTable = new Map<string, DatabaseSchemaIndex[]>();

    for (const row of indexesResult.rows) {
        const index: DatabaseSchemaIndex = {
            name: requiredString(row[0]),
            sql: nullableString(row[2]),
        };
        const tableName = requiredString(row[1]);
        indexesByTable.set(tableName, [...(indexesByTable.get(tableName) ?? []), index]);
    }

    const tables: DatabaseSchemaTable[] = [];
    for (const row of tablesResult.rows) {
        const name = requiredString(row[0]);
        const pragma = `PRAGMA table_info(${quotePragmaIdentifier(name)})`;
        const columnsResult = stableDirectResult(await client.execute(pragma));
        const columns = columnsResult.rows.map((column): DatabaseSchemaColumn => ({
            name: requiredString(column[1]),
            type: requiredString(column[2]),
            notnull: sqliteBoolean(column[3]),
            default: normalizeDatabaseValue(column[4]),
            pk: sqliteInteger(column[5]),
        }));

        tables.push({
            name,
            sql: requiredString(row[1]),
            columns,
            indexes: indexesByTable.get(name) ?? [],
        });
    }

    return { database, tables };
}

function renderSchema(schema: DatabaseSchemaResponse): string {
    if (schema.tables.length === 0) {
        return `Database: ${schema.database}\nNo tables.`;
    }

    const sections = [`Database: ${schema.database}`];
    for (const table of schema.tables) {
        sections.push(
            `Table: ${table.name}`,
            renderTable(
                ['NAME', 'TYPE', 'NOT NULL', 'DEFAULT', 'PK ORDER'],
                table.columns.map((column) => [
                    column.name,
                    column.type,
                    column.notnull ? 'yes' : 'no',
                    formatDatabaseTableValue(column.default),
                    String(column.pk),
                ]),
            ).join('\n'),
        );

        if (table.indexes.length > 0) {
            sections.push(
                'Indexes:',
                renderTable(
                    ['NAME', 'SQL'],
                    table.indexes.map((index) => [index.name, index.sql ?? 'NULL']),
                ).join('\n'),
            );
        }
    }

    return sections.join('\n\n');
}

export async function databaseListWithConfig(
    options: DatabaseListOptions,
    config: Config,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    const io = resolveDependencies(dependencies);
    const data = stableListResponse(await requestDatabaseOperation<DatabaseListResponse>(
        config,
        { operation: 'list' },
        requestDependencies(io),
    ));

    if (options.json) {
        writeJson(io.stdout, data);
        return;
    }

    io.stdout(`${renderDatabaseTable(data.databases)}\nQuota: ${data.quota.used} / ${data.quota.limit}`);
}

export async function databaseCreateWithConfig(
    name: string,
    options: DatabaseCreateOptions,
    config: Config,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    const io = resolveDependencies(dependencies);
    const data = stableDatabaseResponse(await requestDatabaseOperation<DatabaseMutationResponse>(
        config,
        { operation: 'create', name },
        requestDependencies(io),
    ));

    if (options.from) {
        try {
            await io.importDatabase(data.database.name, options.from);
        } catch {
            throw new DatabaseOperationError(
                'import_failed',
                `Database "${data.database.name}" was created, but its SQL import failed. The database remains in place.`,
            );
        }
    }

    if (options.json) {
        writeJson(io.stdout, data);
        return;
    }

    io.stdout(renderMutation('create', data.database));
}

export async function databaseDeleteWithConfig(
    name: string,
    options: DatabaseDeleteOptions,
    config: Config,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    const io = resolveDependencies(dependencies);

    if (!options.yes) {
        if (options.json || !io.isTTY) {
            throw new DatabaseOperationError(
                'confirmation_required',
                'Database deletion requires --yes in JSON or non-interactive mode.',
            );
        }

        if (!await io.confirm(`Delete database "${name}"?`)) {
            io.stdout('Cancelled.');
            return;
        }
    }

    const data = stableDatabaseResponse(await requestDatabaseOperation<DatabaseMutationResponse>(
        config,
        { operation: 'delete', name },
        requestDependencies(io),
    ));

    if (options.json) {
        writeJson(io.stdout, data);
        return;
    }

    io.stdout(renderMutation('delete', data.database));
}

export async function databaseUndeleteWithConfig(
    name: string,
    options: DatabaseUndeleteOptions,
    config: Config,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    const io = resolveDependencies(dependencies);
    const data = stableDatabaseResponse(await requestDatabaseOperation<DatabaseMutationResponse>(
        config,
        { operation: 'undelete', name },
        requestDependencies(io),
    ));

    if (options.json) {
        writeJson(io.stdout, data);
        return;
    }

    io.stdout(renderMutation('undelete', data.database));
}

export async function databaseSchemaWithConfig(
    name: string,
    options: DatabaseSchemaOptions,
    config: Config,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    const io = resolveDependencies(dependencies);
    const schema = await withDatabaseClient(
        config,
        name,
        'read',
        (client) => readDatabaseSchema(client, name),
        clientDependencies(io),
    );

    if (options.json) {
        writeJson(io.stdout, schema);
        return;
    }

    io.stdout(renderSchema(schema));
}

export async function databaseQueryWithConfig(
    name: string,
    sql: string,
    options: DatabaseQueryOptions,
    config: Config,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    const io = resolveDependencies(dependencies);
    const result = await withDatabaseClient(
        config,
        name,
        'read',
        async (client) => stableDirectResult(await client.execute(sql)),
        clientDependencies(io),
    );

    if (options.json) {
        writeJson(io.stdout, {
            columns: result.columns,
            rows: normalizedRows(result),
            row_count: result.rows.length,
        });
        return;
    }

    io.stdout(result.columns.length > 0 ? renderDirectTable(result) : 'No rows returned.');
}

export async function databaseExecWithConfig(
    name: string,
    sql: string,
    options: DatabaseExecOptions,
    config: Config,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    const io = resolveDependencies(dependencies);

    if (!options.yes) {
        if (options.json || !io.isTTY) {
            throw new DatabaseOperationError(
                'confirmation_required',
                'Database execution requires --yes in JSON or non-interactive mode.',
            );
        }

        if (!await io.confirm(`Execute SQL against database "${name}"?`)) {
            io.stdout('Cancelled.');
            return;
        }
    }

    const result = await withDatabaseClient(
        config,
        name,
        'write',
        async (client) => stableDirectResult(await client.execute(sql)),
        clientDependencies(io),
    );

    if (options.json) {
        writeJson(io.stdout, {
            columns: result.columns,
            rows: normalizedRows(result),
            row_count: result.rows.length,
            rows_affected: result.rowsAffected,
            last_insert_rowid: normalizeDatabaseValue(result.lastInsertRowid),
        });
        return;
    }

    const output = [`Rows affected: ${result.rowsAffected}`];
    if (result.rows.length > 0 && result.columns.length > 0) {
        output.push(renderDirectTable(result));
    }
    io.stdout(output.join('\n'));
}

export async function databaseList(
    options: DatabaseListOptions,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    await databaseListWithConfig(options, await requireConfigWithWorkspace(), dependencies);
}

export async function databaseCreate(
    name: string,
    options: DatabaseCreateOptions,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    await databaseCreateWithConfig(name, options, await requireConfigWithWorkspace(), dependencies);
}

export async function databaseDelete(
    name: string,
    options: DatabaseDeleteOptions,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    await databaseDeleteWithConfig(name, options, await requireConfigWithWorkspace(), dependencies);
}

export async function databaseUndelete(
    name: string,
    options: DatabaseUndeleteOptions,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    await databaseUndeleteWithConfig(name, options, await requireConfigWithWorkspace(), dependencies);
}

export async function databaseSchema(
    name: string,
    options: DatabaseSchemaOptions,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    await databaseSchemaWithConfig(name, options, await requireConfigWithWorkspace(), dependencies);
}

export async function databaseQuery(
    name: string,
    sql: string,
    options: DatabaseQueryOptions,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    await databaseQueryWithConfig(name, sql, options, await requireConfigWithWorkspace(), dependencies);
}

export async function databaseExec(
    name: string,
    sql: string,
    options: DatabaseExecOptions,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    await databaseExecWithConfig(name, sql, options, await requireConfigWithWorkspace(), dependencies);
}

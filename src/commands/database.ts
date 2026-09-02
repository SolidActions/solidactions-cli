import fs from 'fs';
import path from 'path';
import * as readline from 'readline';
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
import { requireConfigWithWorkspace } from '../utils/api';
import { Config } from '../utils/config';
import {
    DatabaseClient,
    DatabaseClientDependencies,
    DatabaseAccess,
    DatabaseCredentialDeadline,
    DatabaseOperationError,
    DatabaseRequestDependencies,
    DatabaseResultSet,
    DEFAULT_DATABASE_DATA_PLANE_TIMEOUT_MS,
    databaseCredentialDeadline,
    databaseCredentialFailureCode,
    formatDatabaseTableValue,
    normalizeDatabaseValue,
    isDatabaseCredentialAuthFailure,
    runDatabaseClientOperationWithDeadline,
    requestDatabaseAccess,
    requestDatabaseDumpStream,
    requestDatabaseOperation,
    withDatabaseClient,
} from '../utils/database-data-plane';
import { loadDatabaseClientBeforeMint } from '../utils/database-client-support';
import { DatabaseSqlStatementAccumulator } from '../utils/database-sql-import';
export { parseDatabaseImportSql } from '../utils/database-sql-import';
import {
    bindPreparedDatabaseImport,
    prepareDatabaseImport,
    prepareDatabaseImportSource,
    runPreparedDatabaseImport,
} from '../utils/database-sql-import-runner';
import { renderTable } from '../utils/table';

export type DatabaseKind = 'libsql' | 'duckdb';
export type DatabaseActivity = 'active' | 'idle' | 'idle_no_credit' | 'waking' | 'optimizing';

export interface DatabaseRecord {
    id?: string;
    name: string;
    kind: DatabaseKind;
    status: string;
    activity?: DatabaseActivity;
    deleted_at: string | null;
    purge_at: string | null;
    size_bytes: number;
    size_limit_bytes?: number;
    over_cap?: boolean;
    table_count?: number;
    last_loaded_at?: string | null;
    last_optimized_at?: string | null;
    created_at?: string;
    updated_at?: string;
}

export interface DatabaseQuota {
    used: number;
    limit: number;
    scope: 'workspace' | 'org';
}

interface DatabaseListResponse {
    databases: DatabaseRecord[];
    quota: {
        libsql: DatabaseQuota;
        duckdb: DatabaseQuota;
    };
}

interface DatabaseMutationResponse {
    database: DatabaseRecord;
}

interface DatabaseListOptions {
    kind?: DatabaseKind;
    json?: boolean;
}

interface DatabaseCreateOptions {
    from?: string;
    kind?: DatabaseKind;
    wait?: boolean;
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
    limit?: number;
    json?: boolean;
}

interface DatabaseExecOptions {
    yes?: boolean;
    json?: boolean;
}

interface DatabaseDumpOptions {
    yes?: boolean;
}

interface DatabasePullOptions {
    yes?: boolean;
    writable?: boolean;
}

interface DatabaseImportOptions {
    yes?: boolean;
    resume?: string;
}

type DatabaseFileSystem = typeof fs.promises;

export interface DatabaseCommandDependencies extends DatabaseClientDependencies {
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
    confirm?: (message: string) => Promise<boolean | undefined>;
    isTTY?: boolean;
    importDatabase?: (name: string, file: string) => Promise<void>;
    cwd?: string;
    tempPath?: (target: string) => string;
    filesystem?: DatabaseFileSystem;
    input?: AsyncIterable<string>;
    now?: () => number;
    monotonicNow?: () => number;
    abortSignal?: AbortSignal;
    sleep?: (milliseconds: number) => Promise<void>;
}

interface ResolvedCommandDependencies {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
    confirm: (message: string) => Promise<boolean>;
    isTTY: boolean;
    importDatabase?: (name: string, file: string) => Promise<void>;
    post: DatabaseCommandDependencies['post'];
    loadClient: DatabaseCommandDependencies['loadClient'];
    cwd: string;
    tempPath: (target: string) => string;
    filesystem: DatabaseFileSystem;
    input?: AsyncIterable<string>;
    now: () => number;
    monotonicNow: () => number;
    abortSignal?: AbortSignal;
    controlPlaneTimeoutMs: number | undefined;
    dataPlaneTimeoutMs: number;
    sleep: (milliseconds: number) => Promise<void>;
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

function resolveDependencies(dependencies: DatabaseCommandDependencies): ResolvedCommandDependencies {
    return {
        stdout: dependencies.stdout ?? ((line) => console.log(line)),
        stderr: dependencies.stderr ?? ((line) => console.error(line)),
        confirm: async (message) => (await (dependencies.confirm ?? defaultConfirmation)(message)) === true,
        isTTY: dependencies.isTTY ?? process.stdin.isTTY === true,
        importDatabase: dependencies.importDatabase,
        post: dependencies.post,
        loadClient: dependencies.loadClient,
        cwd: dependencies.cwd ?? process.cwd(),
        tempPath: dependencies.tempPath ?? ((target) => path.join(
            path.dirname(target),
            `.${path.basename(target)}.solidactions-${randomUUID()}.tmp`,
        )),
        filesystem: dependencies.filesystem ?? fs.promises,
        input: dependencies.input,
        now: dependencies.now ?? Date.now,
        monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
        abortSignal: dependencies.abortSignal,
        controlPlaneTimeoutMs: dependencies.controlPlaneTimeoutMs,
        dataPlaneTimeoutMs: dependencies.dataPlaneTimeoutMs ?? DEFAULT_DATABASE_DATA_PLANE_TIMEOUT_MS,
        sleep: dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => {
            setTimeout(resolve, milliseconds);
        })),
    };
}

function requestDependencies(dependencies: ResolvedCommandDependencies): DatabaseRequestDependencies {
    return {
        post: dependencies.post,
        controlPlaneTimeoutMs: dependencies.controlPlaneTimeoutMs,
    };
}

function clientDependencies(dependencies: ResolvedCommandDependencies): DatabaseClientDependencies {
    return {
        post: dependencies.post,
        loadClient: dependencies.loadClient,
        controlPlaneTimeoutMs: dependencies.controlPlaneTimeoutMs,
        dataPlaneTimeoutMs: dependencies.dataPlaneTimeoutMs,
    };
}

function stableDatabaseRecord(database: DatabaseRecord | null | undefined): DatabaseRecord {
    if (
        !database
        || (database.id !== undefined && typeof database.id !== 'string')
        || typeof database.name !== 'string'
        || typeof database.status !== 'string'
        || typeof database.size_bytes !== 'number'
        || (database.deleted_at !== null && typeof database.deleted_at !== 'string')
        || (database.purge_at !== null && typeof database.purge_at !== 'string')
        || (database.kind !== undefined && database.kind !== 'libsql' && database.kind !== 'duckdb')
        || (database.activity !== undefined && typeof database.activity !== 'string')
        || (database.size_limit_bytes !== undefined && typeof database.size_limit_bytes !== 'number')
        || (database.over_cap !== undefined && typeof database.over_cap !== 'boolean')
        || (database.table_count !== undefined && typeof database.table_count !== 'number')
        || (
            database.last_loaded_at !== undefined
            && database.last_loaded_at !== null
            && typeof database.last_loaded_at !== 'string'
        )
        || (
            database.last_optimized_at !== undefined
            && database.last_optimized_at !== null
            && typeof database.last_optimized_at !== 'string'
        )
        || (database.created_at !== undefined && typeof database.created_at !== 'string')
        || (database.updated_at !== undefined && typeof database.updated_at !== 'string')
    ) {
        throw new DatabaseOperationError('upstream_unavailable', 'The database response was invalid.');
    }

    // `kind` defaults to 'libsql' for a server response that predates this
    // field — every existing fixture across the suite keeps validating.
    const kind: DatabaseKind = database.kind === 'duckdb' ? 'duckdb' : 'libsql';

    return {
        ...(database.id === undefined ? {} : { id: database.id }),
        name: database.name,
        kind,
        status: database.status,
        ...(database.activity === undefined ? {} : { activity: database.activity }),
        deleted_at: database.deleted_at,
        purge_at: database.purge_at,
        size_bytes: database.size_bytes,
        ...(database.size_limit_bytes === undefined ? {} : { size_limit_bytes: database.size_limit_bytes }),
        ...(database.over_cap === undefined ? {} : { over_cap: database.over_cap }),
        ...(database.table_count === undefined ? {} : { table_count: database.table_count }),
        ...(database.last_loaded_at === undefined ? {} : { last_loaded_at: database.last_loaded_at }),
        ...(database.last_optimized_at === undefined ? {} : { last_optimized_at: database.last_optimized_at }),
        ...(database.created_at === undefined ? {} : { created_at: database.created_at }),
        ...(database.updated_at === undefined ? {} : { updated_at: database.updated_at }),
    };
}

function stableDatabaseResponse(data: DatabaseMutationResponse): DatabaseMutationResponse {
    return { database: stableDatabaseRecord(data?.database) };
}

function stableQuota(quota: DatabaseQuota | null | undefined): DatabaseQuota {
    if (
        !quota
        || typeof quota.used !== 'number'
        || typeof quota.limit !== 'number'
        || (quota.scope !== 'workspace' && quota.scope !== 'org')
    ) {
        throw new DatabaseOperationError('upstream_unavailable', 'The database response was invalid.');
    }
    return { used: quota.used, limit: quota.limit, scope: quota.scope };
}

function stableListResponse(data: DatabaseListResponse): DatabaseListResponse {
    if (!data || !Array.isArray(data.databases)) {
        throw new DatabaseOperationError('upstream_unavailable', 'The database response was invalid.');
    }

    return {
        databases: data.databases.map(stableDatabaseRecord),
        quota: {
            libsql: stableQuota(data.quota?.libsql),
            duckdb: stableQuota(data.quota?.duckdb),
        },
    };
}

function databaseRows(databases: DatabaseRecord[]): string[][] {
    return databases.map((database) => [
        database.name,
        database.kind,
        database.status,
        database.kind === 'duckdb' ? (database.activity ?? '-') : '-',
        database.kind === 'duckdb'
            ? `${formatByteSize(database.size_bytes)} / ${formatByteSize(database.size_limit_bytes ?? 0)}`
            : String(database.size_bytes),
        database.deleted_at ?? '-',
        database.purge_at ?? '-',
    ]);
}

function renderDatabaseTable(databases: DatabaseRecord[]): string {
    return renderTable(
        ['NAME', 'KIND', 'STATUS', 'ACTIVITY', 'SIZE', 'DELETED AT', 'PURGE AT'],
        databaseRows(databases),
    ).join('\n');
}

function renderQuota(quota: DatabaseListResponse['quota']): string {
    return [
        `Quota: libsql ${quota.libsql.used} / ${quota.libsql.limit} (${quota.libsql.scope})`,
        `       duckdb ${quota.duckdb.used} / ${quota.duckdb.limit} (${quota.duckdb.scope})`,
    ].join('\n');
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

interface AnalyticalSchemaColumn {
    name: string;
    type: string;
}

interface AnalyticalSchemaTable {
    name: string;
    columns: AnalyticalSchemaColumn[];
    row_count: number;
    last_loaded_at: string | null;
}

interface AnalyticalSchemaResponse {
    tables: AnalyticalSchemaTable[];
}

function stableAnalyticalSchemaColumn(column: AnalyticalSchemaColumn): AnalyticalSchemaColumn {
    if (!column || typeof column.name !== 'string' || typeof column.type !== 'string') {
        throw new DatabaseOperationError('upstream_unavailable', 'The database response was invalid.');
    }
    return { name: column.name, type: column.type };
}

function stableAnalyticalSchema(data: AnalyticalSchemaResponse): AnalyticalSchemaResponse {
    if (!data || !Array.isArray(data.tables)) {
        throw new DatabaseOperationError('upstream_unavailable', 'The database response was invalid.');
    }

    return {
        tables: data.tables.map((table) => {
            if (
                !table
                || typeof table.name !== 'string'
                || !Array.isArray(table.columns)
                || typeof table.row_count !== 'number'
                || (table.last_loaded_at !== null && typeof table.last_loaded_at !== 'string')
            ) {
                throw new DatabaseOperationError('upstream_unavailable', 'The database response was invalid.');
            }
            return {
                name: table.name,
                columns: table.columns.map(stableAnalyticalSchemaColumn),
                row_count: table.row_count,
                last_loaded_at: table.last_loaded_at,
            };
        }),
    };
}

function renderAnalyticalSchema(schema: AnalyticalSchemaResponse): string {
    if (schema.tables.length === 0) {
        return 'No tables.';
    }

    return schema.tables.map((table) => {
        const columns = table.columns.map((column) => `${column.name} (${column.type})`).join(', ');
        return `${table.name} — ${table.row_count} rows, last loaded ${table.last_loaded_at ?? 'never'}\n  ${columns}`;
    }).join('\n\n');
}

/** "1.2 GB", "512.0 MB", "900 B" — used by `show`, `list`, and `ingest`. */
export function formatByteSize(bytes: number): string {
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}

interface DatabaseShowOptions {
    json?: boolean;
}

// The analytical (DuckDB) kind is Beta on every surface — this label is the
// canonical rendering; standard (libSQL) rows keep the plain kind value.
function kindLabel(kind: DatabaseKind): string {
    return kind === 'duckdb' ? 'Analytical · DuckDB (Beta)' : kind;
}

function renderShow(database: DatabaseRecord): string {
    const lines = [
        `Name: ${database.name}`,
        `Kind: ${kindLabel(database.kind)}`,
        `Status: ${database.status}`,
    ];
    if (database.kind === 'duckdb') {
        lines.push(`Activity: ${database.activity ?? 'unknown'}`);
        lines.push(`Size: ${formatByteSize(database.size_bytes)} of ${formatByteSize(database.size_limit_bytes ?? 0)}`);
        lines.push(`Tables: ${database.table_count ?? 0}`);
        lines.push(`Last loaded: ${database.last_loaded_at ?? 'never'}`);
        lines.push(`Last optimized: ${database.last_optimized_at ?? 'never'}`);
    } else {
        lines.push(`Size: ${formatByteSize(database.size_bytes)}`);
    }
    lines.push(`Created: ${database.created_at ?? '-'}`);
    return lines.join('\n');
}

const INCOMPLETE_DUMP_MARKER = '-- DOWNLOAD INCOMPLETE';
const DUMP_TAIL_BYTES = 4096;
const PULL_ATTEMPTS = 3;
const PULL_RETRY_BACKOFF_MS = [250, 500] as const;

function safeDatabaseStem(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'database';
}

function errorCode(error: unknown): string | undefined {
    return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : undefined;
}

function freshSafeFileError(error: unknown): DatabaseOperationError {
    if (error instanceof DatabaseOperationError) {
        return new DatabaseOperationError(error.code, error.message, error.status);
    }

    if (errorCode(error) === 'database_client_unsupported') {
        return new DatabaseOperationError(
            'database_client_unsupported',
            'Database commands are not supported on this platform.',
        );
    }

    return new DatabaseOperationError('upstream_unavailable', 'Database file operation failed.');
}

function isMissingPath(error: unknown): boolean {
    return errorCode(error) === 'ENOENT';
}

async function lstatIfPresent(
    filesystem: DatabaseFileSystem,
    candidate: string,
): Promise<Awaited<ReturnType<DatabaseFileSystem['lstat']>> | null> {
    try {
        return await filesystem.lstat(candidate);
    } catch (error) {
        if (isMissingPath(error)) return null;
        throw error;
    }
}

async function assertNoSymlinkComponents(
    filesystem: DatabaseFileSystem,
    destination: string,
): Promise<void> {
    const absolute = path.resolve(destination);
    const root = path.parse(absolute).root;
    const relative = absolute.slice(root.length);
    const components = relative.split(path.sep).filter(Boolean);
    let current = root;

    for (const component of components) {
        current = path.join(current, component);
        const stat = await lstatIfPresent(filesystem, current);
        if (stat?.isSymbolicLink()) {
            throw new DatabaseOperationError(
                'unsafe_destination',
                'Destination paths cannot contain symbolic links.',
            );
        }
    }
}

async function confirmFileOverwrite(
    target: string,
    options: { yes?: boolean },
    io: ResolvedCommandDependencies,
): Promise<boolean> {
    await assertNoSymlinkComponents(io.filesystem, target);
    const targetStat = await lstatIfPresent(io.filesystem, target);
    if (!targetStat) return true;

    if (!targetStat.isFile()) {
        throw new DatabaseOperationError('unsafe_destination', 'Destination must be a regular file.');
    }

    if (options.yes) return true;
    if (!io.isTTY) {
        throw new DatabaseOperationError(
            'confirmation_required',
            'Overwriting an existing database file requires --yes in non-interactive mode.',
        );
    }

    if (!await io.confirm(`Overwrite "${target}"?`)) {
        io.stdout('Cancelled.');
        return false;
    }

    return true;
}

function resolveDatabaseDestination(
    io: ResolvedCommandDependencies,
    requested: string | undefined,
    fallback: string,
): string {
    return path.resolve(io.cwd, requested ?? fallback);
}

function validatedTempPath(io: ResolvedCommandDependencies, target: string): string {
    const temp = path.resolve(io.tempPath(target));
    if (temp === target || path.dirname(temp) !== path.dirname(target)) {
        throw new DatabaseOperationError(
            'unsafe_destination',
            'The temporary database file must be a sibling of its destination.',
        );
    }
    return temp;
}

async function reserveDestinationTemp(
    io: ResolvedCommandDependencies,
    target: string,
): Promise<{
    temp: string;
    handle: Awaited<ReturnType<DatabaseFileSystem['open']>>;
}> {
    const parent = path.dirname(target);
    await assertNoSymlinkComponents(io.filesystem, target);
    await io.filesystem.mkdir(parent, { recursive: true });
    await assertNoSymlinkComponents(io.filesystem, target);

    const temp = validatedTempPath(io, target);
    await assertNoSymlinkComponents(io.filesystem, temp);
    const handle = await io.filesystem.open(temp, 'wx', 0o600);
    return { temp, handle };
}

async function removeOwnedFiles(
    filesystem: DatabaseFileSystem,
    paths: string[],
): Promise<void> {
    for (const candidate of paths) {
        try {
            await filesystem.unlink(candidate);
        } catch {
            // Cleanup is best effort and may target only paths owned by this invocation.
        }
    }
}

function pullSidecars(temp: string): string[] {
    return [`${temp}-wal`, `${temp}-shm`, `${temp}-journal`, `${temp}-client_wal_index`];
}

async function anyPathExists(filesystem: DatabaseFileSystem, candidates: string[]): Promise<boolean> {
    for (const candidate of candidates) {
        if (await lstatIfPresent(filesystem, candidate)) return true;
    }
    return false;
}

function streamChunk(value: unknown): Buffer {
    if (typeof value === 'string') return Buffer.from(value);
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    if (ArrayBuffer.isView(value)) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new Error('Invalid database dump stream chunk.');
}

async function writeDumpStream(
    stream: unknown,
    handle: Awaited<ReturnType<DatabaseFileSystem['open']>>,
): Promise<Buffer> {
    if (!stream || typeof (stream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function') {
        throw new Error('Invalid database dump stream.');
    }

    let tail = Buffer.alloc(0);
    for await (const value of stream as AsyncIterable<unknown>) {
        const chunk = streamChunk(value);
        let offset = 0;
        while (offset < chunk.byteLength) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null);
            if (bytesWritten <= 0) throw new Error('Database dump write failed.');
            offset += bytesWritten;
        }

        tail = Buffer.concat([tail, chunk]);
        if (tail.byteLength > DUMP_TAIL_BYTES) {
            tail = tail.subarray(tail.byteLength - DUMP_TAIL_BYTES);
        }
    }

    return tail;
}

function displayDestination(io: ResolvedCommandDependencies, target: string): string {
    return path.relative(io.cwd, target) || path.basename(target);
}

function checkpointInteger(value: unknown): bigint {
    if (typeof value === 'bigint' && value >= 0n) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
    throw new Error('Invalid database checkpoint result.');
}

function validateCheckpointResult(result: DatabaseResultSet): void {
    if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) {
        throw new Error('Invalid database checkpoint result.');
    }

    const row = result.rows[0];
    if (!row || !Number.isSafeInteger(row.length) || row.length < 3) {
        throw new Error('Invalid database checkpoint result.');
    }

    const busy = checkpointInteger(row[0]);
    const log = checkpointInteger(row[1]);
    const checkpointed = checkpointInteger(row[2]);
    if (busy !== 0n || checkpointed < log) {
        throw new Error('Database checkpoint did not complete.');
    }
}

const WRITABLE_RENEWAL_WINDOW_MS = 30_000;
const WRITABLE_WARNING = 'Writable live session: writes go to the live workspace database.';
const WRITABLE_PROMPT = 'solidactions-db> ';
const WRITABLE_CONTINUATION_PROMPT = '...> ';

interface WritableInputSession {
    iterator: AsyncIterator<string>;
    prompt: (pending: boolean) => void;
    interrupted: () => boolean;
    close: () => Promise<void>;
}

function createWritableInput(io: ResolvedCommandDependencies): WritableInputSession {
    if (io.input) {
        const iterator = io.input[Symbol.asyncIterator]();
        return {
            iterator,
            prompt: () => undefined,
            interrupted: () => false,
            close: async () => {
                await iterator.return?.();
            },
        };
    }

    const input = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: io.isTTY,
    });
    let interrupted = false;
    const onSigint = () => {
        interrupted = true;
        input.close();
    };
    input.on('SIGINT', onSigint);
    const iterator = input[Symbol.asyncIterator]();

    return {
        iterator,
        prompt: (pending) => {
            if (!io.isTTY) return;
            input.setPrompt(pending ? WRITABLE_CONTINUATION_PROMPT : WRITABLE_PROMPT);
            input.prompt();
        },
        interrupted: () => interrupted,
        close: async () => {
            input.off('SIGINT', onSigint);
            input.close();
        },
    };
}

async function nextWritableInput(
    iterator: AsyncIterator<string>,
    signal: AbortSignal | undefined,
): Promise<IteratorResult<string>> {
    if (!signal) return iterator.next();
    if (signal.aborted) return { done: true, value: undefined };

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (result: IteratorResult<string>) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve(result);
        };
        const onAbort = () => finish({ done: true, value: undefined });
        signal.addEventListener('abort', onAbort, { once: true });
        iterator.next().then(finish, (error) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(error);
        });
    });
}

function validateWritableAccess(access: unknown, now: number, monotonicNow: number): {
    url: string;
    token: string;
    deadline: DatabaseCredentialDeadline;
} {
    const value = access as Record<string, unknown> | null;
    const url = typeof value?.url === 'string' ? value.url.trim() : '';
    const token = typeof value?.token === 'string' ? value.token.trim() : '';
    const deadline = databaseCredentialDeadline(
        value as unknown as DatabaseAccess,
        now,
        monotonicNow,
        WRITABLE_RENEWAL_WINDOW_MS,
    );
    if (
        value?.mode !== 'write'
        || url === ''
        || token === ''
        || !deadline
    ) {
        throw new DatabaseOperationError('upstream_unavailable', 'The database access response was invalid.');
    }

    return { url, token, deadline };
}

class WritableRenewalAttemptError extends Error {
    readonly publicError: DatabaseOperationError;
    readonly publishLastValid: boolean;

    constructor(error: DatabaseOperationError, publishLastValid: boolean) {
        super(error.message);
        this.publicError = error;
        this.publishLastValid = publishLastValid;
        delete this.stack;
    }
}

type PullFailureClass = 'credential_expiry' | 'transient_transport' | 'deterministic';

function classifyPullFailure(error: unknown): PullFailureClass {
    if (isDatabaseCredentialAuthFailure(error)) return 'credential_expiry';

    const value = error as { code?: unknown; name?: unknown; message?: unknown } | null;
    const code = typeof value?.code === 'string' ? value.code.toUpperCase() : '';
    const name = typeof value?.name === 'string' ? value.name : '';
    const message = typeof value?.message === 'string' ? value.message : '';
    const transientCodes = new Set([
        'ECONNABORTED',
        'ECONNREFUSED',
        'ECONNRESET',
        'EHOSTUNREACH',
        'ENETDOWN',
        'ENETUNREACH',
        'ENOTFOUND',
        'ETIMEDOUT',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_SOCKET',
    ]);
    if (
        transientCodes.has(code)
        || name === 'AbortError'
        || /\b(?:connection reset|network unavailable|temporary transport|transport failure|timed? ?out)\b/i.test(message)
    ) {
        return 'transient_transport';
    }

    return 'deterministic';
}

async function handoffReplicaReservation(
    io: ResolvedCommandDependencies,
    temp: string,
    handle: Awaited<ReturnType<DatabaseFileSystem['open']>>,
): Promise<void> {
    await assertNoSymlinkComponents(io.filesystem, temp);
    const reservedStat = await handle.stat();
    const pathStat = await lstatIfPresent(io.filesystem, temp);
    if (
        !pathStat
        || !pathStat.isFile()
        || pathStat.dev !== reservedStat.dev
        || pathStat.ino !== reservedStat.ino
    ) {
        throw new DatabaseOperationError('upstream_unavailable', 'Database file operation failed.');
    }
    await handle.close();
    await io.filesystem.unlink(temp);
}

async function finalizeReplica(
    io: ResolvedCommandDependencies,
    temp: string,
    target: string,
    createClient: (config: Record<string, unknown>) => DatabaseClient,
): Promise<void> {
    const assertOwnedMainFile = async () => {
        await assertNoSymlinkComponents(io.filesystem, temp);
        const stat = await lstatIfPresent(io.filesystem, temp);
        if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
            throw new DatabaseOperationError(
                'unsafe_destination',
                'The database replica temporary path is unsafe.',
            );
        }
    };

    await assertOwnedMainFile();
    let finalizer: DatabaseClient | undefined;
    let finalizerClosePromise: Promise<void> | undefined;
    const closeFinalizer = (): Promise<void> => {
        finalizerClosePromise ??= runDatabaseClientOperationWithDeadline(
            async () => { await finalizer?.close(); },
            undefined,
            io.dataPlaneTimeoutMs,
        );
        return finalizerClosePromise;
    };
    let checkpointResult: DatabaseResultSet | undefined;
    let finalizationFailed = false;
    try {
        finalizer = createClient({
            url: pathToFileURL(temp).href,
            intMode: 'string',
        });
        checkpointResult = await runDatabaseClientOperationWithDeadline(
            () => finalizer!.execute('PRAGMA wal_checkpoint(TRUNCATE)'),
            closeFinalizer,
            io.dataPlaneTimeoutMs,
        );
    } catch {
        finalizationFailed = true;
    } finally {
        if (finalizer) {
            try {
                await closeFinalizer();
            } catch {
                finalizationFailed = true;
            }
        }
    }

    if (finalizationFailed || !checkpointResult) {
        throw new DatabaseOperationError('upstream_unavailable', 'Database file operation failed.');
    }
    validateCheckpointResult(checkpointResult);
    await assertOwnedMainFile();

    await removeOwnedFiles(io.filesystem, pullSidecars(temp));
    if (await anyPathExists(io.filesystem, pullSidecars(temp))) {
        throw new DatabaseOperationError('upstream_unavailable', 'Database file operation failed.');
    }

    await io.filesystem.chmod(temp, 0o444);
    await assertNoSymlinkComponents(io.filesystem, target);
    await io.filesystem.rename(temp, target);
}

export async function databaseListWithConfig(
    options: DatabaseListOptions,
    config: Config,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    const io = resolveDependencies(dependencies);
    // The server's `list` operation takes no `kind` parameter — CliDatabaseRequest
    // prohibits it on anything but `create` — so the filter is applied here,
    // client-side, against the full row set.
    if (options.kind !== undefined && options.kind !== 'libsql' && options.kind !== 'duckdb') {
        throw new DatabaseOperationError(
            'invalid_kind',
            `--kind must be "libsql" or "duckdb" (received "${options.kind}").`,
        );
    }

    const data = stableListResponse(await requestDatabaseOperation<DatabaseListResponse>(
        config,
        { operation: 'list' },
        requestDependencies(io),
    ));

    const databases = options.kind
        ? data.databases.filter((database) => database.kind === options.kind)
        : data.databases;

    if (options.json) {
        writeJson(io.stdout, options.kind ? { ...data, databases } : data);
        return;
    }

    io.stdout(`${renderDatabaseTable(databases)}\n${renderQuota(data.quota)}`);
}

const CREATE_POLL_INTERVAL_MS = 2_000;
const CREATE_POLL_TIMEOUT_MS = 5 * 60_000;

export async function databaseCreateWithConfig(
    name: string,
    options: DatabaseCreateOptions,
    config: Config,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    const io = resolveDependencies(dependencies);
    if (options.kind !== undefined && options.kind !== 'libsql' && options.kind !== 'duckdb') {
        throw new DatabaseOperationError(
            'invalid_kind',
            `--kind must be "libsql" or "duckdb" (received "${options.kind}").`,
        );
    }
    const kind: DatabaseKind = options.kind === 'duckdb' ? 'duckdb' : 'libsql';
    const preparedSource = options.from && !io.importDatabase
        ? await prepareDatabaseImportSource(options.from, io.cwd, io.filesystem)
        : undefined;
    let data = stableDatabaseResponse(await requestDatabaseOperation<DatabaseMutationResponse>(
        config,
        { operation: 'create', name, kind },
        requestDependencies(io),
    ));

    if (kind === 'duckdb' && options.wait !== false && data.database.status === 'provisioning') {
        if (!options.json) {
            io.stdout(`Provisioning ${kindLabel(kind)} database "${data.database.name}"… this can take about a minute.`);
        }
        const deadline = io.now() + CREATE_POLL_TIMEOUT_MS;
        let record = data.database;
        while (record.status === 'provisioning' && io.now() < deadline) {
            await io.sleep(CREATE_POLL_INTERVAL_MS);
            record = await requestDatabaseRecord(name, config, dependencies);
        }
        data = { database: record };

        if (record.status !== 'ready') {
            if (record.status === 'provisioning') {
                throw new DatabaseOperationError(
                    'provisioning_timeout',
                    `Database "${name}" is still provisioning after ${Math.round(CREATE_POLL_TIMEOUT_MS / 60_000)} minute(s). It remains in place; check status with \`solidactions database show ${name}\`.`,
                );
            }
            throw new DatabaseOperationError(
                'provisioning_failed',
                `Database "${name}" failed to provision (status: ${record.status}). Check \`solidactions database show ${name}\` for details.`,
            );
        }
    }

    if (options.from) {
        try {
            if (io.importDatabase) {
                await io.importDatabase(data.database.name, options.from);
            } else if (preparedSource) {
                const prepared = await bindPreparedDatabaseImport(
                    preparedSource,
                    data.database.name,
                    undefined,
                    io.cwd,
                    io.filesystem,
                );
                await runPreparedDatabaseImport(
                    prepared,
                    config,
                    {
                        cwd: io.cwd,
                        filesystem: io.filesystem,
                        stdout: options.json ? () => undefined : io.stdout,
                        now: io.now,
                        monotonicNow: io.monotonicNow,
                        post: io.post,
                        loadClient: io.loadClient,
                        controlPlaneTimeoutMs: io.controlPlaneTimeoutMs,
                        dataPlaneTimeoutMs: io.dataPlaneTimeoutMs,
                    },
                );
            }
        } catch (error) {
            const safeGuidance = error instanceof DatabaseOperationError
                && error.code === 'import_failed'
                && error.message.includes('Resume with:')
                ? `\n${error.message}`
                : '';
            throw new DatabaseOperationError(
                'import_failed',
                `Database "${data.database.name}" was created, but its SQL import failed. The database remains in place.${safeGuidance}`,
            );
        }
    }

    if (options.json) {
        writeJson(io.stdout, data);
        return;
    }

    io.stdout(renderMutation('create', data.database));
}

// The "call show first, branch on `.kind`" helper every later analytical verb
// (schema/query/exec/dump/pull/push/import/ingest) reuses to learn a
// database's kind before dispatching to the libsql or duckdb code path.
export async function requestDatabaseRecord(
    name: string,
    config: Config,
    dependencies: DatabaseCommandDependencies = {},
): Promise<DatabaseRecord> {
    const io = resolveDependencies(dependencies);
    return stableDatabaseResponse(await requestDatabaseOperation<DatabaseMutationResponse>(
        config,
        { operation: 'show', name },
        requestDependencies(io),
    )).database;
}

// Refuses an analytical (duckdb) name for the SQLite-only verbs (exec, dump,
// pull, push, import), reusing the same `show`-first lookup as `schema` and
// `query` above. The server (`HandleCliDatabaseOperation`) already refuses
// these operations with `kind_mismatch`; this guard only makes the refusal
// fast (before any file read, temp file, or data-plane mint) and legible.
export async function refuseIfAnalytical(
    config: Config,
    name: string,
    verb: 'exec' | 'sqlite-only',
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    const row = await requestDatabaseRecord(name, config, dependencies);
    if (row.kind !== 'duckdb') return;

    if (verb === 'exec') {
        throw new DatabaseOperationError(
            'read_only',
            "read-only: this is an analytical database — load data with `solidactions database ingest` or your workflow's ingest step",
        );
    }

    throw new DatabaseOperationError(
        'kind_mismatch',
        `"${name}" is an analytical database — use \`database ingest\` to load data and \`database query\` to read it`,
    );
}

export async function databaseShowWithConfig(
    name: string,
    options: DatabaseShowOptions,
    config: Config,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    const io = resolveDependencies(dependencies);
    const database = await requestDatabaseRecord(name, config, dependencies);

    if (options.json) {
        writeJson(io.stdout, { database });
        return;
    }

    io.stdout(renderShow(database));
}

export async function databaseImportWithConfig(
    name: string,
    file: string,
    options: DatabaseImportOptions,
    config: Config,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    const io = resolveDependencies(dependencies);
    await refuseIfAnalytical(config, name, 'sqlite-only', io);
    const prepared = await prepareDatabaseImport(
        name,
        file,
        options.resume,
        io.cwd,
        io.filesystem,
    );

    if (!options.yes) {
        if (!io.isTTY) {
            throw new DatabaseOperationError(
                'confirmation_required',
                'Database import requires --yes in non-interactive mode.',
            );
        }
        if (!await io.confirm(`Import SQL into database "${name}"?`)) {
            io.stdout('Cancelled.');
            return;
        }
    }

    await runPreparedDatabaseImport(prepared, config, {
        cwd: io.cwd,
        filesystem: io.filesystem,
        stdout: io.stdout,
        now: io.now,
        monotonicNow: io.monotonicNow,
        post: io.post,
        loadClient: io.loadClient,
        controlPlaneTimeoutMs: io.controlPlaneTimeoutMs,
        dataPlaneTimeoutMs: io.dataPlaneTimeoutMs,
    });
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
    const row = await requestDatabaseRecord(name, config, dependencies);

    if (row.kind === 'duckdb') {
        // Read-intent, served from the cached catalog — never wakes a
        // paused database (spec:568/598).
        const schema = stableAnalyticalSchema(await requestDatabaseOperation<AnalyticalSchemaResponse>(
            config,
            { operation: 'schema', name },
            requestDependencies(io),
        ));

        if (options.json) {
            writeJson(io.stdout, schema);
            return;
        }

        io.stdout(renderAnalyticalSchema(schema));
        return;
    }

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

interface AnalyticalQueryResult {
    columns: string[];
    rows: unknown[][];
    truncated: boolean;
    elapsed_ms: number;
}

interface AnalyticalWakingResponse {
    code: 'waking';
    message?: string;
    retry_after_ms?: number;
}

function isAnalyticalWaking(value: unknown): value is AnalyticalWakingResponse {
    const candidate = value as { code?: unknown } | null;
    return candidate?.code === 'waking';
}

function stableAnalyticalQueryResult(data: AnalyticalQueryResult): AnalyticalQueryResult {
    if (
        !data
        || !Array.isArray(data.columns)
        || !data.columns.every((column) => typeof column === 'string')
        || !Array.isArray(data.rows)
        || !data.rows.every((row) => Array.isArray(row))
        || typeof data.truncated !== 'boolean'
        || typeof data.elapsed_ms !== 'number'
    ) {
        throw new DatabaseOperationError('upstream_unavailable', 'The database response was invalid.');
    }

    return {
        columns: [...data.columns],
        rows: data.rows.map((row) => [...row]),
        truncated: data.truncated,
        elapsed_ms: data.elapsed_ms,
    };
}

// CLI-surface cap (`services.analytical.query_row_limit_cli` on the server;
// `config/services.php`) — the server clamps to the same value when
// `row_limit` is omitted, so this is both the client-side validation bound
// and the number shown for an un-limited truncation.
const ANALYTICAL_QUERY_ROW_LIMIT_CLI_MAX = 10_000;

// Bounds how long the CLI itself waits out a `waking` database before giving
// up and surfacing the condition as an error; the server keeps retrying on
// its own schedule via `retry_after_ms`.
const ANALYTICAL_QUERY_MAX_WAIT_MS = 60_000;

async function requestAnalyticalQuery(
    config: Config,
    name: string,
    sql: string,
    rowLimit: number | undefined,
    io: ResolvedCommandDependencies,
): Promise<AnalyticalQueryResult> {
    const body: Record<string, unknown> = { operation: 'query', name, sql };
    if (rowLimit !== undefined) {
        body.row_limit = rowLimit;
    }

    const deadline = io.now() + ANALYTICAL_QUERY_MAX_WAIT_MS;
    let announced = false;
    for (;;) {
        const response = await requestDatabaseOperation<AnalyticalQueryResult | AnalyticalWakingResponse>(
            config,
            body,
            requestDependencies(io),
        );
        if (!isAnalyticalWaking(response)) {
            return stableAnalyticalQueryResult(response);
        }
        if (io.now() >= deadline) {
            throw new DatabaseOperationError(
                'waking',
                response.message ?? `${name} is still waking up — try again in a moment.`,
            );
        }
        if (!announced) {
            io.stderr(`Waking ${name}…`);
            announced = true;
        }
        await io.sleep(response.retry_after_ms ?? 3_000);
    }
}

export async function databaseQueryWithConfig(
    name: string,
    sql: string,
    options: DatabaseQueryOptions,
    config: Config,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    const io = resolveDependencies(dependencies);
    const row = await requestDatabaseRecord(name, config, dependencies);

    if (row.kind === 'duckdb') {
        if (options.limit !== undefined && (options.limit < 1 || options.limit > ANALYTICAL_QUERY_ROW_LIMIT_CLI_MAX)) {
            throw new DatabaseOperationError(
                'invalid_limit',
                `--limit must be between 1 and ${ANALYTICAL_QUERY_ROW_LIMIT_CLI_MAX} (received "${options.limit}").`,
            );
        }

        const result = await requestAnalyticalQuery(config, name, sql, options.limit, io);

        if (options.json) {
            writeJson(io.stdout, result);
            return;
        }

        io.stdout(result.columns.length > 0
            ? renderTable(result.columns, result.rows.map((resultRow) => resultRow.map((value) => String(value)))).join('\n')
            : 'No rows returned.');
        if (result.truncated) {
            io.stdout(`(truncated at ${options.limit ?? ANALYTICAL_QUERY_ROW_LIMIT_CLI_MAX} rows)`);
        }
        return;
    }

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
    await refuseIfAnalytical(config, name, 'exec', io);

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

export async function databaseDumpWithConfig(
    name: string,
    file: string | undefined,
    options: DatabaseDumpOptions,
    config: Config,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    const io = resolveDependencies(dependencies);
    await refuseIfAnalytical(config, name, 'sqlite-only', io);
    const target = resolveDatabaseDestination(io, file, `${safeDatabaseStem(name)}.sql`);
    let temp: string | undefined;
    let handle: Awaited<ReturnType<DatabaseFileSystem['open']>> | undefined;
    let ownsTemp = false;

    try {
        if (!await confirmFileOverwrite(target, options, io)) return;

        const reservation = await reserveDestinationTemp(io, target);
        temp = reservation.temp;
        handle = reservation.handle;
        ownsTemp = true;

        const stream = await requestDatabaseDumpStream(config, name, requestDependencies(io));
        const tail = await writeDumpStream(stream, handle);
        await handle.close();
        handle = undefined;

        if (tail.includes(Buffer.from(INCOMPLETE_DUMP_MARKER))) {
            throw new DatabaseOperationError(
                'upstream_unavailable',
                'The downloaded database dump is incomplete.',
            );
        }

        await assertNoSymlinkComponents(io.filesystem, target);
        await io.filesystem.rename(temp, target);
        ownsTemp = false;
        await io.filesystem.chmod(target, 0o444);
        io.stdout(`Database dump saved to ${displayDestination(io, target)}.`);
    } catch (error) {
        if (handle) {
            try {
                await handle.close();
            } catch {
                // The public error remains stable; cleanup below owns the path.
            }
        }
        if (ownsTemp && temp) await removeOwnedFiles(io.filesystem, [temp]);
        throw freshSafeFileError(error);
    }
}

async function databaseWritablePullWithConfig(
    name: string,
    destination: string | undefined,
    options: DatabasePullOptions,
    config: Config,
    io: ResolvedCommandDependencies,
): Promise<void> {
    const target = resolveDatabaseDestination(
        io,
        destination,
        path.join('.solidactions', 'databases', `${safeDatabaseStem(name)}.db`),
    );
    let temp: string | undefined;
    let reservationHandle: Awaited<ReturnType<DatabaseFileSystem['open']>> | undefined;
    let ownsTemp = false;
    let ownsSidecars = false;
    let client: DatabaseClient | undefined;
    let localCreateClient: ((config: Record<string, unknown>) => DatabaseClient) | undefined;
    let credentialDeadline: DatabaseCredentialDeadline | undefined;
    let inputSession: WritableInputSession | undefined;
    let attachedClosePromise: Promise<void> | undefined;

    const closeAttachedClient = async (): Promise<void> => {
        if (client) {
            const closing = client;
            client = undefined;
            attachedClosePromise ??= runDatabaseClientOperationWithDeadline(
                async () => { await closing.close(); },
                undefined,
                io.dataPlaneTimeoutMs,
            );
        }
        if (!attachedClosePromise) return;
        try {
            await attachedClosePromise;
        } catch {
            throw new DatabaseOperationError('upstream_unavailable', 'Database file operation failed.');
        }
    };

    const openAttachedClient = async (initial: boolean): Promise<void> => {
        if (!initial) {
            await assertNoSymlinkComponents(io.filesystem, temp!);
            const beforeMint = await lstatIfPresent(io.filesystem, temp!);
            if (!beforeMint || beforeMint.isSymbolicLink() || !beforeMint.isFile()) {
                throw new DatabaseOperationError(
                    'unsafe_destination',
                    'The database replica temporary path is unsafe.',
                );
            }
        }

        let loaded: Awaited<ReturnType<typeof loadDatabaseClientBeforeMint>>;
        try {
            loaded = await loadDatabaseClientBeforeMint(
                () => requestDatabaseAccess(config, name, 'write', requestDependencies(io)),
                { loadClient: io.loadClient },
            );
        } catch (error) {
            const safeError = freshSafeFileError(error);
            if (!initial && error instanceof DatabaseOperationError) {
                throw new WritableRenewalAttemptError(safeError, true);
            }
            throw safeError;
        }
        const access = validateWritableAccess(loaded.access, io.now(), io.monotonicNow());
        const createClient = loaded.createClient as (config: Record<string, unknown>) => DatabaseClient;

        if (initial) {
            await handoffReplicaReservation(io, temp!, reservationHandle!);
            reservationHandle = undefined;
            ownsTemp = false;
        }

        await assertNoSymlinkComponents(io.filesystem, temp!);
        const beforeCreate = await lstatIfPresent(io.filesystem, temp!);
        if (
            (initial && beforeCreate !== null)
            || (!initial && (!beforeCreate || beforeCreate.isSymbolicLink() || !beforeCreate.isFile()))
        ) {
            throw new DatabaseOperationError(
                'unsafe_destination',
                'The database replica temporary path is unsafe.',
            );
        }

        let opened: DatabaseClient;
        try {
            opened = createClient({
                url: pathToFileURL(temp!).href,
                syncUrl: access.url,
                authToken: access.token,
                intMode: 'string',
                readYourWrites: true,
                offline: false,
            });
        } catch {
            const createdStat = await lstatIfPresent(io.filesystem, temp!);
            if (createdStat?.isFile() && !createdStat.isSymbolicLink()) ownsTemp = true;
            throw new DatabaseOperationError('upstream_unavailable', 'Database file operation failed.');
        }

        let openedClosePromise: Promise<void> | undefined;
        const closeOpened = (): Promise<void> => {
            openedClosePromise ??= runDatabaseClientOperationWithDeadline(
                async () => { await opened.close(); },
                undefined,
                io.dataPlaneTimeoutMs,
            );
            return openedClosePromise;
        };
        let syncFailed = false;
        try {
            if (typeof opened.sync !== 'function') throw new Error('Database sync is unavailable.');
            await runDatabaseClientOperationWithDeadline(
                () => opened.sync!(),
                closeOpened,
                io.dataPlaneTimeoutMs,
            );
        } catch {
            syncFailed = true;
        }

        const replicaStat = await lstatIfPresent(io.filesystem, temp!);
        if (replicaStat?.isFile() && !replicaStat.isSymbolicLink()) ownsTemp = true;
        if (
            syncFailed
            || !replicaStat
            || replicaStat.isSymbolicLink()
            || !replicaStat.isFile()
        ) {
            try {
                await closeOpened();
            } catch {
                // The stable setup error below takes precedence.
            }
            throw new DatabaseOperationError('upstream_unavailable', 'Database file operation failed.');
        }

        attachedClosePromise = undefined;
        client = opened;
        localCreateClient = createClient;
        credentialDeadline = access.deadline;
    };

    try {
        if (!await confirmFileOverwrite(target, options, io)) return;

        const reservation = await reserveDestinationTemp(io, target);
        temp = reservation.temp;
        reservationHandle = reservation.handle;
        ownsTemp = true;
        if (await anyPathExists(io.filesystem, pullSidecars(temp))) {
            throw new DatabaseOperationError(
                'upstream_unavailable',
                'Database replica temporary files already exist.',
            );
        }
        ownsSidecars = true;

        await openAttachedClient(true);
        io.stdout(WRITABLE_WARNING);
        inputSession = createWritableInput(io);
        const accumulator = new DatabaseSqlStatementAccumulator();
        let sessionFailure: unknown;
        let publishAfterFailure = false;

        try {
            while (true) {
                if (io.abortSignal?.aborted || inputSession.interrupted()) break;

                const deadlineNow = credentialDeadline?.clock === 'monotonic'
                    ? io.monotonicNow()
                    : io.now();
                if (!credentialDeadline || deadlineNow >= credentialDeadline.renewalAt) {
                    try {
                        await closeAttachedClient();
                        await openAttachedClient(false);
                    } catch (error) {
                        sessionFailure = error instanceof WritableRenewalAttemptError
                            ? error.publicError
                            : error;
                        publishAfterFailure = error instanceof WritableRenewalAttemptError
                            && error.publishLastValid;
                        break;
                    }
                }

                inputSession.prompt(accumulator.pending);
                const next = await nextWritableInput(inputSession.iterator, io.abortSignal);
                if (io.abortSignal?.aborted || inputSession.interrupted()) break;
                if (next.done) {
                    if (accumulator.pending) {
                        sessionFailure = new DatabaseOperationError(
                            'incomplete_sql',
                            'The SQL input is incomplete.',
                        );
                    }
                    break;
                }

                if (next.value.trim() === '.exit') {
                    if (accumulator.pending) {
                        sessionFailure = new DatabaseOperationError(
                            'incomplete_sql',
                            'The SQL input is incomplete.',
                        );
                    }
                    break;
                }

                const statement = accumulator.push(next.value);
                if (!statement) continue;

                try {
                    if (statement.multiple) {
                        if (typeof client?.executeMultiple !== 'function') {
                            throw new Error('Multiple SQL execution is unavailable.');
                        }
                        await runDatabaseClientOperationWithDeadline(
                            () => client!.executeMultiple!(statement.sql),
                            closeAttachedClient,
                            io.dataPlaneTimeoutMs,
                        );
                        io.stdout('Transaction group executed successfully.');
                    } else {
                        const result = stableDirectResult(await runDatabaseClientOperationWithDeadline(
                            () => client!.execute(statement.sql),
                            closeAttachedClient,
                            io.dataPlaneTimeoutMs,
                        ));
                        io.stdout(
                            result.columns.length > 0
                                ? renderDirectTable(result)
                                : `Rows affected: ${result.rowsAffected}`,
                        );
                    }
                } catch (error) {
                    if (
                        error instanceof DatabaseOperationError
                        && error.message === 'Database operation timed out.'
                    ) {
                        sessionFailure = error;
                        break;
                    }
                    if (!isDatabaseCredentialAuthFailure(error)) {
                        io.stderr('Database statement failed.');
                        continue;
                    }

                    const credentialCode = databaseCredentialFailureCode(
                        credentialDeadline!,
                        io.now(),
                        io.monotonicNow(),
                    );
                    io.stderr(`Database statement has an unknown outcome because of ${credentialCode}.`);
                    try {
                        await closeAttachedClient();
                        await openAttachedClient(false);
                    } catch (renewalError) {
                        sessionFailure = renewalError instanceof WritableRenewalAttemptError
                            ? renewalError.publicError
                            : renewalError;
                        publishAfterFailure = renewalError instanceof WritableRenewalAttemptError
                            && renewalError.publishLastValid;
                        break;
                    }
                }
            }
        } catch (error) {
            sessionFailure = error;
        } finally {
            if (inputSession) {
                try {
                    await inputSession.close();
                } catch {
                    if (!sessionFailure) {
                        sessionFailure = new DatabaseOperationError(
                            'upstream_unavailable',
                            'Database file operation failed.',
                        );
                    }
                }
                inputSession = undefined;
            }
            try {
                await closeAttachedClient();
            } catch (error) {
                if (!sessionFailure) sessionFailure = error;
                publishAfterFailure = false;
            }
        }

        if (sessionFailure && !publishAfterFailure) throw sessionFailure;

        await finalizeReplica(io, temp, target, localCreateClient!);
        ownsTemp = false;
        ownsSidecars = false;
        if (sessionFailure) throw sessionFailure;
        io.stdout(`Database replica saved to ${displayDestination(io, target)}.`);
    } catch (error) {
        if (inputSession) {
            try {
                await inputSession.close();
            } catch {
                // Cleanup remains scoped to this invocation's input session.
            }
        }
        if (client) {
            try {
                await client.close();
            } catch {
                // Cleanup below remains scoped to this invocation's replica.
            }
        }
        if (reservationHandle) {
            try {
                await reservationHandle.close();
            } catch {
                // Cleanup below remains scoped to the exclusively reserved path.
            }
        }
        if (temp) {
            await removeOwnedFiles(io.filesystem, [
                ...(ownsTemp ? [temp] : []),
                ...(ownsSidecars ? pullSidecars(temp) : []),
            ]);
        }
        throw freshSafeFileError(error);
    }
}

export async function databasePullWithConfig(
    name: string,
    destination: string | undefined,
    options: DatabasePullOptions,
    config: Config,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    const io = resolveDependencies(dependencies);
    await refuseIfAnalytical(config, name, 'sqlite-only', io);
    if (options.writable) {
        return databaseWritablePullWithConfig(name, destination, options, config, io);
    }

    const target = resolveDatabaseDestination(
        io,
        destination,
        path.join('.solidactions', 'databases', `${safeDatabaseStem(name)}.db`),
    );
    let temp: string | undefined;
    let reservationHandle: Awaited<ReturnType<DatabaseFileSystem['open']>> | undefined;
    let ownsTemp = false;
    let ownsSidecars = false;

    try {
        if (!await confirmFileOverwrite(target, options, io)) return;

        const reservation = await reserveDestinationTemp(io, target);
        temp = reservation.temp;
        reservationHandle = reservation.handle;
        ownsTemp = true;

        const sidecars = pullSidecars(temp);
        if (await anyPathExists(io.filesystem, sidecars)) {
            throw new DatabaseOperationError(
                'upstream_unavailable',
                'Database replica temporary files already exist.',
            );
        }
        ownsSidecars = true;

        let synced = false;
        let localCreateClient: ((config: Record<string, unknown>) => DatabaseClient) | undefined;
        let credentialRemintUsed = false;
        for (let attempt = 0; attempt < PULL_ATTEMPTS; attempt += 1) {
            const { createClient, access } = await loadDatabaseClientBeforeMint(
                () => requestDatabaseAccess(config, name, 'read', requestDependencies(io)),
                { loadClient: io.loadClient },
            );
            localCreateClient = createClient as (config: Record<string, unknown>) => DatabaseClient;

            if (attempt === 0) {
                await assertNoSymlinkComponents(io.filesystem, temp);
                const reservedStat = await reservationHandle!.stat();
                const pathStat = await lstatIfPresent(io.filesystem, temp);
                if (
                    !pathStat
                    || !pathStat.isFile()
                    || pathStat.dev !== reservedStat.dev
                    || pathStat.ino !== reservedStat.ino
                ) {
                    throw new DatabaseOperationError('upstream_unavailable', 'Database file operation failed.');
                }
                await reservationHandle!.close();
                reservationHandle = undefined;
                await io.filesystem.unlink(temp);
                ownsTemp = false;
            }

            let client: DatabaseClient;
            try {
                client = createClient({
                    url: pathToFileURL(temp).href,
                    syncUrl: access.url,
                    authToken: access.token,
                    intMode: 'string',
                }) as DatabaseClient;
            } catch {
                const createdStat = await lstatIfPresent(io.filesystem, temp);
                if (createdStat?.isFile() && !createdStat.isSymbolicLink()) ownsTemp = true;
                throw new DatabaseOperationError('upstream_unavailable', 'Database file operation failed.');
            }

            let attemptFailure: unknown;
            let closePromise: Promise<void> | undefined;
            const closeClient = (): Promise<void> => {
                closePromise ??= runDatabaseClientOperationWithDeadline(
                    async () => { await client.close(); },
                    undefined,
                    io.dataPlaneTimeoutMs,
                );
                return closePromise;
            };
            try {
                if (typeof client.sync !== 'function') throw new Error('Database sync is unavailable.');
                await runDatabaseClientOperationWithDeadline(
                    () => client.sync!(),
                    closeClient,
                    io.dataPlaneTimeoutMs,
                );
            } catch (error) {
                attemptFailure = error;
            } finally {
                try {
                    await closeClient();
                } catch (error) {
                    if (!attemptFailure) attemptFailure = error;
                }
            }

            if (!attemptFailure) {
                const replicaStat = await lstatIfPresent(io.filesystem, temp);
                if (!replicaStat || replicaStat.isSymbolicLink() || !replicaStat.isFile()) {
                    throw new DatabaseOperationError('upstream_unavailable', 'Database file operation failed.');
                }
                ownsTemp = true;
                synced = true;
                break;
            }

            const replicaStat = await lstatIfPresent(io.filesystem, temp);
            if (replicaStat?.isSymbolicLink() || (replicaStat && !replicaStat.isFile())) {
                throw new DatabaseOperationError('upstream_unavailable', 'Database file operation failed.');
            }
            if (replicaStat?.isFile()) ownsTemp = true;

            const failureClass = classifyPullFailure(attemptFailure);
            const hasAnotherAttempt = attempt + 1 < PULL_ATTEMPTS;
            if (failureClass === 'credential_expiry' && !credentialRemintUsed && hasAnotherAttempt) {
                credentialRemintUsed = true;
                continue;
            }
            if (failureClass === 'transient_transport' && hasAnotherAttempt) {
                await io.sleep(PULL_RETRY_BACKOFF_MS[attempt] ?? PULL_RETRY_BACKOFF_MS.at(-1)!);
                continue;
            }
            break;
        }

        if (!synced) {
            throw new DatabaseOperationError('upstream_unavailable', 'Database file operation failed.');
        }

        await finalizeReplica(io, temp, target, localCreateClient!);
        ownsTemp = false;
        ownsSidecars = false;
        io.stdout(`Database replica saved to ${displayDestination(io, target)}.`);
    } catch (error) {
        if (reservationHandle) {
            try {
                await reservationHandle.close();
            } catch {
                // Cleanup below remains scoped to the exclusively reserved path.
            }
        }
        if (temp) {
            await removeOwnedFiles(io.filesystem, [
                ...(ownsTemp ? [temp] : []),
                ...(ownsSidecars ? pullSidecars(temp) : []),
            ]);
        }
        throw freshSafeFileError(error);
    }
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

export async function databaseShow(
    name: string,
    options: DatabaseShowOptions,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    await databaseShowWithConfig(name, options, await requireConfigWithWorkspace(), dependencies);
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

export async function databaseDump(
    name: string,
    file: string | undefined,
    options: DatabaseDumpOptions,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    await databaseDumpWithConfig(name, file, options, await requireConfigWithWorkspace(), dependencies);
}

export async function databasePull(
    name: string,
    destination: string | undefined,
    options: DatabasePullOptions,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    await databasePullWithConfig(name, destination, options, await requireConfigWithWorkspace(), dependencies);
}

export async function databaseImport(
    name: string,
    file: string,
    options: DatabaseImportOptions,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    await databaseImportWithConfig(name, file, options, await requireConfigWithWorkspace(), dependencies);
}

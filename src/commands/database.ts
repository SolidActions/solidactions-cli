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
    DatabaseOperationError,
    DatabaseRequestDependencies,
    DatabaseResultSet,
    formatDatabaseTableValue,
    normalizeDatabaseValue,
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
    abortSignal?: AbortSignal;
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
    abortSignal?: AbortSignal;
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
        abortSignal: dependencies.abortSignal,
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

const INCOMPLETE_DUMP_MARKER = '-- DOWNLOAD INCOMPLETE';
const DUMP_TAIL_BYTES = 4096;
const PULL_ATTEMPTS = 3;

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

function validateWritableAccess(access: unknown, now: number): {
    url: string;
    token: string;
    expiresAt: number;
} {
    const value = access as Record<string, unknown> | null;
    const url = typeof value?.url === 'string' ? value.url.trim() : '';
    const token = typeof value?.token === 'string' ? value.token.trim() : '';
    const expiresAt = typeof value?.expires_at === 'string' ? Date.parse(value.expires_at) : Number.NaN;
    if (
        value?.mode !== 'write'
        || url === ''
        || token === ''
        || !Number.isFinite(now)
        || !Number.isFinite(expiresAt)
        || expiresAt <= now + WRITABLE_RENEWAL_WINDOW_MS
    ) {
        throw new DatabaseOperationError('upstream_unavailable', 'The database access response was invalid.');
    }

    return { url, token, expiresAt };
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

function isAuthenticationExpired(error: unknown): boolean {
    const value = error as { code?: unknown; message?: unknown } | null;
    const code = typeof value?.code === 'string' ? value.code.toUpperCase() : '';
    const message = typeof value?.message === 'string' ? value.message : '';
    if (['AUTH_TOKEN_EXPIRED', 'AUTH_EXPIRED', 'TOKEN_EXPIRED'].includes(code)) return true;
    return code === 'SQLITE_AUTH' && /expired|expiration|\bjwt\b/i.test(message);
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
    let checkpointResult: DatabaseResultSet | undefined;
    let finalizationFailed = false;
    try {
        finalizer = createClient({
            url: pathToFileURL(temp).href,
            intMode: 'string',
        });
        checkpointResult = await finalizer.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
        finalizationFailed = true;
    } finally {
        if (finalizer) {
            try {
                await finalizer.close();
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
    const preparedSource = options.from && !io.importDatabase
        ? await prepareDatabaseImportSource(options.from, io.cwd, io.filesystem)
        : undefined;
    const data = stableDatabaseResponse(await requestDatabaseOperation<DatabaseMutationResponse>(
        config,
        { operation: 'create', name },
        requestDependencies(io),
    ));

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
                        post: io.post,
                        loadClient: io.loadClient,
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

export async function databaseImportWithConfig(
    name: string,
    file: string,
    options: DatabaseImportOptions,
    config: Config,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    const io = resolveDependencies(dependencies);
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
        post: io.post,
        loadClient: io.loadClient,
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

export async function databaseDumpWithConfig(
    name: string,
    file: string | undefined,
    options: DatabaseDumpOptions,
    config: Config,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    const io = resolveDependencies(dependencies);
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
    let expiresAt = 0;
    let inputSession: WritableInputSession | undefined;

    const closeAttachedClient = async (): Promise<void> => {
        if (!client) return;
        const closing = client;
        client = undefined;
        try {
            await closing.close();
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
        const access = validateWritableAccess(loaded.access, io.now());
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

        let syncFailed = false;
        try {
            if (typeof opened.sync !== 'function') throw new Error('Database sync is unavailable.');
            await opened.sync();
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
                await opened.close();
            } catch {
                // The stable setup error below takes precedence.
            }
            throw new DatabaseOperationError('upstream_unavailable', 'Database file operation failed.');
        }

        client = opened;
        localCreateClient = createClient;
        expiresAt = access.expiresAt;
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

                if (io.now() >= expiresAt - WRITABLE_RENEWAL_WINDOW_MS) {
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
                        await client.executeMultiple(statement.sql);
                        io.stdout('Transaction group executed successfully.');
                    } else {
                        const result = stableDirectResult(await client!.execute(statement.sql));
                        io.stdout(
                            result.columns.length > 0
                                ? renderDirectTable(result)
                                : `Rows affected: ${result.rowsAffected}`,
                        );
                    }
                } catch (error) {
                    if (!isAuthenticationExpired(error)) {
                        io.stderr('Database statement failed.');
                        continue;
                    }

                    io.stderr('Database statement has an unknown outcome because authorization expired.');
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

            let attemptFailed = false;
            try {
                if (typeof client.sync !== 'function') throw new Error('Database sync is unavailable.');
                await client.sync();
            } catch {
                attemptFailed = true;
            } finally {
                try {
                    await client.close();
                } catch {
                    attemptFailed = true;
                }
            }

            const replicaStat = await lstatIfPresent(io.filesystem, temp);
            if (!replicaStat || replicaStat.isSymbolicLink() || !replicaStat.isFile()) {
                throw new DatabaseOperationError('upstream_unavailable', 'Database file operation failed.');
            }
            ownsTemp = true;

            if (!attemptFailed) {
                synced = true;
                break;
            }
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

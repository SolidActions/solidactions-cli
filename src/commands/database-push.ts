import axios from 'axios';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { createClient } from '@libsql/client';
import { Config } from '../utils/config';
import { DEFAULT_DATABASE_CONTROL_PLANE_TIMEOUT_MS, DatabaseOperationError, DatabaseRequestDependencies, requestDatabaseOperation } from '../utils/database-data-plane';

const MAX_BYTES = 20_000_000_000;
const PAGE_SIZE = 4096;
const POLL_MS = 2_000;
const TERMINAL = new Set(['promoted', 'failed', 'aborted']);
const PHASES = new Set(['preparing', 'uploading', 'validating', 'finalizing', 'promoted_pending_ready', 'promoted', 'aborting', 'aborted', 'failed']);
// Laravel's unversioned `uuid` validation accepts the canonical hexadecimal
// 8-4-4-4-12 representation regardless of UUID version (including UUIDv7).
const IDEMPOTENCY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXCLUDED_PREFIXES = ['sqlite_', '_litestream', 'libsql_', '_turso_'];

export interface DatabasePushOptions {
    yes?: boolean;
    allowEmpty?: boolean;
    idempotencyKey?: string;
}

interface PushDependencies {
    stdout?: (line: string) => void;
    post?: DatabaseRequestDependencies['post'];
    upload?: (url: string, body: fs.ReadStream, options: { headers: Record<string, string>; maxBodyLength: number; maxContentLength: number; timeout: number; validateStatus: (status: number) => boolean }) => Promise<{ status: number; data?: unknown }>;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
    tempRoot?: string;
    statfs?: typeof fs.promises.statfs;
}

export interface PushManifest {
    sha256: string;
    schema_sha256: string;
    tables: Record<string, number>;
}

export interface NormalizedDatabase {
    file: string;
    inputBytes: number;
    pageCount: number;
    totalRows: number;
    manifest: PushManifest;
    cleanup: () => Promise<void>;
}

function sqlString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function sqlIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

function scalar(rows: Array<ArrayLike<unknown>>, label: string): unknown {
    if (rows.length !== 1 || rows[0].length < 1) throw new Error(`Invalid ${label} result.`);
    return rows[0][0];
}

function integer(value: unknown, label: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid ${label}.`);
    return parsed;
}

function isExcluded(name: string): boolean {
    const folded = name.toLowerCase();
    return EXCLUDED_PREFIXES.some((prefix) => folded.startsWith(prefix));
}

function safeNormalizationError(error: unknown): DatabaseOperationError {
    if (error instanceof DatabaseOperationError) return error;
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return new DatabaseOperationError('invalid_bulk_database', 'The source database file was not found; no source file was changed.');
    }
    const text = error instanceof Error ? error.message.toLowerCase() : '';
    if (text.includes('database is locked') || text.includes('busy')) {
        return new DatabaseOperationError('invalid_bulk_database', 'The SQLite snapshot is busy. Quiesce local writers and retry; the source database was not changed.');
    }
    if (text.includes('encrypted') || text.includes('not a database') || text.includes('malformed') || text.includes('corrupt')) {
        return new DatabaseOperationError('invalid_bulk_database', 'The SQLite file is corrupt, encrypted, or not a database. Export an unencrypted SQLite database and retry; the source database was not changed.');
    }
    if (text.includes('no space') || text.includes('disk full')) {
        return new DatabaseOperationError('invalid_bulk_database', 'Temporary disk space is insufficient for database normalization; the source database was not changed.');
    }
    return new DatabaseOperationError('invalid_bulk_database', 'The local SQLite binding could not open or normalize a temporary copy. Verify Node 20 platform support and the input file; the source database was not changed.');
}

async function sha256(file: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest('hex');
}

async function removeSidecars(file: string): Promise<void> {
    await Promise.all(['-wal', '-shm', '-journal'].map((suffix) => fs.promises.rm(`${file}${suffix}`, { force: true })));
}

export async function normalizeDatabaseForPush(sourceInput: string, dependencies: Pick<PushDependencies, 'tempRoot' | 'statfs'> = {}): Promise<NormalizedDatabase> {
    const source = path.resolve(sourceInput);
    let directory: string | undefined;
    let sourceClient: ReturnType<typeof createClient> | undefined;
    let stageClient: ReturnType<typeof createClient> | undefined;
    let finalClient: ReturnType<typeof createClient> | undefined;
    try {
        const sourceStat = await fs.promises.stat(source);
        if (!sourceStat.isFile() || sourceStat.size === 0) throw new DatabaseOperationError('invalid_bulk_database', 'A database push requires a non-empty regular SQLite file; the source database was not changed.');
        if (sourceStat.size > MAX_BYTES) throw new DatabaseOperationError('bulk_load_too_large', 'The database exceeds the decimal 20,000,000,000-byte bulk-load limit; the source database was not changed.');

        const tempRoot = dependencies.tempRoot ?? os.tmpdir();
        const statfs = dependencies.statfs ?? fs.promises.statfs;
        const space = await statfs(tempRoot);
        const available = Number(space.bavail) * Number(space.bsize);
        if (!Number.isFinite(available) || available < sourceStat.size * 2 + 16 * 1024 * 1024) {
            throw new DatabaseOperationError('invalid_bulk_database', 'Temporary disk space is insufficient for two normalized database copies; the source database was not changed.');
        }
        directory = await fs.promises.mkdtemp(path.join(tempRoot, 'solidactions-database-push-'));
        await fs.promises.chmod(directory, 0o700);
        const snapshot = path.join(directory, 'snapshot.db');
        const final = path.join(directory, 'upload.db');

        sourceClient = createClient({ url: pathToFileURL(source).href, intMode: 'number' });
        await sourceClient.execute(`VACUUM INTO ${sqlString(snapshot)}`);
        await sourceClient.close(); sourceClient = undefined;

        stageClient = createClient({ url: pathToFileURL(snapshot).href, intMode: 'number' });
        await stageClient.execute('PRAGMA journal_mode=DELETE');
        await stageClient.execute('PRAGMA page_size=4096');
        await stageClient.execute('PRAGMA auto_vacuum=NONE');
        await stageClient.execute(`VACUUM INTO ${sqlString(final)}`);
        await stageClient.close(); stageClient = undefined;

        finalClient = createClient({ url: pathToFileURL(final).href, intMode: 'number' });
        const mode = String(scalar((await finalClient.execute('PRAGMA journal_mode=WAL')).rows, 'journal mode')).toLowerCase();
        const checkpoint = (await finalClient.execute('PRAGMA wal_checkpoint(TRUNCATE)')).rows[0];
        if (mode !== 'wal' || !checkpoint || Number(checkpoint[0]) !== 0) throw new Error('WAL checkpoint is busy.');
        await finalClient.close(); finalClient = undefined;
        await removeSidecars(final);
        await fs.promises.chmod(final, 0o400);
        finalClient = createClient({ url: pathToFileURL(final).href, intMode: 'number' });
        const encoding = String(scalar((await finalClient.execute('PRAGMA encoding')).rows, 'encoding'));
        if (encoding.toUpperCase() !== 'UTF-8') {
            throw new DatabaseOperationError('invalid_bulk_database', 'The database encoding is not UTF-8 and cannot be changed in place. Export or rebuild a new UTF-8 SQLite database; the source database was not changed.');
        }
        const pageSize = integer(scalar((await finalClient.execute('PRAGMA page_size')).rows, 'page size'), 'page size');
        const autoVacuum = integer(scalar((await finalClient.execute('PRAGMA auto_vacuum')).rows, 'auto vacuum'), 'auto vacuum');
        const persistedMode = String(scalar((await finalClient.execute('PRAGMA journal_mode')).rows, 'journal mode')).toLowerCase();
        const integrity = String(scalar((await finalClient.execute('PRAGMA integrity_check(1)')).rows, 'integrity'));
        if (pageSize !== PAGE_SIZE || autoVacuum !== 0 || persistedMode !== 'wal' || integrity !== 'ok') throw new Error('Normalized SQLite invariants failed.');

        const schemaResult = await finalClient.execute('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type COLLATE BINARY, name COLLATE BINARY, tbl_name COLLATE BINARY, sql COLLATE BINARY');
        const schema = schemaResult.rows
            .map((row) => Array.from(row, (value) => value === null ? null : String(value)))
            .filter((row) => !isExcluded(String(row[1])) && !isExcluded(String(row[2])));
        const schemaSha = createHash('sha256').update(JSON.stringify(schema), 'utf8').digest('hex');
        const tableList = await finalClient.execute('PRAGMA table_list');
        const candidates = tableList.rows
            .filter((row) => String(row[2]) === 'table')
            .map((row) => String(row[1]))
            .filter((name) => !isExcluded(name));
        const masterNames = new Set(schema.filter((row) => row[0] === 'table').map((row) => row[1] as string));
        const names = candidates.filter((name) => masterNames.has(name)).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
        assertCountableTableLimit(names.length);
        const tables: Record<string, number> = {};
        let totalRows = 0;
        for (const name of names) {
            const count = integer(scalar((await finalClient.execute(`SELECT COUNT(*) FROM ${sqlIdentifier(name)}`)).rows, `row count for ${name}`), `row count for ${name}`);
            tables[name] = count;
            totalRows += count;
            if (!Number.isSafeInteger(totalRows)) throw new Error('Row count overflow.');
        }
        const pageCount = integer(scalar((await finalClient.execute('PRAGMA page_count')).rows, 'page count'), 'page count');
        await finalClient.close(); finalClient = undefined;
        await removeSidecars(final);
        const inputBytes = (await fs.promises.stat(final)).size;
        if (inputBytes !== pageCount * PAGE_SIZE || inputBytes < PAGE_SIZE) throw new Error('Normalized byte count mismatch.');
        if (inputBytes > MAX_BYTES) throw new DatabaseOperationError('bulk_load_too_large', 'The normalized database exceeds the decimal 20,000,000,000-byte bulk-load limit; the source database was not changed.');
        const digest = await sha256(final);
        return {
            file: final, inputBytes, pageCount, totalRows,
            manifest: { sha256: digest, schema_sha256: schemaSha, tables },
            cleanup: async () => { if (directory) await fs.promises.rm(directory, { recursive: true, force: true }); },
        };
    } catch (error) {
        try { await sourceClient?.close(); } catch { /* sanitized below */ }
        try { await stageClient?.close(); } catch { /* sanitized below */ }
        try { await finalClient?.close(); } catch { /* sanitized below */ }
        if (directory) {
            try { await fs.promises.chmod(directory, 0o700); } catch { /* cleanup remains best effort */ }
            await fs.promises.rm(directory, { recursive: true, force: true });
        }
        throw safeNormalizationError(error);
    }
}

export function assertCountableTableLimit(count: number): void {
    if (count > 1_000) {
        throw new DatabaseOperationError('invalid_bulk_database', 'The database has more than 1,000 countable tables and cannot be bulk loaded; the source database was not changed.');
    }
}

function hardDeadlineMs(bytes: number): number {
    return Math.min(4 * 60 * 60_000, 30 * 60_000 + Math.ceil(bytes / 2_000_000) * 1000);
}

function stableOperation(data: unknown): Record<string, unknown> {
    const operation = (data as any)?.operation;
    if (!operation || typeof operation.id !== 'string' || !OPERATION_UUID.test(operation.id) || typeof operation.phase !== 'string' || !PHASES.has(operation.phase)) throw new DatabaseOperationError('upstream_unavailable', 'The database bulk-load response was invalid.');
    return operation;
}

export async function databasePushWithConfig(name: string, file: string, options: DatabasePushOptions, config: Config, dependencies: PushDependencies = {}): Promise<void> {
    if (!options.yes) throw new DatabaseOperationError('confirmation_required', 'Database push is destructive and requires --yes.');
    const key = options.idempotencyKey ?? randomUUID();
    if (!IDEMPOTENCY_UUID.test(key)) throw new DatabaseOperationError('invalid_bulk_database', '--idempotency-key must be a UUID.');
    const stdout = dependencies.stdout ?? console.log;
    const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const normalized = await normalizeDatabaseForPush(file, dependencies);
    let operationId: string | undefined;
    let promoteAccepted = false;
    let terminalObserved = false;
    try {
        if (normalized.totalRows === 0 && !options.allowEmpty) throw new DatabaseOperationError('invalid_bulk_database', 'This database has zero countable rows. Retry with --allow-empty only if replacing the remote database with an empty database is intended; the source database was not changed.');
        const deadlineMs = hardDeadlineMs(normalized.inputBytes);
        const clock = dependencies.now ?? Date.now;
        const deadlineAt = clock() + deadlineMs;
        const remaining = (): number => {
            const value = deadlineAt - clock();
            if (value <= 0) throw new DatabaseOperationError('upstream_unavailable', 'Database replacement did not finish before the displayed hard deadline. Retry with the same idempotency key.');
            return value;
        };
        const controlRemaining = (): number => Math.min(DEFAULT_DATABASE_CONTROL_PLANE_TIMEOUT_MS, remaining());
        stdout(`WARNING: This destructively replaces database "${name}". Quiesce all writers; old URLs and credentials will become invalid. A private snapshot is normalized to WAL, 4096-byte pages, and auto-vacuum NONE; the source file is unchanged.`);
        stdout(`Hard deadline: ${Math.ceil(deadlineMs / 60_000)} minutes for ${normalized.inputBytes} bytes. Idempotency key: ${key}`);
        const prepareBody = {
            operation: 'bulk_load_prepare', name, bulk_mode: 'replace', input_bytes: normalized.inputBytes,
            page_count: normalized.pageCount, manifest: normalized.manifest, allow_empty: options.allowEmpty === true, idempotency_key: key,
        };
        const prepare = await requestDatabaseOperation<any>(config, prepareBody, { post: dependencies.post, controlPlaneTimeoutMs: controlRemaining() });
        const operation = stableOperation(prepare);
        operationId = String(operation.id);
        const upload = prepare?.upload;
        if (typeof upload?.url !== 'string' || typeof upload?.token !== 'string') throw new DatabaseOperationError('upstream_unavailable', 'The database upload credential response was invalid.');
        const uploader = dependencies.upload ?? axios.post;
        let uploaded;
        let renewalFailure: unknown;
        let renewing: Promise<void> = Promise.resolve();
        const renewalTimer = setInterval(() => {
            renewing = renewing.then(async () => {
                const replay = await requestDatabaseOperation<any>(config, prepareBody, { post: dependencies.post, controlPlaneTimeoutMs: controlRemaining() });
                const replayOperation = stableOperation(replay);
                if (replayOperation.id !== operation.id) throw new DatabaseOperationError('bulk_load_conflict', 'The bulk-load replay returned a different operation.');
                // A replay is a LEASE renewal only (#1287 R9b): the server
                // returns no credential, because an in-progress direct upload
                // cannot swap tokens mid-flight. The original single-use
                // credential stays valid until the hard deadline. Should any
                // server ever include one, it is neither retained nor printed.
            }).catch((error) => { renewalFailure = error; });
        }, 5 * 60_000);
        try {
            uploaded = await uploader(upload.url, fs.createReadStream(normalized.file), {
                headers: { Authorization: `Bearer ${upload.token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(normalized.inputBytes) },
                maxBodyLength: normalized.inputBytes, maxContentLength: 1024, timeout: remaining(),
                validateStatus: (status) => (status >= 200 && status < 300) || status === 413,
            });
        } catch {
            throw new DatabaseOperationError('upstream_unavailable', 'Candidate upload failed. The upstream response was hidden to protect credentials; the source database was not changed.');
        } finally {
            clearInterval(renewalTimer);
            await renewing;
        }
        if (renewalFailure) throw new DatabaseOperationError('upstream_unavailable', 'The database upload lease could not be renewed; the source database was not changed.');
        if (uploaded.status < 200 || uploaded.status > 299) {
            if (uploaded.status === 413) throw new DatabaseOperationError('bulk_load_too_large', 'The upstream database service rejected the upload size; the source database was not changed.');
            throw new DatabaseOperationError('upstream_unavailable', 'Candidate upload failed. The upstream response was hidden to protect credentials; the source database was not changed.');
        }
        await requestDatabaseOperation(config, { operation: 'bulk_load_promote', operation_id: operation.id, idempotency_key: key, upload_http_status: uploaded.status }, { post: dependencies.post, controlPlaneTimeoutMs: controlRemaining() });
        promoteAccepted = true;
        while (clock() <= deadlineAt) {
            const response = await requestDatabaseOperation<any>(config, { operation: 'bulk_load_status', operation_id: operation.id }, { post: dependencies.post, controlPlaneTimeoutMs: controlRemaining() });
            const status = stableOperation(response);
            if (!TERMINAL.has(String(status.phase))) { await sleep(POLL_MS); continue; }
            terminalObserved = true;
            if (status.phase !== 'promoted') throw new DatabaseOperationError(typeof status.failure_code === 'string' ? status.failure_code : 'upstream_unavailable', `Database replacement ended in ${status.phase}.`);
            stdout(`Database "${name}" replaced successfully (${String(status.rows_loaded ?? normalized.totalRows)} countable rows). Reacquire database credentials before reconnecting.`);
            return;
        }
        throw new DatabaseOperationError('upstream_unavailable', 'Database replacement did not finish before the displayed hard deadline. Retry status with the same idempotency key.');
    } catch (error) {
        if (operationId && !promoteAccepted) {
            try {
                await requestDatabaseOperation(config, { operation: 'bulk_load_abort', operation_id: operationId, idempotency_key: key }, { post: dependencies.post });
            } catch {
                // Preserve the original credential-safe failure. The durable
                // operation deadline and server reconciliation own cleanup.
            }
        }
        if (operationId && promoteAccepted && !terminalObserved) {
            throw new DatabaseOperationError(
                'upstream_unavailable',
                `Promotion was accepted, but status could not be confirmed. Operation ${operationId} remains active; retry with idempotency key ${key}.`,
            );
        }
        throw error;
    } finally {
        await normalized.cleanup();
    }
}

export async function databasePush(name: string, file: string, options: DatabasePushOptions): Promise<void> {
    const { requireConfigWithWorkspace } = await import('../utils/api');
    await databasePushWithConfig(name, file, options, await requireConfigWithWorkspace());
}

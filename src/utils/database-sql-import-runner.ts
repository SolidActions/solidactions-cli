import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Config } from './config';
import { loadDatabaseClientBeforeMint } from './database-client-support';
import {
    DatabaseClient,
    DatabaseClientDependencies,
    DatabaseAccess,
    DatabaseCredentialDeadline,
    DatabaseOperationError,
    DEFAULT_DATABASE_DATA_PLANE_TIMEOUT_MS,
    requestDatabaseAccess,
    runDatabaseClientOperationWithDeadline,
    databaseCredentialDeadline,
    databaseCredentialFailureCode,
    isDatabaseCredentialAuthFailure,
    isDatabaseDeadlineElapsed,
} from './database-data-plane';
import {
    DEFAULT_IMPORT_BATCH_TIMEOUT_MS,
    MAX_BATCH_GROUPS,
    SCHEMA_CATALOG_SQL,
    VECTOR_MAX_BATCH_GROUPS,
    batchCreatedFacts,
    isLockError,
    lockBackoffMs,
    mergeSchemaFacts,
    nextBatch,
    replayVerdict,
    schemaFactsFromSql,
    sourceHasVectorColumns,
} from './database-import-batching';
import {
    DatabaseSqlImportGroup,
    parseDatabaseImportSql,
} from './database-sql-import';

const CHECKPOINT_VERSION = 1;
const RENEWAL_WINDOW_MS = 30_000;

type ImportFileSystem = typeof fs.promises;

interface ImportCheckpoint {
    version: 1;
    database: string;
    source: {
        sha256: string;
        sizeBytes: number;
    };
    lastCompletedBatch: number;
    nextStatement: number;
    completedSourceBytes: number;
}

export interface PreparedDatabaseImportSource {
    file: string;
    source: Buffer;
    sha256: string;
    sizeBytes: number;
    groups: DatabaseSqlImportGroup[];
}

export interface PreparedDatabaseImport extends PreparedDatabaseImportSource {
    database: string;
    checkpointPath: string;
    checkpoint: ImportCheckpoint | null;
}

export interface DatabaseImportRunnerDependencies extends DatabaseClientDependencies {
    cwd: string;
    filesystem: ImportFileSystem;
    stdout: (line: string) => void;
    now: () => number;
    monotonicNow: () => number;
    batchTimeoutMs?: number;
    resumeTimeout?: string;
    sleep?: (ms: number) => Promise<void>;
}

function importFailure(message = 'Database import failed.'): DatabaseOperationError {
    return new DatabaseOperationError('import_failed', message);
}

function safeStem(database: string): string {
    return database
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'database';
}

function resumeLine(database: string, file: string, checkpoint: string, resumeTimeout?: string): string {
    const timeoutSuffix = resumeTimeout !== undefined ? ` --timeout ${resumeTimeout}` : '';
    return `Resume with: solidactions database import ${JSON.stringify(database)} ${JSON.stringify(file)} --resume ${JSON.stringify(checkpoint)} --yes${timeoutSuffix}`;
}

function checkpointPath(cwd: string, database: string, sha256: string, sizeBytes: number): string {
    return path.join(
        cwd,
        '.solidactions',
        'imports',
        `${safeStem(database)}-${sha256}-${sizeBytes}.json`,
    );
}

async function lstatMaybe(filesystem: ImportFileSystem, target: string): Promise<fs.Stats | null> {
    try {
        return await filesystem.lstat(target);
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw importFailure('The import checkpoint path could not be validated.');
    }
}

async function assertSafeAncestors(filesystem: ImportFileSystem, target: string): Promise<void> {
    const absolute = path.resolve(target);
    const parent = path.dirname(absolute);
    const root = path.parse(parent).root;
    const parts = parent.slice(root.length).split(path.sep).filter(Boolean);
    let current = root;

    for (const part of parts) {
        current = path.join(current, part);
        const stat = await lstatMaybe(filesystem, current);
        if (!stat) return;
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw importFailure('The import checkpoint path is unsafe.');
        }
    }
}

async function assertRegularCheckpoint(
    filesystem: ImportFileSystem,
    target: string,
): Promise<fs.Stats> {
    await assertSafeAncestors(filesystem, target);
    const stat = await lstatMaybe(filesystem, target);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
        throw importFailure('The import checkpoint must be a regular non-symlink file.');
    }
    return stat;
}

function checkpointBoundary(groups: DatabaseSqlImportGroup[], nextStatement: number): number | null {
    if (!Number.isInteger(nextStatement) || nextStatement < 0 || nextStatement > groups.length) return null;
    return nextStatement === 0 ? 0 : groups[nextStatement - 1].endByte;
}

function validateCheckpoint(
    value: unknown,
    database: string,
    sha256: string,
    sizeBytes: number,
    groups: DatabaseSqlImportGroup[],
): ImportCheckpoint {
    const checkpoint = value as Record<string, unknown> | null;
    const source = checkpoint?.source as Record<string, unknown> | null;
    const nextStatement = checkpoint?.nextStatement;
    const completedSourceBytes = checkpoint?.completedSourceBytes;
    const expectedBoundary = typeof nextStatement === 'number'
        ? checkpointBoundary(groups, nextStatement)
        : null;

    if (
        checkpoint?.version !== CHECKPOINT_VERSION
        || checkpoint.database !== database
        || source?.sha256 !== sha256
        || source.sizeBytes !== sizeBytes
        || typeof checkpoint.lastCompletedBatch !== 'number'
        || !Number.isInteger(checkpoint.lastCompletedBatch)
        || typeof nextStatement !== 'number'
        || checkpoint.lastCompletedBatch < (nextStatement === 0 ? 0 : 1)
        || checkpoint.lastCompletedBatch > nextStatement
        || expectedBoundary === null
        || completedSourceBytes !== expectedBoundary
    ) {
        throw importFailure('The import checkpoint does not match this database and SQL source.');
    }

    return {
        version: 1,
        database,
        source: { sha256, sizeBytes },
        lastCompletedBatch: checkpoint.lastCompletedBatch,
        nextStatement,
        completedSourceBytes,
    };
}

async function readCheckpoint(
    filesystem: ImportFileSystem,
    target: string,
    database: string,
    sha256: string,
    sizeBytes: number,
    groups: DatabaseSqlImportGroup[],
): Promise<ImportCheckpoint> {
    await assertRegularCheckpoint(filesystem, target);
    let value: unknown;
    try {
        value = JSON.parse(await filesystem.readFile(target, 'utf8'));
    } catch {
        throw importFailure('The import checkpoint is corrupt.');
    }
    return validateCheckpoint(value, database, sha256, sizeBytes, groups);
}

export async function prepareDatabaseImportSource(
    file: string,
    cwd: string,
    filesystem: ImportFileSystem,
): Promise<PreparedDatabaseImportSource> {
    const sourcePath = path.isAbsolute(file) ? file : path.resolve(cwd, file);
    let source: Buffer;
    try {
        source = Buffer.from(await filesystem.readFile(sourcePath));
    } catch {
        throw importFailure('The SQL import source could not be read.');
    }

    let groups: DatabaseSqlImportGroup[];
    try {
        groups = parseDatabaseImportSql(source).groups;
    } catch (error) {
        if (error instanceof DatabaseOperationError) throw importFailure(error.message);
        throw importFailure('The SQL import source is invalid.');
    }
    if (groups.length === 0) throw importFailure('The SQL import source contains no statements.');

    const sha256 = createHash('sha256').update(source).digest('hex');
    const sizeBytes = source.length;
    return { file, source, sha256, sizeBytes, groups };
}

export async function bindPreparedDatabaseImport(
    prepared: PreparedDatabaseImportSource,
    database: string,
    resume: string | undefined,
    cwd: string,
    filesystem: ImportFileSystem,
    resumeTimeout?: string,
): Promise<PreparedDatabaseImport> {
    const { file, source, sha256, sizeBytes, groups } = prepared;
    const deterministic = checkpointPath(cwd, database, sha256, sizeBytes);
    await assertSafeAncestors(filesystem, deterministic);
    const deterministicStat = await lstatMaybe(filesystem, deterministic);
    if (deterministicStat && (deterministicStat.isSymbolicLink() || !deterministicStat.isFile())) {
        throw importFailure('The import checkpoint path is unsafe.');
    }

    if (resume) {
        const supplied = path.isAbsolute(resume) ? resume : path.resolve(cwd, resume);
        if (deterministicStat && path.resolve(deterministic) !== path.resolve(supplied)) {
            throw importFailure('A different import checkpoint already exists for this SQL source.');
        }
        const checkpoint = await readCheckpoint(
            filesystem,
            supplied,
            database,
            sha256,
            sizeBytes,
            groups,
        );
        return {
            database,
            file,
            source,
            sha256,
            sizeBytes,
            groups,
            checkpointPath: supplied,
            checkpoint,
        };
    }

    if (deterministicStat) {
        await readCheckpoint(filesystem, deterministic, database, sha256, sizeBytes, groups);
        throw importFailure(
            `A matching import checkpoint already exists.\n${resumeLine(database, file, deterministic, resumeTimeout)}`,
        );
    }

    return {
        database,
        file,
        source,
        sha256,
        sizeBytes,
        groups,
        checkpointPath: deterministic,
        checkpoint: null,
    };
}

export async function prepareDatabaseImport(
    database: string,
    file: string,
    resume: string | undefined,
    cwd: string,
    filesystem: ImportFileSystem,
    resumeTimeout?: string,
): Promise<PreparedDatabaseImport> {
    const prepared = await prepareDatabaseImportSource(file, cwd, filesystem);
    return bindPreparedDatabaseImport(prepared, database, resume, cwd, filesystem, resumeTimeout);
}

async function ensureSafeDirectory(filesystem: ImportFileSystem, directory: string): Promise<void> {
    const absolute = path.resolve(directory);
    const root = path.parse(absolute).root;
    const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
    let current = root;

    for (const part of parts) {
        current = path.join(current, part);
        let stat = await lstatMaybe(filesystem, current);
        if (!stat) {
            try {
                await filesystem.mkdir(current, { mode: 0o700 });
            } catch (error) {
                if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
                    throw importFailure('The import checkpoint directory could not be created.');
                }
            }
            stat = await lstatMaybe(filesystem, current);
        }
        if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
            throw importFailure('The import checkpoint path is unsafe.');
        }
    }
}

async function publishCheckpoint(
    filesystem: ImportFileSystem,
    target: string,
    checkpoint: ImportCheckpoint,
    allowExisting: boolean,
): Promise<void> {
    const directory = path.dirname(target);
    await ensureSafeDirectory(filesystem, directory);
    await assertSafeAncestors(filesystem, target);

    const existing = await lstatMaybe(filesystem, target);
    if (
        (existing && (existing.isSymbolicLink() || !existing.isFile()))
        || (existing && !allowExisting)
    ) {
        throw importFailure('The import checkpoint path is unsafe.');
    }

    const temp = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<ImportFileSystem['open']>> | undefined;
    let ownsTemp = false;
    try {
        handle = await filesystem.open(temp, 'wx', 0o600);
        ownsTemp = true;
        await handle.writeFile(`${JSON.stringify(checkpoint)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;

        await assertSafeAncestors(filesystem, target);
        const finalExisting = await lstatMaybe(filesystem, target);
        if (
            (finalExisting && (finalExisting.isSymbolicLink() || !finalExisting.isFile()))
            || (finalExisting && !allowExisting)
        ) {
            throw importFailure('The import checkpoint path is unsafe.');
        }
        const tempStat = await lstatMaybe(filesystem, temp);
        if (!tempStat || tempStat.isSymbolicLink() || !tempStat.isFile()) {
            throw importFailure('The import checkpoint temporary file is unsafe.');
        }
        await filesystem.rename(temp, target);
        ownsTemp = false;
    } catch {
        if (handle) {
            try {
                await handle.close();
            } catch {
                // The public failure below remains credential- and path-safe.
            }
        }
        if (ownsTemp) {
            try {
                await filesystem.unlink(temp);
            } catch {
                // Cleanup is scoped to the exclusively created sibling.
            }
        }
        throw importFailure('The committed batch could not be checkpointed safely.');
    }
}

async function removeCheckpoint(filesystem: ImportFileSystem, target: string): Promise<void> {
    await assertRegularCheckpoint(filesystem, target);
    try {
        await filesystem.unlink(target);
    } catch {
        throw importFailure('The completed import checkpoint could not be removed safely.');
    }
}

function batchSql(groups: DatabaseSqlImportGroup[]): string {
    return [
        'PRAGMA foreign_keys=OFF;',
        'BEGIN IMMEDIATE;',
        ...groups.map((group) => group.sql),
        'COMMIT;',
        'PRAGMA foreign_keys=ON;',
    ].join('\n');
}

function validateAccess(access: unknown, now: number, monotonicNow: number): {
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
        RENEWAL_WINDOW_MS,
    );
    if (
        value?.mode !== 'write'
        || url === ''
        || token === ''
        || !deadline
    ) {
        throw importFailure('Database import access was invalid.');
    }
    return { url, token, deadline };
}

async function acquireClient(
    prepared: PreparedDatabaseImport,
    config: Config,
    dependencies: DatabaseImportRunnerDependencies,
): Promise<{ client: DatabaseClient; deadline: DatabaseCredentialDeadline }> {
    let loaded: Awaited<ReturnType<typeof loadDatabaseClientBeforeMint>>;
    try {
        loaded = await loadDatabaseClientBeforeMint(
            () => requestDatabaseAccess(config, prepared.database, 'write', {
                post: dependencies.post,
                controlPlaneTimeoutMs: dependencies.controlPlaneTimeoutMs,
            }),
            { loadClient: dependencies.loadClient },
        );
    } catch (error) {
        if (error instanceof DatabaseOperationError) throw error;
        throw importFailure('Database import access could not be renewed.');
    }

    const access = validateAccess(loaded.access, dependencies.now(), dependencies.monotonicNow());
    let client: DatabaseClient;
    try {
        client = loaded.createClient({
            url: access.url,
            authToken: access.token,
            intMode: 'string',
        }) as DatabaseClient;
    } catch {
        throw importFailure('Database import client could not be created.');
    }

    if (typeof client.executeMultiple !== 'function') {
        try {
            await runDatabaseClientOperationWithDeadline(
                async () => { await client.close(); },
                undefined,
                dependencies.dataPlaneTimeoutMs ?? DEFAULT_DATABASE_DATA_PLANE_TIMEOUT_MS,
            );
        } catch {
            // The unsupported client error below is the only public detail.
        }
        throw importFailure('Database import requires atomic multi-statement execution support.');
    }
    return { client, deadline: access.deadline };
}

async function closeClient(
    client: DatabaseClient | undefined,
    timeoutMs = DEFAULT_DATABASE_DATA_PLANE_TIMEOUT_MS,
): Promise<void> {
    if (!client) return;
    try {
        await runDatabaseClientOperationWithDeadline(
            async () => { await client.close(); },
            undefined,
            timeoutMs,
        );
    } catch {
        throw importFailure('Database import client cleanup failed.');
    }
}

export async function runPreparedDatabaseImport(
    prepared: PreparedDatabaseImport,
    config: Config,
    dependencies: DatabaseImportRunnerDependencies,
): Promise<void> {
    let nextStatement = prepared.checkpoint?.nextStatement ?? 0;
    let completedBatches = prepared.checkpoint?.lastCompletedBatch ?? 0;
    let completedSourceBytes = prepared.checkpoint?.completedSourceBytes ?? 0;
    let checkpointPublished = prepared.checkpoint !== null;
    let suppressResume = false;
    let client: DatabaseClient | undefined;
    let clientClosePromise: Promise<void> | undefined;
    let deadline: DatabaseCredentialDeadline | undefined;
    let failure: DatabaseOperationError | undefined;
    const closeCurrentClient = (): Promise<void> => {
        clientClosePromise ??= closeClient(client, dependencies.dataPlaneTimeoutMs);
        return clientClosePromise;
    };

    const batchTimeoutMs = dependencies.batchTimeoutMs ?? DEFAULT_IMPORT_BATCH_TIMEOUT_MS;
    const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let batchCap = sourceHasVectorColumns(prepared.groups) ? VECTOR_MAX_BATCH_GROUPS : MAX_BATCH_GROUPS;
    let retryingAfterTimeout = false;
    let lockAttempts = 0;
    let lockWaitedMs = 0;

    try {
        while (nextStatement < prepared.groups.length) {
            const deadlineNow = deadline?.clock === 'monotonic' ? dependencies.monotonicNow() : dependencies.now();
            if (!client || !deadline || deadlineNow >= deadline.renewalAt) {
                await closeCurrentClient();
                client = undefined;
                clientClosePromise = undefined;
                const acquired = await acquireClient(prepared, config, dependencies);
                client = acquired.client;
                deadline = acquired.deadline;
            }

            const batch = nextBatch(prepared.groups, nextStatement, batchCap);
            try {
                await runDatabaseClientOperationWithDeadline(
                    () => client!.executeMultiple!(batchSql(batch.groups)),
                    closeCurrentClient,
                    batchTimeoutMs,
                );
            } catch (error) {
                const batchFrom = batch.groups[0].startLine;
                const batchTo = batch.groups[batch.groups.length - 1].endLine;
                const dropClient = () => {
                    void closeCurrentClient().catch(() => undefined);
                    client = undefined;
                    clientClosePromise = undefined;
                    deadline = undefined;
                };
                // D3: every stop below is a first-batch stop while nothing is
                // checkpointed yet; a later batch keeps its resume line instead.
                const firstBatchHint = checkpointPublished ? '' : ' Nothing was checkpointed yet, so there is no resume line; the first batch may or may not have committed. Check its tables, then rerun the whole import with a longer --timeout (for example --timeout 15m).';

                // D7: a lock error that follows a retried timeout: same batch, same size, bounded backoff.
                if (retryingAfterTimeout && isLockError(error)) {
                    const delay = lockBackoffMs(lockAttempts, batchTimeoutMs - lockWaitedMs);
                    if (delay <= 0) {
                        const lockHint = checkpointPublished
                            ? 'Wait and resume, or raise the per-batch limit with --timeout.'
                            : 'Wait, then rerun the whole import, or raise the per-batch limit with --timeout.';
                        throw new DatabaseOperationError(
                            'upstream_unavailable',
                            `The database stayed locked for ${Math.round(batchTimeoutMs / 1000)}s after a batch timed out (lines ${batchFrom}-${batchTo}); the timed-out transaction may still be running. ${lockHint}${firstBatchHint}`,
                        );
                    }
                    lockAttempts += 1;
                    lockWaitedMs += delay;
                    dropClient();
                    dependencies.stdout(`The database is still locked by the timed-out batch; retrying the same ${batch.groups.length} statements in ${Math.round(delay / 100) / 10}s.`);
                    await sleep(delay);
                    continue;
                }

                // D1, D2, D8: a deadline timeout.
                if (isDatabaseDeadlineElapsed(error)) {
                    let keepFreshClient = false;
                    const size = batch.groups.length;
                    const seconds = Math.round(batchTimeoutMs / 1000);
                    const sourceFacts = schemaFactsFromSql(prepared.groups.slice(0, batch.nextStatement).map((group) => group.sql), 'source');
                    let verdict = replayVerdict(batch.groups, sourceFacts);
                    if (size >= 2 && verdict.status === 'unknown') {
                        // D8: a read of the target catalog, on a fresh client, under the per-batch deadline (never cached).
                        dropClient();
                        const acquired = await acquireClient(prepared, config, dependencies);
                        client = acquired.client;
                        deadline = acquired.deadline;
                        keepFreshClient = true;
                        let rows: Array<ArrayLike<unknown>>;
                        try {
                            rows = (await runDatabaseClientOperationWithDeadline(
                                () => client!.execute(SCHEMA_CATALOG_SQL),
                                closeCurrentClient,
                                batchTimeoutMs,
                            )).rows;
                        } catch {
                            throw new DatabaseOperationError(
                                'upstream_unavailable',
                                `A batch of ${size} statements (lines ${batchFrom}-${batchTo}) did not finish within ${seconds}s, and the target schema could not be read to check whether repeating it is safe, so it was not retried. Raise the per-batch limit with --timeout (for example --timeout 15m).${firstBatchHint}`,
                            );
                        }
                        // D8: the facts are used for this verdict only and dropped; the next timeout reads again.
                        const catalogFacts = schemaFactsFromSql(rows.map((row) => String(row[3] ?? '')), 'catalog');
                        const catalogObjectNames = new Set(rows.map((row) => String(row[1] ?? '').toLowerCase()));
                        verdict = replayVerdict(batch.groups, mergeSchemaFacts(mergeSchemaFacts(sourceFacts, catalogFacts), batchCreatedFacts(batch.groups, catalogFacts, catalogObjectNames)));
                    }
                    if (size >= 2 && verdict.status === 'safe') {
                        if (!keepFreshClient) dropClient();
                        batchCap = Math.max(1, Math.floor(size / 2));
                        retryingAfterTimeout = true;
                        lockAttempts = 0;
                        lockWaitedMs = 0;
                        dependencies.stdout(
                            `A batch of ${size} statements did not finish within ${seconds}s; retrying from the same statement in batches of up to ${batchCap}.`,
                        );
                        continue;
                    }
                    const recheckHint = checkpointPublished ? 'before resuming.' : 'before rerunning.';
                    const reason = size === 1
                        ? `A single statement (lines ${batchFrom}-${batchTo}, ${Buffer.byteLength(batch.groups[0].sql, 'utf8')} bytes) did not finish within ${seconds}s and cannot be split further.`
                        : `A batch of ${size} statements (lines ${batchFrom}-${batchTo}) did not finish within ${seconds}s and may or may not have committed. ${verdict.status === 'unsafe' && verdict.firstUnsafe ? (verdict.unsafeTable ? `The statement at lines ${verdict.firstUnsafe.startLine}-${verdict.firstUnsafe.endLine} writes into table ${verdict.unsafeTable.name}, which ${verdict.unsafeTable.reason === 'trigger' ? 'has a trigger' : 'has no primary key or unique constraint (in the target, or as this batch creates it)'}, so it is not safe to repeat` : `The statement at lines ${verdict.firstUnsafe.startLine}-${verdict.firstUnsafe.endLine} is not safe to repeat (a plain INSERT or CREATE, an UPDATE or DELETE, or an INSERT OR REPLACE/IGNORE into a table without a primary key or unique constraint, or with a trigger)`) : `The table(s) ${verdict.unknownTables.join(', ')} are not in the target database yet and this batch does not create them, so repeating the batch is not safe`}, so it was not retried; the batch may have committed, so check the last rows of its tables ${recheckHint}`;
                    throw new DatabaseOperationError(
                        'upstream_unavailable',
                        `Database operation timed out. ${reason} Raise the per-batch limit with --timeout (for example --timeout 15m).${firstBatchHint}`,
                    );
                }

                if (error instanceof DatabaseOperationError) throw error;
                if (deadline && isDatabaseCredentialAuthFailure(error)) {
                    const code = databaseCredentialFailureCode(deadline, dependencies.now(), dependencies.monotonicNow());
                    const label = code === 'database_credential_expired' ? 'expired' : 'was revoked';
                    throw new DatabaseOperationError(
                        code,
                        `Database credential ${label} during an import batch; the batch outcome is unknown.`,
                    );
                }
                throw importFailure('A database import batch failed.');
            }

            const boundary = prepared.groups[batch.nextStatement - 1].endByte;
            const checkpoint: ImportCheckpoint = {
                version: 1,
                database: prepared.database,
                source: {
                    sha256: prepared.sha256,
                    sizeBytes: prepared.sizeBytes,
                },
                lastCompletedBatch: completedBatches + 1,
                nextStatement: batch.nextStatement,
                completedSourceBytes: boundary,
            };
            try {
                await publishCheckpoint(
                    dependencies.filesystem,
                    prepared.checkpointPath,
                    checkpoint,
                    checkpointPublished,
                );
            } catch {
                suppressResume = true;
                throw importFailure('A committed database import batch could not be checkpointed safely.');
            }

            checkpointPublished = true;
            completedBatches += 1;
            retryingAfterTimeout = false;
            lockAttempts = 0;
            lockWaitedMs = 0;
            nextStatement = batch.nextStatement;
            completedSourceBytes = boundary;
            dependencies.stdout(
                `Imported checkpoint: ${nextStatement} statements, committed source progress: ${boundary} source bytes.`,
            );
        }
    } catch (error) {
        failure = error instanceof DatabaseOperationError
            ? error
            : importFailure('Database import failed.');
    }

    try {
        await closeCurrentClient();
        client = undefined;
        clientClosePromise = undefined;
    } catch {
        if (!failure) failure = importFailure('Database import client cleanup failed.');
    }

    if (!failure) {
        try {
            await removeCheckpoint(dependencies.filesystem, prepared.checkpointPath);
            checkpointPublished = false;
        } catch {
            suppressResume = true;
            failure = importFailure('The completed import could not remove its checkpoint safely.');
        }
    }

    if (failure) {
        const policyRefusal = failure.code === 'read_only_mode'
            || failure.code === 'plan_denied'
            || ['reads_exhausted', 'writes_exhausted', 'storage_exhausted'].includes(failure.code)
            || failure.status === 429;
        const guidance = checkpointPublished && !suppressResume && !policyRefusal
            ? `\nLast completed position: batch ${completedBatches}, ${nextStatement} statements, ${completedSourceBytes} source bytes.\n${resumeLine(prepared.database, prepared.file, prepared.checkpointPath, dependencies.resumeTimeout)}`
            : '';
        throw new DatabaseOperationError(failure.code, `${failure.message}${guidance}`, failure.status);
    }

    dependencies.stdout(
        `Imported ${prepared.groups.length} statements (${prepared.sizeBytes} total source bytes) into database "${prepared.database}".`,
    );
}

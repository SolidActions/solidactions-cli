import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Config } from './config';
import { loadDatabaseClientBeforeMint } from './database-client-support';
import {
    DatabaseClient,
    DatabaseClientDependencies,
    DatabaseOperationError,
    requestDatabaseAccess,
} from './database-data-plane';
import {
    DatabaseSqlImportGroup,
    parseDatabaseImportSql,
} from './database-sql-import';

const CHECKPOINT_VERSION = 1;
const MAX_BATCH_GROUPS = 100;
const MAX_BATCH_BYTES = 512 * 1024;
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

function resumeLine(database: string, file: string, checkpoint: string): string {
    return `Resume with: solidactions database import ${JSON.stringify(database)} ${JSON.stringify(file)} --resume ${JSON.stringify(checkpoint)} --yes`;
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

function deterministicBatchCount(
    groups: DatabaseSqlImportGroup[],
    nextStatement: number,
): number | null {
    if (nextStatement === 0) return 0;
    let cursor = 0;
    let count = 0;
    while (cursor < groups.length) {
        const batch = nextBatch(groups, cursor);
        cursor = batch.nextStatement;
        count += 1;
        if (cursor === nextStatement) return count;
        if (cursor > nextStatement) return null;
    }
    return null;
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
    const expectedBatchCount = typeof nextStatement === 'number'
        ? deterministicBatchCount(groups, nextStatement)
        : null;

    if (
        checkpoint?.version !== CHECKPOINT_VERSION
        || checkpoint.database !== database
        || source?.sha256 !== sha256
        || source.sizeBytes !== sizeBytes
        || typeof checkpoint.lastCompletedBatch !== 'number'
        || !Number.isInteger(checkpoint.lastCompletedBatch)
        || checkpoint.lastCompletedBatch !== expectedBatchCount
        || typeof nextStatement !== 'number'
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
            `A matching import checkpoint already exists.\n${resumeLine(database, file, deterministic)}`,
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
): Promise<PreparedDatabaseImport> {
    const prepared = await prepareDatabaseImportSource(file, cwd, filesystem);
    return bindPreparedDatabaseImport(prepared, database, resume, cwd, filesystem);
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

interface ImportBatch {
    groups: DatabaseSqlImportGroup[];
    nextStatement: number;
}

function nextBatch(groups: DatabaseSqlImportGroup[], start: number): ImportBatch {
    const selected: DatabaseSqlImportGroup[] = [];
    let bytes = 0;
    let index = start;
    while (index < groups.length && selected.length < MAX_BATCH_GROUPS) {
        const groupBytes = Buffer.byteLength(groups[index].sql, 'utf8');
        if (selected.length > 0 && bytes + groupBytes > MAX_BATCH_BYTES) break;
        selected.push(groups[index]);
        bytes += groupBytes;
        index += 1;
        if (groupBytes > MAX_BATCH_BYTES) break;
    }
    return { groups: selected, nextStatement: index };
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

function validateAccess(access: unknown, now: number): { url: string; token: string; expiresAt: number } {
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
        || expiresAt <= now + RENEWAL_WINDOW_MS
    ) {
        throw importFailure('Database import access was invalid.');
    }
    return { url, token, expiresAt };
}

async function acquireClient(
    prepared: PreparedDatabaseImport,
    config: Config,
    dependencies: DatabaseImportRunnerDependencies,
): Promise<{ client: DatabaseClient; expiresAt: number }> {
    let loaded: Awaited<ReturnType<typeof loadDatabaseClientBeforeMint>>;
    try {
        loaded = await loadDatabaseClientBeforeMint(
            () => requestDatabaseAccess(config, prepared.database, 'write', { post: dependencies.post }),
            { loadClient: dependencies.loadClient },
        );
    } catch (error) {
        if (error instanceof DatabaseOperationError) throw error;
        throw importFailure('Database import access could not be renewed.');
    }

    const access = validateAccess(loaded.access, dependencies.now());
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
            await client.close();
        } catch {
            // The unsupported client error below is the only public detail.
        }
        throw importFailure('Database import requires atomic multi-statement execution support.');
    }
    return { client, expiresAt: access.expiresAt };
}

async function closeClient(client: DatabaseClient | undefined): Promise<void> {
    if (!client) return;
    try {
        await client.close();
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
    let expiresAt = 0;
    let failure: DatabaseOperationError | undefined;

    try {
        while (nextStatement < prepared.groups.length) {
            if (!client || dependencies.now() >= expiresAt - RENEWAL_WINDOW_MS) {
                await closeClient(client);
                client = undefined;
                const acquired = await acquireClient(prepared, config, dependencies);
                client = acquired.client;
                expiresAt = acquired.expiresAt;
            }

            const batch = nextBatch(prepared.groups, nextStatement);
            try {
                await client.executeMultiple!(batchSql(batch.groups));
            } catch (error) {
                if (error instanceof DatabaseOperationError) throw error;
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
        await closeClient(client);
        client = undefined;
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
            || failure.status === 429;
        const guidance = checkpointPublished && !suppressResume && !policyRefusal
            ? `\nLast completed position: batch ${completedBatches}, ${nextStatement} statements, ${completedSourceBytes} source bytes.\n${resumeLine(prepared.database, prepared.file, prepared.checkpointPath)}`
            : '';
        throw new DatabaseOperationError(failure.code, `${failure.message}${guidance}`, failure.status);
    }

    dependencies.stdout(
        `Imported ${prepared.groups.length} statements (${prepared.sizeBytes} total source bytes) into database "${prepared.database}".`,
    );
}

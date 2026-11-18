/**
 * The hidden per-database replica cache behind `database pull` (cli#262, plan D2-D5).
 * Layout: `<root>/<key>/{lock,lock.reclaim,meta.json,snapshot.tmp,data/}`; everything libSQL
 * creates lives under `data/`, so a wipe removes `data/` whole. A replaced server copy (D3)
 * wipes `data/`; a stale lock (D4) is reclaimed only under `lock.reclaim`. Every cache problem
 * answers `skipped` (D5). Nothing here touches anything outside `<root>/<key>/` (apart from
 * creating `<root>`) or stores a credential (I4).
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const REPLICA_CACHE_REPLACEMENT_LIMIT = 3;
export const REPLICA_CACHE_REPLACEMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const REPLICA_CACHE_SKIP_MS = 7 * 24 * 60 * 60 * 1000;
export const REPLICA_CACHE_STALE_LOCK_MS = 60 * 60 * 1000;
export const REPLICA_CACHE_STALE_RECLAIM_MS = 60 * 1000;

export interface ReplicaCacheIdentity {
    host: string;
    workspaceId: string;
    name: string;
    /** `row.id` of the database record, or null when the record has none. */
    databaseId: string | null;
    /** `row.created_at` of the database record, or null when the record has none. */
    createdAt: string | null;
    /** `syncOriginOf(access.url)`, or null when it cannot be read. */
    syncOrigin: string | null;
}

export interface ReplicaCache {
    /** `<root>/<key>/data/replica.db`; the only path the libSQL sync client is given. `data/` exists. */
    readonly replicaPath: string;
    /** `<root>/<key>/snapshot.tmp`; the only path `VACUUM INTO` writes. Absent at acquire. */
    readonly snapshotPath: string;
    /** True when `replicaPath` existed when the cache was acquired and the identity matched. */
    readonly warm: boolean;
    /** Remove `data/` whole and recreate it empty; after this `warm` reads false. Throws only `ReplicaCacheError`. */
    wipe(): Promise<void>;
    /** Remove `snapshot.tmp` if present. Never throws. */
    discardSnapshot(): Promise<void>;
    /** Record a successful sync and verified snapshot in `meta.json` (identity, `lastSyncedAt`). Never stores a credential. It may reject with a raw filesystem error; callers treat any rejection as a cache fault. */
    markSynced(): Promise<void>;
    /** Remove `snapshot.tmp` and the lock if it is still ours. Idempotent; never throws. */
    release(): Promise<void>;
}

export type ReplicaCacheOutcome =
    | { kind: 'ready'; cache: ReplicaCache }
    | { kind: 'skipped'; reason: 'busy' | 'rewritten_often' | 'unavailable' };

export class ReplicaCacheError extends Error {}

type ReplicaCacheFileSystem = typeof fs.promises;

interface ReplicaCacheMeta {
    version: 1;
    databaseId: string | null;
    createdAt: string | null;
    syncOrigin: string | null;
    lastSyncedAt: number | null;
    replacements: number[];
    skipUntil: number | null;
}

interface LockRecord {
    pid: number;
    host: string;
    nonce: string;
    at: number;
}

/** What was judged stale, so the reclaim can check the lock is still that one. */
type StaleLock =
    | { kind: 'parsed'; nonce: string }
    | { kind: 'unreadable'; dev: number; ino: number; mtimeMs: number; content: string | null };

type LockJudgement = { stale: false } | { stale: true; lock: StaleLock };

const IDENTITY_FIELDS = ['databaseId', 'createdAt', 'syncOrigin'] as const;

/** `<homedir>/.solidactions/cache/database-replicas`. */
export function defaultReplicaCacheRoot(homedir: string = os.homedir()): string {
    return path.join(homedir, '.solidactions', 'cache', 'database-replicas');
}

/** First 32 hex characters of sha256(JSON.stringify([host, workspaceId, name])). */
export function replicaCacheKey(identity: Pick<ReplicaCacheIdentity, 'host' | 'workspaceId' | 'name'>): string {
    return crypto.createHash('sha256').update(JSON.stringify([identity.host, identity.workspaceId, identity.name])).digest('hex').slice(0, 32);
}

/** Lower-cased `host[:port]` of a `libsql://`, `https://` or `http://` URL; null when it cannot be read. */
export function syncOriginOf(syncUrl: unknown): string | null {
    if (typeof syncUrl !== 'string' || syncUrl === '') return null;
    let parsed: URL;
    try {
        parsed = new URL(syncUrl);
    } catch {
        return null;
    }
    if (!['libsql:', 'https:', 'http:'].includes(parsed.protocol)) return null;
    const origin = parsed.host.toLowerCase();
    return origin === '' ? null : origin;
}

/** Never throws for a cache problem: it answers `skipped` instead. */
export async function acquireReplicaCache(options: {
    root: string;
    identity: ReplicaCacheIdentity;
    now: () => number;
    filesystem?: typeof fs.promises;
    pid?: number;
    hostname?: string;
    processAlive?: (pid: number) => boolean;
}): Promise<ReplicaCacheOutcome> {
    const filesystem = options.filesystem ?? fs.promises;
    const { now, identity } = options;
    const dir = path.join(options.root, replicaCacheKey(identity));
    const lockPath = path.join(dir, 'lock');
    const ours: LockRecord = { pid: options.pid ?? process.pid, host: options.hostname ?? os.hostname(), nonce: crypto.randomUUID(), at: now() };
    let cache: CacheHandle | null = null;

    try {
        // Any error from here on (a root that cannot be created included) answers `unavailable` below.
        await filesystem.mkdir(options.root, { recursive: true, mode: 0o700 });
        await filesystem.mkdir(dir, { recursive: true, mode: 0o700 });
        if (!(await filesystem.lstat(dir)).isDirectory()) return { kind: 'skipped', reason: 'unavailable' };

        const locked = await takeLock(filesystem, dir, ours, now, options.processAlive ?? defaultProcessAlive);
        if (!locked) return { kind: 'skipped', reason: 'busy' };
        cache = new CacheHandle(filesystem, dir, lockPath, ours.nonce, now);

        await filesystem.rm(cache.snapshotPath, { force: true });
        const stored = await readMeta(filesystem, path.join(dir, 'meta.json'));
        const meta = stored === null || stored === 'missing' ? defaultMeta() : stored;
        cache.meta = meta;
        // A corrupt meta, or a missing one beside a non-empty data/, leaves a replica of unknown origin (I6).
        if (stored === null || (stored === 'missing' && await isNonEmptyDirectory(filesystem, path.join(dir, 'data')))) await cache.wipe();

        if (meta.skipUntil !== null && meta.skipUntil > now()) {
            await cache.release();
            return { kind: 'skipped', reason: 'rewritten_often' };
        }

        const replaced = IDENTITY_FIELDS.some((field) => meta[field] !== null && identity[field] !== null && meta[field] !== identity[field]);
        for (const field of IDENTITY_FIELDS) {
            const offered = identity[field];
            if (offered !== null) meta[field] = offered;
        }
        if (replaced) {
            await cache.wipe();
            const at = now();
            meta.replacements = [...meta.replacements, at].filter((when) => at - when <= REPLICA_CACHE_REPLACEMENT_WINDOW_MS);
            if (meta.replacements.length >= REPLICA_CACHE_REPLACEMENT_LIMIT) {
                meta.skipUntil = at + REPLICA_CACHE_SKIP_MS;
                await cache.writeMeta();
                await cache.release();
                return { kind: 'skipped', reason: 'rewritten_often' };
            }
        }
        await cache.writeMeta();

        const dataDir = path.join(dir, 'data');
        if ((await lstatIfPresent(filesystem, dataDir)) === null) await filesystem.mkdir(dataDir, { mode: 0o700 });
        if (!(await filesystem.lstat(dataDir)).isDirectory()) {
            await cache.release();
            return { kind: 'skipped', reason: 'unavailable' };
        }
        cache.warm = (await lstatIfPresent(filesystem, cache.replicaPath))?.isFile() === true;

        return { kind: 'ready', cache };
    } catch {
        if (cache !== null) await cache.release();
        return { kind: 'skipped', reason: 'unavailable' };
    }
}

class CacheHandle implements ReplicaCache {
    readonly replicaPath: string;
    readonly snapshotPath: string;
    warm = false;
    meta: ReplicaCacheMeta = defaultMeta();
    private released = false;
    private readonly dataDir: string;

    constructor(
        private readonly filesystem: ReplicaCacheFileSystem,
        private readonly dir: string,
        private readonly lockPath: string,
        private readonly nonce: string,
        private readonly now: () => number,
    ) {
        this.dataDir = path.join(dir, 'data');
        this.replicaPath = path.join(this.dataDir, 'replica.db');
        this.snapshotPath = path.join(dir, 'snapshot.tmp');
    }

    async wipe(): Promise<void> {
        try {
            const existing = await lstatIfPresent(this.filesystem, this.dataDir);
            if (existing !== null) {
                if (!existing.isDirectory()) throw new ReplicaCacheError(`The cache's data folder is not a plain folder: ${this.dataDir}`);
                await this.filesystem.rm(this.dataDir, { recursive: true, force: true });
            }
            await this.filesystem.mkdir(this.dataDir, { mode: 0o700 });
        } catch (error) {
            if (error instanceof ReplicaCacheError) throw error;
            throw new ReplicaCacheError(`Could not reset the cache's data folder: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.warm = false;
        this.meta.lastSyncedAt = null;
    }

    async discardSnapshot(): Promise<void> {
        try {
            await this.filesystem.rm(this.snapshotPath, { force: true });
        } catch {
            // Never throws: a snapshot that cannot be removed is removed at the next acquire.
        }
    }

    async markSynced(): Promise<void> {
        this.meta.lastSyncedAt = this.now();
        await this.writeMeta();
    }

    async release(): Promise<void> {
        if (this.released) return;
        this.released = true;
        await this.discardSnapshot();
        try {
            const stat = await lstatIfPresent(this.filesystem, this.lockPath);
            if (stat === null || !stat.isFile()) return;
            const record = parseLockRecord(await this.filesystem.readFile(this.lockPath, 'utf8'));
            if (record !== null && record.nonce === this.nonce) await this.filesystem.unlink(this.lockPath);
        } catch {
            // Never throws: a lock left behind is judged stale and reclaimed by the next pull.
        }
    }

    /** Writes `meta.json` atomically: `meta.json.<nonce>.tmp`, then `rename`. Only the documented keys. */
    async writeMeta(): Promise<void> {
        const { databaseId, createdAt, syncOrigin, lastSyncedAt, replacements, skipUntil } = this.meta;
        const body: ReplicaCacheMeta = { version: 1, databaseId, createdAt, syncOrigin, lastSyncedAt, replacements, skipUntil };
        const temp = path.join(this.dir, `meta.json.${this.nonce}.tmp`);
        try {
            const handle = await this.filesystem.open(temp, 'wx', 0o600);
            try {
                await handle.writeFile(JSON.stringify(body));
            } finally {
                await handle.close();
            }
            await this.filesystem.rename(temp, path.join(this.dir, 'meta.json'));
        } catch (error) {
            await this.filesystem.rm(temp, { force: true }).catch(() => undefined);
            throw error;
        }
    }
}

function defaultMeta(): ReplicaCacheMeta {
    return { version: 1, databaseId: null, createdAt: null, syncOrigin: null, lastSyncedAt: null, replacements: [], skipUntil: null };
}

/** The stored meta; `'missing'` when there is no file; null when it is corrupt (not a regular file, unparseable, wrong version or wrong shape). */
async function readMeta(filesystem: ReplicaCacheFileSystem, metaPath: string): Promise<ReplicaCacheMeta | 'missing' | null> {
    const stat = await lstatIfPresent(filesystem, metaPath);
    if (stat === null) return 'missing';
    if (!stat.isFile()) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(await filesystem.readFile(metaPath, 'utf8'));
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
    const isNullableNumber = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value));
    if (
        candidate.version !== 1
        || !isNullableString(candidate.databaseId)
        || !isNullableString(candidate.createdAt)
        || !isNullableString(candidate.syncOrigin)
        || !isNullableNumber(candidate.lastSyncedAt)
        || !isNullableNumber(candidate.skipUntil)
        || !Array.isArray(candidate.replacements)
        || !candidate.replacements.every((when) => typeof when === 'number' && Number.isFinite(when))
    ) {
        return null;
    }
    // Validated above; extra keys are harmless because writeMeta writes only the documented ones.
    return candidate as unknown as ReplicaCacheMeta;
}

/** True when this run now holds the lock; false when it is busy. Throws only for an unexpected filesystem error. */
async function takeLock(
    filesystem: ReplicaCacheFileSystem,
    dir: string,
    ours: LockRecord,
    now: () => number,
    processAlive: (pid: number) => boolean,
): Promise<boolean> {
    const lockPath = path.join(dir, 'lock');
    if (await createLockFile(filesystem, lockPath, ours)) return true;

    const judgement = await judgeExistingLock(filesystem, lockPath, ours.host, now, processAlive);
    if (!judgement.stale) return false;
    return reclaimStaleLock(filesystem, dir, judgement.lock, ours, now);
}

/** Creates `lock` with `wx` and writes our record; false when a lock already exists. */
async function createLockFile(filesystem: ReplicaCacheFileSystem, lockPath: string, record: LockRecord): Promise<boolean> {
    let handle: fs.promises.FileHandle;
    try {
        handle = await filesystem.open(lockPath, 'wx', 0o600);
    } catch (error) {
        if (errorCode(error) === 'EEXIST') return false;
        throw error;
    }
    try {
        try {
            await handle.writeFile(JSON.stringify(record));
        } finally {
            await handle.close();
        }
    } catch (error) {
        // A lock we created but could not fill is ours to remove; never leave an empty one behind.
        await filesystem.unlink(lockPath).catch(() => undefined);
        throw error;
    }
    return true;
}

async function judgeExistingLock(
    filesystem: ReplicaCacheFileSystem,
    lockPath: string,
    ourHost: string,
    now: () => number,
    processAlive: (pid: number) => boolean,
): Promise<LockJudgement> {
    const stat = await lstatIfPresent(filesystem, lockPath);
    // Gone between our `wx` and this read: another pull just released it. Busy this time.
    if (stat === null) return { stale: false };
    const content = stat.isFile() ? await readIfPresent(filesystem, lockPath) : null;
    const record = content === null ? null : parseLockRecord(content);
    const oldEnough = now() - stat.mtimeMs > REPLICA_CACHE_STALE_LOCK_MS;

    if (record === null) {
        return oldEnough ? { stale: true, lock: { kind: 'unreadable', dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, content } } : { stale: false };
    }
    if (record.host !== ourHost) {
        return oldEnough ? { stale: true, lock: { kind: 'parsed', nonce: record.nonce } } : { stale: false };
    }
    return processAlive(record.pid) ? { stale: false } : { stale: true, lock: { kind: 'parsed', nonce: record.nonce } };
}

/**
 * Replaces a stale lock under `lock.reclaim` (`wx`): re-read `lock`, confirm it is still the one
 * judged stale, remove it, create ours with `wx`. Every loser answers busy.
 */
async function reclaimStaleLock(
    filesystem: ReplicaCacheFileSystem,
    dir: string,
    judged: StaleLock,
    ours: LockRecord,
    now: () => number,
): Promise<boolean> {
    const lockPath = path.join(dir, 'lock');
    const reclaimPath = path.join(dir, 'lock.reclaim');
    let reclaimHandle: fs.promises.FileHandle;
    try {
        reclaimHandle = await filesystem.open(reclaimPath, 'wx', 0o600);
    } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        const reclaimStat = await lstatIfPresent(filesystem, reclaimPath);
        // A reclaim abandoned by a crashed pull: clear it for the next acquirer; busy this time.
        if (reclaimStat !== null && now() - reclaimStat.mtimeMs > REPLICA_CACHE_STALE_RECLAIM_MS) {
            await filesystem.rm(reclaimPath, { force: true });
        }
        return false;
    }

    try {
        await reclaimHandle.close();
        if (!(await isSameStaleLock(filesystem, lockPath, judged))) return false;
        await filesystem.unlink(lockPath);
        return await createLockFile(filesystem, lockPath, ours);
    } finally {
        await filesystem.rm(reclaimPath, { force: true }).catch(() => undefined);
    }
}

async function isSameStaleLock(filesystem: ReplicaCacheFileSystem, lockPath: string, judged: StaleLock): Promise<boolean> {
    const stat = await lstatIfPresent(filesystem, lockPath);
    if (stat === null) return false;
    const content = stat.isFile() ? await readIfPresent(filesystem, lockPath) : null;
    const record = content === null ? null : parseLockRecord(content);
    if (judged.kind === 'parsed') return record !== null && record.nonce === judged.nonce;
    return record === null
        && stat.dev === judged.dev
        && stat.ino === judged.ino
        && stat.mtimeMs === judged.mtimeMs
        && content === judged.content;
}

function parseLockRecord(content: string): LockRecord | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (
        typeof candidate.pid !== 'number' || !Number.isInteger(candidate.pid) || candidate.pid <= 0
        || typeof candidate.host !== 'string'
        || typeof candidate.nonce !== 'string' || candidate.nonce === ''
        || typeof candidate.at !== 'number'
    ) {
        return null;
    }
    return { pid: candidate.pid, host: candidate.host, nonce: candidate.nonce, at: candidate.at };
}

/** `process.kill(pid, 0)`: alive unless it throws `ESRCH` (`EPERM` means alive, owned by someone else). */
function defaultProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return errorCode(error) !== 'ESRCH';
    }
}

/** True when `candidate` is a real directory (never followed through a symlink) with anything inside it. */
async function isNonEmptyDirectory(filesystem: ReplicaCacheFileSystem, candidate: string): Promise<boolean> {
    const stat = await lstatIfPresent(filesystem, candidate);
    if (stat === null || !stat.isDirectory()) return false;
    return (await filesystem.readdir(candidate)).length > 0;
}

async function lstatIfPresent(filesystem: ReplicaCacheFileSystem, candidate: string): Promise<fs.Stats | null> {
    try {
        return await filesystem.lstat(candidate);
    } catch (error) {
        if (isMissingPath(error)) return null;
        throw error;
    }
}

async function readIfPresent(filesystem: ReplicaCacheFileSystem, candidate: string): Promise<string | null> {
    try {
        return await filesystem.readFile(candidate, 'utf8');
    } catch (error) {
        if (isMissingPath(error)) return null;
        throw error;
    }
}

function isMissingPath(error: unknown): boolean {
    return errorCode(error) === 'ENOENT';
}

function errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

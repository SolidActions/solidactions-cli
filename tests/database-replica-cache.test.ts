/**
 * The replica cache module (cli#262, Task 2). Real files under a fresh mkdtemp base; the clock,
 * pid, hostname and process table are injected (CLI ADR 0004 call site 3, PM mail 425132c2). The
 * two-process rows inject nothing: real `node` children import the BUILT module (dist/; CI builds first).
 */
import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    REPLICA_CACHE_HEARTBEAT_MS,
    REPLICA_CACHE_REPLACEMENT_WINDOW_MS,
    REPLICA_CACHE_SKIP_MS,
    REPLICA_CACHE_STALE_LOCK_MS,
    REPLICA_CACHE_STALE_RECLAIM_MS,
    ReplicaCache,
    ReplicaCacheError,
    ReplicaCacheIdentity,
    ReplicaCacheOutcome,
    acquireReplicaCache,
    defaultReplicaCacheRoot,
    replicaCacheKey,
    syncOriginOf,
} from '../src/utils/database-replica-cache';

const BUILT_MODULE = path.resolve(__dirname, '../dist/utils/database-replica-cache.js');
const DAY_MS = 24 * 60 * 60 * 1000;
const OUR_PID = 4242;
const OUR_HOST = 'host-a';

const IDENTITY: ReplicaCacheIdentity = {
    host: 'https://api.example.test', workspaceId: 'ws-1', name: 'sales',
    databaseId: 'db-1', createdAt: '2026-11-01T00:00:00Z', syncOrigin: 'sales-x.example.io',
};

const bases: string[] = [];

afterEach(() => {
    for (const base of bases.splice(0)) fs.rmSync(base, { recursive: true, force: true });
});

function makeBase(): string {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'replica-cache-'));
    bases.push(base);
    return base;
}

function makeRoot(): string {
    return path.join(makeBase(), 'cache');
}

function keyDir(root: string, identity: ReplicaCacheIdentity = IDENTITY): string {
    return path.join(root, replicaCacheKey(identity));
}

/** Far from the real clock on purpose: every mtime a row relies on is set relative to the injected `now` (ageFile). */
const CLOCK_START = Date.UTC(2030, 0, 1);

function makeClock(start = CLOCK_START): { now: () => number; advance: (ms: number) => void } {
    let current = start;
    return { now: () => current, advance: (ms: number) => { current += ms; } };
}

type AcquireOverrides = Partial<Parameters<typeof acquireReplicaCache>[0]>;

function acquire(root: string, now: () => number, overrides: AcquireOverrides = {}): Promise<ReplicaCacheOutcome> {
    return acquireReplicaCache({ root, identity: IDENTITY, now, pid: OUR_PID, hostname: OUR_HOST, processAlive: () => false, ...overrides });
}

function expectReady(outcome: ReplicaCacheOutcome): ReplicaCache {
    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') throw new Error(`expected a ready cache, got ${JSON.stringify(outcome)}`);
    return outcome.cache;
}

function readJson(file: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function writeForeignLock(root: string, lock: unknown): string {
    const dir = keyDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const lockPath = path.join(dir, 'lock');
    fs.writeFileSync(lockPath, typeof lock === 'string' ? lock : JSON.stringify(lock));
    expect(fs.existsSync(lockPath)).toBe(true);
    return lockPath;
}

/** Sets `file`'s mtime to `ageMs` before the injected clock's `now()`, the time the module compares against. */
function ageFile(file: string, now: () => number, ageMs: number): void {
    const when = (now() - ageMs) / 1000;
    fs.utimesSync(file, when, when);
    expect(Math.abs(now() - fs.statSync(file).mtimeMs - ageMs)).toBeLessThan(1000);
}

/** A cold cache with a replica file in it, released again: the next acquire of the same identity is warm. */
async function seedWarmCache(root: string, now: () => number, identity: ReplicaCacheIdentity = IDENTITY): Promise<void> {
    const cache = expectReady(await acquire(root, now, { identity }));
    fs.writeFileSync(cache.replicaPath, 'replica bytes');
    await cache.release();
    expect(fs.existsSync(path.join(keyDir(root, identity), 'lock'))).toBe(false);
}

describe('replica cache key and sync origin', () => {
    it('key is stable, 32 hex, and differs by host, workspace and name', () => {
        const key = replicaCacheKey(IDENTITY);

        expect(key).toMatch(/^[0-9a-f]{32}$/);
        expect(replicaCacheKey({ host: IDENTITY.host, workspaceId: IDENTITY.workspaceId, name: IDENTITY.name })).toBe(key);
        expect(key).toBe(crypto.createHash('sha256').update(JSON.stringify([IDENTITY.host, IDENTITY.workspaceId, IDENTITY.name])).digest('hex').slice(0, 32));
        expect(replicaCacheKey({ ...IDENTITY, host: 'https://other.example.test' })).not.toBe(key);
        expect(replicaCacheKey({ ...IDENTITY, workspaceId: 'ws-2' })).not.toBe(key);
        expect(replicaCacheKey({ ...IDENTITY, name: 'sales2' })).not.toBe(key);
        expect(defaultReplicaCacheRoot('/home/someone')).toBe(path.join('/home/someone', '.solidactions', 'cache', 'database-replicas'));
        expect(defaultReplicaCacheRoot()).toBe(path.join(os.homedir(), '.solidactions', 'cache', 'database-replicas'));
    });

    it('syncOriginOf parses libsql, https and http, lower-cases, keeps a port, and answers null for junk', () => {
        expect(syncOriginOf('libsql://abc-x.example.io')).toBe('abc-x.example.io');
        expect(syncOriginOf('libsql://ABC-X.Example.IO')).toBe('abc-x.example.io');
        expect(syncOriginOf('HTTPS://H.example:8443/x')).toBe('h.example:8443');
        expect(syncOriginOf('http://Local.Test:8080')).toBe('local.test:8080');
        expect(syncOriginOf('')).toBeNull();
        expect(syncOriginOf(undefined)).toBeNull();
        expect(syncOriginOf('not a url')).toBeNull();
        expect(syncOriginOf(42)).toBeNull();
        expect(syncOriginOf('ftp://files.example.io')).toBeNull();
    });
});

describe('acquireReplicaCache', () => {
    it('cold acquire creates data/, a lock, snapshotPath absent, and reports warm=false', async () => {
        const root = makeRoot();
        const clock = makeClock();
        const dir = keyDir(root);

        const cache = expectReady(await acquire(root, clock.now));

        expect(cache.warm).toBe(false);
        expect(cache.replicaPath).toBe(path.join(dir, 'data', 'replica.db'));
        expect(cache.snapshotPath).toBe(path.join(dir, 'snapshot.tmp'));
        expect(fs.lstatSync(path.join(dir, 'data')).isDirectory()).toBe(true);
        expect(fs.readdirSync(path.join(dir, 'data'))).toEqual([]);
        expect(fs.existsSync(cache.snapshotPath)).toBe(false);
        expect(fs.lstatSync(dir).mode & 0o077).toBe(0);
        const lock = readJson(path.join(dir, 'lock'));
        expect(lock).toMatchObject({ pid: OUR_PID, host: OUR_HOST, at: clock.now() });
        expect(typeof lock.nonce).toBe('string');
        expect(fs.lstatSync(path.join(dir, 'lock')).mode & 0o077).toBe(0);

        fs.writeFileSync(cache.replicaPath, 'replica bytes');
        await cache.release();
        expect(fs.existsSync(path.join(dir, 'lock'))).toBe(false);

        const again = expectReady(await acquire(root, clock.now));
        expect(again.warm).toBe(true);

        await again.wipe();
        expect(again.warm).toBe(false);
        expect(fs.lstatSync(path.join(dir, 'data')).isDirectory()).toBe(true);
        expect(fs.readdirSync(path.join(dir, 'data'))).toEqual([]);
        await again.release();
    });

    it('a live same-host lock (processAlive true) is busy and the lock file is untouched', async () => {
        const root = makeRoot();
        const lockPath = writeForeignLock(root, { pid: 999, host: OUR_HOST, nonce: 'theirs', at: 1 });
        const before = fs.readFileSync(lockPath, 'utf8');

        const outcome = await acquire(root, makeClock().now, { processAlive: (pid) => pid === 999 });

        expect(outcome).toEqual({ kind: 'skipped', reason: 'busy' });
        expect(fs.readFileSync(lockPath, 'utf8')).toBe(before);
        expect(fs.existsSync(path.join(keyDir(root), 'lock.reclaim'))).toBe(false);
    });

    it('a same-host dead-pid lock is reclaimed', async () => {
        const root = makeRoot();
        const lockPath = writeForeignLock(root, { pid: 999, host: OUR_HOST, nonce: 'theirs', at: 1 });

        const cache = expectReady(await acquire(root, makeClock().now, { processAlive: (pid) => pid !== 999 }));

        const lock = readJson(lockPath);
        expect(lock.pid).toBe(OUR_PID);
        expect(lock.nonce).not.toBe('theirs');
        expect(fs.existsSync(path.join(keyDir(root), 'lock.reclaim'))).toBe(false);
        await cache.release();
        expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('another host\'s lock is busy while younger than 1 h and reclaimed when older', async () => {
        const root = makeRoot();
        const clock = makeClock();
        const lockPath = writeForeignLock(root, { pid: 999, host: 'host-b', nonce: 'theirs', at: 1 });
        const before = fs.readFileSync(lockPath, 'utf8');
        ageFile(lockPath, clock.now, 60_000);

        // processAlive answers "dead" for every pid: only the host rule can make this lock busy.
        const young = await acquire(root, clock.now, { processAlive: () => false });
        expect(young).toEqual({ kind: 'skipped', reason: 'busy' });
        expect(fs.readFileSync(lockPath, 'utf8')).toBe(before);

        ageFile(lockPath, clock.now, REPLICA_CACHE_STALE_LOCK_MS + 60_000);
        const cache = expectReady(await acquire(root, clock.now, { processAlive: () => false }));
        expect(readJson(lockPath)).toMatchObject({ pid: OUR_PID, host: OUR_HOST });
        await cache.release();
    });

    it('an unreadable lock younger than 1 h is busy, older than 1 h is reclaimed', async () => {
        const root = makeRoot();
        const clock = makeClock();
        const lockPath = writeForeignLock(root, 'not json at all');
        ageFile(lockPath, clock.now, 60_000);

        const young = await acquire(root, clock.now);
        expect(young).toEqual({ kind: 'skipped', reason: 'busy' });
        expect(fs.readFileSync(lockPath, 'utf8')).toBe('not json at all');

        ageFile(lockPath, clock.now, REPLICA_CACHE_STALE_LOCK_MS + 60_000);
        const cache = expectReady(await acquire(root, clock.now));
        expect(readJson(lockPath)).toMatchObject({ pid: OUR_PID, host: OUR_HOST });
        expect(fs.existsSync(path.join(keyDir(root), 'lock.reclaim'))).toBe(false);
        await cache.release();
    });

    it('a stale lock with a fresh lock.reclaim on disk is busy and both files are untouched', async () => {
        const root = makeRoot();
        const clock = makeClock();
        const lockPath = writeForeignLock(root, { pid: 999, host: OUR_HOST, nonce: 'dead-holder', at: 1 });
        const reclaimPath = path.join(keyDir(root), 'lock.reclaim');
        fs.writeFileSync(reclaimPath, 'another reclaim in progress');
        ageFile(reclaimPath, clock.now, 1000);
        const lockBefore = fs.readFileSync(lockPath, 'utf8');
        const reclaimMtime = fs.statSync(reclaimPath).mtimeMs;

        // processAlive answers dead: without the lock.reclaim gate this lock would be taken.
        const outcome = await acquire(root, clock.now, { processAlive: () => false });

        expect(outcome).toEqual({ kind: 'skipped', reason: 'busy' });
        expect(fs.readFileSync(lockPath, 'utf8')).toBe(lockBefore);
        expect(fs.readFileSync(reclaimPath, 'utf8')).toBe('another reclaim in progress');
        expect(fs.statSync(reclaimPath).mtimeMs).toBe(reclaimMtime);
    });

    it('a lock.reclaim older than the reclaim window is removed (busy this time) and the next acquire takes the stale lock', async () => {
        const root = makeRoot();
        const clock = makeClock();
        const lockPath = writeForeignLock(root, { pid: 999, host: OUR_HOST, nonce: 'dead-holder', at: 1 });
        const reclaimPath = path.join(keyDir(root), 'lock.reclaim');
        fs.writeFileSync(reclaimPath, 'abandoned by a crashed pull');
        ageFile(reclaimPath, clock.now, REPLICA_CACHE_STALE_RECLAIM_MS + 1000);
        const lockBefore = fs.readFileSync(lockPath, 'utf8');

        const first = await acquire(root, clock.now, { processAlive: () => false });

        expect(first).toEqual({ kind: 'skipped', reason: 'busy' });
        expect(fs.existsSync(reclaimPath)).toBe(false);
        expect(fs.readFileSync(lockPath, 'utf8')).toBe(lockBefore);

        const second = expectReady(await acquire(root, clock.now, { processAlive: () => false }));
        expect(readJson(lockPath)).toMatchObject({ pid: OUR_PID, host: OUR_HOST });
        expect(readJson(lockPath).nonce).not.toBe('dead-holder');
        expect(fs.existsSync(reclaimPath)).toBe(false);
        await second.release();
    });

    it('release removes only its own lock', async () => {
        const root = makeRoot();
        const cache = expectReady(await acquire(root, makeClock().now));
        const lockPath = path.join(keyDir(root), 'lock');
        const foreign = JSON.stringify({ pid: 777, host: 'host-c', nonce: 'foreign', at: 2 });
        fs.writeFileSync(lockPath, foreign);

        await cache.release();
        await cache.release();

        expect(fs.readFileSync(lockPath, 'utf8')).toBe(foreign);
    });

    it('a corrupt meta.json wipes data/ and starts clean', async () => {
        for (const corrupt of ['{garbage', JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, replacements: 'nope' })]) {
            const root = makeRoot();
            const clock = makeClock();
            await seedWarmCache(root, clock.now);
            const metaPath = path.join(keyDir(root), 'meta.json');
            expect(readJson(metaPath).version).toBe(1);
            fs.writeFileSync(metaPath, corrupt);

            const cache = expectReady(await acquire(root, clock.now));

            expect(cache.warm).toBe(false);
            expect(fs.readdirSync(path.join(keyDir(root), 'data'))).toEqual([]);
            expect(readJson(metaPath)).toMatchObject({ version: 1, databaseId: IDENTITY.databaseId, replacements: [], skipUntil: null });
            await cache.release();
        }
    });

    it('a missing meta.json beside a non-empty data/ wipes data/ and starts from defaults', async () => {
        const root = makeRoot();
        const clock = makeClock();
        await seedWarmCache(root, clock.now);
        const dataDir = path.join(keyDir(root), 'data');
        fs.writeFileSync(path.join(dataDir, 'replica.db-wal'), 'companion bytes');
        fs.rmSync(path.join(keyDir(root), 'meta.json'));
        expect(fs.readdirSync(dataDir).sort()).toEqual(['replica.db', 'replica.db-wal']);

        const cache = expectReady(await acquire(root, clock.now));

        // A replica of unknown origin is never offered warm (I6).
        expect(cache.warm).toBe(false);
        expect(fs.readdirSync(dataDir)).toEqual([]);
        expect(readJson(path.join(keyDir(root), 'meta.json'))).toMatchObject({ version: 1, databaseId: IDENTITY.databaseId, lastSyncedAt: null, replacements: [], skipUntil: null });
        await cache.release();
    });

    it('a missing meta.json with an empty or absent data/ is plain defaults and nothing is wiped', async () => {
        const root = makeRoot();
        const clock = makeClock();
        const dataDir = path.join(keyDir(root), 'data');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.chmodSync(dataDir, 0o750);
        const before = fs.lstatSync(dataDir);

        const cache = expectReady(await acquire(root, clock.now));

        // Not removed and recreated: a wipe would make a new 0700 folder.
        const after = fs.lstatSync(dataDir);
        expect(after.mode & 0o777).toBe(0o750);
        expect(after.ino).toBe(before.ino);
        expect(cache.warm).toBe(false);
        expect(readJson(path.join(keyDir(root), 'meta.json'))).toMatchObject({ version: 1, databaseId: IDENTITY.databaseId, replacements: [] });
        await cache.release();

        const absentRoot = makeRoot();
        const absent = expectReady(await acquire(absentRoot, clock.now));
        expect(absent.warm).toBe(false);
        expect(fs.readdirSync(path.join(keyDir(absentRoot), 'data'))).toEqual([]);
        await absent.release();
    });

    it('identity change wipes data/ and records a replacement', async () => {
        const changes: Array<Partial<ReplicaCacheIdentity>> = [
            { databaseId: 'db-2' },
            { createdAt: '2026-11-02T00:00:00Z' },
            // Same id and created_at, a new sync origin: the server copy was swapped under the record (I6).
            { syncOrigin: 'sales-y.example.io' },
        ];
        for (const change of changes) {
            const root = makeRoot();
            const clock = makeClock();
            await seedWarmCache(root, clock.now);
            clock.advance(1000);
            const offered = { ...IDENTITY, ...change };

            const cache = expectReady(await acquire(root, clock.now, { identity: offered }));

            expect(cache.warm).toBe(false);
            expect(fs.readdirSync(path.join(keyDir(root), 'data'))).toEqual([]);
            const meta = readJson(path.join(keyDir(root), 'meta.json'));
            expect(meta.replacements).toEqual([clock.now()]);
            expect(meta).toMatchObject(change);
            await cache.release();
        }
    });

    it('null on either side is not a change', async () => {
        const root = makeRoot();
        const clock = makeClock();
        const metaPath = path.join(keyDir(root), 'meta.json');
        await seedWarmCache(root, clock.now, { ...IDENTITY, databaseId: null, createdAt: null, syncOrigin: null });

        // Stored nulls, offered values: warm, no replacement, the offered values are stored.
        const first = expectReady(await acquire(root, clock.now));
        expect(first.warm).toBe(true);
        expect(readJson(metaPath)).toMatchObject({ databaseId: 'db-1', createdAt: IDENTITY.createdAt, syncOrigin: IDENTITY.syncOrigin, replacements: [] });
        await first.release();

        // Stored values, offered nulls: warm, no replacement, the stored values are kept.
        const second = expectReady(await acquire(root, clock.now, { identity: { ...IDENTITY, databaseId: null, createdAt: null, syncOrigin: null } }));
        expect(second.warm).toBe(true);
        expect(readJson(metaPath)).toMatchObject({ databaseId: 'db-1', createdAt: IDENTITY.createdAt, syncOrigin: IDENTITY.syncOrigin, replacements: [] });
        await second.release();
    });

    it('the third replacement inside 7 days skips with rewritten_often for 7 days, then the cache is usable again', async () => {
        const root = makeRoot();
        const clock = makeClock();
        const lockPath = path.join(keyDir(root), 'lock');
        const metaPath = path.join(keyDir(root), 'meta.json');
        await seedWarmCache(root, clock.now, { ...IDENTITY, syncOrigin: 'a.example.io' });

        clock.advance(DAY_MS);
        await (expectReady(await acquire(root, clock.now, { identity: { ...IDENTITY, syncOrigin: 'b.example.io' } }))).release();
        clock.advance(DAY_MS);
        await (expectReady(await acquire(root, clock.now, { identity: { ...IDENTITY, syncOrigin: 'c.example.io' } }))).release();
        expect((readJson(metaPath).replacements as number[]).length).toBe(2);
        clock.advance(DAY_MS);

        const third = await acquire(root, clock.now, { identity: { ...IDENTITY, syncOrigin: 'd.example.io' } });

        expect(third).toEqual({ kind: 'skipped', reason: 'rewritten_often' });
        expect(fs.existsSync(lockPath)).toBe(false);
        const skippedAt = clock.now();
        expect(readJson(metaPath)).toMatchObject({ skipUntil: skippedAt + REPLICA_CACHE_SKIP_MS });
        expect((readJson(metaPath).replacements as number[]).length).toBe(3);

        clock.advance(REPLICA_CACHE_SKIP_MS - 1);
        expect(await acquire(root, clock.now, { identity: { ...IDENTITY, syncOrigin: 'd.example.io' } })).toEqual({ kind: 'skipped', reason: 'rewritten_often' });
        expect(fs.existsSync(lockPath)).toBe(false);

        clock.advance(2);
        expect(clock.now()).toBe(skippedAt + REPLICA_CACHE_SKIP_MS + 1);
        expect(clock.now() - skippedAt).toBeGreaterThan(REPLICA_CACHE_REPLACEMENT_WINDOW_MS);
        const usable = expectReady(await acquire(root, clock.now, { identity: { ...IDENTITY, syncOrigin: 'd.example.io' } }));
        expect(usable.warm).toBe(false);
        await usable.release();
    });

    it('a symlinked data/ is refused and its target survives', async () => {
        const base = makeBase();
        const root = path.join(base, 'cache');
        const target = path.join(base, 'elsewhere');
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
        const sibling = path.join(root, 'f'.repeat(32));
        fs.mkdirSync(sibling, { recursive: true });
        fs.writeFileSync(path.join(sibling, 'meta.json'), 'sibling');
        fs.mkdirSync(keyDir(root), { recursive: true });
        fs.symlinkSync(target, path.join(keyDir(root), 'data'));

        const outcome = await acquire(root, makeClock().now);

        expect(outcome).toEqual({ kind: 'skipped', reason: 'unavailable' });
        expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('keep');
        expect(fs.lstatSync(path.join(keyDir(root), 'data')).isSymbolicLink()).toBe(true);
        expect(fs.existsSync(path.join(keyDir(root), 'lock'))).toBe(false);
        expect(fs.readFileSync(path.join(sibling, 'meta.json'), 'utf8')).toBe('sibling');

        // wipe() refuses a data/ that became a symlink after acquire, and leaves the target alone.
        const otherRoot = makeRoot();
        const cache = expectReady(await acquire(otherRoot, makeClock().now));
        const dataDir = path.dirname(cache.replicaPath);
        fs.rmdirSync(dataDir);
        fs.symlinkSync(target, dataDir);
        await expect(cache.wipe()).rejects.toBeInstanceOf(ReplicaCacheError);
        expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('keep');
        await cache.release();
    });

    it('an unwritable root answers unavailable and never throws', async () => {
        const base = makeBase();
        const file = path.join(base, 'a-file');
        fs.writeFileSync(file, 'not a directory');
        expect(fs.lstatSync(file).isFile()).toBe(true);

        const outcome = acquire(path.join(file, 'cache'), makeClock().now);

        await expect(outcome).resolves.toEqual({ kind: 'skipped', reason: 'unavailable' });
        expect(fs.readFileSync(file, 'utf8')).toBe('not a directory');
    });

    it('meta.json has exactly the documented keys', async () => {
        const root = makeRoot();
        const clock = makeClock();
        const cache = expectReady(await acquire(root, clock.now));
        clock.advance(5000);

        await cache.markSynced();

        const meta = readJson(path.join(keyDir(root), 'meta.json'));
        expect(Object.keys(meta).sort()).toEqual(['createdAt', 'databaseId', 'lastSyncedAt', 'replacements', 'skipUntil', 'syncOrigin', 'version']);
        expect(meta).toEqual({
            version: 1,
            databaseId: IDENTITY.databaseId,
            createdAt: IDENTITY.createdAt,
            syncOrigin: IDENTITY.syncOrigin,
            lastSyncedAt: clock.now(),
            replacements: [],
            skipUntil: null,
        });
        for (const value of Object.values(meta)) {
            if (typeof value === 'string') expect(value.length).toBeLessThanOrEqual(200);
        }
        await cache.release();
    });

    it('after markSynced the cache directory holds exactly lock, meta.json and data', async () => {
        const root = makeRoot();
        const cache = expectReady(await acquire(root, makeClock().now));
        fs.writeFileSync(cache.replicaPath, 'replica bytes');

        await cache.markSynced();

        expect(fs.readdirSync(keyDir(root)).sort()).toEqual(['data', 'lock', 'meta.json']);
        await cache.release();
        expect(fs.readdirSync(keyDir(root)).sort()).toEqual(['data', 'meta.json']);
    });

    it('a stale snapshot.tmp is removed at acquire; release removes the snapshot and the lock', async () => {
        const root = makeRoot();
        const snapshot = path.join(keyDir(root), 'snapshot.tmp');
        fs.mkdirSync(keyDir(root), { recursive: true });
        fs.writeFileSync(snapshot, 'left over from a crash');

        const cache = expectReady(await acquire(root, makeClock().now));
        expect(cache.snapshotPath).toBe(snapshot);
        expect(fs.existsSync(snapshot)).toBe(false);

        fs.writeFileSync(snapshot, 'this run');
        await cache.discardSnapshot();
        expect(fs.existsSync(snapshot)).toBe(false);
        await cache.discardSnapshot();

        fs.writeFileSync(snapshot, 'this run again');
        await cache.release();
        expect(fs.existsSync(snapshot)).toBe(false);
        expect(fs.existsSync(path.join(keyDir(root), 'lock'))).toBe(false);
    });
});

describe('replica cache lock heartbeat (I5)', () => {
    const HOUR_MS = 60 * 60 * 1000;
    const HEARTBEAT_MS = 20;
    /** The real clock: the heartbeat stamps the lock with `now()`, and these rows read the mtime against `Date.now`. */
    const realNow = (): number => Date.now();

    function setMtimeAgo(file: string, ageMs: number): void {
        const when = (Date.now() - ageMs) / 1000;
        fs.utimesSync(file, when, when);
    }

    function lockAgeMs(file: string): number {
        return Date.now() - fs.statSync(file).mtimeMs;
    }

    async function waitUntil(condition: () => boolean, what: string): Promise<void> {
        const deadline = Date.now() + 5000;
        while (!condition()) {
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }

    /** A negative row's window: about seven heartbeat ticks, long enough that a live interval would have fired. */
    const quietWindow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 7 * HEARTBEAT_MS));

    it('the default heartbeat is five minutes, well inside the one-hour stale window', () => {
        expect(REPLICA_CACHE_HEARTBEAT_MS).toBe(5 * 60 * 1000);
        expect(REPLICA_CACHE_HEARTBEAT_MS).toBeLessThan(REPLICA_CACHE_STALE_LOCK_MS);
    });

    it('a held lock whose mtime is two hours old is refreshed within a few heartbeats', async () => {
        const root = makeRoot();
        const cache = expectReady(await acquire(root, realNow, { heartbeatMs: HEARTBEAT_MS }));
        const lockPath = path.join(keyDir(root), 'lock');
        try {
            setMtimeAgo(lockPath, 2 * HOUR_MS);

            await waitUntil(() => lockAgeMs(lockPath) < 5000, 'the heartbeat to refresh the lock mtime');

            expect(readJson(lockPath)).toMatchObject({ pid: OUR_PID, host: OUR_HOST });
        } finally {
            await cache.release();
        }
    });

    it('with the default heartbeat the same two-hour-old lock is not refreshed in a short window (the control for the rows around it)', async () => {
        const root = makeRoot();
        const cache = expectReady(await acquire(root, realNow));
        const lockPath = path.join(keyDir(root), 'lock');
        try {
            setMtimeAgo(lockPath, 2 * HOUR_MS);

            await quietWindow();

            expect(lockAgeMs(lockPath)).toBeGreaterThan(HOUR_MS);
        } finally {
            await cache.release();
        }
    });

    it('another host answers busy for a lock whose heartbeat kept it fresh, and reclaims the same lock without one', async () => {
        const heartbeatRoot = makeRoot();
        const held = expectReady(await acquire(heartbeatRoot, realNow, { heartbeatMs: HEARTBEAT_MS }));
        const heartbeatLock = path.join(keyDir(heartbeatRoot), 'lock');
        const plainRoot = makeRoot();
        const plain = expectReady(await acquire(plainRoot, realNow));
        const plainLock = path.join(keyDir(plainRoot), 'lock');
        let reclaimed: ReplicaCache | undefined;
        try {
            setMtimeAgo(heartbeatLock, 2 * HOUR_MS);
            await waitUntil(() => lockAgeMs(heartbeatLock) < 5000, 'the heartbeat to refresh the lock mtime');
            setMtimeAgo(plainLock, 2 * HOUR_MS);

            const withHeartbeat = await acquire(heartbeatRoot, realNow, { hostname: 'host-b', pid: 999, processAlive: () => false });
            const withoutHeartbeat = await acquire(plainRoot, realNow, { hostname: 'host-b', pid: 999, processAlive: () => false });

            expect(withHeartbeat).toEqual({ kind: 'skipped', reason: 'busy' });
            expect(readJson(heartbeatLock)).toMatchObject({ pid: OUR_PID, host: OUR_HOST });
            // Positive control: the module's own reclaim rule takes a two-hour-old lock nothing refreshed.
            reclaimed = expectReady(withoutHeartbeat);
            expect(readJson(plainLock)).toMatchObject({ pid: 999, host: 'host-b' });
        } finally {
            await held.release();
            await plain.release();
            await reclaimed?.release();
        }
    });

    it('after release no interval is left: a lock record that carries the old nonce is not refreshed', async () => {
        const root = makeRoot();
        const cache = expectReady(await acquire(root, realNow, { heartbeatMs: HEARTBEAT_MS }));
        const lockPath = path.join(keyDir(root), 'lock');
        const record = fs.readFileSync(lockPath, 'utf8');
        setMtimeAgo(lockPath, 2 * HOUR_MS);
        await waitUntil(() => lockAgeMs(lockPath) < 5000, 'the heartbeat to refresh the lock mtime');

        await cache.release();
        expect(fs.existsSync(lockPath)).toBe(false);
        // The same record, so only a surviving interval could touch it.
        fs.writeFileSync(lockPath, record);
        setMtimeAgo(lockPath, 2 * HOUR_MS);
        await quietWindow();

        expect(lockAgeMs(lockPath)).toBeGreaterThan(HOUR_MS);
        expect(fs.readFileSync(lockPath, 'utf8')).toBe(record);
    });

    it('a lock that is not ours is not refreshed, and is left as it is', async () => {
        const root = makeRoot();
        const cache = expectReady(await acquire(root, realNow, { heartbeatMs: HEARTBEAT_MS }));
        const lockPath = path.join(keyDir(root), 'lock');
        try {
            // Positive control: while the lock is ours the heartbeat does refresh it.
            setMtimeAgo(lockPath, 2 * HOUR_MS);
            await waitUntil(() => lockAgeMs(lockPath) < 5000, 'the heartbeat to refresh the lock mtime');

            const foreign = JSON.stringify({ pid: 777, host: 'host-c', nonce: 'foreign', at: 2 });
            fs.writeFileSync(lockPath, foreign);
            // A tick that read our record before the swap finishes inside this window; later ticks see the foreign one.
            await quietWindow();
            setMtimeAgo(lockPath, 2 * HOUR_MS);
            await quietWindow();

            expect(lockAgeMs(lockPath)).toBeGreaterThan(HOUR_MS);
            expect(fs.readFileSync(lockPath, 'utf8')).toBe(foreign);
        } finally {
            await cache.release();
        }
    });
});

/** One real child: `started-<id>`, waits for `go`, acquires with the real clock, pid, host and process
 * table, prints one JSON line, writes `result-<id>`, and holds a lock it won until `done` appears. */
const CHILD_SCRIPT = `
const fs = require('fs');
const path = require('path');
const [modulePath, root, barrier, id, identityJson] = process.argv.slice(1);
const cacheModule = require(modulePath);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(file) {
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(file)) {
        if (Date.now() > deadline) throw new Error('barrier timeout waiting for ' + file);
        await sleep(2);
    }
}
(async () => {
    fs.writeFileSync(path.join(barrier, 'started-' + id), '');
    await waitFor(path.join(barrier, 'go'));
    const outcome = await cacheModule.acquireReplicaCache({ root, identity: JSON.parse(identityJson), now: Date.now });
    process.stdout.write(JSON.stringify({ id, pid: process.pid, kind: outcome.kind, reason: outcome.kind === 'skipped' ? outcome.reason : null }) + '\\n');
    fs.writeFileSync(path.join(barrier, 'result-' + id), '');
    await waitFor(path.join(barrier, 'done'));
    if (outcome.kind === 'ready') await outcome.cache.release();
})().catch((error) => {
    process.stderr.write(String(error && error.stack || error) + '\\n');
    process.exit(3);
});
`;

type ChildResult = { code: number | null; stdout: string; stderr: string };

async function waitForFile(file: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(file)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

type ChildAnswer = { id: string; pid: number; kind: string; reason: string | null };

/** Two real children on one root and identity, released together. `lockWhileHeld` is the lock
 * read after both answered and before the winner is told to release. */
async function raceTwoChildren(root: string): Promise<{ answers: ChildAnswer[]; lockWhileHeld: Record<string, unknown> }> {
    expect(fs.existsSync(BUILT_MODULE)).toBe(true);
    const barrier = fs.mkdtempSync(path.join(makeBase(), 'barrier-'));
    const ids = ['one', 'two'];
    const children = ids.map((id) => new Promise<ChildResult>((resolve) => {
        const child = spawn(process.execPath, ['-e', CHILD_SCRIPT, BUILT_MODULE, root, barrier, id, JSON.stringify(IDENTITY)], { stdio: ['ignore', 'pipe', 'pipe'] });
        const result: ChildResult = { code: null, stdout: '', stderr: '' };
        child.stdout.on('data', (chunk) => { result.stdout += String(chunk); });
        child.stderr.on('data', (chunk) => { result.stderr += String(chunk); });
        child.on('close', (code) => resolve({ ...result, code }));
    }));

    for (const id of ids) await waitForFile(path.join(barrier, `started-${id}`));
    fs.writeFileSync(path.join(barrier, 'go'), '');
    for (const id of ids) await waitForFile(path.join(barrier, `result-${id}`));
    const lockWhileHeld = readJson(path.join(keyDir(root), 'lock'));
    fs.writeFileSync(path.join(barrier, 'done'), '');
    const results = await Promise.all(children);

    for (const result of results) {
        expect(result.stderr).toBe('');
        expect(result.code).toBe(0);
    }
    const answers = results.map((result): ChildAnswer => {
        const lines = result.stdout.trim().split('\n');
        expect(lines).toHaveLength(1);
        return JSON.parse(lines[0]) as ChildAnswer;
    });
    return { answers, lockWhileHeld };
}

describe('replica cache lock across real processes', () => {
    it('two processes started before either acquires: exactly one is ready, the other busy', async () => {
        const root = makeRoot();

        const { answers, lockWhileHeld } = await raceTwoChildren(root);

        expect(answers.map((answer) => answer.kind).sort()).toEqual(['ready', 'skipped']);
        expect(answers.find((answer) => answer.kind === 'skipped')?.reason).toBe('busy');
        expect(lockWhileHeld.pid).toBe(answers.find((answer) => answer.kind === 'ready')?.pid);
        // The winner released its lock before exiting.
        expect(fs.existsSync(path.join(keyDir(root), 'lock'))).toBe(false);
    }, 60_000);

    it('two processes reclaiming the same dead lock: exactly one is ready', async () => {
        // A pid that really existed and has exited: the lock's holder is dead on this host.
        const finished = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
        expect(finished.status).toBe(0);
        const deadPid = finished.pid as number;
        expect(Number.isInteger(deadPid)).toBe(true);

        // Several rounds widen the chance of the interleaving a plain "unlink the stale lock, retry wx" loses.
        for (let round = 0; round < 5; round += 1) {
            const root = makeRoot();
            const lockPath = writeForeignLock(root, { pid: deadPid, host: os.hostname(), nonce: 'dead-holder', at: 1 });
            expect(readJson(lockPath).nonce).toBe('dead-holder');

            const { answers, lockWhileHeld } = await raceTwoChildren(root);

            expect(answers.map((answer) => answer.kind).sort()).toEqual(['ready', 'skipped']);
            expect(answers.find((answer) => answer.kind === 'skipped')?.reason).toBe('busy');
            // The lock the winner holds is its own, not the dead holder's.
            expect(lockWhileHeld.pid).toBe(answers.find((answer) => answer.kind === 'ready')?.pid);
            expect(lockWhileHeld.nonce).not.toBe('dead-holder');
            expect(fs.existsSync(path.join(keyDir(root), 'lock.reclaim'))).toBe(false);
        }
    }, 120_000);
});

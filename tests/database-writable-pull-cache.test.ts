/**
 * The cached writable `database pull --writable` (cli#262, plan Task 5).
 *
 * Test seams, each named by docs/decisions/0004-database-pull-cache-test-seams.md:
 * - call site 1: the sync client inside `loadClient` (a config WITH `syncUrl`) writes a REAL
 *   SQLite file at its `url` through the real `@libsql/client` plus the companion files the
 *   probe measured, and records `close()`; its `execute()` records the statement and answers
 *   the canned DML result of tests/database-writable-pull-command.test.ts (`run`, :113-120),
 *   except in the real-write row, where it runs the statement on a REAL local client over the
 *   replica file. A `sync()` hook may throw, write non-SQLite bytes at the cache path, or stage a
 *   real-file race. A config WITHOUT `syncUrl` gets the REAL `createClient`, so `PRAGMA
 *   quick_check`, `VACUUM INTO` and the uncached checkpoint run for real;
 * - call site 2: the injected `post` answering `show` and `access` (the shape of
 *   tests/database-writable-pull-command.test.ts), with the access `url` host set per scenario;
 * - call site 3: the injected clock (`now`), the injected `env` and the deterministic `tempPath`;
 * - call site 3a: `confirm` as a `vi.fn` returning true (the live-lock row);
 * - call site 3c: the injected terminal facts: the `input` line source, `abortSignal`, `isTTY`.
 */
import { createClient as createRealClient } from '@libsql/client';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { databasePullWithConfig, type DatabaseCommandDependencies } from '../src/commands/database';
import type { DatabaseClient } from '../src/utils/database-data-plane';
import { WORKFLOW_RUN_PULL_WARNING } from '../src/utils/database-pull-guidance';
import { replicaCacheKey } from '../src/utils/database-replica-cache';

const CONFIG = {
    host: 'https://app.example.test',
    apiKey: 'control-plane-pat-sentinel',
    workspaceId: 'workspace-1146',
};
const NAME = 'Analytics';
const ACCESS_TOKEN_SENTINEL = 'fresh-access-token-sentinel';
const CACHE_KEY = replicaCacheKey({ host: CONFIG.host, workspaceId: CONFIG.workspaceId, name: NAME });
/** The companion files Task 1's probe measured beside a real replica (no `-info`). */
const MEASURED_COMPANIONS = ['-client_wal_index', '-shm', '-wal'];
const WARNING = 'Writable live session: writes go to the live workspace database.';
const BUSY_NOTE = 'Another pull of this database is using the local cache; downloading a full copy instead.';
const FALLBACK_NOTE = "The live session's writes are saved. Publishing a read-only copy instead.";
const START = Date.parse('2026-11-18T09:00:00.000Z');

type ItemRow = [number, string];

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function tempRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-database-writable-pull-cache-'));
    roots.push(root);
    return root;
}

/**
 * Writes a real SQLite file holding `rows` through the real client, then the measured companions.
 * `freePages` leaves dropped pages on the free list, which only a `VACUUM INTO` product drops.
 */
async function writeReplica(file: string, rows: ItemRow[], freePages = false): Promise<void> {
    for (const leftover of [file, `${file}-journal`, ...MEASURED_COMPANIONS.map((suffix) => `${file}${suffix}`)]) {
        fs.rmSync(leftover, { force: true });
    }
    const client = createRealClient({ url: pathToFileURL(file).href, intMode: 'string' });
    try {
        await client.execute('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
        for (const [id, label] of rows) {
            await client.execute({ sql: 'INSERT INTO items (id, label) VALUES (?, ?)', args: [id, label] });
        }
        if (freePages) {
            await client.execute('CREATE TABLE scratch (pad TEXT)');
            await client.execute("INSERT INTO scratch SELECT printf('%.3000c', 'x') FROM (WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 8) SELECT i FROM n)");
            await client.execute('DROP TABLE scratch');
        }
    } finally {
        client.close();
    }
    for (const suffix of MEASURED_COMPANIONS) {
        fs.writeFileSync(`${file}${suffix}`, `replica companion ${suffix}`);
    }
}

/** Runs `sql` through a real local client on a private copy of `file`, so nothing appears beside `file`. */
async function readCopy(file: string, sql: string): Promise<unknown[][]> {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-database-writable-pull-cache-read-'));
    roots.push(scratch);
    const copy = path.join(scratch, 'copy.db');
    fs.copyFileSync(file, copy);
    fs.chmodSync(copy, 0o600);
    const client = createRealClient({ url: pathToFileURL(copy).href, intMode: 'string' });
    try {
        return (await client.execute(sql)).rows.map((row) => Array.from({ length: row.length }, (_value, index) => row[index]));
    } finally {
        client.close();
    }
}

async function readItems(file: string): Promise<ItemRow[]> {
    return (await readCopy(file, 'SELECT id, label FROM items ORDER BY id')).map((row) => [Number(row[0]), String(row[1])]);
}

async function freelistCount(file: string): Promise<number> {
    return Number((await readCopy(file, 'PRAGMA freelist_count'))[0][0]);
}

function filesUnder(directory: string): string[] {
    const found: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) found.push(...filesUnder(candidate));
        else found.push(candidate);
    }
    return found;
}

function deterministicFailure(): Error {
    return Object.assign(new Error('DETERMINISTIC_FAILURE_SENTINEL'), { code: 'SQLITE_CORRUPT' });
}

/** Call site 3c: the injected line source of tests/database-writable-pull-command.test.ts. */
function lineSource(lines: string[], onRead: (line: string, index: number) => void = () => undefined): AsyncIterable<string> {
    return {
        async *[Symbol.asyncIterator]() {
            for (const [index, line] of lines.entries()) {
                onRead(line, index);
                yield line;
            }
        },
    };
}

function writableCacheHarness(root: string, cacheRoot: string = path.join(root, 'cache')) {
    const outDir = path.join(root, 'out');
    fs.mkdirSync(outDir);
    const cacheDir = path.join(cacheRoot, CACHE_KEY);
    const dataDir = path.join(cacheDir, 'data');
    const replicaPath = path.join(dataDir, 'replica.db');
    const server = {
        rows: [[1, 'alpha'], [2, 'beta']] as ItemRow[],
        host: 'primary-host.sentinel.invalid',
        expiresAt: ['2026-11-18T09:10:00.000Z'],
    };
    const syncConfigs: Array<Record<string, unknown>> = [];
    const executions: Array<{ client: number; sql: string }> = [];
    const mints: string[] = [];
    const events: string[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const reads: string[] = [];
    const confirm = vi.fn(async () => true as boolean | undefined);
    const clock = { now: START };
    let realWrites = false;
    // Call site 1: what the sync stand-in does on its Nth `sync()`; the default writes the server rows.
    let onSync: (index: number, file: string) => Promise<void> = async (_index, file) => writeReplica(file, server.rows);

    const dependencies: DatabaseCommandDependencies = {
        cwd: root,
        tempPath: (target: string) => path.join(path.dirname(target), `.${path.basename(target)}.solidactions-task5.tmp`),
        replicaCacheRoot: cacheRoot,
        env: {},
        now: () => clock.now,
        input: lineSource(['.exit']),
        loadClient: async () => ({
            createClient: (config: Record<string, unknown>): DatabaseClient => {
                if (!Object.prototype.hasOwnProperty.call(config, 'syncUrl')) {
                    return createRealClient(config as unknown as Parameters<typeof createRealClient>[0]) as unknown as DatabaseClient;
                }

                syncConfigs.push({ ...config });
                const index = syncConfigs.length;
                events.push(`create:${index}`);
                let localWriter: ReturnType<typeof createRealClient> | undefined;
                return {
                    execute: async (statement: unknown) => {
                        executions.push({ client: index, sql: String(statement) });
                        if (realWrites) {
                            // The real-write row: the statement really changes the replica file.
                            localWriter ??= createRealClient({ url: String(config.url), intMode: 'string' });
                            return localWriter.execute(String(statement));
                        }
                        return { columns: [], rows: [], rowsAffected: 1, lastInsertRowid: undefined };
                    },
                    sync: async () => {
                        events.push(`sync:${index}`);
                        await onSync(index, fileURLToPath(String(config.url)));
                    },
                    close: async () => {
                        events.push(`close:${index}`);
                        localWriter?.close();
                    },
                } as unknown as DatabaseClient;
            },
        }),
        post: async (_url: string, body: Record<string, unknown>) => {
            if (body.operation === 'show') {
                return {
                    data: {
                        database: {
                            id: 'database-record-1',
                            name: String(body.name),
                            kind: 'libsql',
                            status: 'ready',
                            size_bytes: 0,
                            deleted_at: null,
                            purge_at: null,
                            created_at: '2026-11-01T00:00:00Z',
                        },
                    },
                };
            }
            mints.push(String(body.mode));
            const count = mints.length;
            return {
                data: {
                    url: `libsql://${server.host}`,
                    token: `${ACCESS_TOKEN_SENTINEL}-${count}`,
                    mode: body.mode,
                    expires_at: server.expiresAt[Math.min(count - 1, server.expiresAt.length - 1)],
                },
            };
        },
        stdout: (line: string) => stdout.push(line),
        stderr: (line: string) => stderr.push(line),
        confirm,
        isTTY: true,
    };

    return {
        outDir,
        cacheRoot,
        cacheDir,
        dataDir,
        replicaPath,
        replicaUrl: pathToFileURL(replicaPath).href,
        lockPath: path.join(cacheDir, 'lock'),
        server,
        syncConfigs,
        executions,
        mints,
        events,
        stdout,
        stderr,
        reads,
        confirm,
        clock,
        dependencies,
        tempUrl: (target: string) => pathToFileURL(path.join(path.dirname(target), `.${path.basename(target)}.solidactions-task5.tmp`)).href,
        setSync: (behaviour: (index: number, file: string) => Promise<void>) => {
            onSync = behaviour;
        },
        useRealWrites: () => {
            realWrites = true;
        },
        setLines: (lines: string[], onRead: (line: string, index: number) => void = () => undefined) => {
            dependencies.input = lineSource(lines, (line, index) => {
                reads.push(line);
                onRead(line, index);
            });
        },
        readMeta: () => JSON.parse(fs.readFileSync(path.join(cacheDir, 'meta.json'), 'utf8')),
        pull: (target: string, options: { yes?: boolean; cache?: boolean } = { yes: true }) =>
            databasePullWithConfig(NAME, target, { writable: true, ...options }, CONFIG, dependencies),
    };
}

type Harness = ReturnType<typeof writableCacheHarness>;

/** I1 sweep: the destination holds exactly what it held before plus the target. */
function expectOnlyTargetAdded(harness: Harness, before: string[], target: string): void {
    expect(fs.readdirSync(harness.outDir).sort()).toEqual([...new Set([...before, path.basename(target)])].sort());
}

async function caught(promise: Promise<unknown>): Promise<any> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    return undefined;
}

describe('database pull --writable through the hidden replica cache', () => {
    it('writable session syncs, renews and writes through the cache replica path', async () => {
        const harness = writableCacheHarness(tempRoot());
        const target = path.join(harness.outDir, 'analytics.db');
        harness.server.expiresAt = ['2026-11-18T09:10:00.000Z', '2026-11-18T09:20:00.000Z', '2026-11-18T09:30:00.000Z'];
        // Each SELECT moves the clock past the current credential's renewal point (30 s before expiry).
        harness.setLines(['SELECT 1;', 'SELECT 2;', 'SELECT 3;', '.exit'], (_line, index) => {
            if (index === 0) harness.clock.now = Date.parse('2026-11-18T09:09:31.000Z');
            if (index === 1) harness.clock.now = Date.parse('2026-11-18T09:19:31.000Z');
        });

        await harness.pull(target);

        expect(harness.mints).toEqual(['write', 'write', 'write']);
        expect(harness.syncConfigs).toEqual([1, 2, 3].map((count) => ({
            url: harness.replicaUrl,
            syncUrl: 'libsql://primary-host.sentinel.invalid',
            authToken: `${ACCESS_TOKEN_SENTINEL}-${count}`,
            intMode: 'string',
            readYourWrites: true,
            offline: false,
        })));
        expect(harness.executions).toEqual([
            { client: 1, sql: 'SELECT 1;' },
            { client: 2, sql: 'SELECT 2;' },
            { client: 3, sql: 'SELECT 3;' },
        ]);
        expect(harness.events.indexOf('close:1')).toBeLessThan(harness.events.indexOf('create:2'));
        expect(harness.events.indexOf('close:2')).toBeLessThan(harness.events.indexOf('create:3'));
        expect(await readItems(target)).toEqual([[1, 'alpha'], [2, 'beta']]);
        expect(fs.statSync(target).mode & 0o777).toBe(0o444);
        expect(harness.stdout[0]).toBe(WARNING);
        expect(harness.stdout.at(-1)).toBe(`Database replica saved to ${path.join('out', 'analytics.db')}.`);
        expect(harness.stderr).toEqual([]);
        expect(fs.readdirSync(harness.cacheDir).sort()).toEqual(['data', 'meta.json']);
    });

    it('a warm cache opens a normal writable session', async () => {
        const harness = writableCacheHarness(tempRoot());
        const first = path.join(harness.outDir, 'first.db');
        const second = path.join(harness.outDir, 'second.db');
        const replicaExistedAtSync: boolean[] = [];
        harness.setSync(async (_index, file) => {
            replicaExistedAtSync.push(fs.existsSync(file));
            await writeReplica(file, harness.server.rows);
        });

        await harness.pull(first);
        expect(fs.statSync(harness.replicaPath).isFile()).toBe(true);
        harness.server.rows = [[1, 'alpha'], [2, 'beta'], [3, 'gamma']];
        harness.setLines(["INSERT INTO items (id, label) VALUES (4, 'delta');", '.exit']);
        const before = fs.readdirSync(harness.outDir);
        await harness.pull(second);

        expect(harness.syncConfigs).toHaveLength(2);
        expect(harness.syncConfigs[0].url).toBe(harness.replicaUrl);
        expect(harness.syncConfigs[1].url).toBe(harness.syncConfigs[0].url);
        expect(replicaExistedAtSync).toEqual([false, true]);
        expect(harness.executions).toEqual([{ client: 2, sql: "INSERT INTO items (id, label) VALUES (4, 'delta');" }]);
        expect(await readItems(second)).toEqual([[1, 'alpha'], [2, 'beta'], [3, 'gamma']]);
        expect(await readItems(first)).toEqual([[1, 'alpha'], [2, 'beta']]);
        expectOnlyTargetAdded(harness, before, second);
        expect(harness.stderr).toEqual([]);
    });

    it('the published target is a standalone snapshot with no companions beside it', async () => {
        const harness = writableCacheHarness(tempRoot());
        const target = path.join(harness.outDir, 'analytics.db');
        fs.writeFileSync(path.join(harness.outDir, 'unrelated.txt'), 'DO NOT TOUCH');
        harness.setSync(async (_index, file) => writeReplica(file, harness.server.rows, true));
        const before = fs.readdirSync(harness.outDir);

        await harness.pull(target);

        expect(harness.syncConfigs.map((config) => config.url)).toEqual([harness.replicaUrl]);
        // The replica keeps its companions and its free pages inside the cache ...
        for (const suffix of MEASURED_COMPANIONS) {
            expect(fs.existsSync(`${harness.replicaPath}${suffix}`), suffix).toBe(true);
        }
        expect(await freelistCount(harness.replicaPath)).toBeGreaterThan(0);
        // ... while the target is the VACUUM INTO product: no free pages, nothing beside it.
        expect(await freelistCount(target)).toBe(0);
        expect(await readItems(target)).toEqual([[1, 'alpha'], [2, 'beta']]);
        expectOnlyTargetAdded(harness, before, target);
        expect(fs.readFileSync(path.join(harness.outDir, 'unrelated.txt'), 'utf8')).toBe('DO NOT TOUCH');
        expect(fs.statSync(target).mode & 0o777).toBe(0o444);
    });

    it('a live lock makes the writable session uncached with the stderr note, and the session still works', async () => {
        const harness = writableCacheHarness(tempRoot());
        const target = path.join(harness.outDir, 'analytics.db');
        fs.writeFileSync(target, 'OLD REPLICA');
        fs.mkdirSync(harness.cacheDir, { recursive: true });
        const liveLock = JSON.stringify({ pid: process.pid, host: os.hostname(), nonce: 'live-foreign-nonce', at: harness.clock.now });
        fs.writeFileSync(harness.lockPath, liveLock);
        harness.setLines(["INSERT INTO items (id, label) VALUES (3, 'gamma');", '.exit']);
        const before = fs.readdirSync(harness.outDir);

        await harness.pull(target, {});

        expect(harness.confirm).toHaveBeenCalledTimes(1);
        expect(harness.stderr).toEqual([BUSY_NOTE]);
        // The cached path's identity mint, then today's path mints its own.
        expect(harness.mints).toEqual(['write', 'write']);
        expect(harness.syncConfigs.map((config) => [config.url, config.authToken])).toEqual([
            [harness.tempUrl(target), `${ACCESS_TOKEN_SENTINEL}-2`],
        ]);
        expect(harness.executions).toEqual([{ client: 1, sql: "INSERT INTO items (id, label) VALUES (3, 'gamma');" }]);
        expect(harness.stdout[0]).toBe(WARNING);
        expect(fs.readFileSync(harness.lockPath, 'utf8')).toBe(liveLock);
        expect(fs.existsSync(harness.dataDir)).toBe(false);
        expect(await readItems(target)).toEqual([[1, 'alpha'], [2, 'beta']]);
        expectOnlyTargetAdded(harness, before, target);
    });

    describe('a warm cache whose initial sync fails is wiped and reopened cold once', () => {
        it('the cold reopen syncs and the session runs', async () => {
            const harness = writableCacheHarness(tempRoot());
            await harness.pull(path.join(harness.outDir, 'first.db'));
            expect(fs.statSync(harness.replicaPath).isFile()).toBe(true);
            const target = path.join(harness.outDir, 'second.db');
            const replicaExistedAtSync: boolean[] = [];
            harness.server.rows = [[1, 'alpha'], [5, 'after the cold reopen']];
            harness.setSync(async (index, file) => {
                replicaExistedAtSync.push(fs.existsSync(file));
                if (index === 2) throw deterministicFailure();
                await writeReplica(file, harness.server.rows);
            });
            harness.setLines(["INSERT INTO items (id, label) VALUES (6, 'zeta');", '.exit']);
            const before = fs.readdirSync(harness.outDir);

            await harness.pull(target);

            expect(harness.syncConfigs.slice(1).map((config) => config.url)).toEqual([harness.replicaUrl, harness.replicaUrl]);
            expect(replicaExistedAtSync).toEqual([true, false]);
            expect(harness.events.indexOf('close:2')).toBeLessThan(harness.events.indexOf('create:3'));
            expect(harness.executions).toEqual([{ client: 3, sql: "INSERT INTO items (id, label) VALUES (6, 'zeta');" }]);
            expect(harness.stdout.filter((line) => line === WARNING)).toHaveLength(2);
            expect(await readItems(target)).toEqual([[1, 'alpha'], [5, 'after the cold reopen']]);
            expectOnlyTargetAdded(harness, before, target);
            expect(harness.stderr).toEqual([]);
            expect(fs.existsSync(harness.lockPath)).toBe(false);
        });

        it('a second failure is upstream_unavailable and nothing is published', async () => {
            const harness = writableCacheHarness(tempRoot());
            await harness.pull(path.join(harness.outDir, 'first.db'));
            expect(fs.statSync(harness.replicaPath).isFile()).toBe(true);
            const target = path.join(harness.outDir, 'second.db');
            fs.writeFileSync(target, 'OLD REPLICA');
            harness.setSync(async () => {
                throw deterministicFailure();
            });
            harness.setLines(['DELETE FROM items;', '.exit']);
            const before = fs.readdirSync(harness.outDir);
            const stdoutBefore = harness.stdout.length;

            const error = await caught(harness.pull(target));

            expect(error).toMatchObject({ code: 'upstream_unavailable' });
            expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain('DETERMINISTIC_FAILURE_SENTINEL');
            expect(harness.syncConfigs.slice(1).map((config) => config.url)).toEqual([harness.replicaUrl, harness.replicaUrl]);
            expect(harness.reads).toEqual([]);
            expect(harness.executions).toEqual([]);
            expect(harness.stdout.slice(stdoutBefore)).toEqual([]);
            expect(fs.readFileSync(target, 'utf8')).toBe('OLD REPLICA');
            expect(fs.readdirSync(harness.outDir).sort()).toEqual(before.sort());
            expect(fs.existsSync(harness.lockPath)).toBe(false);
        });
    });

    describe('a snapshot failure wipes the cache, replays no input, says the writes are saved, and publishes a read-only copy', () => {
        const INSERT = "INSERT INTO items (id, label) VALUES (3, 'written in the session');";

        /** The cache replica syncs to bytes no local client can open, so the snapshot fails; the temp syncs real rows. */
        function damagedCacheReplica(harness: Harness, tempFails: boolean): void {
            harness.setSync(async (_index, file) => {
                if (file === harness.replicaPath) {
                    fs.writeFileSync(file, Buffer.alloc(4096, 0x5a));
                    return;
                }
                if (tempFails) throw deterministicFailure();
                await writeReplica(file, harness.server.rows);
            });
        }

        it('the read-only copy holds the server rows', async () => {
            const harness = writableCacheHarness(tempRoot());
            const target = path.join(harness.outDir, 'analytics.db');
            harness.dependencies.env = { SOLIDACTIONS_RUN_ID: 'run-uuid-1' };
            // The session's write is on the server (readYourWrites, offline: false).
            harness.server.rows = [[1, 'alpha'], [2, 'beta'], [3, 'written in the session']];
            damagedCacheReplica(harness, false);
            harness.setLines([INSERT, '.exit']);
            const before = fs.readdirSync(harness.outDir);

            await harness.pull(target);

            expect(harness.stderr).toEqual([WORKFLOW_RUN_PULL_WARNING, FALLBACK_NOTE]);
            expect(harness.executions).toEqual([{ client: 1, sql: INSERT }]);
            expect(harness.mints).toEqual(['write', 'read']);
            expect(harness.syncConfigs.map((config) => [config.url, config.readYourWrites])).toEqual([
                [harness.replicaUrl, true],
                [harness.tempUrl(target), undefined],
            ]);
            expect(await readItems(target)).toEqual([[1, 'alpha'], [2, 'beta'], [3, 'written in the session']]);
            expect(fs.statSync(target).mode & 0o777).toBe(0o444);
            expectOnlyTargetAdded(harness, before, target);
            expect(harness.stdout).toEqual([WARNING, 'Rows affected: 1', `Database replica saved to ${path.join('out', 'analytics.db')}.`]);
            expect(fs.readdirSync(harness.dataDir)).toEqual([]);
            expect(fs.readdirSync(harness.cacheDir).sort()).toEqual(['data', 'meta.json']);
        });

        it('the read-only publish also fails: upstream_unavailable', async () => {
            const harness = writableCacheHarness(tempRoot());
            const target = path.join(harness.outDir, 'analytics.db');
            fs.writeFileSync(target, 'OLD REPLICA');
            damagedCacheReplica(harness, true);
            harness.setLines([INSERT, '.exit']);
            const before = fs.readdirSync(harness.outDir);

            const error = await caught(harness.pull(target));

            expect(error).toMatchObject({ code: 'upstream_unavailable' });
            expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain('DETERMINISTIC_FAILURE_SENTINEL');
            expect(harness.stderr).toEqual([FALLBACK_NOTE]);
            expect(harness.executions).toEqual([{ client: 1, sql: INSERT }]);
            expect(harness.syncConfigs.map((config) => config.url)).toEqual([harness.replicaUrl, harness.tempUrl(target)]);
            expect(fs.readFileSync(target, 'utf8')).toBe('OLD REPLICA');
            expect(fs.readdirSync(harness.outDir).sort()).toEqual(before.sort());
            expect(fs.readdirSync(harness.dataDir)).toEqual([]);
            expect(fs.existsSync(harness.lockPath)).toBe(false);
        });
    });

    it('abort publishes the last valid state through the snapshot and releases the lock', async () => {
        const harness = writableCacheHarness(tempRoot());
        const target = path.join(harness.outDir, 'analytics.db');
        const controller = new AbortController();
        let reads = 0;
        harness.dependencies.abortSignal = controller.signal;
        harness.dependencies.input = {
            [Symbol.asyncIterator]() {
                return {
                    async next() {
                        reads += 1;
                        if (reads === 1) return { done: false as const, value: 'SELECT 1;' };
                        controller.abort();
                        return { done: true as const, value: undefined };
                    },
                };
            },
        };
        const before = fs.readdirSync(harness.outDir);

        await harness.pull(target);

        expect(reads).toBe(2);
        expect(harness.executions).toEqual([{ client: 1, sql: 'SELECT 1;' }]);
        expect(harness.syncConfigs.map((config) => config.url)).toEqual([harness.replicaUrl]);
        expect(await readItems(target)).toEqual([[1, 'alpha'], [2, 'beta']]);
        expect(fs.statSync(target).mode & 0o777).toBe(0o444);
        expectOnlyTargetAdded(harness, before, target);
        expect(fs.readdirSync(harness.cacheDir).sort()).toEqual(['data', 'meta.json']);
        expect(harness.readMeta().lastSyncedAt).toBe(harness.clock.now);
    });

    it('an error mid-session releases the lock', async () => {
        const harness = writableCacheHarness(tempRoot());
        const target = path.join(harness.outDir, 'analytics.db');
        fs.writeFileSync(target, 'OLD REPLICA');
        harness.setLines(["INSERT INTO items (id, label) VALUES (9, 'unfinished;", '.exit']);
        const before = fs.readdirSync(harness.outDir);

        const error = await caught(harness.pull(target));

        expect(error).toMatchObject({ code: 'incomplete_sql' });
        expect(harness.syncConfigs.map((config) => config.url)).toEqual([harness.replicaUrl]);
        expect(harness.executions).toEqual([]);
        expect(fs.readFileSync(target, 'utf8')).toBe('OLD REPLICA');
        expect(fs.readdirSync(harness.outDir).sort()).toEqual(before.sort());
        expect(fs.existsSync(path.join(harness.cacheDir, 'meta.json'))).toBe(true);
        expect(fs.existsSync(harness.lockPath)).toBe(false);
        expect(harness.readMeta().lastSyncedAt).toBeNull();
    });

    it('a renewal re-mint with a different sync origin ends the session and publishes the last valid state', async () => {
        const harness = writableCacheHarness(tempRoot());
        const target = path.join(harness.outDir, 'analytics.db');
        harness.server.expiresAt = ['2026-11-18T09:10:00.000Z', '2026-11-18T09:20:00.000Z'];
        harness.setSync(async (_index, file) => {
            await writeReplica(file, harness.server.rows);
            // The record now points at another server copy; the next mint answers with its host.
            harness.server.host = 'replacement-host.sentinel.invalid';
            harness.server.rows = [[1, 'from the replacement server']];
        });
        // Reading the first line moves the clock past the renewal point, so a renewal is due before the next line.
        harness.setLines(['SELECT 1;', 'DELETE FROM items;', '.exit'], (_line, index) => {
            if (index === 0) harness.clock.now = Date.parse('2026-11-18T09:09:31.000Z');
        });
        const before = fs.readdirSync(harness.outDir);

        const error = await caught(harness.pull(target));

        expect(error).toMatchObject({ code: 'upstream_unavailable' });
        expect(harness.mints).toEqual(['write', 'write']);
        expect(harness.syncConfigs.map((config) => [config.url, config.syncUrl])).toEqual([
            [harness.replicaUrl, 'libsql://primary-host.sentinel.invalid'],
        ]);
        expect(harness.reads).toEqual(['SELECT 1;']);
        expect(harness.executions).toEqual([{ client: 1, sql: 'SELECT 1;' }]);
        expect(await readItems(target)).toEqual([[1, 'alpha'], [2, 'beta']]);
        expect(fs.statSync(target).mode & 0o777).toBe(0o444);
        expectOnlyTargetAdded(harness, before, target);
        expect(fs.existsSync(harness.lockPath)).toBe(false);
    });

    it.each([
        {
            label: 'a symlink to an outside file',
            replace: (temp: string, outside: string) => fs.symlinkSync(outside, temp),
            survives: (temp: string, outside: string) => fs.lstatSync(temp).isSymbolicLink() && fs.readlinkSync(temp) === outside,
        },
        {
            label: 'another regular file',
            replace: (temp: string) => fs.writeFileSync(temp, 'SOMEONE ELSES FILE'),
            survives: (temp: string) => fs.readFileSync(temp, 'utf8') === 'SOMEONE ELSES FILE',
        },
    ])('a temp replaced by $label while the session holds its reservation is refused and left alone', async ({ replace, survives }) => {
        const root = tempRoot();
        const harness = writableCacheHarness(root);
        const target = path.join(harness.outDir, 'analytics.db');
        const temp = fileURLToPath(harness.tempUrl(target));
        fs.writeFileSync(target, 'OLD REPLICA');
        const outside = path.join(root, 'outside.txt');
        fs.writeFileSync(outside, 'OUTSIDE FILE');
        const swapped: boolean[] = [];
        harness.setSync(async (_index, file) => {
            await writeReplica(file, harness.server.rows);
            // The reserved temp is swapped while the session still holds its handle.
            if (file === harness.replicaPath) {
                swapped.push(fs.existsSync(temp));
                fs.unlinkSync(temp);
                replace(temp, outside);
            }
        });

        const error = await caught(harness.pull(target));

        expect(error).toMatchObject({ code: 'unsafe_destination' });
        expect(swapped).toEqual([true]);
        expect(harness.syncConfigs.map((config) => config.url)).toEqual([harness.replicaUrl]);
        expect(fs.readFileSync(target, 'utf8')).toBe('OLD REPLICA');
        expect(fs.readFileSync(outside, 'utf8')).toBe('OUTSIDE FILE');
        // What now sits at the temp path is not this run's, so it is left alone.
        expect(survives(temp, outside)).toBe(true);
        expect(fs.existsSync(harness.lockPath)).toBe(false);
    });

    it('a real write through the local client lands in the published snapshot', async () => {
        const harness = writableCacheHarness(tempRoot());
        const target = path.join(harness.outDir, 'analytics.db');
        const insert = "INSERT INTO items (id, label) VALUES (3, 'written for real');";
        harness.useRealWrites();
        harness.setLines([insert, '.exit']);
        const before = fs.readdirSync(harness.outDir);

        await harness.pull(target);

        expect(harness.syncConfigs.map((config) => config.url)).toEqual([harness.replicaUrl]);
        expect(harness.executions).toEqual([{ client: 1, sql: insert }]);
        expect(harness.stdout).toEqual([WARNING, 'Rows affected: 1', `Database replica saved to ${path.join('out', 'analytics.db')}.`]);
        // The statement really changed the cache replica file, and the snapshot carries it.
        expect(await readItems(harness.replicaPath)).toEqual([[1, 'alpha'], [2, 'beta'], [3, 'written for real']]);
        expect(await readItems(target)).toEqual([[1, 'alpha'], [2, 'beta'], [3, 'written for real']]);
        expect(fs.statSync(target).mode & 0o777).toBe(0o444);
        expectOnlyTargetAdded(harness, before, target);
        expect(harness.stderr).toEqual([]);
    });

    describe('the cache path is checked by the cache, not by the destination rules (I3)', () => {
        it('a cache root reached through a symlinked directory still opens a cached writable session', async () => {
            const root = tempRoot();
            const realHome = path.join(root, 'real-home');
            fs.mkdirSync(realHome);
            const linkedHome = path.join(root, 'linked-home');
            fs.symlinkSync(realHome, linkedHome);
            const harness = writableCacheHarness(root, path.join(linkedHome, '.solidactions', 'cache', 'database-replicas'));
            expect(fs.lstatSync(linkedHome).isSymbolicLink()).toBe(true);
            harness.server.expiresAt = ['2026-11-18T09:10:00.000Z', '2026-11-18T09:20:00.000Z'];
            harness.setLines(['SELECT 1;', 'SELECT 2;', '.exit'], (_line, index) => {
                if (index === 0) harness.clock.now = Date.parse('2026-11-18T09:09:31.000Z');
            });
            const first = path.join(harness.outDir, 'first.db');
            const second = path.join(harness.outDir, 'second.db');

            await harness.pull(first);
            harness.setLines(['.exit']);
            await harness.pull(second);

            // Cold open, renewal, then a warm open, all through the symlinked ancestor.
            expect(harness.syncConfigs.map((config) => config.url)).toEqual([harness.replicaUrl, harness.replicaUrl, harness.replicaUrl]);
            expect(harness.replicaUrl.startsWith(`${pathToFileURL(linkedHome).href}/`)).toBe(true);
            expect(fs.statSync(path.join(realHome, '.solidactions', 'cache', 'database-replicas', CACHE_KEY, 'data', 'replica.db')).isFile()).toBe(true);
            expect(await readItems(first)).toEqual([[1, 'alpha'], [2, 'beta']]);
            expect(await readItems(second)).toEqual([[1, 'alpha'], [2, 'beta']]);
            expect(harness.stderr).toEqual([]);
            expect(fs.existsSync(harness.lockPath)).toBe(false);
        });

        it('a symlinked replica.db is wiped and the session opens cold, never unsafe_destination', async () => {
            const root = tempRoot();
            const harness = writableCacheHarness(root);
            await harness.pull(path.join(harness.outDir, 'first.db'));
            expect(fs.statSync(harness.replicaPath).isFile()).toBe(true);
            const outside = path.join(root, 'outside.db');
            fs.writeFileSync(outside, 'OUTSIDE FILE');
            fs.rmSync(harness.replicaPath);
            fs.symlinkSync(outside, harness.replicaPath);
            expect(fs.lstatSync(harness.replicaPath).isSymbolicLink()).toBe(true);
            const presentAtSync: boolean[] = [];
            harness.setSync(async (_index, file) => {
                presentAtSync.push(fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined);
                await writeReplica(file, harness.server.rows);
            });
            harness.setLines(["INSERT INTO items (id, label) VALUES (3, 'gamma');", '.exit']);
            const target = path.join(harness.outDir, 'second.db');
            const before = fs.readdirSync(harness.outDir);

            await harness.pull(target);

            expect(harness.syncConfigs.slice(1).map((config) => config.url)).toEqual([harness.replicaUrl]);
            expect(presentAtSync).toEqual([false]);
            expect(harness.executions).toEqual([{ client: 2, sql: "INSERT INTO items (id, label) VALUES (3, 'gamma');" }]);
            expect(fs.readFileSync(outside, 'utf8')).toBe('OUTSIDE FILE');
            expect(fs.lstatSync(harness.replicaPath).isFile()).toBe(true);
            expect(await readItems(target)).toEqual([[1, 'alpha'], [2, 'beta']]);
            expectOnlyTargetAdded(harness, before, target);
            expect(harness.stderr).toEqual([]);
            expect(fs.existsSync(harness.lockPath)).toBe(false);
        });

        it('a warm retry whose wipe fails drops the cache and the session runs uncached', async () => {
            const root = tempRoot();
            const harness = writableCacheHarness(root);
            await harness.pull(path.join(harness.outDir, 'first.db'));
            expect(fs.statSync(harness.replicaPath).isFile()).toBe(true);
            const outsideDir = path.join(root, 'outside-data');
            fs.mkdirSync(outsideDir);
            fs.writeFileSync(path.join(outsideDir, 'sentinel.txt'), 'OUTSIDE SENTINEL');
            harness.setSync(async (index, file) => {
                if (index === 2) {
                    // The data folder becomes a symlink to an outside folder, so the wipe after this failure refuses it.
                    fs.rmSync(harness.dataDir, { recursive: true, force: true });
                    fs.symlinkSync(outsideDir, harness.dataDir);
                    throw deterministicFailure();
                }
                await writeReplica(file, harness.server.rows);
            });
            const insert = "INSERT INTO items (id, label) VALUES (3, 'gamma');";
            harness.setLines([insert, '.exit']);
            const target = path.join(harness.outDir, 'second.db');
            const before = fs.readdirSync(harness.outDir);

            await harness.pull(target);

            expect(harness.syncConfigs.slice(1).map((config) => config.url)).toEqual([harness.replicaUrl, harness.tempUrl(target)]);
            // The first session's mint, then this session's identity mint and the uncached open's own mint.
            expect(harness.mints).toEqual(['write', 'write', 'write']);
            expect(harness.executions).toEqual([{ client: 3, sql: insert }]);
            expect(await readItems(target)).toEqual([[1, 'alpha'], [2, 'beta']]);
            expectOnlyTargetAdded(harness, before, target);
            expect(fs.lstatSync(harness.dataDir).isSymbolicLink()).toBe(true);
            expect(fs.readdirSync(outsideDir)).toEqual(['sentinel.txt']);
            expect(fs.readFileSync(path.join(outsideDir, 'sentinel.txt'), 'utf8')).toBe('OUTSIDE SENTINEL');
            expect(harness.stderr).toEqual([]);
            expect(fs.existsSync(harness.lockPath)).toBe(false);
        });
    });

    it('no credential reaches the cache directory (write token and PAT sentinels)', async () => {
        const harness = writableCacheHarness(tempRoot());
        harness.server.expiresAt = ['2026-11-18T09:10:00.000Z', '2026-11-18T09:20:00.000Z'];
        harness.setLines(['SELECT 1;', 'SELECT 2;', '.exit'], (_line, index) => {
            if (index === 0) harness.clock.now = Date.parse('2026-11-18T09:09:31.000Z');
        });
        await harness.pull(path.join(harness.outDir, 'first.db'));
        harness.server.rows = [[3, 'gamma']];
        harness.setLines(['.exit']);
        await harness.pull(path.join(harness.outDir, 'second.db'));

        expect(harness.mints).toEqual(['write', 'write', 'write']);
        expect(harness.syncConfigs.map((config) => config.url)).toEqual([harness.replicaUrl, harness.replicaUrl, harness.replicaUrl]);
        expect(fs.existsSync(harness.cacheRoot)).toBe(true);
        const files = filesUnder(harness.cacheRoot);
        expect(files).toEqual(expect.arrayContaining([harness.replicaPath, path.join(harness.cacheDir, 'meta.json')]));
        for (const file of files) {
            const contents = fs.readFileSync(file).toString('latin1');
            expect(contents, file).not.toContain(ACCESS_TOKEN_SENTINEL);
            expect(contents, file).not.toContain(CONFIG.apiKey);
        }
    });

    it.each([
        { label: '--no-cache', options: { yes: true, cache: false }, omitRoot: false },
        { label: 'an omitted root', options: { yes: true }, omitRoot: true },
    ])('$label leaves the existing flow', async ({ options, omitRoot }) => {
        const harness = writableCacheHarness(tempRoot());
        const target = path.join(harness.outDir, 'analytics.db');
        if (omitRoot) delete harness.dependencies.replicaCacheRoot;
        harness.setLines(["INSERT INTO items (id, label) VALUES (3, 'gamma');", '.exit']);
        const before = fs.readdirSync(harness.outDir);

        await harness.pull(target, options);

        expect(harness.mints).toEqual(['write']);
        expect(harness.syncConfigs.map((config) => config.url)).toEqual([harness.tempUrl(target)]);
        expect(harness.executions).toEqual([{ client: 1, sql: "INSERT INTO items (id, label) VALUES (3, 'gamma');" }]);
        expect(fs.existsSync(harness.cacheRoot)).toBe(false);
        expect(await readItems(target)).toEqual([[1, 'alpha'], [2, 'beta']]);
        expect(fs.statSync(target).mode & 0o777).toBe(0o444);
        expectOnlyTargetAdded(harness, before, target);
        expect(harness.stderr).toEqual([]);
    });
});

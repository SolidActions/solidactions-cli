/**
 * The cached read-only `database pull` (cli#262, plan Task 4).
 *
 * Test seams, each named by docs/decisions/0004-database-pull-cache-test-seams.md:
 * - call site 1: the sync client inside `loadClient` (a config WITH `syncUrl`) writes a REAL
 *   SQLite file at its `url` through the real `@libsql/client` plus the companion files the
 *   probe measured; a config WITHOUT `syncUrl` gets the REAL `createClient`, so `PRAGMA
 *   quick_check`, `VACUUM INTO` and the uncached checkpoint run for real;
 * - call site 2: the injected `post` answering `show` and `access` (the `pullHarness` shape of
 *   tests/database-pull-command.test.ts), with the access `url` host set per scenario;
 * - call site 3: the injected clock (`now`, `sleep`);
 * - call site 3a: `confirm` as a `vi.fn` returning true (the live-lock row);
 * - call site 3b: the recording wrapper around the real local client (the VACUUM row).
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
const READ_TOKEN_SENTINEL = 'fresh-read-token-sentinel';
const CACHE_KEY = replicaCacheKey({ host: CONFIG.host, workspaceId: CONFIG.workspaceId, name: NAME });
/** The companion files Task 1's probe measured beside a real replica (no `-info`). */
const MEASURED_COMPANIONS = ['-client_wal_index', '-shm', '-wal'];
const BUSY_NOTE = 'Another pull of this database is using the local cache; downloading a full copy instead.';
const REWRITTEN_OFTEN_NOTE = 'This database is replaced often, so its local cache is off for now; downloading a full copy.';
const DAY_MS = 24 * 60 * 60 * 1000;

type ItemRow = [number, string];

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function tempRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-database-pull-cache-'));
    roots.push(root);
    return root;
}

/** Writes a real SQLite file holding `rows` through the real client, then the measured companions. */
async function writeReplica(file: string, rows: ItemRow[]): Promise<void> {
    for (const leftover of [file, `${file}-journal`, ...MEASURED_COMPANIONS.map((suffix) => `${file}${suffix}`)]) {
        fs.rmSync(leftover, { force: true });
    }
    const client = createRealClient({ url: pathToFileURL(file).href, intMode: 'string' });
    try {
        await client.execute('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
        for (const [id, label] of rows) {
            await client.execute({ sql: 'INSERT INTO items (id, label) VALUES (?, ?)', args: [id, label] });
        }
    } finally {
        client.close();
    }
    for (const suffix of MEASURED_COMPANIONS) {
        fs.writeFileSync(`${file}${suffix}`, `replica companion ${suffix}`);
    }
}

/** Copies `file` and the `-wal` / `-shm` companions beside it: a real writer leaves its newest rows in `-wal`. */
function copyWithCompanions(file: string, copy: string): void {
    fs.copyFileSync(file, copy);
    fs.chmodSync(copy, 0o600);
    for (const suffix of ['-wal', '-shm']) {
        if (!fs.existsSync(`${file}${suffix}`)) continue;
        fs.copyFileSync(`${file}${suffix}`, `${copy}${suffix}`);
        fs.chmodSync(`${copy}${suffix}`, 0o600);
    }
}

/** Reads `items` back through a real local client, from a private copy of `file` and its companions so nothing appears beside `file`. */
async function readItems(file: string): Promise<ItemRow[]> {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-database-pull-cache-read-'));
    roots.push(scratch);
    const copy = path.join(scratch, 'copy.db');
    copyWithCompanions(file, copy);
    const client = createRealClient({ url: pathToFileURL(copy).href, intMode: 'string' });
    try {
        const result = await client.execute('SELECT id, label FROM items ORDER BY id');
        return result.rows.map((row) => [Number(row[0]), String(row[1])]);
    } finally {
        client.close();
    }
}

async function quickCheck(file: string): Promise<string[]> {
    const client = createRealClient({ url: pathToFileURL(file).href, intMode: 'string' });
    try {
        return (await client.execute('PRAGMA quick_check')).rows.map((row) => String(row[0]));
    } finally {
        client.close();
    }
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

function cacheHarness(root: string) {
    const outDir = path.join(root, 'out');
    fs.mkdirSync(outDir);
    const cacheRoot = path.join(root, 'cache');
    const cacheDir = path.join(cacheRoot, CACHE_KEY);
    const dataDir = path.join(cacheDir, 'data');
    const replicaPath = path.join(dataDir, 'replica.db');
    const server = {
        rows: [[1, 'alpha'], [2, 'beta']] as ItemRow[],
        host: 'primary-host.sentinel.invalid',
        databaseId: 'database-record-1',
        createdAt: '2026-11-01T00:00:00Z',
    };
    const syncConfigs: Array<Record<string, unknown>> = [];
    const localStatements: Array<{ url: string; sql: string }> = [];
    const events: string[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const delays: number[] = [];
    const confirm = vi.fn(async () => true as boolean | undefined);
    const clock = { now: Date.parse('2026-11-18T09:00:00Z') };
    let mintCount = 0;
    let recordLocalStatements = false;
    // Call site 1: what the sync stand-in does on its Nth `sync()`; the default writes the server rows.
    let onSync: (index: number, file: string) => Promise<void> = async (_index, file) => writeReplica(file, server.rows);
    // Call site 1: what the stand-in's `createClient` does on its Nth call, before it hands the client back; it may throw.
    let onCreate: (index: number, file: string) => void = () => undefined;

    const dependencies: DatabaseCommandDependencies = {
        cwd: root,
        tempPath: (target: string) => path.join(path.dirname(target), `.${path.basename(target)}.solidactions-task4.tmp`),
        replicaCacheRoot: cacheRoot,
        env: {},
        now: () => clock.now,
        sleep: async (milliseconds: number) => {
            delays.push(milliseconds);
        },
        loadClient: async () => ({
            createClient: (config: Record<string, unknown>): DatabaseClient => {
                if (!Object.prototype.hasOwnProperty.call(config, 'syncUrl')) {
                    const real = createRealClient(config as unknown as Parameters<typeof createRealClient>[0]);
                    if (!recordLocalStatements) return real as unknown as DatabaseClient;
                    // Call site 3b: forwards every statement unchanged and records its text.
                    const recorder = {
                        execute: async (statement: string) => {
                            localStatements.push({ url: String(config.url), sql: statement });
                            return real.execute(statement);
                        },
                        close: () => real.close(),
                    };
                    return recorder as unknown as DatabaseClient;
                }

                syncConfigs.push({ ...config });
                const index = syncConfigs.length;
                events.push(`create:${index}`);
                onCreate(index, fileURLToPath(String(config.url)));
                return {
                    execute: async () => {
                        throw new Error('The sync stand-in runs no SQL.');
                    },
                    sync: async () => {
                        events.push(`sync:${index}`);
                        await onSync(index, fileURLToPath(String(config.url)));
                    },
                    close: async () => {
                        events.push(`close:${index}`);
                    },
                };
            },
        }),
        post: async (_url: string, body: Record<string, unknown>) => {
            if (body.operation === 'show') {
                return {
                    data: {
                        database: {
                            id: server.databaseId,
                            name: String(body.name),
                            kind: 'libsql',
                            status: 'ready',
                            size_bytes: 0,
                            deleted_at: null,
                            purge_at: null,
                            created_at: server.createdAt,
                        },
                    },
                };
            }
            mintCount += 1;
            return {
                data: {
                    url: `libsql://${server.host}`,
                    token: `${READ_TOKEN_SENTINEL}-${mintCount}`,
                    mode: 'read',
                    expires_at: '2026-11-18T12:10:00Z',
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
        server,
        syncConfigs,
        localStatements,
        events,
        stdout,
        stderr,
        delays,
        confirm,
        clock,
        dependencies,
        mints: () => mintCount,
        tempFor: (target: string) => path.join(path.dirname(target), `.${path.basename(target)}.solidactions-task4.tmp`),
        recordLocal: () => {
            recordLocalStatements = true;
        },
        setSync: (behaviour: (index: number, file: string) => Promise<void>) => {
            onSync = behaviour;
        },
        setCreate: (behaviour: (index: number, file: string) => void) => {
            onCreate = behaviour;
        },
        pull: (target: string, options: Record<string, unknown> = { yes: true }) =>
            databasePullWithConfig(NAME, target, options, CONFIG, dependencies),
    };
}

type Harness = ReturnType<typeof cacheHarness>;

/** Row 15's sweep (I1): the destination holds exactly what it held before plus the target. */
function expectOnlyTargetAdded(harness: Harness, before: string[], target: string): void {
    expect(fs.readdirSync(harness.outDir).sort()).toEqual([...new Set([...before, path.basename(target)])].sort());
}

function deterministicFailure(): Error {
    return Object.assign(new Error('DETERMINISTIC_FAILURE_SENTINEL'), { code: 'SQLITE_CORRUPT' });
}

describe('database pull through the hidden replica cache', () => {
    it('cold pull syncs into the cache replica, writes a standalone snapshot to the target, leaves exactly the target beside it', async () => {
        const harness = cacheHarness(tempRoot());
        const target = path.join(harness.outDir, 'analytics.db');
        const before = fs.readdirSync(harness.outDir);

        await harness.pull(target, {});

        expect(harness.syncConfigs).toEqual([{
            url: harness.replicaUrl,
            syncUrl: 'libsql://primary-host.sentinel.invalid',
            authToken: `${READ_TOKEN_SENTINEL}-1`,
            intMode: 'string',
        }]);
        expect(harness.mints()).toBe(1);
        expectOnlyTargetAdded(harness, before, target);
        expect(fs.statSync(target).mode & 0o777).toBe(0o444);
        expect(await readItems(target)).toEqual([[1, 'alpha'], [2, 'beta']]);
        expect(await quickCheck(harness.replicaPath)).toEqual(['ok']);
        expect(harness.stdout).toEqual([`Database replica saved to ${path.join('out', 'analytics.db')}.`]);
        expect(harness.stderr).toEqual([]);
        expect(fs.readdirSync(harness.cacheDir).sort()).toEqual(['data', 'meta.json']);
    });

    it('warm pull syncs the same cache path again and a second target gets the new rows', async () => {
        const harness = cacheHarness(tempRoot());
        const first = path.join(harness.outDir, 'first.db');
        const second = path.join(harness.outDir, 'second.db');
        const replicaExistedAtSync: boolean[] = [];
        harness.setSync(async (_index, file) => {
            replicaExistedAtSync.push(fs.existsSync(file));
            await writeReplica(file, harness.server.rows);
        });

        await harness.pull(first);
        const firstBytes = fs.readFileSync(first);
        harness.server.rows = [[1, 'alpha'], [2, 'beta'], [3, 'gamma']];
        const before = fs.readdirSync(harness.outDir);
        await harness.pull(second);

        expect(harness.syncConfigs).toHaveLength(2);
        expect(harness.syncConfigs[0].url).toBe(harness.replicaUrl);
        expect(harness.syncConfigs[1].url).toBe(harness.syncConfigs[0].url);
        expect(replicaExistedAtSync).toEqual([false, true]);
        expect(await readItems(second)).toEqual([[1, 'alpha'], [2, 'beta'], [3, 'gamma']]);
        expect(fs.readFileSync(first).equals(firstBytes)).toBe(true);
        expect(await readItems(first)).toEqual([[1, 'alpha'], [2, 'beta']]);
        expectOnlyTargetAdded(harness, before, second);
        expect(harness.stderr).toEqual([]);
    });

    it('warm pull reflects remote inserts, updates and deletes', async () => {
        const harness = cacheHarness(tempRoot());
        const states: ItemRow[][] = [
            [[1, 'alpha'], [2, 'beta'], [3, 'gamma']],
            [[1, 'alpha'], [2, 'BETA'], [3, 'gamma'], [4, 'delta']],
            [[2, 'BETA'], [4, 'DELTA'], [5, 'epsilon']],
        ];
        const targets = ['one.db', 'two.db', 'three.db'].map((file) => path.join(harness.outDir, file));

        for (const [index, state] of states.entries()) {
            harness.server.rows = state;
            await harness.pull(targets[index]);
        }

        expect(new Set(harness.syncConfigs.map((config) => config.url))).toEqual(new Set([harness.replicaUrl]));
        for (const [index, state] of states.entries()) {
            expect(await readItems(targets[index])).toEqual(state);
        }
    });

    it('a failed warm sync never publishes the previous file', async () => {
        const harness = cacheHarness(tempRoot());
        const target = path.join(harness.outDir, 'analytics.db');
        await harness.pull(target);
        const publishedBytes = fs.readFileSync(target);
        harness.server.rows = [[9, 'never published']];
        harness.setSync(async () => {
            throw deterministicFailure();
        });

        let caught: any;
        try {
            await harness.pull(target);
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({ code: 'upstream_unavailable' });
        expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain('DETERMINISTIC_FAILURE_SENTINEL');
        // The cached attempt (warm, deterministic: wipe and fall back), then the uncached path's one attempt.
        expect(harness.syncConfigs.slice(1).map((config) => config.url)).toEqual([
            harness.replicaUrl,
            pathToFileURL(harness.tempFor(target)).href,
        ]);
        expect(fs.readFileSync(target).equals(publishedBytes)).toBe(true);
        expect(fs.readdirSync(harness.outDir)).toEqual(['analytics.db']);
        expect(fs.readdirSync(harness.dataDir)).toEqual([]);
        expect(harness.delays).toEqual([]);
    });

    it('a deterministic warm failure wipes the cache and the uncached path publishes', async () => {
        const harness = cacheHarness(tempRoot());
        const target = path.join(harness.outDir, 'analytics.db');
        await harness.pull(target);
        harness.server.rows = [[1, 'alpha'], [7, 'after the fallback']];
        harness.setSync(async (index, file) => {
            if (index === 2) throw deterministicFailure();
            await writeReplica(file, harness.server.rows);
        });
        const before = fs.readdirSync(harness.outDir);

        await harness.pull(target);

        expect(harness.syncConfigs.map((config) => config.url)).toEqual([
            harness.replicaUrl,
            harness.replicaUrl,
            pathToFileURL(harness.tempFor(target)).href,
        ]);
        expect(await readItems(target)).toEqual([[1, 'alpha'], [7, 'after the fallback']]);
        expectOnlyTargetAdded(harness, before, target);
        expect(fs.readdirSync(harness.dataDir)).toEqual([]);
        expect(harness.delays).toEqual([]);
        expect(harness.stderr).toEqual([]);

        const dataAtSync: string[][] = [];
        harness.setSync(async (_index, file) => {
            dataAtSync.push(fs.readdirSync(path.dirname(file)));
            await writeReplica(file, harness.server.rows);
        });
        await harness.pull(target);

        expect(harness.syncConfigs.at(-1)?.url).toBe(harness.replicaUrl);
        expect(dataAtSync).toEqual([[]]);
        expect(await readItems(target)).toEqual([[1, 'alpha'], [7, 'after the fallback']]);
    });

    describe('a cold cache that fails for a local reason falls back to the uncached path (I3)', () => {
        function cannotOpenDatabaseFile(): Error {
            return Object.assign(new Error('SQLITE_CANTOPEN: unable to open database file'), { code: 'SQLITE_CANTOPEN' });
        }

        it('a cold sync that fails with SQLITE_CANTOPEN publishes through the uncached path', async () => {
            const harness = cacheHarness(tempRoot());
            const target = path.join(harness.outDir, 'analytics.db');
            harness.server.rows = [[1, 'alpha'], [4, 'from the uncached path']];
            harness.setSync(async (_index, file) => {
                if (file === harness.replicaPath) throw cannotOpenDatabaseFile();
                await writeReplica(file, harness.server.rows);
            });
            const before = fs.readdirSync(harness.outDir);

            await harness.pull(target);

            expect(harness.syncConfigs.map((config) => config.url)).toEqual([harness.replicaUrl, pathToFileURL(harness.tempFor(target)).href]);
            expect(await readItems(target)).toEqual([[1, 'alpha'], [4, 'from the uncached path']]);
            expectOnlyTargetAdded(harness, before, target);
            expect(fs.readdirSync(harness.dataDir)).toEqual([]);
            expect(fs.existsSync(path.join(harness.cacheDir, 'lock'))).toBe(false);
            expect(harness.delays).toEqual([]);
            expect(harness.stderr).toEqual([]);
        });

        it('a cold createClient that throws publishes through the uncached path', async () => {
            const harness = cacheHarness(tempRoot());
            const target = path.join(harness.outDir, 'analytics.db');
            harness.server.rows = [[1, 'alpha'], [5, 'after the open failed']];
            harness.setCreate((_index, file) => {
                if (file === harness.replicaPath) throw cannotOpenDatabaseFile();
            });
            const before = fs.readdirSync(harness.outDir);

            await harness.pull(target);

            expect(harness.syncConfigs.map((config) => config.url)).toEqual([harness.replicaUrl, pathToFileURL(harness.tempFor(target)).href]);
            // The cache client never existed: no sync ran against the cache path, and the uncached one synced once.
            expect(harness.events.filter((event) => event.startsWith('sync:'))).toEqual(['sync:2']);
            expect(await readItems(target)).toEqual([[1, 'alpha'], [5, 'after the open failed']]);
            expectOnlyTargetAdded(harness, before, target);
            expect(fs.readdirSync(harness.dataDir)).toEqual([]);
            expect(fs.existsSync(path.join(harness.cacheDir, 'lock'))).toBe(false);
            expect(harness.stderr).toEqual([]);
        });

        it('when the uncached path also fails the error is upstream_unavailable and the target is untouched', async () => {
            const harness = cacheHarness(tempRoot());
            const target = path.join(harness.outDir, 'analytics.db');
            fs.writeFileSync(target, 'OLD REPLICA');
            harness.setSync(async () => {
                throw cannotOpenDatabaseFile();
            });
            const before = fs.readdirSync(harness.outDir);

            let caught: any;
            try {
                await harness.pull(target);
            } catch (error) {
                caught = error;
            }

            expect(caught).toMatchObject({ code: 'upstream_unavailable' });
            expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain('SQLITE_CANTOPEN');
            expect(harness.syncConfigs.map((config) => config.url)).toEqual([harness.replicaUrl, pathToFileURL(harness.tempFor(target)).href]);
            expect(fs.readFileSync(target, 'utf8')).toBe('OLD REPLICA');
            expect(fs.readdirSync(harness.outDir).sort()).toEqual(before.sort());
            expect(fs.readdirSync(harness.dataDir)).toEqual([]);
            expect(fs.existsSync(path.join(harness.cacheDir, 'lock'))).toBe(false);
        });
    });

    it('transient failures retry on the same cache path with backoff', async () => {
        const harness = cacheHarness(tempRoot());
        const target = path.join(harness.outDir, 'analytics.db');
        fs.writeFileSync(target, 'OLD REPLICA');
        harness.setSync(async (_index, file) => {
            fs.writeFileSync(file, 'PARTIAL REPLICA');
            throw Object.assign(new Error('transport failure primary-host.sentinel.invalid'), { code: 'ECONNRESET' });
        });

        let caught: any;
        try {
            await harness.pull(target);
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({ code: 'upstream_unavailable' });
        expect(harness.syncConfigs.map((config) => config.url)).toEqual([
            harness.replicaUrl,
            harness.replicaUrl,
            harness.replicaUrl,
        ]);
        expect(harness.syncConfigs.map((config) => config.authToken)).toEqual([
            `${READ_TOKEN_SENTINEL}-1`,
            `${READ_TOKEN_SENTINEL}-2`,
            `${READ_TOKEN_SENTINEL}-3`,
        ]);
        expect(harness.events.filter((event) => event.startsWith('close:'))).toEqual(['close:1', 'close:2', 'close:3']);
        expect(harness.delays).toEqual([250, 500]);
        expect(fs.readFileSync(target, 'utf8')).toBe('OLD REPLICA');
        expect(fs.readdirSync(harness.outDir)).toEqual(['analytics.db']);
        // A transient failure keeps the cache (a resumable partial) and releases the lock.
        expect(fs.readFileSync(harness.replicaPath, 'utf8')).toBe('PARTIAL REPLICA');
        expect(fs.existsSync(path.join(harness.cacheDir, 'lock'))).toBe(false);
    });

    it('credential expiry re-mints exactly once on the same cache path', async () => {
        const harness = cacheHarness(tempRoot());
        const target = path.join(harness.outDir, 'analytics.db');
        harness.setSync(async (index, file) => {
            if (index === 1) {
                fs.writeFileSync(file, 'PARTIAL');
                throw Object.assign(new Error('JWT expired with raw credential details'), { code: 'SQLITE_AUTH' });
            }
            await writeReplica(file, harness.server.rows);
        });

        await harness.pull(target);

        expect(harness.mints()).toBe(2);
        expect(harness.syncConfigs.map((config) => config.url)).toEqual([harness.replicaUrl, harness.replicaUrl]);
        expect(harness.events.filter((event) => event.startsWith('close:'))).toEqual(['close:1', 'close:2']);
        expect(harness.delays).toEqual([]);
        expect(await readItems(target)).toEqual([[1, 'alpha'], [2, 'beta']]);
        expect(fs.statSync(target).mode & 0o777).toBe(0o444);
    });

    it('a re-mint answered by another server wipes the cache and the uncached path publishes', async () => {
        const harness = cacheHarness(tempRoot());
        const target = path.join(harness.outDir, 'analytics.db');
        harness.setSync(async (index, file) => {
            if (index === 1) {
                fs.writeFileSync(file, 'PARTIAL FROM THE FIRST SERVER');
                // The record now points at another server copy; the next mint answers with its host.
                harness.server.host = 'replacement-host.sentinel.invalid';
                harness.server.rows = [[1, 'from the replacement server']];
                throw Object.assign(new Error('transport failure'), { code: 'ECONNRESET' });
            }
            await writeReplica(file, harness.server.rows);
        });

        await harness.pull(target);

        expect(harness.syncConfigs.map((config) => [config.url, config.syncUrl])).toEqual([
            [harness.replicaUrl, 'libsql://primary-host.sentinel.invalid'],
            [pathToFileURL(harness.tempFor(target)).href, 'libsql://replacement-host.sentinel.invalid'],
        ]);
        expect(harness.mints()).toBe(3);
        expect(harness.delays).toEqual([250]);
        expect(fs.readdirSync(harness.dataDir)).toEqual([]);
        expect(await readItems(target)).toEqual([[1, 'from the replacement server']]);
        expect(fs.readdirSync(harness.outDir)).toEqual(['analytics.db']);
    });

    it('a live lock makes the pull uncached, says so on stderr, and asks the overwrite question once', async () => {
        const harness = cacheHarness(tempRoot());
        const target = path.join(harness.outDir, 'analytics.db');
        fs.writeFileSync(target, 'OLD REPLICA');
        fs.mkdirSync(harness.cacheDir, { recursive: true });
        const lockPath = path.join(harness.cacheDir, 'lock');
        const liveLock = JSON.stringify({ pid: process.pid, host: os.hostname(), nonce: 'live-foreign-nonce', at: harness.clock.now });
        fs.writeFileSync(lockPath, liveLock);
        const before = fs.readdirSync(harness.outDir);

        await harness.pull(target, {});

        expect(harness.confirm).toHaveBeenCalledTimes(1);
        expect(harness.syncConfigs.map((config) => config.url)).toEqual([pathToFileURL(harness.tempFor(target)).href]);
        expect(harness.stderr).toEqual([BUSY_NOTE]);
        expect(fs.readFileSync(lockPath, 'utf8')).toBe(liveLock);
        expect(fs.existsSync(harness.dataDir)).toBe(false);
        expect(await readItems(target)).toEqual([[1, 'alpha'], [2, 'beta']]);
        expectOnlyTargetAdded(harness, before, target);
    });

    it('a swapped server wipes the cache, and three swaps in a week switch the cache off', async () => {
        const harness = cacheHarness(tempRoot());
        const target = path.join(harness.outDir, 'analytics.db');
        const dataAtSync: Array<{ url: string; data: string[] }> = [];
        harness.setSync(async (_index, file) => {
            dataAtSync.push({ url: pathToFileURL(file).href, data: fs.readdirSync(path.dirname(file)) });
            await writeReplica(file, harness.server.rows);
        });
        const readMeta = () => JSON.parse(fs.readFileSync(path.join(harness.cacheDir, 'meta.json'), 'utf8'));

        await harness.pull(target);
        harness.server.host = 'swapped-host-2.sentinel.invalid';
        harness.server.rows = [[1, 'after swap 2']];
        harness.clock.now += DAY_MS;
        await harness.pull(target);

        expect(dataAtSync[1]).toEqual({ url: harness.replicaUrl, data: [] });
        expect(readMeta().replacements).toHaveLength(1);
        expect(await readItems(target)).toEqual([[1, 'after swap 2']]);

        harness.server.host = 'swapped-host-3.sentinel.invalid';
        harness.clock.now += DAY_MS;
        await harness.pull(target);
        expect(dataAtSync[2]).toEqual({ url: harness.replicaUrl, data: [] });
        expect(readMeta().replacements).toHaveLength(2);
        expect(harness.stderr).toEqual([]);

        harness.server.host = 'swapped-host-4.sentinel.invalid';
        harness.server.rows = [[1, 'after swap 4']];
        harness.clock.now += DAY_MS;
        await harness.pull(target);

        expect(dataAtSync[3].url).toBe(pathToFileURL(harness.tempFor(target)).href);
        expect(harness.stderr).toEqual([REWRITTEN_OFTEN_NOTE]);
        expect(readMeta().skipUntil).toBeGreaterThan(harness.clock.now);
        expect(await readItems(target)).toEqual([[1, 'after swap 4']]);
    });

    it('--no-cache (options.cache === false) never touches the cache root', async () => {
        const harness = cacheHarness(tempRoot());
        const target = path.join(harness.outDir, 'analytics.db');
        const before = fs.readdirSync(harness.outDir);

        await harness.pull(target, { cache: false });

        expect(harness.mints()).toBe(1);
        expect(harness.syncConfigs.map((config) => config.url)).toEqual([pathToFileURL(harness.tempFor(target)).href]);
        expect(fs.existsSync(harness.cacheRoot)).toBe(false);
        expect(await readItems(target)).toEqual([[1, 'alpha'], [2, 'beta']]);
        expectOnlyTargetAdded(harness, before, target);
        expect(harness.stderr).toEqual([]);
    });

    it('--no-cache removes the `-info` file the real host leaves beside the temp', async () => {
        const harness = cacheHarness(tempRoot());
        const target = path.join(harness.outDir, 'analytics.db');
        harness.setSync(async (_index, file) => {
            await writeReplica(file, harness.server.rows);
            // The real database host's sync client leaves a 68-byte `-info` beside the replica (cli#266).
            fs.writeFileSync(`${file}-info`, 'x'.repeat(68));
        });
        const before = fs.readdirSync(harness.outDir);

        await harness.pull(target, { cache: false });

        expect(harness.syncConfigs.map((config) => config.url)).toEqual([pathToFileURL(harness.tempFor(target)).href]);
        expect(await readItems(target)).toEqual([[1, 'alpha'], [2, 'beta']]);
        expect(fs.existsSync(`${harness.tempFor(target)}-info`)).toBe(false);
        expectOnlyTargetAdded(harness, before, target);
        expect(harness.stderr).toEqual([]);
    });

    it('no replicaCacheRoot means no cache', async () => {
        const harness = cacheHarness(tempRoot());
        const target = path.join(harness.outDir, 'analytics.db');
        delete harness.dependencies.replicaCacheRoot;
        const before = fs.readdirSync(harness.outDir);

        await harness.pull(target, {});

        expect(harness.mints()).toBe(1);
        expect(harness.syncConfigs.map((config) => config.url)).toEqual([pathToFileURL(harness.tempFor(target)).href]);
        expect(fs.existsSync(harness.cacheRoot)).toBe(false);
        expect(await readItems(target)).toEqual([[1, 'alpha'], [2, 'beta']]);
        expect(fs.statSync(target).mode & 0o777).toBe(0o444);
        expectOnlyTargetAdded(harness, before, target);
        expect(harness.stdout).toEqual([`Database replica saved to ${path.join('out', 'analytics.db')}.`]);
        expect(harness.stderr).toEqual([]);
    });

    describe('cache faults fall back to the uncached path', () => {
        async function expectCorrectUncachedOutcome(harness: Harness, target: string, before: string[]): Promise<void> {
            expect(harness.syncConfigs.at(-1)?.url).toBe(pathToFileURL(harness.tempFor(target)).href);
            expect(await readItems(target)).toEqual(harness.server.rows);
            expectOnlyTargetAdded(harness, before, target);
            expect(fs.readFileSync(path.join(harness.outDir, 'unrelated.txt'), 'utf8')).toBe('DO NOT TOUCH');
            expect([...harness.stdout, ...harness.stderr].join('\n')).not.toMatch(/cache/i);
        }

        it('an unwritable root (its parent is a regular file)', async () => {
            const root = tempRoot();
            const harness = cacheHarness(root);
            const blocker = path.join(root, 'blocker');
            fs.writeFileSync(blocker, 'A REGULAR FILE');
            harness.dependencies.replicaCacheRoot = path.join(blocker, 'cache');
            fs.writeFileSync(path.join(harness.outDir, 'unrelated.txt'), 'DO NOT TOUCH');
            const target = path.join(harness.outDir, 'analytics.db');
            const before = fs.readdirSync(harness.outDir);

            await harness.pull(target);

            // The cached path minted first, found the cache unavailable, and the uncached path minted again.
            expect(harness.mints()).toBe(2);
            expect(harness.syncConfigs).toHaveLength(1);
            expect(harness.stderr).toEqual([]);
            expect(fs.readFileSync(blocker, 'utf8')).toBe('A REGULAR FILE');
            await expectCorrectUncachedOutcome(harness, target, before);
        });

        it('a data folder that is a symlink to an outside folder', async () => {
            const root = tempRoot();
            const harness = cacheHarness(root);
            const outside = path.join(root, 'outside');
            fs.mkdirSync(outside);
            fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'OUTSIDE SENTINEL');
            fs.mkdirSync(harness.cacheDir, { recursive: true });
            fs.symlinkSync(outside, harness.dataDir);
            fs.writeFileSync(path.join(harness.outDir, 'unrelated.txt'), 'DO NOT TOUCH');
            const target = path.join(harness.outDir, 'analytics.db');
            const before = fs.readdirSync(harness.outDir);

            await harness.pull(target);

            expect(harness.mints()).toBe(2);
            expect(harness.syncConfigs).toHaveLength(1);
            expect(fs.lstatSync(harness.dataDir).isSymbolicLink()).toBe(true);
            expect(fs.readdirSync(outside)).toEqual(['sentinel.txt']);
            expect(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('OUTSIDE SENTINEL');
            await expectCorrectUncachedOutcome(harness, target, before);
        });

        it('a corrupt meta.json is wiped and the pull refills the cache', async () => {
            const harness = cacheHarness(tempRoot());
            const target = path.join(harness.outDir, 'analytics.db');
            await harness.pull(target);
            expect(fs.existsSync(path.join(harness.cacheDir, 'meta.json'))).toBe(true);
            fs.writeFileSync(path.join(harness.cacheDir, 'meta.json'), '{ not json');
            fs.writeFileSync(path.join(harness.outDir, 'unrelated.txt'), 'DO NOT TOUCH');
            harness.server.rows = [[1, 'after a corrupt meta']];
            const dataAtSync: string[][] = [];
            harness.setSync(async (_index, file) => {
                dataAtSync.push(fs.readdirSync(path.dirname(file)));
                await writeReplica(file, harness.server.rows);
            });
            const before = fs.readdirSync(harness.outDir);

            await harness.pull(target);

            expect(harness.syncConfigs.at(-1)?.url).toBe(harness.replicaUrl);
            expect(dataAtSync).toEqual([[]]);
            expect(await readItems(target)).toEqual([[1, 'after a corrupt meta']]);
            expectOnlyTargetAdded(harness, before, target);
            expect(fs.readFileSync(path.join(harness.outDir, 'unrelated.txt'), 'utf8')).toBe('DO NOT TOUCH');
            expect([...harness.stdout, ...harness.stderr].join('\n')).not.toMatch(/cache/i);
            expect(JSON.parse(fs.readFileSync(path.join(harness.cacheDir, 'meta.json'), 'utf8')).version).toBe(1);
        });

        it('a damaged replica (4 KB of non-SQLite bytes) that the sync leaves alone', async () => {
            const harness = cacheHarness(tempRoot());
            const target = path.join(harness.outDir, 'analytics.db');
            await harness.pull(target);
            expect(fs.existsSync(harness.replicaPath)).toBe(true);
            const garbage = Buffer.alloc(4096);
            let seed = 1146;
            for (let index = 0; index < garbage.length; index += 1) {
                seed = (seed * 1103515245 + 12345) >>> 0;
                garbage[index] = seed >>> 24;
            }
            fs.writeFileSync(harness.replicaPath, garbage);
            expect(fs.readFileSync(harness.replicaPath).subarray(0, 16).toString('latin1')).not.toBe('SQLite format 3\0');
            fs.writeFileSync(path.join(harness.outDir, 'unrelated.txt'), 'DO NOT TOUCH');
            harness.server.rows = [[1, 'after a damaged replica']];
            harness.setSync(async (_index, file) => {
                if (file === harness.replicaPath) return;
                await writeReplica(file, harness.server.rows);
            });
            const before = fs.readdirSync(harness.outDir);

            await harness.pull(target);

            expect(harness.syncConfigs.slice(1).map((config) => config.url)).toEqual([
                harness.replicaUrl,
                pathToFileURL(harness.tempFor(target)).href,
            ]);
            expect(fs.readdirSync(harness.dataDir)).toEqual([]);
            expect(fs.readdirSync(harness.cacheDir).sort()).toEqual(['data', 'meta.json']);
            await expectCorrectUncachedOutcome(harness, target, before);
        });

        it('a replica whose own PRAGMA quick_check is not ok while VACUUM INTO would still succeed', async () => {
            const root = tempRoot();
            const harness = cacheHarness(root);
            const target = path.join(harness.outDir, 'analytics.db');
            await harness.pull(target);
            expect(fs.existsSync(harness.replicaPath)).toBe(true);
            // A free list the header no longer points at: quick_check reports the orphaned pages,
            // while VACUUM INTO copies only the tables and rebuilds the free list (review N1).
            for (const leftover of fs.readdirSync(harness.dataDir)) fs.rmSync(path.join(harness.dataDir, leftover));
            const damaged = createRealClient({ url: harness.replicaUrl, intMode: 'string' });
            try {
                await damaged.execute('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
                await damaged.execute("INSERT INTO items (id, label) VALUES (1, 'stale cached row')");
                await damaged.execute('CREATE TABLE scratch (pad TEXT)');
                await damaged.execute("INSERT INTO scratch SELECT printf('%.3000c', 'x') FROM (WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 8) SELECT i FROM n)");
                await damaged.execute('DROP TABLE scratch');
                expect(Number((await damaged.execute('PRAGMA freelist_count')).rows[0][0])).toBeGreaterThan(0);
            } finally {
                damaged.close();
            }
            const descriptor = fs.openSync(harness.replicaPath, 'r+');
            try {
                // Header bytes 32-39: the first free-list trunk page and the free-list page count.
                expect(fs.writeSync(descriptor, Buffer.alloc(8, 0), 0, 8, 32)).toBe(8);
            } finally {
                fs.closeSync(descriptor);
            }
            const replicaCheck = await quickCheck(harness.replicaPath);
            expect(replicaCheck).toHaveLength(1);
            expect(replicaCheck[0]).not.toBe('ok');
            expect(replicaCheck[0]).toContain('never used');
            // Positive control: VACUUM INTO of a copy succeeds and its product checks ok.
            const control = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-database-pull-cache-control-'));
            roots.push(control);
            copyWithCompanions(harness.replicaPath, path.join(control, 'replica.db'));
            const vacuumed = createRealClient({ url: pathToFileURL(path.join(control, 'replica.db')).href, intMode: 'string' });
            try {
                await vacuumed.execute(`VACUUM INTO '${path.join(control, 'snapshot.db').replaceAll("'", "''")}'`);
            } finally {
                vacuumed.close();
            }
            expect(await quickCheck(path.join(control, 'snapshot.db'))).toEqual(['ok']);

            fs.writeFileSync(path.join(harness.outDir, 'unrelated.txt'), 'DO NOT TOUCH');
            harness.server.rows = [[1, 'after a damaged free list']];
            harness.setSync(async (_index, file) => {
                if (file === harness.replicaPath) return;
                await writeReplica(file, harness.server.rows);
            });
            const before = fs.readdirSync(harness.outDir);

            await harness.pull(target);

            expect(harness.syncConfigs.slice(1).map((config) => config.url)).toEqual([
                harness.replicaUrl,
                pathToFileURL(harness.tempFor(target)).href,
            ]);
            expect(fs.readdirSync(harness.dataDir)).toEqual([]);
            await expectCorrectUncachedOutcome(harness, target, before);
        });
    });

    it('the VACUUM target is inside the cache directory and the reserved temp is never unlinked', async () => {
        const harness = cacheHarness(tempRoot());
        const target = path.join(harness.outDir, 'analytics.db');
        const temp = harness.tempFor(target);
        harness.recordLocal();
        const reservedInodes: Array<number | null> = [];
        harness.setSync(async (_index, file) => {
            reservedInodes.push(fs.existsSync(temp) ? fs.lstatSync(temp).ino : null);
            await writeReplica(file, harness.server.rows);
        });

        await harness.pull(target);

        const vacuums = harness.localStatements.filter((statement) => /^VACUUM INTO /.test(statement.sql));
        expect(vacuums).toHaveLength(1);
        expect(vacuums[0].url).toBe(harness.replicaUrl);
        const vacuumPath = /^VACUUM INTO '(.*)'$/s.exec(vacuums[0].sql)?.[1]?.replaceAll("''", "'");
        expect(vacuumPath?.startsWith(`${harness.cacheDir}${path.sep}`)).toBe(true);
        expect(harness.localStatements.map((statement) => [statement.url, statement.sql])).toEqual([
            [harness.replicaUrl, 'PRAGMA quick_check'],
            [harness.replicaUrl, vacuums[0].sql],
            [pathToFileURL(vacuumPath!).href, 'PRAGMA quick_check'],
        ]);
        expect(reservedInodes).toHaveLength(1);
        expect(reservedInodes[0]).not.toBeNull();
        expect(fs.statSync(target).ino).toBe(reservedInodes[0]);
        expect(fs.existsSync(vacuumPath!)).toBe(false);
        expect(await readItems(target)).toEqual([[1, 'alpha'], [2, 'beta']]);
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
    ])('a temp replaced by $label while its handle is open is refused and nothing is published', async ({ replace, survives }) => {
        const root = tempRoot();
        const harness = cacheHarness(root);
        const target = path.join(harness.outDir, 'analytics.db');
        const temp = harness.tempFor(target);
        fs.writeFileSync(target, 'OLD REPLICA');
        const outside = path.join(root, 'outside.txt');
        fs.writeFileSync(outside, 'OUTSIDE FILE');
        harness.setSync(async (_index, file) => {
            await writeReplica(file, harness.server.rows);
            // The reserved temp is swapped while the pull still holds its handle; the snapshot
            // bytes go through that handle into the original inode, and publication must refuse.
            if (file === harness.replicaPath) {
                expect(fs.existsSync(temp)).toBe(true);
                fs.unlinkSync(temp);
                replace(temp, outside);
            }
        });

        await expect(harness.pull(target)).rejects.toMatchObject({ code: 'unsafe_destination' });

        expect(harness.syncConfigs.map((config) => config.url)).toEqual([harness.replicaUrl]);
        expect(fs.readFileSync(target, 'utf8')).toBe('OLD REPLICA');
        expect(fs.readFileSync(outside, 'utf8')).toBe('OUTSIDE FILE');
        // What now sits at the temp path is not this run's, so it is left alone.
        expect(survives(temp, outside)).toBe(true);
        expect(fs.existsSync(path.join(harness.cacheDir, 'lock'))).toBe(false);
    });

    it.each([
        { label: 'SOLIDACTIONS_RUN_ID', env: { SOLIDACTIONS_RUN_ID: 'run-uuid-1' }, warned: true, cache: true },
        { label: 'SOLIDACTIONS_RUN_ID', env: { SOLIDACTIONS_RUN_ID: 'run-uuid-1' }, warned: true, cache: false },
        { label: 'STEPS_TRIGGER_ID', env: { STEPS_TRIGGER_ID: '42' }, warned: true, cache: true },
        { label: 'STEPS_TRIGGER_ID', env: { STEPS_TRIGGER_ID: '42' }, warned: true, cache: false },
        { label: 'an empty env', env: {}, warned: false, cache: true },
        { label: 'an empty env', env: {}, warned: false, cache: false },
        { label: 'SOLIDACTIONS_RUN_ID with skipWorkflowWarning', env: { SOLIDACTIONS_RUN_ID: 'run-uuid-1' }, warned: false, cache: true, skipWorkflowWarning: true },
    ])('the workflow-run warning for $label (cache: $cache) is printed only inside a run, and the pull still succeeds', async ({ env, warned, cache, skipWorkflowWarning }) => {
        const harness = cacheHarness(tempRoot());
        const target = path.join(harness.outDir, 'analytics.db');
        harness.dependencies.env = env;

        await harness.pull(target, { cache, ...(skipWorkflowWarning ? { skipWorkflowWarning } : {}) });

        expect(harness.stderr).toEqual(warned ? [WORKFLOW_RUN_PULL_WARNING] : []);
        expect(harness.syncConfigs.map((config) => config.url)).toEqual([
            cache ? harness.replicaUrl : pathToFileURL(harness.tempFor(target)).href,
        ]);
        expect(await readItems(target)).toEqual([[1, 'alpha'], [2, 'beta']]);
    });

    it('no credential reaches the cache directory', async () => {
        const harness = cacheHarness(tempRoot());
        await harness.pull(path.join(harness.outDir, 'first.db'));
        harness.server.rows = [[3, 'gamma']];
        await harness.pull(path.join(harness.outDir, 'second.db'));

        expect(fs.existsSync(harness.cacheRoot)).toBe(true);
        const files = filesUnder(harness.cacheRoot);
        expect(files).toEqual(expect.arrayContaining([harness.replicaPath, path.join(harness.cacheDir, 'meta.json')]));
        for (const file of files) {
            const contents = fs.readFileSync(file).toString('latin1');
            expect(contents, file).not.toContain(READ_TOKEN_SENTINEL);
            expect(contents, file).not.toContain(CONFIG.apiKey);
        }
    });
});

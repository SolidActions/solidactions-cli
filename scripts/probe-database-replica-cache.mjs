import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SEED_ROWS = 3000;
const SECOND_SEED_ROWS = 500;
const REPLICA_NAME = 'replica.db';

export function assertWarmCheaper(coldBytes, warmBytes) {
    if (!(warmBytes * 4 < coldBytes)) {
        throw new Error(
            `The warm sync downloaded ${warmBytes} bytes, which is not under a quarter of the cold sync's ${coldBytes} bytes.`,
        );
    }
}

export function describeCompanions(names) {
    return names
        .filter((name) => name.startsWith(REPLICA_NAME) && name !== REPLICA_NAME)
        .sort();
}

export function digestRows(rows) {
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export function classifyOutcome(error, matched) {
    if (error !== undefined && error !== null) {
        const message = error instanceof Error ? error.message : String(error);
        return `throws: ${message.slice(0, 80)}`;
    }
    return matched ? 'succeeds-correct' : 'succeeds-WRONG';
}

function log(line) {
    process.stdout.write(`${line}\n`);
}

function fileUrl(filePath) {
    return pathToFileURL(filePath).href;
}

function paddedValue(id) {
    return `row-${id}-${'x'.repeat(1000)}`;
}

function toPairs(rows) {
    return rows.map((row) => [String(row[0]), String(row[1])]);
}

async function startCountingProxy(remoteUrl) {
    const { hostname, port } = new URL(remoteUrl);
    const sockets = new Set();
    let counted = 0;
    let armedLimit = null;
    let armedCounted = 0;

    const destroyAll = () => {
        for (const socket of sockets) socket.destroy();
    };

    const server = net.createServer((client) => {
        const upstream = net.connect({ host: hostname, port: Number(port) });
        for (const socket of [client, upstream]) {
            sockets.add(socket);
            socket.on('error', () => socket.destroy());
            socket.on('close', () => sockets.delete(socket));
        }
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
        client.on('data', (chunk) => upstream.write(chunk));
        upstream.on('data', (chunk) => {
            counted += chunk.length;
            if (armedLimit !== null) {
                armedCounted += chunk.length;
                if (armedCounted >= armedLimit) {
                    armedLimit = null;
                    destroyAll();
                    return;
                }
            }
            client.write(chunk);
        });
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    return {
        url: `http://127.0.0.1:${server.address().port}`,
        bytes: () => counted,
        resetCounter: () => {
            counted = 0;
        },
        armFailure: (limit) => {
            armedLimit = limit;
            armedCounted = 0;
        },
        disarmFailure: () => {
            armedLimit = null;
        },
        close: async () => {
            destroyAll();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

async function readRemotePairs(client) {
    const result = await client.execute('SELECT id, pad FROM replica_probe ORDER BY id');
    return toPairs(result.rows);
}

async function seedRemote(client, count, padFor) {
    await client.execute('CREATE TABLE IF NOT EXISTS replica_probe (id INTEGER PRIMARY KEY, pad TEXT NOT NULL)');
    const statements = [{ sql: 'DELETE FROM replica_probe', args: [] }];
    for (let id = 1; id <= count; id += 1) {
        statements.push({ sql: 'INSERT INTO replica_probe (id, pad) VALUES (?, ?)', args: [id, padFor(id)] });
    }
    await client.batch(statements, 'write');
}

async function syncReplica({ createClient, replicaPath, syncUrl }) {
    const client = createClient({ url: fileUrl(replicaPath), syncUrl, intMode: 'string' });
    try {
        await client.sync();
    } finally {
        client.close();
    }
}

async function takeSnapshot({ createClient, replicaPath, snapshotPath }) {
    await rm(snapshotPath, { force: true });
    const quotedPath = snapshotPath.replaceAll("'", "''");

    const replica = createClient({ url: fileUrl(replicaPath), intMode: 'string' });
    try {
        await replica.execute(`VACUUM INTO '${quotedPath}'`);
    } finally {
        replica.close();
    }

    const snapshot = createClient({ url: fileUrl(snapshotPath), intMode: 'string' });
    try {
        const check = await snapshot.execute('PRAGMA quick_check');
        if (check.rows.length !== 1 || String(check.rows[0][0]) !== 'ok') {
            throw new Error('The snapshot failed PRAGMA quick_check.');
        }
        const result = await snapshot.execute('SELECT id, pad FROM replica_probe ORDER BY id');
        return toPairs(result.rows);
    } finally {
        snapshot.close();
    }
}

async function assertSnapshotAlone(cacheDirectory, snapshotName) {
    const names = await readdir(cacheDirectory);
    if (!names.includes(snapshotName)) {
        throw new Error(`The snapshot ${snapshotName} is missing from ${cacheDirectory}.`);
    }
    const companions = names.filter((name) => name.startsWith(`${snapshotName}-`));
    if (companions.length > 0) {
        throw new Error(`The snapshot left companion files behind: ${companions.join(', ')}.`);
    }
}

async function assertSnapshotMatches({ createClient, replicaPath, snapshotPath, remoteClient, label }) {
    const snapshotRows = await takeSnapshot({ createClient, replicaPath, snapshotPath });
    await assertSnapshotAlone(path.dirname(snapshotPath), path.basename(snapshotPath));
    if (digestRows(snapshotRows) !== digestRows(await readRemotePairs(remoteClient))) {
        throw new Error(`The ${label} snapshot does not hold the same rows as the server.`);
    }
}

async function warmSyncOutcome({ createClient, replicaPath, syncUrl, snapshotPath, remoteClient }) {
    let failure;
    let matched = false;
    try {
        await syncReplica({ createClient, replicaPath, syncUrl });
        const snapshotRows = await takeSnapshot({ createClient, replicaPath, snapshotPath });
        matched = digestRows(snapshotRows) === digestRows(await readRemotePairs(remoteClient));
    } catch (error) {
        failure = error;
    }
    return classifyOutcome(failure, matched);
}

export async function runReplicaCacheProbe({ createClient, remoteUrl, secondRemoteUrl, directory }) {
    const proxies = [];
    const remoteClients = [];
    const information = {};
    const record = (name, outcome) => {
        information[name] = outcome;
        log(`information: ${name}: ${outcome}`);
    };
    let nextExtraId = 10000;

    try {
        const proxy = await startCountingProxy(remoteUrl);
        proxies.push(proxy);

        const remoteClient = createClient({ url: remoteUrl, intMode: 'string' });
        remoteClients.push(remoteClient);
        await seedRemote(remoteClient, SEED_ROWS, paddedValue);

        const cacheDirectory = path.join(directory, 'cache');
        const dataDirectory = path.join(cacheDirectory, 'data');
        const replicaPath = path.join(dataDirectory, REPLICA_NAME);
        const snapshotPath = path.join(cacheDirectory, 'snapshot.tmp');
        await mkdir(dataDirectory, { recursive: true });

        // Cold: the first sync of an empty replica downloads everything.
        proxy.resetCounter();
        await syncReplica({ createClient, replicaPath, syncUrl: proxy.url });
        const coldBytes = proxy.bytes();
        proxy.resetCounter();
        const companions = describeCompanions(await readdir(dataDirectory));
        log(`replica companions: ${companions.join(', ') || '(none)'}`);
        log(`cold sync downloaded ${coldBytes} bytes`);

        // Snapshot 1: the CLI's own local open and VACUUM INTO, then compare with the server.
        await assertSnapshotMatches({
            createClient, replicaPath, snapshotPath, remoteClient, label: 'first',
        });

        // Change the server, then warm-sync in the real order (after the local open and VACUUM).
        const changes = [
            { sql: 'INSERT INTO replica_probe (id, pad) VALUES (?, ?)', args: [SEED_ROWS + 1, paddedValue(SEED_ROWS + 1)] },
        ];
        for (let id = 1; id <= 10; id += 1) {
            changes.push({
                sql: 'UPDATE replica_probe SET pad = ? WHERE id = ?',
                args: [`updated-${id}-${'y'.repeat(1000)}`, id],
            });
        }
        changes.push({ sql: 'DELETE FROM replica_probe WHERE id BETWEEN 11 AND 20', args: [] });
        await remoteClient.batch(changes, 'write');

        proxy.resetCounter();
        await syncReplica({ createClient, replicaPath, syncUrl: proxy.url });
        const warmBytes = proxy.bytes();
        proxy.resetCounter();
        log(`warm sync downloaded ${warmBytes} bytes`);
        assertWarmCheaper(coldBytes, warmBytes);

        // Snapshot 2: inserts, updates and deletes must all be visible.
        await assertSnapshotMatches({
            createClient, replicaPath, snapshotPath, remoteClient, label: 'second',
        });

        // Information rows: printed, never asserted. Each starts from a fresh copy of the step-5 replica.
        const freshCopy = async (name) => {
            const copyCache = path.join(directory, name);
            await cp(dataDirectory, path.join(copyCache, 'data'), { recursive: true });
            await remoteClient.execute({
                sql: 'INSERT INTO replica_probe (id, pad) VALUES (?, ?)',
                args: [nextExtraId, paddedValue(nextExtraId)],
            });
            nextExtraId += 1;
            return {
                replicaPath: path.join(copyCache, 'data', REPLICA_NAME),
                snapshotPath: path.join(copyCache, 'snapshot.tmp'),
            };
        };
        const warmOutcome = (paths) => warmSyncOutcome({
            createClient,
            replicaPath: paths.replicaPath,
            syncUrl: proxy.url,
            snapshotPath: paths.snapshotPath,
            remoteClient,
        });

        const withoutMetadata = await freshCopy('info-metadata-deleted');
        for (const name of companions) {
            if (name.endsWith('-wal') || name.endsWith('-shm')) continue;
            await rm(path.join(path.dirname(withoutMetadata.replicaPath), name), { force: true });
        }
        record('companion files deleted (not -wal or -shm)', await warmOutcome(withoutMetadata));

        const truncated = await freshCopy('info-truncated');
        const size = (await stat(truncated.replicaPath)).size;
        await truncate(truncated.replicaPath, Math.floor(size / 2));
        record('replica.db truncated to half', await warmOutcome(truncated));

        const zeroed = await freshCopy('info-zeroed');
        await writeFile(zeroed.replicaPath, Buffer.alloc(4096));
        record('replica.db overwritten with 4 KB of zeros', await warmOutcome(zeroed));

        if (secondRemoteUrl) {
            const secondProxy = await startCountingProxy(secondRemoteUrl);
            proxies.push(secondProxy);
            const secondRemoteClient = createClient({ url: secondRemoteUrl, intMode: 'string' });
            remoteClients.push(secondRemoteClient);
            await seedRemote(secondRemoteClient, SECOND_SEED_ROWS, (id) => `second-${id}-${'z'.repeat(1000)}`);

            const swapped = await freshCopy('info-different-server');
            record('different server on the same cache path', await warmSyncOutcome({
                createClient,
                replicaPath: swapped.replicaPath,
                syncUrl: secondProxy.url,
                snapshotPath: swapped.snapshotPath,
                remoteClient: secondRemoteClient,
            }));
        }

        const retryDirectory = path.join(directory, 'retry', 'data');
        const retryReplicaPath = path.join(retryDirectory, REPLICA_NAME);
        await mkdir(retryDirectory, { recursive: true });
        proxy.resetCounter();
        proxy.armFailure(Math.floor(coldBytes / 2));
        let firstAttempt = 'did-not-fail';
        try {
            await syncReplica({ createClient, replicaPath: retryReplicaPath, syncUrl: proxy.url });
        } catch {
            firstAttempt = 'failed';
        }
        proxy.disarmFailure();
        log(`information: half-way failure first attempt: ${firstAttempt}`);

        proxy.resetCounter();
        let retryFailure;
        let retryMatched = false;
        try {
            await syncReplica({ createClient, replicaPath: retryReplicaPath, syncUrl: proxy.url });
        } catch (error) {
            retryFailure = error;
        }
        const retryBytes = proxy.bytes();
        log(
            `retry after a half-way failure downloaded ${retryBytes} of ${coldBytes} bytes `
            + `(restarts from zero: ${retryBytes >= coldBytes * 0.9})`,
        );
        if (retryFailure === undefined) {
            const retryRows = await takeSnapshot({
                createClient,
                replicaPath: retryReplicaPath,
                snapshotPath: path.join(directory, 'retry', 'snapshot.tmp'),
            });
            retryMatched = digestRows(retryRows) === digestRows(await readRemotePairs(remoteClient));
        }
        record('retry after a half-way failure', classifyOutcome(retryFailure, retryMatched));

        return { coldBytes, warmBytes, companions, information };
    } finally {
        for (const client of remoteClients) {
            try {
                client.close();
            } catch {
                // The probe's own result is what matters; a failed close is not.
            }
        }
        for (const proxy of proxies) {
            await proxy.close();
        }
    }
}

async function runDirectProbe() {
    const probeDirectory = await mkdtemp(path.join(tmpdir(), 'solidactions-database-replica-cache-probe-'));
    const remoteUrl = process.env.SOLIDACTIONS_DATABASE_SYNC_URL ?? 'http://127.0.0.1:8080';
    const secondRemoteUrl = process.env.SOLIDACTIONS_DATABASE_SYNC_URL_2 || undefined;

    try {
        const { createClient } = await import('@libsql/client');
        await runReplicaCacheProbe({
            createClient,
            remoteUrl,
            secondRemoteUrl,
            directory: probeDirectory,
        });
        log('Replica cache probe passed.');
    } finally {
        await rm(probeDirectory, { recursive: true, force: true });
    }
}

const invokedPath = process.argv[1]
    ? pathToFileURL(path.resolve(process.argv[1])).href
    : null;

if (invokedPath === import.meta.url) {
    await runDirectProbe();
}

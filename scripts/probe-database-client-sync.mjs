import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_VALUE = 'remote-sync-ready';

export async function runRemoteSyncProbe({ createClient, remoteUrl, localUrl }) {
    let remoteClient;
    let localClient;

    try {
        remoteClient = createClient({ url: remoteUrl, intMode: 'string' });
        await remoteClient.execute(
            'CREATE TABLE IF NOT EXISTS probe_results (id INTEGER PRIMARY KEY, value TEXT NOT NULL)',
        );
        await remoteClient.execute({
            sql: 'INSERT INTO probe_results (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value',
            args: [EXPECTED_VALUE],
        });

        localClient = createClient({
            url: localUrl,
            syncUrl: remoteUrl,
            intMode: 'string',
        });
        await localClient.sync();

        const result = await localClient.execute('SELECT value FROM probe_results WHERE id = 1');
        if (result.rows.length !== 1 || result.rows[0].value !== EXPECTED_VALUE) {
            throw new Error('Remote database sync probe returned an unexpected result.');
        }
    } finally {
        try {
            localClient?.close();
        } finally {
            remoteClient?.close();
        }
    }
}

async function runDirectProbe() {
    const probeDirectory = await mkdtemp(path.join(tmpdir(), 'solidactions-database-sync-probe-'));
    const localUrl = pathToFileURL(path.join(probeDirectory, 'replica.db')).href;
    const remoteUrl = process.env.SOLIDACTIONS_DATABASE_SYNC_URL ?? 'http://127.0.0.1:8080';

    try {
        const { createClient } = await import('@libsql/client');
        await runRemoteSyncProbe({ createClient, remoteUrl, localUrl });
        process.stdout.write('Remote database sync probe passed.\n');
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

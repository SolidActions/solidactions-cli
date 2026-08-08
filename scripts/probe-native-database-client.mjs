import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { removeNativeProbeDirectory } from './remove-native-probe-directory.mjs';

const probeDirectory = await mkdtemp(path.join(tmpdir(), 'solidactions-database-probe-'));
const databaseUrl = pathToFileURL(path.join(probeDirectory, 'probe.db')).href;
let client;

try {
    const { createClient } = await import('@libsql/client');
    client = createClient({ url: databaseUrl });

    await client.execute('CREATE TABLE probe_results (value TEXT NOT NULL)');
    await client.execute({
        sql: 'INSERT INTO probe_results (value) VALUES (?)',
        args: ['embedded-client-ready'],
    });
    const result = await client.execute('SELECT value FROM probe_results');

    if (result.rows.length !== 1 || result.rows[0].value !== 'embedded-client-ready') {
        throw new Error('Embedded database probe returned an unexpected result.');
    }

    process.stdout.write('Embedded database client probe passed.\n');
} finally {
    try {
        client?.close();
    } finally {
        await removeNativeProbeDirectory(probeDirectory);
    }
}

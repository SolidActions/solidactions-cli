import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { removeNativeProbeDirectory } from '../scripts/remove-native-probe-directory.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('native database probe cleanup', () => {
    it('removes a real probe directory and its database file', async () => {
        const probeDirectory = await mkdtemp(path.join(tmpdir(), 'solidactions-cleanup-test-'));
        await writeFile(path.join(probeDirectory, 'probe.db'), 'probe');

        await removeNativeProbeDirectory(probeDirectory);

        await expect(access(probeDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('keeps bounded Windows retries wired into the native probe', async () => {
        const helperSource = await readFile(
            path.join(repositoryRoot, 'scripts/remove-native-probe-directory.mjs'),
            'utf8',
        );
        const probeSource = await readFile(
            path.join(repositoryRoot, 'scripts/probe-native-database-client.mjs'),
            'utf8',
        );

        expect(helperSource).toContain('recursive: true');
        expect(helperSource).toContain('force: true');
        expect(helperSource).toContain('maxRetries: 5');
        expect(helperSource).toContain('retryDelay: 100');
        expect(probeSource).toContain("from './remove-native-probe-directory.mjs'");
        expect(probeSource).toContain('await removeNativeProbeDirectory(probeDirectory)');
    });
});

import { rm } from 'node:fs/promises';

const cleanupOptions = {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
};

export async function removeNativeProbeDirectory(probeDirectory) {
    await rm(probeDirectory, cleanupOptions);
}

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        testTimeout: 10_000,
        // process.umask() throws ERR_WORKER_UNSUPPORTED_OPERATION in worker
        // threads, and the suite calls it to make permission assertions
        // deterministic, so pin the forks pool rather than assume it.
        pool: 'forks',
    },
});

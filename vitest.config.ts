import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        testTimeout: 10_000,
        // process.umask() throws ERR_WORKER_UNSUPPORTED_OPERATION in worker
        // threads, and the suite calls it to make permission assertions
        // deterministic, so pin the forks pool rather than assume it.
        pool: 'forks',
        projects: [
            {
                extends: true,
                test: {
                    name: 'unit',
                    include: ['tests/**/*.test.ts'],
                    exclude: ['tests/live/**', '**/node_modules/**'],
                },
            },
            {
                // The live suites each create a crew on the dev stack, and the free
                // plan caps crews at 3 — so they must not run concurrently.
                extends: true,
                test: {
                    name: 'live',
                    include: ['tests/live/**/*.test.ts'],
                    fileParallelism: false,
                },
            },
        ],
    },
});

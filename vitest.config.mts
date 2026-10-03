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
                    // Live calls can hit the server's 60/min throttle; the transport then waits out
                    // Retry-After (<=60s, up to 2 waits), so budget well past the unit default.
                    testTimeout: 240_000,
                    hookTimeout: 240_000,
                },
            },
        ],
    },
});

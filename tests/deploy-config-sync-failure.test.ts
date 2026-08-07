/**
 * PM round #1127 finding 14: `deploy.ts`'s two `pushYamlDeclarations` call
 * sites (--config-only at ~589, and the post-build sync at ~732) used to
 * swallow a failed sync and still report success — the --config-only path
 * printed "Config synced" unconditionally, and the full-deploy path only
 * logged a yellow warning and still exited 0. A failed empty-list prune (or
 * any declaration sync failure) must fail loudly: an explicit
 * "Config sync FAILED: <reason>" line on stderr, and a nonzero exit code —
 * matching how every other deploy failure in this file exits (see the build
 * failure / timeout branches, and the catch blocks in deploy()).
 *
 * Test-double policy: a real in-process HTTP server (Node's http.createServer)
 * — no mock/spy/stub libraries — matching deploy-live-wiring.test.ts and
 * deploy-yaml-sync.test.ts.
 */
import * as http from 'http';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deploy } from '../src/commands/deploy';

/**
 * Real `process.exit()` halts synchronous execution immediately — code after
 * the call never runs. A mock that only records the call and resolves a
 * promise does NOT reproduce that: execution keeps going, so a later,
 * unrelated `process.exit(0)` can clobber the exit code we're asserting on.
 * Throwing (matching deploy-plan-limit.test.ts's ProcessExitError) is what
 * actually stops the call stack, the way the real exit does.
 */
class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function makeSourceDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-deploy-sync-failure-'));
    fs.writeFileSync(
        path.join(dir, 'solidactions.yaml'),
        'workflows:\n  - name: noop\n    command: "true"\n',
    );
    fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'fixture', dependencies: { '@solidactions/sdk': '^0.7.3' } }),
    );
    git(dir, 'init', '-b', 'main');
    git(dir, 'config', 'user.name', 'Deploy Sync Failure Test');
    git(dir, 'config', 'user.email', 'deploy-sync-failure@example.test');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'Initial commit');
    return dir;
}

const PROJECT_NAME = 'sync-fail-project';

let server: http.Server;
let port: number;
let syncYamlRequestCount = 0;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const url = req.url ?? '';

            if (req.method === 'POST' && url.includes('/variable-mappings/sync-yaml')) {
                syncYamlRequestCount++;
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Sync target unreachable.' }));
                return;
            }
            if (req.method === 'POST' && url.endsWith('/deploy')) {
                res.writeHead(202, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ deployment_id: 'dep-1' }));
                return;
            }
            if (req.method === 'GET' && url.includes('include=deployment')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    slug: PROJECT_NAME,
                    status: 'deployed',
                    deployment_matches_deployed_hash: true,
                    latest_successful_deployment: {
                        id: 'dep-1',
                        status: 'succeeded',
                        source_hash: 'archive-hash',
                        metadata_source: 'git',
                        commit_sha: 'a'.repeat(40),
                        short_sha: 'a'.repeat(12),
                        branch: 'main',
                        tag: null,
                        commit_subject: 'Initial commit',
                        commit_author_date: '2026-07-27T10:00:00-05:00',
                        remote_url: null,
                        dirty: false,
                        completed_at: '2026-07-27T15:00:00Z',
                    },
                }));
                return;
            }
            if (req.method === 'GET' && /^\/api\/v1\/projects\/[^/?]+$/.test(url)) {
                // Shared by the pre-deploy existence check and every poll tick.
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ slug: PROJECT_NAME, status: 'deployed' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({}));
        });
    });
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
}));

let originalExit: typeof process.exit;
let sourceDirs: string[] = [];

beforeEach(() => {
    syncYamlRequestCount = 0;
    sourceDirs = [];
    process.env.SOLIDACTIONS_HOST = `http://127.0.0.1:${port}`;
    process.env.SOLIDACTIONS_API_KEY = 'test-key';
    process.env.SOLIDACTIONS_WORKSPACE_ID = 'workspace-1';
    originalExit = process.exit;
});

afterEach(() => {
    process.exit = originalExit;
    delete process.env.SOLIDACTIONS_HOST;
    delete process.env.SOLIDACTIONS_API_KEY;
    delete process.env.SOLIDACTIONS_WORKSPACE_ID;
    for (const dir of sourceDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('deploy() --config-only: a failed YAML sync fails loudly (PM round #1127 finding 14)', () => {
    it('exits nonzero and prints "Config sync FAILED" instead of "Config synced"', async () => {
        const dir = makeSourceDir();
        sourceDirs.push(dir);

        const logs: string[] = [];
        const errors: string[] = [];
        const originalLog = console.log;
        const originalError = console.error;
        console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
        console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };

        let exitCode: number | undefined;
        try {
            await new Promise<void>((resolve) => {
                (process as any).exit = (code?: number) => {
                    exitCode = code;
                    resolve();
                    throw new ProcessExitError(code);
                };
                // configOnly runs entirely within deploy()'s own async body (no
                // detached event handler), so the mocked exit's throw surfaces
                // as a rejection of deploy() itself — swallow it, we already
                // captured the exit code above.
                deploy(PROJECT_NAME, dir, { env: 'production', configOnly: true }).catch(() => {});
            });
        } finally {
            console.log = originalLog;
            console.error = originalError;
        }

        expect(syncYamlRequestCount).toBe(1);
        expect(exitCode).toBe(1);
        expect(errors.join('\n')).toContain('Config sync FAILED');
        expect(logs.join('\n')).not.toContain('Config synced');
    }, 10_000);
});

describe('deploy() full run: a failed post-build YAML sync fails loudly (PM round #1127 finding 14)', () => {
    it('exits nonzero even though the build itself succeeded', async () => {
        const dir = makeSourceDir();
        sourceDirs.push(dir);

        const logs: string[] = [];
        const errors: string[] = [];
        const originalLog = console.log;
        const originalError = console.error;
        console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
        console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };

        let exitCode: number | undefined;
        try {
            await new Promise<void>((resolve) => {
                (process as any).exit = (code?: number) => {
                    exitCode = code;
                    resolve();
                    // The post-build sync failure is handled inside the polling
                    // interval's own try/catch (which otherwise treats thrown
                    // errors as "ignore transient errors"). Throwing here still
                    // halts this callback's remaining synchronous code (in
                    // particular, the later success-path process.exit(0)) the
                    // way a real process.exit() would; the outer try/catch
                    // swallows the throw harmlessly since we already resolved.
                    throw new ProcessExitError(code);
                };
                void deploy(PROJECT_NAME, dir, { env: 'production' });
            });
        } finally {
            console.log = originalLog;
            console.error = originalError;
        }

        expect(syncYamlRequestCount).toBe(1);
        // The build itself succeeded...
        expect(logs.join('\n')).toContain('Deployed to');
        // ...but the whole command must still report failure, not exit 0.
        expect(exitCode).toBe(1);
        expect(errors.join('\n')).toContain('Config sync FAILED');
    }, 10_000);
});

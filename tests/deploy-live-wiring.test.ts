/**
 * Pins the real deploy() wiring — the existing suite (see
 * deploy-plan-limit.test.ts's header) deliberately tests only deploy()'s
 * extracted pure helpers, not deploy() itself, so nothing previously failed
 * if a call site quietly reverted to the unguarded primitive it wraps. This
 * drives the real deploy() function end-to-end against an in-process HTTP
 * server and inspects both the raw live upload request and the printed
 * confirmation output. Covers two call sites (round 3 review):
 *   - deploy.ts ~593: must go through safeCollectSourceMetadata(), not a
 *     direct collectSourceMetadata() call — pinned below by the opt-out
 *     test, which fails if the guard is bypassed (a direct call ignores
 *     `gitMetadata: false` and always attaches source_metadata).
 *   - deploy.ts ~707: must go through confirmDeploymentWithRetry(), not a
 *     single direct fetchDeploymentConfirmation() call — pinned below by
 *     forcing one transient mismatch from the mock server and asserting the
 *     deploy still ends up printing the confirmed message (a single fetch
 *     would only ever see the first, mismatched response).
 */
import * as http from 'http';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deploy } from '../src/commands/deploy';

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function makeSourceDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-deploy-wiring-'));
    fs.writeFileSync(
        path.join(dir, 'solidactions.yaml'),
        'workflows:\n  - name: noop\n    command: "true"\n',
    );
    fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'fixture', dependencies: { '@solidactions/sdk': '^0.7.3' } }),
    );
    git(dir, 'init', '-b', 'main');
    git(dir, 'config', 'user.name', 'Deploy Wiring Test');
    git(dir, 'config', 'user.email', 'deploy-wiring@example.test');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'Initial commit');
    return dir;
}

const PROJECT_NAME = 'wiring-project';

let server: http.Server;
let port: number;
let deployRequests: Array<{ body: string }> = [];
let confirmationCallCount = 0;
let mismatchesBeforeMatch = 0;
let projectStatus = 'deployed';
let acceptedSchedulesPaused: boolean | undefined = true;

function confirmationBody(): unknown {
    return {
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
    };
}

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            const url = req.url ?? '';

            if (req.method === 'POST' && url.endsWith('/deploy')) {
                deployRequests.push({ body });
                res.writeHead(202, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    deployment_id: 'dep-1',
                    ...(acceptedSchedulesPaused === undefined
                        ? {}
                        : { schedules_paused: acceptedSchedulesPaused }),
                }));
                return;
            }
            if (req.method === 'GET' && url.includes('include=deployment')) {
                confirmationCallCount++;
                const body = confirmationCallCount <= mismatchesBeforeMatch
                    ? { ...confirmationBody() as object, deployment_matches_deployed_hash: false }
                    : confirmationBody();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(body));
                return;
            }
            if (req.method === 'GET' && /^\/api\/v1\/projects\/[^/?]+$/.test(url)) {
                // Shared by the pre-deploy existence check and every poll tick —
                // only the poll reads `status`; the existence check reads `slug`.
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ slug: PROJECT_NAME, status: projectStatus }));
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
    deployRequests = [];
    sourceDirs = [];
    confirmationCallCount = 0;
    mismatchesBeforeMatch = 0;
    projectStatus = 'deployed';
    acceptedSchedulesPaused = true;
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

/**
 * deploy()'s own returned promise resolves once archive.finalize() settles —
 * well before the upload/poll/confirm chain runs inside the archive write
 * stream's 'close' event handler (fire-and-forget past that point, per
 * deploy-plan-limit.test.ts's header comment). So completion must be
 * observed via the eventual process.exit() call, not via awaiting deploy().
 */
async function runDeploy(options: { gitMetadata?: boolean; paused?: boolean } = {}): Promise<void> {
    const dir = makeSourceDir();
    sourceDirs.push(dir);

    await new Promise<void>((resolve) => {
        (process as any).exit = (_code?: number) => { resolve(); };
        void deploy(PROJECT_NAME, dir, { env: 'production', ...options });
    });
}

describe('deploy() live wiring — source provenance', () => {
    it('sends real source_metadata, built from the real collector, in the live deploy POST', async () => {
        await runDeploy();

        expect(deployRequests).toHaveLength(1);
        const body = deployRequests[0].body;
        expect(body).toContain('name="source_metadata"');
        expect(body).toContain('"metadata_source":"git"');
        expect(body).toContain(git(sourceDirs[0], 'rev-parse', 'HEAD'));
    }, 10_000);

    it('honors the real shouldCollectGitMetadata() opt-out in the live deploy POST', async () => {
        await runDeploy({ gitMetadata: false });

        expect(deployRequests).toHaveLength(1);
        expect(deployRequests[0].body).not.toContain('name="source_metadata"');
    }, 10_000);
});

describe('deploy() live wiring — paused schedules', () => {
    it('sends the exact multipart paused=1 field and reports the pause only after deployed', async () => {
        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
        try {
            await runDeploy({ paused: true });
        } finally {
            console.log = originalLog;
        }

        expect(deployRequests).toHaveLength(1);
        expect(deployRequests[0].body).toMatch(/name="paused"\r\n\r\n1\r\n/);
        expect(logs.join('\n')).toContain('Schedules deployed paused');
        expect(logs.join('\n')).toContain('solidactions schedule enable');
        expect(logs.findIndex((line) => line.includes('Schedules deployed paused')))
            .toBeGreaterThan(logs.findIndex((line) => line.includes('Deployed to')));
    }, 10_000);

    it('warns instead of claiming schedules are paused when the server does not acknowledge the flag', async () => {
        acceptedSchedulesPaused = undefined;
        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
        try {
            await runDeploy({ paused: true });
        } finally {
            console.log = originalLog;
        }

        const output = logs.join('\n');
        expect(output).not.toContain('Schedules deployed paused');
        expect(output).toContain('server did not acknowledge paused schedules');
        expect(output).toContain('verify schedules');
    }, 10_000);

    it('omits paused from ordinary deploys', async () => {
        await runDeploy();

        expect(deployRequests).toHaveLength(1);
        expect(deployRequests[0].body).not.toContain('name="paused"');
    }, 10_000);

    it('never prints paused success copy when the build fails', async () => {
        projectStatus = 'error';
        const logs: string[] = [];
        const errors: string[] = [];
        const originalLog = console.log;
        const originalError = console.error;
        console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
        console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
        try {
            await runDeploy({ paused: true });
        } finally {
            console.log = originalLog;
            console.error = originalError;
        }

        expect(errors.join('\n')).toContain('Build Failed');
        expect(logs.join('\n')).not.toContain('Schedules deployed paused');
    }, 10_000);
});

describe('deploy() live wiring — confirmation retry', () => {
    it('retries the live confirmation fetch through a transient mismatch and still prints confirmed (app #972 lag)', async () => {
        mismatchesBeforeMatch = 1; // first confirmation GET mismatches; second (real retry) matches

        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
        try {
            await runDeploy();
        } finally {
            console.log = originalLog;
        }

        // A single direct fetch (no retry) would only ever see the first,
        // mismatched response and never reach the confirmed message.
        expect(confirmationCallCount).toBeGreaterThanOrEqual(2);
        expect(logs.join('\n')).toContain('Deployment revision confirmed.');
    }, 10_000);
});

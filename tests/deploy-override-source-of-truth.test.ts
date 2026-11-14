/** Local app server seam accepted in app docs/decisions.md:1174 (chief mail fa9f7607). */
import * as http from 'http';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const slug = 'sot-project';
const REFUSAL = "This app's source of truth is git (https://example.test/acme/sot-project.git). Deploy from the repo, or re-run with --override-source-of-truth to deploy from the sandbox anyway; the app will show as drifted until you mark it reconciled or flip its source of truth to SolidActions.";
const DRIFT_LINE = "Warning: this app is drifted: deployed outside git since 2026-11-13T09:30:00Z. Mark it reconciled in the app's settings, or flip its source of truth to SolidActions.";
const DRIFT = { code: 'drift', since: '2026-11-13T09:30:00Z', deployment_id: null };

type Seen = { method: string; url: string; body: string };
let server: http.Server;
let port: number;
let seen: Seen[] = [];
let refuse: string[] = [];
let deployExtra: Record<string, unknown> = {};

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const url = req.url ?? '';
            const method = req.method ?? '';
            seen.push({ method, url, body: Buffer.concat(chunks).toString('latin1') });
            res.setHeader('Content-Type', 'application/json');
            if (method !== 'GET' && refuse.some((suffix) => url.endsWith(suffix))) {
                res.writeHead(409);
                res.end(JSON.stringify({ code: 'source_of_truth_git', message: REFUSAL, remote_url: 'https://example.test/acme/sot-project.git' }));
            } else if (method === 'POST' && url.endsWith('/deploy')) {
                res.end(JSON.stringify({ stored: true, source_hash: 'a'.repeat(32), deployment_id: 'dep-1', ...deployExtra }));
            } else if (method === 'GET' && url.includes('include=deployment')) {
                res.end(JSON.stringify({ slug, status: 'deployed', deployment_matches_deployed_hash: true, latest_successful_deployment: { id: 'dep-1', status: 'succeeded' } }));
            } else if (method === 'GET') {
                res.end(JSON.stringify({ slug, status: 'deployed' }));
            } else {
                res.end(JSON.stringify({}));
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve(); }));
});
afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

function fixture(kind: 'pages' | 'workflows'): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-sot-deploy-'));
    fs.mkdirSync(path.join(root, 'pages'));
    fs.writeFileSync(path.join(root, 'pages/home.html'), '<h1>home</h1>');
    fs.writeFileSync(path.join(root, 'solidactions.yaml'), kind === 'pages'
        ? 'pages:\n  - id: home\n    name: Home\n    file: pages/home.html\n'
        : 'workflows:\n  - name: noop\n    command: "true"\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { '@solidactions/sdk': '^0.7.3' } }));
    return root;
}

async function run(kind: 'pages' | 'workflows', flags: string[], state: { refuse?: string[]; deployExtra?: Record<string, unknown> } = {}) {
    seen = [];
    refuse = state.refuse ?? [];
    deployExtra = state.deployExtra ?? {};
    const root = fixture(kind);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-sot-home-'));
    try {
        const child = spawn(process.execPath, [path.resolve('dist/index.js'), 'project', 'deploy', slug, root, '-e', 'production', '--no-git-metadata', ...flags], {
            env: { ...process.env, HOME: home, SOLIDACTIONS_HOST: `http://127.0.0.1:${port}`, SOLIDACTIONS_API_KEY: 'test-key', SOLIDACTIONS_WORKSPACE_ID: 'ws-1', FORCE_COLOR: '0', NO_COLOR: '1' },
        });
        let stdout = ''; let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
        const exit = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
        return { stdout, stderr, exit, requests: [...seen] };
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
    }
}

const JSON_WRITES = [['PUT', '/functions/sync'], ['POST', '/variable-mappings/sync-yaml'], ['PUT', '/pages/sync'], ['PUT', '/app/sync']] as const;
const calls = (requests: Seen[], method: string, suffix: string) => requests.filter((r) => r.method === method && r.url.endsWith(suffix));
const formField = (body: string) => body.match(/name="override_source_of_truth"\r\n\r\n([^\r]*)\r\n/)?.[1] ?? null;
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe('project deploy --override-source-of-truth', () => {
    it('sends override_source_of_truth=1 on the archive form and on all four sync calls when the flag is set', async () => {
        const result = await run('pages', ['--override-source-of-truth']);

        expect(result.exit).toBe(0);
        for (const [method, suffix] of JSON_WRITES) {
            const sent = calls(result.requests, method, suffix);
            expect(sent, suffix).toHaveLength(1);
            expect(JSON.parse(sent[0].body).override_source_of_truth, suffix).toBe(1);
        }
        const deploys = calls(result.requests, 'POST', '/deploy');
        expect(deploys).toHaveLength(1);
        expect(formField(deploys[0].body)).toBe('1');
    }, 30_000);

    it('never sends the field on any of the five calls when the flag is not set', async () => {
        const result = await run('pages', []);

        expect(result.exit).toBe(0);
        for (const [method, suffix] of JSON_WRITES) {
            const sent = calls(result.requests, method, suffix);
            expect(sent, suffix).toHaveLength(1);
            expect(JSON.parse(sent[0].body), suffix).not.toHaveProperty('override_source_of_truth');
        }
        const deploys = calls(result.requests, 'POST', '/deploy');
        expect(deploys).toHaveLength(1);
        expect(deploys[0].body).not.toContain('override_source_of_truth');
    }, 30_000);

    it.each([[true], [false]])('config-only sends the field on sync-yaml only when the flag is set (flag set: %s)', async (flagSet) => {
        const result = await run('pages', flagSet ? ['--config-only', '--override-source-of-truth'] : ['--config-only']);

        expect(result.exit).toBe(0);
        const writes = result.requests.filter((r) => r.method !== 'GET');
        expect(writes.map((r) => `${r.method} ${r.url}`)).toEqual([`POST /api/v1/projects/${slug}/variable-mappings/sync-yaml`]);
        const body = JSON.parse(writes[0].body);
        if (flagSet) {
            expect(body.override_source_of_truth).toBe(1);
        } else {
            expect(body).not.toHaveProperty('override_source_of_truth');
        }
    }, 30_000);

    it('prints a functions-sync refusal as the server message exactly once, exits 1 and uploads nothing else', async () => {
        const result = await run('pages', [], { refuse: ['/functions/sync'] });

        expect(result.exit).toBe(1);
        expect(result.stderr.trim().split('\n').at(-1)).toBe(REFUSAL);
        expect(occurrences(result.stdout + result.stderr, REFUSAL)).toBe(1);
        expect(result.stdout).not.toContain('Source archived.');
        expect(result.requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.url}`)).toEqual([`PUT /api/v1/projects/${slug}/functions/sync`]);
    }, 30_000);

    it('prints a config-only sync-yaml refusal as the server message exactly once and exits 1', async () => {
        const result = await run('pages', ['--config-only'], { refuse: ['/variable-mappings/sync-yaml'] });

        expect(result.exit).toBe(1);
        expect(result.stderr.trim().split('\n').at(-1)).toBe(REFUSAL);
        expect(occurrences(result.stdout + result.stderr, REFUSAL)).toBe(1);
        expect(result.stdout).not.toContain('Config synced');
    }, 30_000);

    it('prints an archive refusal as the server message exactly once, exits 1 and runs no later sync', async () => {
        const result = await run('pages', [], { refuse: ['/deploy'] });

        expect(result.exit).toBe(1);
        expect(result.stderr).toContain('Deployment failed:');
        expect(occurrences(result.stdout + result.stderr, REFUSAL)).toBe(1);
        expect(result.stderr).not.toContain('Failed: 409');
        expect(result.stdout).not.toContain('Source archived.');
        expect(result.requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.url}`)).toEqual([
            `PUT /api/v1/projects/${slug}/functions/sync`,
            `POST /api/v1/projects/${slug}/deploy`,
        ]);
    }, 30_000);
});

describe('project deploy drift warning', () => {
    it('prints the drift warning once on a store-only deploy response', async () => {
        const result = await run('pages', [], { deployExtra: { warnings: [DRIFT] } });

        expect(result.exit).toBe(0);
        expect(result.stdout).toContain('Source archived.');
        expect(occurrences(result.stdout, DRIFT_LINE)).toBe(1);
    }, 30_000);

    it('prints the drift warning once on a full workflow deploy response', async () => {
        const result = await run('workflows', [], { deployExtra: { warnings: [DRIFT] } });

        expect(result.exit).toBe(0);
        expect(result.stdout).toContain('Deployment successfully queued!');
        expect(occurrences(result.stdout, DRIFT_LINE)).toBe(1);
    }, 30_000);

    it.each([['pages'], ['workflows']] as const)('prints nothing about drift when the response has no warnings key (%s)', async (kind) => {
        const result = await run(kind, []);

        expect(result.exit).toBe(0);
        expect(result.stdout + result.stderr).not.toMatch(/drift/i);
    }, 30_000);

    it('ignores warnings that are not drift and entries that are not objects', async () => {
        const result = await run('pages', [], { deployExtra: { warnings: [{ code: 'other', since: '2026-11-13T09:30:00Z' }, 'drift', null, 7] } });

        expect(result.exit).toBe(0);
        expect(result.stdout + result.stderr).not.toMatch(/drift/i);
    }, 30_000);

    it('prints one line per drift entry', async () => {
        const result = await run('pages', [], { deployExtra: { warnings: [DRIFT, { code: 'drift', since: '2026-11-12T08:00:00Z', deployment_id: 'dep-0' }] } });

        expect(occurrences(result.stdout, 'Warning: this app is drifted: deployed outside git since ')).toBe(2);
        expect(result.stdout).toContain('since 2026-11-12T08:00:00Z.');
    }, 30_000);
});

describe('project deploy --help', () => {
    it('lists the override flag and names no supplier', () => {
        const help = execFileSync(process.execPath, [path.resolve('dist/index.js'), 'project', 'deploy', '--help'], { encoding: 'utf8' });

        expect(help).toContain('--override-source-of-truth');
        expect(help).not.toMatch(/daytona|blaxel|composio|\br2\b/i);
    });
});

/** Local app server seam accepted in app docs/decisions.md, 2026-11-08 (mail fa9f7607). */
import * as http from 'http';
import { spawn, execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const project = 'archive-project';
let server: http.Server;
let port: number;
let requests: { method: string; url: string; body: Buffer; contentType: string }[] = [];
let sourceDir = '';
let failDeploy = false;
let rewritePage = false;
let pageRewritten = false;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const url = req.url ?? '';
        if (req.method === 'POST' && url.endsWith('/deploy') && rewritePage) {
            fs.writeFileSync(path.join(sourceDir, 'pages/home.html'), 'changed after archive');
            pageRewritten = true;
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            requests.push({ method: req.method ?? '', url, body: Buffer.concat(chunks), contentType: req.headers['content-type'] ?? '' });
            res.setHeader('Content-Type', 'application/json');
            if (req.method === 'POST' && url.endsWith('/deploy')) {
                res.statusCode = failDeploy ? 500 : 200;
                res.end(JSON.stringify(failDeploy ? { message: 'archive refused' } : { stored: true, source_hash: 'a'.repeat(32), deployment_id: 'dep-1' }));
            } else if (req.method === 'GET' && url.includes('include=deployment')) {
                res.end(JSON.stringify({ slug: project, status: 'deployed', deployment_matches_deployed_hash: true, latest_successful_deployment: { id: 'dep-1', status: 'succeeded' } }));
            } else if (req.method === 'GET') {
                res.end(JSON.stringify({ slug: project, status: 'deployed' }));
            } else {
                res.end(JSON.stringify({}));
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port;
        resolve();
    }));
});

afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

function fixture(kind: 'pages' | 'functions' | 'workflows'): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-archive-every-'));
    fs.mkdirSync(path.join(root, 'pages'));
    fs.mkdirSync(path.join(root, 'functions'));
    fs.mkdirSync(path.join(root, 'lib'));
    fs.mkdirSync(path.join(root, '.solidactions'));
    fs.mkdirSync(path.join(root, 'sub/.solidactions'), { recursive: true });
    fs.writeFileSync(path.join(root, '.solidactions/config.json'), 'private config');
    fs.writeFileSync(path.join(root, '.solidactions/base.json'), 'private base');
    fs.writeFileSync(path.join(root, 'sub/.solidactions/base.json'), 'nested base');
    fs.writeFileSync(path.join(root, '.env.local'), 'private env');
    fs.writeFileSync(path.join(root, '.solidactions-skill.json'), 'shipped');
    fs.writeFileSync(path.join(root, 'pages/home.html'), '<h1>original</h1>');
    fs.writeFileSync(path.join(root, 'functions/hello.ts'), 'export default {}');
    fs.writeFileSync(path.join(root, 'lib/x.ts'), 'export const x = 1;');
    const yaml = kind === 'pages' ? 'pages:\n  - id: home\n    name: Home\n    file: pages/home.html\n' : kind === 'functions' ? 'functions:\n  - id: hello\n    name: Hello\n    file: functions/hello.ts\n' : 'workflows:\n  - name: noop\n    command: "true"\n';
    fs.writeFileSync(path.join(root, 'solidactions.yaml'), yaml);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { '@solidactions/sdk': '^0.7.3' } }));
    return root;
}

async function run(kind: 'pages' | 'functions' | 'workflows', options: { fail?: boolean; rewrite?: boolean } = {}) {
    sourceDir = fixture(kind);
    requests = [];
    failDeploy = options.fail ?? false;
    rewritePage = options.rewrite ?? false;
    pageRewritten = false;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-archive-home-'));
    const hashFile = path.join(home, 'hash');
    const modulePath = path.resolve('dist/commands/deploy.js');
    const script = `const fs = require('fs'); const command = require(process.argv[1]); process.on('exit', () => fs.writeFileSync(process.argv[3], String(command.archiveMd5))); command.deploy('archive-project', process.argv[2], { env: 'production', gitMetadata: false });`;
    try {
        const child = spawn(process.execPath, ['-e', script, modulePath, sourceDir, hashFile], {
            env: { ...process.env, HOME: home, SOLIDACTIONS_HOST: `http://127.0.0.1:${port}`, SOLIDACTIONS_API_KEY: 'test-key', SOLIDACTIONS_WORKSPACE_ID: 'workspace-1', FORCE_COLOR: '0' },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
        const exit = await new Promise<number | null>((resolve, reject) => {
            child.on('error', reject);
            child.on('close', resolve);
        });
        expect(fs.existsSync(hashFile)).toBe(true);
        return { stdout, stderr, exit, hash: fs.readFileSync(hashFile, 'utf8'), pageRewritten, requests: [...requests] };
    } finally {
        fs.rmSync(sourceDir, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
    }
}

function archiveBytes(request: { body: Buffer; contentType: string }): Buffer {
    const boundary = request.contentType.match(/boundary=(.+)$/)?.[1];
    expect(boundary).toBeTruthy();
    const start = request.body.indexOf(Buffer.from('name="source"'));
    expect(start).toBeGreaterThanOrEqual(0);
    const headerEnd = request.body.indexOf(Buffer.from('\r\n\r\n'), start);
    expect(headerEnd).toBeGreaterThan(start);
    const contentStart = headerEnd + 4;
    const end = request.body.indexOf(Buffer.from(`\r\n--${boundary}`), contentStart);
    expect(end).toBeGreaterThan(contentStart);
    return request.body.subarray(contentStart, end);
}

function unpack(bytes: Buffer): { names: string[]; page: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-archive-unpack-'));
    try {
        const archive = path.join(root, 'source.tar.gz');
        fs.writeFileSync(archive, bytes);
        const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
        const page = execFileSync('tar', ['-xOzf', archive, 'tenantcode/pages/home.html'], { encoding: 'utf8' });
        return { names, page };
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

describe('deploy archives every app', () => {
    it.each(['pages', 'functions'] as const)('archives %s-only projects before pages sync without polling', async (kind) => {
        const result = await run(kind);
        const posts = result.requests.filter(r => r.method === 'POST' && r.url.endsWith('/deploy'));
        expect(result.exit).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('Source archived.');
        expect(result.stdout).not.toContain('Waiting for build');
        expect(posts).toHaveLength(1);
        expect(posts[0].body.toString('latin1').match(/name="build"\r\n\r\n0\r\n/g)).toHaveLength(1);
        expect(result.requests.filter(r => r.method === 'GET' && r.url === `/api/v1/projects/${project}`)).toHaveLength(1);
        expect(result.requests.findIndex(r => r.method === 'PUT' && r.url.endsWith('/pages/sync'))).toBeGreaterThan(result.requests.indexOf(posts[0]));
    }, 20_000);

    it('omits build and polls for a workflow deploy', async () => {
        const result = await run('workflows');
        const posts = result.requests.filter(r => r.method === 'POST' && r.url.endsWith('/deploy'));
        expect(result.exit).toBe(0);
        expect(result.stderr).toBe('');
        expect(posts).toHaveLength(1);
        expect(posts[0].body.toString('latin1')).not.toContain('name="build"');
        expect(result.stdout).toContain('Waiting for build');
        expect(result.requests.filter(r => r.method === 'GET' && r.url === `/api/v1/projects/${project}`).length).toBeGreaterThan(1);
    }, 20_000);

    it('reports a failed archive POST and exits 1', async () => {
        const result = await run('pages', { fail: true });
        expect(result.requests.filter(r => r.method === 'POST' && r.url.endsWith('/deploy'))).toHaveLength(1);
        expect(result.exit).toBe(1);
        expect(result.stderr).toContain('Deployment failed:');
        expect(result.stdout).not.toContain('Source archived.');
    }, 20_000);

    it.skipIf(process.platform === 'win32')('uploads the finalized immutable archive and its md5 even when source changes at POST headers (requires Unix tar)', async () => {
        const result = await run('pages', { rewrite: true });
        const post = result.requests.find(r => r.method === 'POST' && r.url.endsWith('/deploy'));
        expect(result.exit).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('Source archived.');
        expect(post).toBeDefined();
        expect(result.pageRewritten).toBe(true);
        const bytes = archiveBytes(post!);
        const unpacked = unpack(bytes);
        expect(unpacked.names).toEqual(expect.arrayContaining(['tenantcode/solidactions.yaml', 'tenantcode/pages/home.html', 'tenantcode/lib/x.ts']));
        expect(unpacked.names).toContain('tenantcode/.solidactions-skill.json');
        expect(unpacked.names).not.toContain('tenantcode/.solidactions/config.json');
        expect(unpacked.names).not.toContain('tenantcode/.solidactions/base.json');
        expect(unpacked.names).not.toContain('tenantcode/sub/.solidactions/base.json');
        expect(unpacked.names).not.toContain('tenantcode/.env.local');
        expect(unpacked.page).toBe('<h1>original</h1>');
        expect(result.hash).toBe(createHash('md5').update(bytes).digest('hex'));
    }, 20_000);
});

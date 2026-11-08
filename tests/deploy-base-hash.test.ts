/** Local app server seam accepted in app docs/decisions.md:1174 (chief mail fa9f7607). */
import * as http from 'http';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const slug = 'base-project';
const oldHash = 'a'.repeat(32);
let server: http.Server;
let port: number;
let posts: Buffer[] = [];
let reply: 'match' | 'different' | 'stale' = 'match';
let uploadedHash = '';

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            res.setHeader('Content-Type', 'application/json');
            if (req.method === 'POST' && req.url?.endsWith('/deploy')) {
                posts.push(body);
                const boundary = (req.headers['content-type'] ?? '').match(/boundary=(.+)$/)?.[1];
                const source = body.indexOf(Buffer.from('name="source"'));
                const start = body.indexOf(Buffer.from('\r\n\r\n'), source) + 4;
                const end = body.indexOf(Buffer.from(`\r\n--${boundary}`), start);
                if (!boundary || source < 0 || start < 4 || end < start) {
                    res.writeHead(400); res.end(JSON.stringify({ message: 'bad multipart source' })); return;
                }
                uploadedHash = createHash('md5').update(body.subarray(start, end)).digest('hex');
                if (reply === 'stale') {
                    res.writeHead(409); res.end(JSON.stringify({ code: 'stale_base', message: 'stale' })); return;
                }
                res.end(JSON.stringify({ stored: true, source_hash: reply === 'match' ? uploadedHash : 'b'.repeat(32) }));
            } else if (req.method === 'GET') {
                res.end(JSON.stringify({ slug, status: 'deployed' }));
            } else {
                res.end(JSON.stringify({}));
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve(); }));
});
afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

function setup(base?: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-base-deploy-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-base-home-'));
    fs.mkdirSync(path.join(root, 'pages'));
    fs.writeFileSync(path.join(root, 'pages/home.html'), '<h1>home</h1>');
    fs.writeFileSync(path.join(root, 'solidactions.yaml'), 'pages:\n  - id: home\n    name: Home\n    file: pages/home.html\n');
    if (base !== undefined) {
        fs.mkdirSync(path.join(root, '.solidactions'));
        fs.writeFileSync(path.join(root, '.solidactions/base.json'), base);
    }
    return { root, home, basePath: path.join(root, '.solidactions/base.json') };
}

async function invoke(root: string, home: string) {
    const script = `require(process.argv[1]).deploy('base-project', process.argv[2], {env:'production', gitMetadata:false});`;
    const child = spawn(process.execPath, ['-e', script, path.resolve('dist/commands/deploy.js'), root], {
        env: { ...process.env, HOME: home, SOLIDACTIONS_HOST: `http://127.0.0.1:${port}`, SOLIDACTIONS_API_KEY: 'test-key', SOLIDACTIONS_WORKSPACE_ID: 'ws-1', FORCE_COLOR: '0' },
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const exit = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    return { stdout, stderr, exit };
}

const base = (source_hash: string | null, project = slug) => JSON.stringify({ source_hash, slug: project, restored_at: '2020-01-01T00:00:00.000Z' });
async function scenario(initial: string | undefined, mode: typeof reply = 'match', times = 1) {
    const dirs = setup(initial); posts = []; reply = mode; uploadedHash = '';
    try {
        const runs = [];
        for (let i = 0; i < times; i++) runs.push(await invoke(dirs.root, dirs.home));
        return { runs, posts: [...posts], hash: uploadedHash, contents: fs.existsSync(dirs.basePath) ? fs.readFileSync(dirs.basePath, 'utf8') : null };
    } finally {
        fs.rmSync(dirs.root, { recursive: true, force: true });
        fs.rmSync(dirs.home, { recursive: true, force: true });
    }
}

function field(body: Buffer): string | null {
    return body.toString('latin1').match(/name="base_source_hash"\r\n\r\n([^\r]+)\r\n/)?.[1] ?? null;
}

describe('deploy sandbox base', () => {
    it.each([[oldHash, oldHash], [null, 'none']] as const)('sends the same-slug base %s as %s and rewrites only to the uploaded hash', async (hash, wire) => {
        const original = base(hash);
        const result = await scenario(original);
        expect(result.runs[0].exit).toBe(0); expect(result.runs[0].stderr).toBe('');
        expect(result.runs[0].stdout).toContain('Source archived.');
        expect(result.posts).toHaveLength(1); expect(field(result.posts[0])).toBe(wire);
        expect(result.hash).toMatch(/^[a-f0-9]{32}$/);
        expect(JSON.parse(result.contents!)).toEqual({ source_hash: result.hash, slug, restored_at: expect.any(String) });
        expect(JSON.parse(result.contents!).restored_at).not.toBe('2020-01-01T00:00:00.000Z');
    }, 20_000);

    it('prints the exact stale-base remedy and exits 1', async () => {
        const original = base(oldHash); const result = await scenario(original, 'stale');
        expect(result.posts).toHaveLength(1); expect(field(result.posts[0])).toBe(oldHash);
        expect(result.runs[0].exit).toBe(1);
        expect(result.runs[0].stderr).toContain(`The dev copy moved since you pulled. Run "solidactions pull ${slug} . --yes" and redo your change.`);
        expect(result.runs[0].stdout).not.toContain('Source archived.'); expect(result.contents).toBe(original);
    }, 20_000);

    it('does not create a base or send a guard on either of two ordinary deploys', async () => {
        const result = await scenario(undefined, 'match', 2);
        expect(result.runs.map(run => run.exit)).toEqual([0, 0]);
        expect(result.runs.every(run => run.stderr === '' && run.stdout.includes('Source archived.'))).toBe(true);
        expect(result.posts).toHaveLength(2); expect(result.posts.map(field)).toEqual([null, null]); expect(result.contents).toBeNull();
    }, 20_000);

    it.each([['other slug', base(oldHash, 'other')], ['malformed JSON', '{bad json'], ['invalid hash', base('not-md5')], ['missing timestamp', JSON.stringify({ slug, source_hash: oldHash })]] as const)('leaves a %s base byte-identical and sends no guard', async (_label, original) => {
        const result = await scenario(original);
        expect(result.runs[0].exit).toBe(0); expect(result.runs[0].stderr).toBe('');
        expect(result.runs[0].stdout).toContain('Source archived.'); expect(result.posts).toHaveLength(1);
        expect(field(result.posts[0])).toBeNull(); expect(result.contents).toBe(original);
    }, 20_000);

    it('warns and preserves the guarded base when the server hash differs', async () => {
        const original = base(oldHash); const result = await scenario(original, 'different');
        expect(result.posts).toHaveLength(1); expect(field(result.posts[0])).toBe(oldHash);
        expect(result.hash).not.toBe('b'.repeat(32)); expect(result.runs[0].exit).toBe(0); expect(result.runs[0].stderr).toBe('');
        expect(result.runs[0].stdout).toContain('The server stored different bytes than this deploy uploaded; base.json was left unchanged.');
        expect(result.contents).toBe(original);
    }, 20_000);
});

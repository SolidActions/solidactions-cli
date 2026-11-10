/** Local app server seam accepted in app docs/decisions.md:1175 (chief mail fa9f7607). */
import * as http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTarArchive } from '../src/utils/tar-archive';

let server: http.Server; let port: number; let archive: Buffer;
let requests: string[] = [];

beforeAll(async () => {
    // An archive shaped like a pre-strip server response: it still carries
    // the server-managed .solidactions/ entries, at two depths.
    const tar = await createTarArchive({ gzip: true });
    archive = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        tar.on('data', (chunk: Buffer) => chunks.push(chunk));
        tar.on('error', reject); tar.on('end', () => resolve(Buffer.concat(chunks)));
        tar.append('hello', { name: 'tenantcode/page.html' });
        tar.append('nested', { name: 'tenantcode/nested/keep.txt' });
        tar.append('{"source_hash":"deadbeef"}', { name: 'tenantcode/.solidactions/base.json' });
        tar.append('{}', { name: 'tenantcode/nested/.solidactions/deep.json' });
        void tar.finalize();
    });
    expect(archive.length).toBeGreaterThan(0);
    server = http.createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        if (req.url?.endsWith('/source')) {
            res.setHeader('Content-Type', 'application/gzip');
            res.end(archive);
        } else {
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ slug: 'resolved-slug' }));
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve(); }));
});
afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

async function runPull() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pull-filter-'));
    const destination = path.join(root, 'destination'); requests = [];
    const script = `require(process.argv[1]).pull('requested', process.argv[2], {yes:true});`;
    try {
        const child = spawn(process.execPath, ['-e', script, path.resolve('dist/commands/pull.js'), destination], {
            env: { ...process.env, HOME: root, SOLIDACTIONS_HOST: `http://127.0.0.1:${port}`, SOLIDACTIONS_API_KEY: 'test-key', SOLIDACTIONS_WORKSPACE_ID: 'ws-1', SOLIDACTIONS_APP_SANDBOX: '0', FORCE_COLOR: '0' },
        });
        let stdout = ''; let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
        const exit = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
        return { stdout, stderr, exit, requests: [...requests], page: fs.existsSync(path.join(destination, 'page.html')) ? fs.readFileSync(path.join(destination, 'page.html'), 'utf8') : null, keep: fs.existsSync(path.join(destination, 'nested/keep.txt')) ? fs.readFileSync(path.join(destination, 'nested/keep.txt'), 'utf8') : null, solidactions: fs.existsSync(path.join(destination, '.solidactions')), deep: fs.existsSync(path.join(destination, 'nested/.solidactions/deep.json')) };
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe('pull solidactions filter', () => {
    it('skips .solidactions entries at any depth while extracting project files', async () => {
        const result = await runPull();
        expect(result.exit).toBe(0); expect(result.stderr).toBe(''); expect(result.stdout).toContain('pulled successfully');
        expect(result.requests).toContain('GET /api/v1/projects/resolved-slug/source');
        expect(result.page).toBe('hello');
        expect(result.keep).toBe('nested');
        expect(result.solidactions).toBe(false);
        expect(result.deep).toBe(false);
    }, 20_000);
});

/**
 * A failed media download keeps the tracking it had (cli#183, cli#190; spec §2).
 *
 * Every case runs the built CLI (`node dist/index.js`) against a real in-process HTTP server with a
 * temp HOME and real files. The media doc's signed-URL download answers 500 when the case says so.
 */
import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');
const MANIFEST_FILE = '.solidactions-docs.json';

const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

interface ServedDoc {
    id: number;
    title: string;
    revision: number;
    media?: Buffer;
    /** The signed-URL download answers 500. */
    downloadFails?: boolean;
    /** The `bulk_read` status for this doc (default `found`). */
    bulkStatus?: string;
}

let server: http.Server;
let port: number;
let served: ServedDoc[] = [];

function mcpResult(data: object, isError = false): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError, content: [{ type: 'text', text: JSON.stringify(data) }] } });
}

const mediaProps = (doc: ServedDoc): Record<string, unknown> => (doc.media === undefined ? {} : { blob_sha: `sha-${doc.id}`, mime: 'image/png', size: 4 });

function answerMcp(args: Record<string, any>): string {
    if (args.action === 'list') {
        return mcpResult({ folders: [], docs: served.map((d) => ({ id: d.id, title: d.title, doc_type: null })) });
    }
    if (args.action === 'bulk_read') {
        const ids: number[] = (args.items ?? []).map((item: { id: number }) => item.id);
        return mcpResult({
            results: ids.map((id, index) => {
                const d = served.find((doc) => doc.id === id)!;
                return d.bulkStatus !== undefined && d.bulkStatus !== 'found'
                    ? { index, status: d.bulkStatus, id }
                    : { index, status: 'found', id, title: d.title, current_revision_id: d.revision, properties: mediaProps(d), body: '' };
            }),
        });
    }
    return mcpResult({ code: 'unexpected', message: `unexpected action ${String(args.action)}` }, true);
}

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const url = req.url ?? '';
            const mediaConfirm = url.match(/^\/api\/v1\/docs\/(\d+)\/media$/);
            if (mediaConfirm) {
                const d = served.find((doc) => doc.id === Number(mediaConfirm[1]));
                if (!d || d.media === undefined) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ code: 'media_not_found', message: 'no media' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ url: `http://127.0.0.1:${port}/blob/${d.id}`, mime: 'image/png', size: 4 }));
                return;
            }
            const blob = url.match(/^\/blob\/(\d+)$/);
            if (blob) {
                const d = served.find((doc) => doc.id === Number(blob[1]));
                if (!d || d.media === undefined || d.downloadFails) {
                    res.writeHead(500);
                    res.end();
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
                res.end(d.media);
                return;
            }
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(answerMcp(body.params.arguments));
        });
    });
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))));

interface CliResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

/** Run the built CLI with a temp HOME pointing at the server; no ambient credential or test hook reaches it. */
function runCli(root: string, args: string[]): Promise<CliResult> {
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    writeGlobal(home, { host: `http://127.0.0.1:${port}`, apiKey: 'test-api-key', workspaceId: 'ws-test-uuid' });
    return new Promise<CliResult>((resolve, reject) => {
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
        for (const key of ['SOLIDACTIONS_HOST', 'SOLIDACTIONS_API_KEY', 'SOLIDACTIONS_WORKSPACE_ID', 'DEBUG', 'NODE_DEBUG', 'FORCE_COLOR', 'SOLIDACTIONS_TEST_HOOKS', 'SOLIDACTIONS_DOC_PULL_TEST_FAULT']) {
            delete env[key];
        }
        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`CLI timed out. stdout: ${stdout} stderr: ${stderr}`));
        }, 30_000);
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

const manifestOf = (out: string): { folder_path: string; docs: Record<string, Record<string, unknown>> } =>
    JSON.parse(fs.readFileSync(path.join(out, MANIFEST_FILE), 'utf8'));

/** The previous pull's state, written by hand: `bytes` at `rel` tracked for doc `id`, with its real hash. */
function seedTracked(out: string, rel: string, entry: { id: number; title: string; revision: number }, bytes: Buffer): Record<string, unknown> {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, rel), bytes);
    const tracked = { id: entry.id, title: entry.title, current_revision_id: entry.revision, media: true, body_sha256: sha256(bytes) };
    fs.writeFileSync(path.join(out, MANIFEST_FILE), `${JSON.stringify({ folder_path: 'docs', docs: { [rel]: tracked } }, null, 2)}\n`);
    return tracked;
}

describe('a failed media download keeps the tracking it had', { timeout: 60_000 }, () => {
    let root: string;
    let out: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-pull-failed-'));
        out = path.join(root, 'out');
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('keeps the previous entry (revision, hash) and the file for the same doc at the same path (cli#183)', async () => {
        served = [{ id: 5, title: 'pic', revision: 50, media: Buffer.from('P1') }];
        const first = await runCli(root, ['doc', 'pull', 'docs', out, '-y']);
        expect(first.code).toBe(0);
        expect(first.stdout).toBe(`pulled 1 doc → ${out}\n  pic.png\n`);
        expect(first.stderr).toBe('');
        const saved = manifestOf(out).docs['pic.png'];
        expect(saved).toMatchObject({ id: 5, current_revision_id: 50, body_sha256: sha256('P1') });
        served = [{ id: 5, title: 'pic', revision: 51, media: Buffer.from('P2'), downloadFails: true }];

        const second = await runCli(root, ['doc', 'pull', 'docs', out, '-y']);

        expect(second.code).toBe(0);
        expect(second.stdout).toBe(`pulled 0 docs → ${out}\n`);
        expect(second.stderr).toContain('warn: failed to download media for doc 5 (pic): HTTP 500');
        expect(second.stderr).not.toContain('holds a local file');
        expect(manifestOf(out).docs['pic.png']).toEqual(saved);
        expect(fs.readFileSync(path.join(out, 'pic.png'), 'utf8')).toBe('P1');
    });

    it("keeps the other doc's tracking when a failed download's path holds that doc's file and the doc is still on the server (cli#190, B kept)", async () => {
        const tracked = seedTracked(out, 'P.png', { id: 9, title: 'old', revision: 3 }, Buffer.from('B-BYTES'));
        served = [
            { id: 7, title: 'P', revision: 70, media: Buffer.from('A-BYTES'), downloadFails: true },
            { id: 9, title: 'old', revision: 3, bulkStatus: 'not_found' },
        ];

        const result = await runCli(root, ['doc', 'pull', 'docs', out, '-y']);

        expect(result.code).toBe(0);
        expect(result.stdout).toBe(`pulled 0 docs → ${out}\n`);
        expect(result.stderr).toContain('warn: failed to download media for doc 7 (P): HTTP 500');
        expect(result.stderr).toContain('! doc 7 ("P") failed to download and P.png holds doc 9\'s file ("old"); still tracking it as doc 9 — pull again later');
        expect(manifestOf(out).docs['P.png']).toEqual(tracked);
        expect(fs.readFileSync(path.join(out, 'P.png'), 'utf8')).toBe('B-BYTES');
    });

    it('says the other doc is no longer tracked there when it is gone from the server (cli#190, B gone)', async () => {
        seedTracked(out, 'P.png', { id: 9, title: 'old', revision: 3 }, Buffer.from('B-BYTES'));
        served = [{ id: 7, title: 'P', revision: 70, media: Buffer.from('A-BYTES'), downloadFails: true }];

        const result = await runCli(root, ['doc', 'pull', 'docs', out, '-y']);

        expect(result.code).toBe(0);
        expect(result.stdout).toBe(`pulled 0 docs → ${out}\n- removed (deleted remotely): P.png\n`);
        expect(result.stderr).toContain('warn: failed to download media for doc 7 (P): HTTP 500');
        expect(result.stderr).toContain('! doc 7 ("P") failed to download and P.png holds a local file; not tracking it — pull again later. Doc 9 ("old") was tracked at P.png before and is no longer tracked there.');
        expect(Object.values(manifestOf(out).docs).filter((entry) => entry.id === 9)).toEqual([]);
    });

    it("does not keep the other doc's tracking when its file was edited locally: the edit survives, the entry is dropped with the usual warning (cli#190, F-M2)", async () => {
        seedTracked(out, 'P.png', { id: 9, title: 'old', revision: 3 }, Buffer.from('B-BYTES'));
        fs.writeFileSync(path.join(out, 'P.png'), 'MY EDITED BYTES');
        served = [
            { id: 7, title: 'P', revision: 70, media: Buffer.from('A-BYTES'), downloadFails: true },
            { id: 9, title: 'old', revision: 3, bulkStatus: 'not_found' },
        ];

        const result = await runCli(root, ['doc', 'pull', 'docs', out, '--overwrite']);

        expect(result.code).toBe(0);
        expect(result.stdout).toBe(`pulled 0 docs → ${out}\n`);
        expect(result.stderr).toContain('! doc 7 ("P") failed to download and P.png holds a local file; not tracking it — pull again later. Doc 9 ("old") was tracked at P.png before and is no longer tracked there.');
        expect(result.stderr).not.toContain("still tracking it as doc 9");
        expect(manifestOf(out).docs['P.png']).toBeUndefined();
        expect(fs.readFileSync(path.join(out, 'P.png'), 'utf8')).toBe('MY EDITED BYTES');
    });

    it('keeps today\'s behaviour for a failed download at a new path with no previous entry', async () => {
        served = [{ id: 7, title: 'fresh', revision: 70, media: Buffer.from('A-BYTES'), downloadFails: true }];

        const result = await runCli(root, ['doc', 'pull', 'docs', out, '-y']);

        expect(result.code).toBe(0);
        expect(result.stdout).toBe(`pulled 0 docs → ${out}\n`);
        expect(result.stderr).toContain('warn: failed to download media for doc 7 (fresh): HTTP 500');
        expect(manifestOf(out).docs['fresh.png']).toEqual({ id: 7, title: 'fresh', current_revision_id: 70, media: true, body_sha256: null });
        expect(result.stderr).not.toContain('holds a local file');
        expect(fs.existsSync(path.join(out, 'fresh.png'))).toBe(false);
    });
});

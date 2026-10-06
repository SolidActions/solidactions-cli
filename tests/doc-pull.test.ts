/**
 * Tests for `solidactions doc pull <folder> [dest]`
 *
 * Uses a real in-process HTTP server (Node's http.createServer) to stub the
 * unified /mcp endpoint. No mock/spy/stub libraries — follows the pattern in
 * tests/doc-push.test.ts.
 */

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { docPullWithConfig, sanitizeTitle, DOCS_MANIFEST } from '../src/commands/doc-pull';
import type { DocsManifest } from '../src/commands/doc-pull';
import type { Config } from '../src/utils/config';
import { writeGlobal } from './helpers';

/** sha256 hex digest, for asserting manifest body_sha256 values in tests. */
function sha256Hex(data: string | Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Stub MCP server
// ---------------------------------------------------------------------------

interface CapturedRequest {
    method: string | undefined;
    path: string | undefined;
    headers: http.IncomingHttpHeaders;
    body: any;
}

let stubServer: http.Server;
let stubPort: number;
let allCaptures: CapturedRequest[] = [];

/**
 * Build a canned MCP success response wrapping toolData.
 *
 * The real server always sends the `doc_type` key on list rows (null for
 * untyped docs), so a list row without the key gets `doc_type: null` by
 * default — matching the server without editing every fixture. The one test
 * that covers a genuinely keyless row (the read_doc backfill) uses
 * `makeMcpSuccessRaw` to opt into the keyless shape explicitly.
 */
function makeMcpSuccess(toolData: object): string {
    const data: Record<string, unknown> = { ...toolData };
    if (Array.isArray(data.docs)) {
        data.docs = (data.docs as Array<Record<string, unknown>>).map((row) =>
            row !== null && typeof row === 'object' && !Object.prototype.hasOwnProperty.call(row, 'doc_type')
                ? { ...row, doc_type: null }
                : row,
        );
    }
    return JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
            isError: false,
            content: [{ type: 'text', text: JSON.stringify(data) }],
        },
    });
}

/** Like makeMcpSuccess but sends toolData verbatim — for the keyless-row backfill test. */
function makeMcpSuccessRaw(toolData: object): string {
    return JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
            isError: false,
            content: [{ type: 'text', text: JSON.stringify(toolData) }],
        },
    });
}

/** Build a canned MCP error response (isError envelope). */
function makeMcpError(code: string, message: string): string {
    return JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ code, message }) }],
        },
    });
}

let responseQueue: Array<string | ((body: any) => string)> = [];

function nextResponseBody(body: any): string {
    const entry = responseQueue.length > 0 ? responseQueue.shift()! : null;
    if (entry === null) {
        // Default: empty list result
        return makeMcpSuccess({ folders: [], docs: [] });
    }
    if (typeof entry === 'function') return entry(body);
    return entry;
}

/** Queue of canned responses for `GET /api/v1/docs/{id}/media`. */
let mediaResponseQueue: Array<{ status: number; body: object }> = [];

/** Queue of canned responses for the plain `GET /blob/...` signed-URL stand-in. */
let blobResponseQueue: Array<{ status: number; bytes: Buffer }> = [];

beforeAll(async () => {
    stubServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => { chunks.push(chunk); });
        req.on('end', () => {
            const rawBody = Buffer.concat(chunks).toString('utf8');
            let parsedBody: any = null;
            try { parsedBody = JSON.parse(rawBody); } catch { /* ignore */ }

            const capture: CapturedRequest = {
                method: req.method,
                path: req.url,
                headers: req.headers,
                body: parsedBody,
            };

            allCaptures.push(capture);

            if (req.url?.startsWith('/blob/')) {
                const entry = blobResponseQueue.shift() ?? { status: 200, bytes: Buffer.alloc(0) };
                res.writeHead(entry.status, { 'Content-Type': 'application/octet-stream' });
                res.end(entry.bytes);
                return;
            }

            if (req.url?.startsWith('/api/v1/docs/') && req.url.endsWith('/media')) {
                const entry = mediaResponseQueue.shift() ?? { status: 404, body: { code: 'media_not_found', message: 'no media' } };
                res.writeHead(entry.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(entry.body));
                return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(nextResponseBody(parsedBody));
        });
    });

    await new Promise<void>((resolve) => {
        stubServer.listen(0, '127.0.0.1', () => {
            stubPort = (stubServer.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => {
    return new Promise<void>((resolve, reject) => {
        stubServer.close((err) => (err ? reject(err) : resolve()));
    });
});

beforeEach(() => {
    allCaptures = [];
    responseQueue = [];
    mediaResponseQueue = [];
    blobResponseQueue = [];
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Config that points at the stub server. */
function stubConfig(workspaceId = 'ws-test-uuid'): Config {
    return {
        host: `http://127.0.0.1:${stubPort}`,
        apiKey: 'test-api-key',
        workspaceId,
    };
}

/** Sentinel thrown by the patched process.exit so execution stops. */
class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

/** Patch process.exit to throw ProcessExitError so tests can catch it. */
function patchProcessExit(): () => void {
    const orig = process.exit.bind(process);
    (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };
    return () => { (process as any).exit = orig; };
}

/** Patch process.stderr.write to capture output. */
function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string) => { lines.push(String(chunk)); return true; };
    return { lines, restore: () => { (process.stderr as any).write = orig; } };
}

/** Patch console.log to capture output lines. */
function captureStdout(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (m?: any) => { lines.push(String(m ?? '')); };
    return { lines, restore: () => { console.log = orig; } };
}

/** Run fn, expecting it to call process.exit; returns the captured exit code. */
async function runExpectingExit(fn: () => Promise<void>): Promise<number | undefined> {
    try {
        await fn();
    } catch (e) {
        if (e instanceof ProcessExitError) return e.code;
        throw e;
    }
    return undefined;
}

function makeTmpDir(): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-docs-pull-test-'));
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

/** Whether the temp filesystem treats names that differ only by case as one file (spec §1.7). */
function caseInsensitiveFilesystem(): boolean {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-case-probe-'));
    try {
        fs.writeFileSync(path.join(dir, 'probe.md'), 'x');
        return fs.existsSync(path.join(dir, 'PROBE.md'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

interface CliResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

/**
 * Run a pull through the real built CLI: real stdout, stderr and exit
 * status against the file's in-process stub MCP server. The temp HOME
 * points at the stub server; no credentialed env reaches the child.
 * Async spawn (never spawnSync): the stub server lives in this process.
 */
async function runPullCli(args: string[]): Promise<CliResult> {
    const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-docs-pull-cli-'));
    const home = path.join(homeRoot, 'home');
    fs.mkdirSync(home, { recursive: true });
    writeGlobal(home, { host: `http://127.0.0.1:${stubPort}`, apiKey: 'test-api-key', workspaceId: 'ws-test-uuid' });
    try {
        return await new Promise<CliResult>((resolve, reject) => {
            const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home };
            for (const key of ['SOLIDACTIONS_HOST', 'SOLIDACTIONS_API_KEY', 'SOLIDACTIONS_WORKSPACE_ID', 'DEBUG', 'NODE_DEBUG', 'FORCE_COLOR', 'SOLIDACTIONS_TEST_HOOKS', 'SOLIDACTIONS_DOC_PULL_TEST_FAULT']) {
                delete childEnv[key];
            }
            const child = childProcess.spawn(process.execPath, [CLI_BINARY, 'doc', 'pull', ...args], {
                cwd: homeRoot,
                env: childEnv,
            });
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
    } finally {
        fs.rmSync(homeRoot, { recursive: true, force: true });
    }
}

function readManifest(dest: string): DocsManifest {
    const raw = fs.readFileSync(path.join(dest, DOCS_MANIFEST), 'utf8');
    return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Unit: sanitizeTitle
// ---------------------------------------------------------------------------

describe('sanitizeTitle', () => {
    it('replaces filesystem-unsafe characters with underscores', () => {
        expect(sanitizeTitle('a/b:c')).toBe('a_b_c');
    });

    it('replaces all reserved characters and control chars', () => {
        expect(sanitizeTitle('a*b?c"d<e>f|g')).toBe('a_b_c_d_e_f_g');
        expect(sanitizeTitle('x\\y')).toBe('x_y');
        expect(sanitizeTitle('ctrl\x01char')).toBe('ctrl_char');
    });

    it('leaves already-safe titles unchanged', () => {
        expect(sanitizeTitle('My Doc Title')).toBe('My Doc Title');
    });
});

// ---------------------------------------------------------------------------
// Integration: BFS folder tree pull
// ---------------------------------------------------------------------------

describe('docPullWithConfig — folder tree', () => {
    it('BFS-walks a folder tree, writes files + manifest with ids/revisions', async () => {
        responseQueue = [
            // list on marketing/fb-campaign -> one subfolder (ads) + root doc "brief"
            (body: any) => {
                expect(body.params.arguments.action).toBe('list');
                expect(body.params.arguments.folder_path).toBe('marketing/fb-campaign');
                return makeMcpSuccess({
                    folders: [{ id: 100, name: 'ads', parent_folder_id: 1, folder_path: 'marketing/fb-campaign/ads' }],
                    docs: [{ id: 1, title: 'brief', properties: {}, folder_id: 1, updated_at: '2026-01-01' }],
                });
            },
            // list on marketing/fb-campaign/ads -> one doc "ad-a"
            (body: any) => {
                expect(body.params.arguments.action).toBe('list');
                expect(body.params.arguments.folder_path).toBe('marketing/fb-campaign/ads');
                return makeMcpSuccess({
                    folders: [],
                    docs: [{ id: 2, title: 'ad-a', properties: {}, folder_id: 100, updated_at: '2026-01-01' }],
                });
            },
            // bulk_read for ids [1, 2]
            (body: any) => {
                expect(body.params.arguments.action).toBe('bulk_read');
                const ids = body.params.arguments.items.map((i: any) => i.id);
                expect(ids).toEqual([1, 2]);
                return makeMcpSuccess({
                    results: [
                        { index: 0, status: 'found', id: 1, title: 'brief', folder_path: 'marketing/fb-campaign', current_revision_id: 10, properties: {}, body: '# Brief' },
                        { index: 1, status: 'found', id: 2, title: 'ad-a', folder_path: 'marketing/fb-campaign/ads', current_revision_id: 20, properties: {}, body: '# Ad A' },
                    ],
                });
            },
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing/fb-campaign', dest, {}, stubConfig()),
            );
            expect(code).toBe(0);

            expect(fs.readFileSync(path.join(dest, 'brief.md'), 'utf8')).toBe('# Brief');
            expect(fs.readFileSync(path.join(dest, 'ads', 'ad-a.md'), 'utf8')).toBe('# Ad A');

            const manifest = readManifest(dest);
            expect(manifest.docs['brief.md']).toEqual({ id: 1, title: 'brief', current_revision_id: 10, media: false, body_sha256: sha256Hex('# Brief') });
            expect(manifest.docs['ads/ad-a.md']).toEqual({ id: 2, title: 'ad-a', current_revision_id: 20, media: false, body_sha256: sha256Hex('# Ad A') });
            expect(manifest.folder_path).toBe('marketing/fb-campaign');

            // Manifest file itself is pretty-printed with a trailing newline
            const raw = fs.readFileSync(path.join(dest, DOCS_MANIFEST), 'utf8');
            expect(raw.endsWith('\n')).toBe(true);
            expect(raw).toContain('\n  ');

            // All requests hit /mcp with docs_read
            expect(allCaptures.length).toBe(3);
            for (const cap of allCaptures) {
                expect(cap.path).toBe('/mcp');
                expect(cap.body.params.name).toBe('docs_read');
            }
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('bulk_read is chunked at 50 ids per call', async () => {
        const docs = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, title: `doc-${i + 1}`, properties: {} }));
        responseQueue = [
            makeMcpSuccess({ folders: [], docs }),
            (body: any) => {
                const items = body.params.arguments.items;
                expect(items.length).toBeLessThanOrEqual(50);
                return makeMcpSuccess({
                    results: items.map((it: any, i: number) => ({
                        index: i, status: 'found', id: it.id, title: `doc-${it.id}`,
                        folder_path: 'many', current_revision_id: it.id * 10, properties: {}, body: `body-${it.id}`,
                    })),
                });
            },
            (body: any) => {
                const items = body.params.arguments.items;
                return makeMcpSuccess({
                    results: items.map((it: any, i: number) => ({
                        index: i, status: 'found', id: it.id, title: `doc-${it.id}`,
                        folder_path: 'many', current_revision_id: it.id * 10, properties: {}, body: `body-${it.id}`,
                    })),
                });
            },
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() => docPullWithConfig('many', dest, {}, stubConfig()));
            expect(code).toBe(0);

            // 1 list call + 2 bulk_read calls (50 + 10)
            expect(allCaptures.length).toBe(3);
            const bulkCalls = allCaptures.slice(1);
            expect(bulkCalls[0].body.params.arguments.items.length).toBe(50);
            expect(bulkCalls[1].body.params.arguments.items.length).toBe(10);

            const manifest = readManifest(dest);
            expect(Object.keys(manifest.docs).length).toBe(60);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Unit/integration: collision suffixing
// ---------------------------------------------------------------------------

describe('docPullWithConfig — title collisions', () => {
    it('two docs titled "Same" in different folders get no suffix; same folder gets -2', async () => {
        responseQueue = [
            // root list: one subfolder "sub" + one root doc "Same"
            makeMcpSuccess({
                folders: [{ id: 10, name: 'sub', parent_folder_id: 1, folder_path: 'root/sub' }],
                docs: [
                    { id: 1, title: 'Same', properties: {} },
                    { id: 2, title: 'Same', properties: {} },
                ],
            }),
            // sub list: one doc "Same"
            makeMcpSuccess({
                folders: [],
                docs: [{ id: 3, title: 'Same', properties: {} }],
            }),
            // bulk_read for [1, 2, 3]
            (body: any) => {
                const ids = body.params.arguments.items.map((i: any) => i.id);
                expect(ids).toEqual([1, 2, 3]);
                return makeMcpSuccess({
                    results: [
                        { index: 0, status: 'found', id: 1, title: 'Same', folder_path: 'root', current_revision_id: 1, properties: {}, body: 'one' },
                        { index: 1, status: 'found', id: 2, title: 'Same', folder_path: 'root', current_revision_id: 2, properties: {}, body: 'two' },
                        { index: 2, status: 'found', id: 3, title: 'Same', folder_path: 'root/sub', current_revision_id: 3, properties: {}, body: 'three' },
                    ],
                });
            },
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() => docPullWithConfig('root', dest, {}, stubConfig()));
            expect(code).toBe(0);

            // Same-folder collision: "Same.md" and "Same-2.md"
            expect(fs.readFileSync(path.join(dest, 'Same.md'), 'utf8')).toBe('one');
            expect(fs.readFileSync(path.join(dest, 'Same-2.md'), 'utf8')).toBe('two');
            // Different folder: no suffix needed
            expect(fs.readFileSync(path.join(dest, 'sub', 'Same.md'), 'utf8')).toBe('three');

            const manifest = readManifest(dest);
            expect(Object.keys(manifest.docs).sort()).toEqual(['Same-2.md', 'Same.md', 'sub/Same.md'].sort());
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Single-doc fallback
// ---------------------------------------------------------------------------

describe('docPullWithConfig — single-doc fallback', () => {
    it('falls back to a single read when list 404s with folder_path_not_found', async () => {
        responseQueue = [
            (body: any) => {
                expect(body.params.arguments.action).toBe('list');
                expect(body.params.arguments.folder_path).toBe('notes/solo');
                return makeMcpError('folder_path_not_found', 'No folder at that path');
            },
            (body: any) => {
                expect(body.params.arguments.action).toBe('read_doc');
                expect(body.params.arguments.path).toEqual({ folder_path: 'notes', title: 'solo' });
                return makeMcpSuccess({ id: 5, title: 'solo', body: 'x', current_revision_id: 3, folder_path: 'notes' });
            },
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');

        try {
            const result = await runPullCli(['notes/solo', dest]);
            expect(result.code).toBe(0);

            expect(fs.readFileSync(path.join(dest, 'solo.md'), 'utf8')).toBe('x');
            const manifest = readManifest(dest);
            expect(Object.keys(manifest.docs).length).toBe(1);
            expect(manifest.docs['solo.md']).toEqual({ id: 5, title: 'solo', current_revision_id: 3, media: false, body_sha256: sha256Hex('x') });
            expect(manifest.folder_path).toBe('notes');

            expect(allCaptures.length).toBe(2);
        } finally {
            cleanup();
        }
    });

    it('omits path.folder_path when the target is a root-level doc', async () => {
        responseQueue = [
            (body: any) => {
                expect(body.params.arguments.folder_path).toBe('solo');
                return makeMcpError('folder_path_not_found', 'No folder at that path');
            },
            (body: any) => {
                expect(body.params.arguments.path).toEqual({ title: 'solo' });
                return makeMcpSuccess({ id: 5, title: 'solo', body: 'x', current_revision_id: 3 });
            },
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');

        try {
            const result = await runPullCli(['solo', dest]);
            expect(result.code).toBe(0);
            expect(fs.readFileSync(path.join(dest, 'solo.md'), 'utf8')).toBe('x');
            expect(readManifest(dest).folder_path).toBe('');
        } finally {
            cleanup();
        }
    });

    it('exits 1 with both errors when list 404s and the read fallback also fails', async () => {
        responseQueue = [
            makeMcpError('folder_path_not_found', 'No folder at that path'),
            makeMcpError('doc_not_found', 'No doc at that path either'),
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const restoreExit = patchProcessExit();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            const code = await runExpectingExit(() => docPullWithConfig('notes/ghost', dest, {}, stubConfig()));
            expect(code).not.toBe(0);
            const out = stderrLines.join('');
            expect(out).toContain('folder_path_not_found');
            expect(out).toContain('doc_not_found');
            expect(fs.existsSync(dest)).toBe(false);
        } finally {
            restoreExit();
            restoreStderr();
            cleanup();
        }
    });

    it('exits 1 immediately (no fallback attempted) when list fails with a different error code', async () => {
        responseQueue = [
            makeMcpError('permission_denied', 'not allowed'),
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const restoreExit = patchProcessExit();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            const code = await runExpectingExit(() => docPullWithConfig('marketing/fb-campaign', dest, {}, stubConfig()));
            expect(code).not.toBe(0);
            expect(allCaptures.length).toBe(1);
            expect(stderrLines.join('')).toContain('permission_denied');
        } finally {
            restoreExit();
            restoreStderr();
            cleanup();
        }
    });

    it('records path.posix.dirname of the argument when read_doc returns no folder_path', async () => {
        responseQueue = [
            makeMcpError('folder_path_not_found', 'No folder at that path'),
            makeMcpSuccess({ id: 5, title: 'solo', body: 'x', current_revision_id: 3 }),
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');

        try {
            const result = await runPullCli(['notes/solo', dest]);
            expect(result.code).toBe(0);
            expect(readManifest(dest).folder_path).toBe('notes');
        } finally {
            cleanup();
        }
    });

    function writeSingleDocManifest(dest: string, manifest: DocsManifest): void {
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, DOCS_MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');
    }

    function singleDocReadResponse(revision: number, body: string, folderPath = 'notes'): string {
        return makeMcpSuccess({ id: 5, title: 'solo', body, current_revision_id: revision, folder_path: folderPath });
    }

    it('re-pull agrees with itself instead of refusing "already tracks"', async () => {
        responseQueue = [
            makeMcpError('folder_path_not_found', 'No folder at that path'),
            singleDocReadResponse(3, 'x'),
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeSingleDocManifest(dest, {
            folder_path: 'notes',
            docs: { 'solo.md': { id: 5, title: 'solo', current_revision_id: 3, media: false, body_sha256: sha256Hex('x') } },
        });
        fs.writeFileSync(path.join(dest, 'solo.md'), 'x', 'utf8');

        try {
            const result = await runPullCli(['notes/solo', dest, '--yes']);
            expect(result.code).toBe(0);
            expect(readManifest(dest).folder_path).toBe('notes');
        } finally {
            cleanup();
        }
    });

    it('merges into a manifest tracking the same folder, never untracking the rest', async () => {
        responseQueue = [
            makeMcpError('folder_path_not_found', 'No folder at that path'),
            singleDocReadResponse(3, 'x'),
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeSingleDocManifest(dest, {
            folder_path: 'notes',
            docs: {
                'other.md': { id: 9, title: 'other', current_revision_id: 1, media: false, body_sha256: sha256Hex('o') },
                'solo.md': { id: 5, title: 'solo', current_revision_id: 2, media: false, body_sha256: sha256Hex('old') },
            },
        });
        fs.writeFileSync(path.join(dest, 'other.md'), 'o', 'utf8');
        fs.writeFileSync(path.join(dest, 'solo.md'), 'old', 'utf8');

        try {
            const result = await runPullCli(['notes/solo', dest, '--yes']);
            expect(result.code).toBe(0);
            const manifest = readManifest(dest);
            expect(manifest.docs['other.md']).toEqual({ id: 9, title: 'other', current_revision_id: 1, media: false, body_sha256: sha256Hex('o') });
            expect(manifest.docs['solo.md'].current_revision_id).toBe(3);
            expect(fs.readFileSync(path.join(dest, 'other.md'), 'utf8')).toBe('o');
        } finally {
            cleanup();
        }
    });

    it('merge drops a stale key for the same doc id', async () => {
        responseQueue = [
            makeMcpError('folder_path_not_found', 'No folder at that path'),
            singleDocReadResponse(3, 'x'),
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeSingleDocManifest(dest, {
            folder_path: 'notes',
            docs: {
                'renamed.md': { id: 5, title: 'solo', current_revision_id: 2, media: false, body_sha256: sha256Hex('old') },
            },
        });
        fs.writeFileSync(path.join(dest, 'renamed.md'), 'old', 'utf8');

        try {
            const result = await runPullCli(['notes/solo', dest, '--yes']);
            expect(result.code).toBe(0);
            const manifest = readManifest(dest);
            expect(manifest.docs['solo.md'].id).toBe(5);
            expect(manifest.docs).not.toHaveProperty('renamed.md');
        } finally {
            cleanup();
        }
    });

    it('the parent folder may be pulled into a single-doc directory', async () => {
        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 5, title: 'solo', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 5, title: 'solo', folder_path: 'notes', current_revision_id: 3, properties: {}, body: 'x' }],
            }),
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeSingleDocManifest(dest, {
            folder_path: 'notes',
            docs: { 'solo.md': { id: 5, title: 'solo', current_revision_id: 3, media: false, body_sha256: sha256Hex('x') } },
        });
        fs.writeFileSync(path.join(dest, 'solo.md'), 'x', 'utf8');

        try {
            const result = await runPullCli(['notes', dest, '--yes']);
            expect(result.code).toBe(0);
        } finally {
            cleanup();
        }
    });

    it('a different folder is still refused, writing nothing', async () => {
        responseQueue = [
            makeMcpError('folder_path_not_found', 'No folder at that path'),
            singleDocReadResponse(3, 'x'),
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeSingleDocManifest(dest, { folder_path: 'elsewhere', docs: {} });
        fs.writeFileSync(path.join(dest, 'keep.md'), 'keep', 'utf8');
        const manifestBefore = fs.readFileSync(path.join(dest, DOCS_MANIFEST), 'utf8');

        try {
            const result = await runPullCli(['notes/solo', dest, '--yes']);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('already tracks "elsewhere"');
            expect(fs.existsSync(path.join(dest, 'solo.md'))).toBe(false);
            expect(fs.readFileSync(path.join(dest, DOCS_MANIFEST), 'utf8')).toBe(manifestBefore);
        } finally {
            cleanup();
        }
    });

    // Single-doc filename collisions (cli#153 C1): the allocator must avoid
    // every path the previous manifest assigns to other ids, so a
    // same-sanitized-name pull can never overwrite and untrack another doc.
    function writeCollisionManifest(dest: string, docs: DocsManifest['docs']): void {
        writeSingleDocManifest(dest, { folder_path: 'notes', docs });
    }

    function queueSingleDocList404ThenRead(readBody: object): void {
        responseQueue = [
            makeMcpError('folder_path_not_found', 'No folder at that path'),
            makeMcpSuccess(readBody),
        ];
    }

    it('a colliding single-doc pull keeps the other tracked doc: file and manifest entry survive', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeCollisionManifest(dest, {
            'note_one.md': { id: 1, title: 'note:one', current_revision_id: 1, media: false, body_sha256: sha256Hex('first doc') },
            'note_one-2.md': { id: 2, title: 'note?one', current_revision_id: 1, media: false, body_sha256: sha256Hex('second old') },
        });
        fs.writeFileSync(path.join(dest, 'note_one.md'), 'first doc', 'utf8');
        fs.writeFileSync(path.join(dest, 'note_one-2.md'), 'second old', 'utf8');
        queueSingleDocList404ThenRead({ id: 2, title: 'note?one', body: 'second new', current_revision_id: 2, folder_path: 'notes' });

        try {
            const result = await runPullCli(['notes/note?one', dest, '--yes']);
            expect(result.code).toBe(0);
            expect(fs.readFileSync(path.join(dest, 'note_one.md'), 'utf8')).toBe('first doc');
            expect(fs.readFileSync(path.join(dest, 'note_one-2.md'), 'utf8')).toBe('second new');
            const manifest = readManifest(dest);
            expect(manifest.docs['note_one.md'].id).toBe(1);
            expect(manifest.docs['note_one-2.md']).toEqual({ id: 2, title: 'note?one', current_revision_id: 2, media: false, body_sha256: sha256Hex('second new') });
        } finally {
            cleanup();
        }
    });

    it('pulling the other colliding doc updates it in place, keeping both entries', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeCollisionManifest(dest, {
            'note_one.md': { id: 1, title: 'note:one', current_revision_id: 1, media: false, body_sha256: sha256Hex('first doc') },
            'note_one-2.md': { id: 2, title: 'note?one', current_revision_id: 1, media: false, body_sha256: sha256Hex('second old') },
        });
        fs.writeFileSync(path.join(dest, 'note_one.md'), 'first doc', 'utf8');
        fs.writeFileSync(path.join(dest, 'note_one-2.md'), 'second old', 'utf8');
        queueSingleDocList404ThenRead({ id: 1, title: 'note:one', body: 'first new', current_revision_id: 2, folder_path: 'notes' });

        try {
            const result = await runPullCli(['notes/note:one', dest, '--yes']);
            expect(result.code).toBe(0);
            expect(fs.readFileSync(path.join(dest, 'note_one.md'), 'utf8')).toBe('first new');
            expect(fs.readFileSync(path.join(dest, 'note_one-2.md'), 'utf8')).toBe('second old');
            const manifest = readManifest(dest);
            expect(manifest.docs['note_one.md'].current_revision_id).toBe(2);
            expect(manifest.docs['note_one-2.md'].id).toBe(2);
        } finally {
            cleanup();
        }
    });

    it('a NEW colliding doc lands on a suffixed name, leaving the tracked file alone', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeCollisionManifest(dest, {
            'note_one.md': { id: 1, title: 'note:one', current_revision_id: 1, media: false, body_sha256: sha256Hex('first doc') },
        });
        fs.writeFileSync(path.join(dest, 'note_one.md'), 'first doc', 'utf8');
        queueSingleDocList404ThenRead({ id: 3, title: 'note*one', body: 'third new', current_revision_id: 1, folder_path: 'notes' });

        try {
            const result = await runPullCli(['notes/note*one', dest, '--yes']);
            expect(result.code).toBe(0);
            expect(fs.readFileSync(path.join(dest, 'note_one.md'), 'utf8')).toBe('first doc');
            expect(fs.readFileSync(path.join(dest, 'note_one-2.md'), 'utf8')).toBe('third new');
            const manifest = readManifest(dest);
            expect(manifest.docs['note_one.md'].id).toBe(1);
            expect(manifest.docs['note_one-2.md'].id).toBe(3);
        } finally {
            cleanup();
        }
    });

    it('vacant earlier slot, unchanged title: keeps the collision-assigned path instead of moving down', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeCollisionManifest(dest, {
            'different.md': { id: 1, title: 'different', current_revision_id: 1, media: false, body_sha256: sha256Hex('first doc') },
            'note_one-2.md': { id: 2, title: 'note?one', current_revision_id: 1, media: false, body_sha256: sha256Hex('second old') },
        });
        fs.writeFileSync(path.join(dest, 'different.md'), 'first doc', 'utf8');
        fs.writeFileSync(path.join(dest, 'note_one-2.md'), 'second old', 'utf8');
        queueSingleDocList404ThenRead({ id: 2, title: 'note?one', body: 'second new', current_revision_id: 2, folder_path: 'notes' });

        try {
            const result = await runPullCli(['notes/note?one', dest, '--yes']);
            expect(result.code).toBe(0);
            expect(fs.readFileSync(path.join(dest, 'note_one-2.md'), 'utf8')).toBe('second new');
            expect(fs.existsSync(path.join(dest, 'note_one.md'))).toBe(false);
            const manifest = readManifest(dest);
            expect(manifest.docs['note_one-2.md']).toEqual({ id: 2, title: 'note?one', current_revision_id: 2, media: false, body_sha256: sha256Hex('second new') });
            expect(manifest.docs['different.md'].id).toBe(1);
        } finally {
            cleanup();
        }
    });

    it('vacant earlier slot, locally edited collision path: refuses with unpushed local changes', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeCollisionManifest(dest, {
            'different.md': { id: 1, title: 'different', current_revision_id: 1, media: false, body_sha256: sha256Hex('first doc') },
            'note_one-2.md': { id: 2, title: 'note?one', current_revision_id: 1, media: false, body_sha256: sha256Hex('second old') },
        });
        fs.writeFileSync(path.join(dest, 'different.md'), 'first doc', 'utf8');
        fs.writeFileSync(path.join(dest, 'note_one-2.md'), 'second edited', 'utf8');
        queueSingleDocList404ThenRead({ id: 2, title: 'note?one', body: 'second new', current_revision_id: 2, folder_path: 'notes' });
        const manifestBefore = fs.readFileSync(path.join(dest, DOCS_MANIFEST), 'utf8');

        try {
            const result = await runPullCli(['notes/note?one', dest, '--yes']);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('unpushed local changes');
            expect(result.stderr).toContain('note_one-2.md');
            expect(fs.readFileSync(path.join(dest, 'note_one-2.md'), 'utf8')).toBe('second edited');
            expect(fs.existsSync(path.join(dest, 'note_one.md'))).toBe(false);
            expect(fs.readFileSync(path.join(dest, DOCS_MANIFEST), 'utf8')).toBe(manifestBefore);
        } finally {
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Overwrite confirmation
// ---------------------------------------------------------------------------

describe('docPullWithConfig — overwrite confirm', () => {
    // Declining the prompt (exit 0, nothing written) is covered through a real terminal in
    // tests/doc-pull-destination-checks.test.ts; in-process there is no terminal, so the pull now
    // fails with the no-terminal line instead of prompting (cli#176).

    it('--yes bypasses the confirmation on a non-empty dest', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'existing.txt'), 'hi', 'utf8');

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'brief', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'brief', folder_path: 'marketing/fb-campaign', current_revision_id: 10, properties: {}, body: '# Brief' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing/fb-campaign', dest, { yes: true }, stubConfig()),
            );
            expect(code).toBe(0);
            expect(fs.readFileSync(path.join(dest, 'brief.md'), 'utf8')).toBe('# Brief');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Unpushed local changes — pull overwrite protection + --overwrite
// ---------------------------------------------------------------------------

describe('docPullWithConfig — unpushed local changes', () => {
    function writeManifest(dest: string, docs: DocsManifest['docs'], folderPath = 'marketing/docs'): void {
        const manifest: DocsManifest = { folder_path: folderPath, docs };
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, DOCS_MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');
    }

    it('edited file whose doc STILL EXISTS remotely: plain pull still refuses (exit 1), names the file, points at --overwrite, and writes nothing', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeManifest(dest, {
            'doc.md': { id: 1, title: 'doc', current_revision_id: 10, media: false, body_sha256: sha256Hex('# Original') },
        });
        fs.writeFileSync(path.join(dest, 'doc.md'), 'local edits, unpushed', 'utf8');
        const manifestBefore = fs.readFileSync(path.join(dest, DOCS_MANIFEST), 'utf8');

        // The doc still exists on the server — this is a genuine conflict, not an orphan.
        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'doc', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'doc', folder_path: 'marketing/docs', current_revision_id: 15, properties: {}, body: '# Server Content' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing/docs', dest, { yes: true }, stubConfig()),
            );
            expect(code).toBe(1);

            const err = stderrLines.join('');
            expect(err).toContain('doc.md');
            expect(err).toContain('unpushed local changes');
            expect(err).toContain('--overwrite');

            // Refusal happens AFTER the server walk (network calls did occur) but BEFORE
            // any write: the file's edited bytes and the manifest sidecar are untouched.
            expect(allCaptures.length).toBeGreaterThan(0);
            expect(fs.readFileSync(path.join(dest, 'doc.md'), 'utf8')).toBe('local edits, unpushed');
            expect(fs.readFileSync(path.join(dest, DOCS_MANIFEST), 'utf8')).toBe(manifestBefore);
        } finally {
            restoreExit();
            restoreStderr();
            cleanup();
        }
    });

    it('edited MEDIA file whose doc STILL EXISTS remotely: plain pull still refuses (exit 1) — coverage: detection is extension-agnostic, no code change needed', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const originalBytes = Buffer.from([1, 2, 3, 4]);
        writeManifest(dest, {
            'hero.png': { id: 7, title: 'hero', current_revision_id: 10, media: true, body_sha256: sha256Hex(originalBytes) },
        });
        fs.writeFileSync(path.join(dest, 'hero.png'), Buffer.from([9, 9, 9, 9]));

        responseQueue = [
            makeMcpSuccess({
                folders: [],
                docs: [{ id: 7, title: 'hero', properties: { blob_sha: 'abc', mime: 'image/png', size: 4 } }],
            }),
            makeMcpSuccess({
                results: [{
                    index: 0, status: 'found', id: 7, title: 'hero', folder_path: 'marketing/docs', current_revision_id: 11,
                    properties: { blob_sha: 'abc', mime: 'image/png', size: 4 }, body: '',
                }],
            }),
        ];
        mediaResponseQueue = [
            { status: 200, body: { url: `http://127.0.0.1:${stubPort}/blob/7`, mime: 'image/png', size: 4 } },
        ];
        blobResponseQueue = [{ status: 200, bytes: Buffer.from([5, 6, 7, 8]) }];

        const restoreExit = patchProcessExit();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing/docs', dest, { yes: true }, stubConfig()),
            );
            expect(code).toBe(1);

            const err = stderrLines.join('');
            expect(err).toContain('hero.png');
            expect(err).toContain('unpushed local changes');
            expect(err).toContain('--overwrite');

            // Nothing written: the locally-modified bytes on disk are untouched.
            expect(fs.readFileSync(path.join(dest, 'hero.png'))).toEqual(Buffer.from([9, 9, 9, 9]));
        } finally {
            restoreExit();
            restoreStderr();
            cleanup();
        }
    });

    it('edited file whose doc was DELETED remotely: plain pull (no flags at all) succeeds, the file survives on disk with its edited bytes, and kept_modified names it', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeManifest(dest, {
            'a.md': { id: 1, title: 'a', current_revision_id: 1, media: false, body_sha256: sha256Hex('A') },
            'doc.md': { id: 2, title: 'doc', current_revision_id: 10, media: false, body_sha256: sha256Hex('# Original') },
        }, 'marketing');
        fs.writeFileSync(path.join(dest, 'a.md'), 'A', 'utf8');
        fs.writeFileSync(path.join(dest, 'doc.md'), 'local edits, unpushed', 'utf8');

        // doc.md's doc (id 2) is no longer returned by the server — it was deleted remotely.
        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'a', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'a', folder_path: 'marketing', current_revision_id: 1, properties: {}, body: 'A' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            // No --overwrite: the plain default path must be enough. --yes bypasses only
            // the unrelated generic non-empty-destination prompt (it never bypasses the
            // unpushed-local-changes conflict check — see the "even with --yes" test above).
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing', dest, { yes: true }, stubConfig()),
            );
            expect(code).toBe(0);

            expect(fs.readFileSync(path.join(dest, 'doc.md'), 'utf8')).toBe('local edits, unpushed');
            const err = stderrLines.join('');
            expect(err).toContain('doc.md');
            expect(err).toContain('modified locally');
        } finally {
            restoreExit();
            restoreStdout();
            restoreStderr();
            cleanup();
        }
    });

    it('both together in one pull: the still-existing conflict refuses (exit 1) and NOTHING is written or deleted, including the deleted-remotely orphan', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeManifest(dest, {
            'a.md': { id: 1, title: 'a', current_revision_id: 1, media: false, body_sha256: sha256Hex('A') },
            // Still exists remotely, edited locally: a real conflict.
            'conflict.md': { id: 2, title: 'conflict', current_revision_id: 10, media: false, body_sha256: sha256Hex('# Original') },
            // Deleted remotely, edited locally: an orphan — not part of the refusal.
            'orphan.md': { id: 3, title: 'orphan', current_revision_id: 5, media: false, body_sha256: sha256Hex('# Orphan Original') },
        }, 'marketing');
        fs.writeFileSync(path.join(dest, 'a.md'), 'A', 'utf8');
        fs.writeFileSync(path.join(dest, 'conflict.md'), 'local edits to conflict', 'utf8');
        fs.writeFileSync(path.join(dest, 'orphan.md'), 'local edits to orphan', 'utf8');
        const manifestBefore = fs.readFileSync(path.join(dest, DOCS_MANIFEST), 'utf8');

        // Server still has doc 1 (a) and doc 2 (conflict), but doc 3 (orphan) is gone.
        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'a', properties: {} }, { id: 2, title: 'conflict', properties: {} }] }),
            makeMcpSuccess({
                results: [
                    { index: 0, status: 'found', id: 1, title: 'a', folder_path: 'marketing', current_revision_id: 1, properties: {}, body: 'A' },
                    { index: 1, status: 'found', id: 2, title: 'conflict', folder_path: 'marketing', current_revision_id: 12, properties: {}, body: '# Server Content' },
                ],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing', dest, { yes: true }, stubConfig()),
            );
            expect(code).toBe(1);

            const err = stderrLines.join('');
            expect(err).toContain('conflict.md');
            expect(err).toContain('unpushed local changes');
            // The orphan must not be named in the refusal — it isn't a conflict.
            expect(err).not.toContain('orphan.md');

            // Nothing was written or deleted: both edited files retain their local bytes,
            // the unmodified file is untouched, and the manifest sidecar was never rewritten.
            expect(fs.readFileSync(path.join(dest, 'conflict.md'), 'utf8')).toBe('local edits to conflict');
            expect(fs.readFileSync(path.join(dest, 'orphan.md'), 'utf8')).toBe('local edits to orphan');
            expect(fs.readFileSync(path.join(dest, 'a.md'), 'utf8')).toBe('A');
            expect(fs.readFileSync(path.join(dest, DOCS_MANIFEST), 'utf8')).toBe(manifestBefore);
        } finally {
            restoreExit();
            restoreStderr();
            cleanup();
        }
    });

    it('--overwrite proceeds without a prompt and replaces the locally-modified file with server content', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeManifest(dest, {
            'doc.md': { id: 1, title: 'doc', current_revision_id: 10, media: false, body_sha256: sha256Hex('# Original') },
        });
        fs.writeFileSync(path.join(dest, 'doc.md'), 'local edits, unpushed', 'utf8');

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'doc', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'doc', folder_path: 'marketing/docs', current_revision_id: 99, properties: {}, body: '# Server Content' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            // No prompt injected: prompts() would throw/hang if the code tried to prompt.
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing/docs', dest, { overwrite: true }, stubConfig()),
            );
            expect(code).toBe(0);
            expect(fs.readFileSync(path.join(dest, 'doc.md'), 'utf8')).toBe('# Server Content');

            const manifest = readManifest(dest);
            expect(manifest.docs['doc.md'].body_sha256).toBe(sha256Hex('# Server Content'));
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('unmodified tracked files (hash matches) + --yes: proceeds silently, no refusal', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeManifest(dest, {
            'doc.md': { id: 1, title: 'doc', current_revision_id: 10, media: false, body_sha256: sha256Hex('# Original') },
        });
        fs.writeFileSync(path.join(dest, 'doc.md'), '# Original', 'utf8');

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'doc', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'doc', folder_path: 'marketing/docs', current_revision_id: 11, properties: {}, body: '# Original updated' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing/docs', dest, { yes: true }, stubConfig()),
            );
            expect(code).toBe(0);
            expect(fs.readFileSync(path.join(dest, 'doc.md'), 'utf8')).toBe('# Original updated');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    function legacyManifestPull(): { dest: string; cleanup: () => void } {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeManifest(dest, {
            // Old manifest shape: no body_sha256 field at all.
            'doc.md': { id: 1, title: 'doc', current_revision_id: 10, media: false },
        });
        fs.writeFileSync(path.join(dest, 'doc.md'), 'arbitrary local content, no hash to compare against', 'utf8');
        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'doc', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'doc', folder_path: 'marketing/docs', current_revision_id: 12, properties: {}, body: '# Fresh Pull' }],
            }),
        ];
        return { dest, cleanup };
    }

    it('old manifest entries without body_sha256 are refused over different bytes unless --overwrite (cli#167)', async () => {
        const { dest, cleanup } = legacyManifestPull();

        try {
            const result = await runPullCli(['marketing/docs', dest, '--yes']);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('1 file exists locally but is not tracked:\n  doc.md\n');
            expect(fs.readFileSync(path.join(dest, 'doc.md'), 'utf8')).toBe('arbitrary local content, no hash to compare against');
        } finally {
            cleanup();
        }
    });

    it('old manifest entries without body_sha256 are re-pulled under --overwrite', async () => {
        const { dest, cleanup } = legacyManifestPull();

        try {
            const result = await runPullCli(['marketing/docs', dest, '--overwrite']);
            expect(result.code).toBe(0);
            expect(fs.readFileSync(path.join(dest, 'doc.md'), 'utf8')).toBe('# Fresh Pull');
        } finally {
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Manifest-clobber protection — dest tracks a DIFFERENT folder
// ---------------------------------------------------------------------------

describe('docPullWithConfig — manifest tracks a different folder', () => {
    it('dest manifest tracks a DIFFERENT folder: refuses once the server answers, names both folders, and leaves the manifest untouched', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const manifest: DocsManifest = {
            folder_path: 'marketing/a',
            docs: { 'x.md': { id: 1, title: 'x', current_revision_id: 1, media: false, body_sha256: sha256Hex('X') } },
        };
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, DOCS_MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');
        fs.writeFileSync(path.join(dest, 'x.md'), 'X', 'utf8');
        const manifestBefore = fs.readFileSync(path.join(dest, DOCS_MANIFEST), 'utf8');

        // The clobber check runs against the resolved folder once the server answers,
        // but still before anything is written.
        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 3, title: 'b-doc', properties: {} }] }),
        ];

        try {
            const result = await runPullCli(['marketing/b', dest, '--yes']);
            expect(result.code).toBe(1);

            expect(result.stderr).toContain('marketing/a');
            expect(result.stderr).toContain('marketing/b');
            expect(result.stderr).toContain('--overwrite');

            expect(allCaptures.length).toBe(1);
            // The manifest on disk is byte-for-byte unchanged.
            expect(fs.readFileSync(path.join(dest, DOCS_MANIFEST), 'utf8')).toBe(manifestBefore);
        } finally {
            cleanup();
        }
    });

    it('--overwrite bypasses the mismatched-folder refusal and replaces the manifest with the new folder', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const manifest: DocsManifest = {
            folder_path: 'marketing/a',
            docs: { 'x.md': { id: 1, title: 'x', current_revision_id: 1, media: false, body_sha256: sha256Hex('X') } },
        };
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, DOCS_MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');
        fs.writeFileSync(path.join(dest, 'x.md'), 'X', 'utf8');

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 2, title: 'y', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 2, title: 'y', folder_path: 'marketing/b', current_revision_id: 1, properties: {}, body: 'Y' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing/b', dest, { overwrite: true }, stubConfig()),
            );
            expect(code).toBe(0);

            const newManifest = readManifest(dest);
            expect(newManifest.folder_path).toBe('marketing/b');
            expect(fs.readFileSync(path.join(dest, 'y.md'), 'utf8')).toBe('Y');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('dest manifest tracks the SAME folder: no refusal, normal re-pull proceeds', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const manifest: DocsManifest = {
            folder_path: 'marketing/a',
            docs: { 'x.md': { id: 1, title: 'x', current_revision_id: 1, media: false, body_sha256: sha256Hex('X') } },
        };
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, DOCS_MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');
        fs.writeFileSync(path.join(dest, 'x.md'), 'X', 'utf8');

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'x', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'x', folder_path: 'marketing/a', current_revision_id: 2, properties: {}, body: 'X updated' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing/a', dest, { yes: true }, stubConfig()),
            );
            expect(code).toBe(0);
            expect(fs.readFileSync(path.join(dest, 'x.md'), 'utf8')).toBe('X updated');
            expect(allCaptures.length).toBeGreaterThan(0);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('empty dest with no manifest: no refusal, first pull proceeds', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'x', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'x', folder_path: 'marketing/a', current_revision_id: 1, properties: {}, body: 'X' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing/a', dest, {}, stubConfig()),
            );
            expect(code).toBe(0);
            expect(fs.readFileSync(path.join(dest, 'x.md'), 'utf8')).toBe('X');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('single-doc fallback into a dir tracking another folder: refuses once the server names the doc, and the one-entry manifest is never written', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const manifest: DocsManifest = {
            folder_path: 'marketing/a',
            docs: {
                'x.md': { id: 1, title: 'x', current_revision_id: 1, media: false, body_sha256: sha256Hex('X') },
                'y.md': { id: 2, title: 'y', current_revision_id: 1, media: false, body_sha256: sha256Hex('Y') },
            },
        };
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, DOCS_MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');
        fs.writeFileSync(path.join(dest, 'x.md'), 'X', 'utf8');
        fs.writeFileSync(path.join(dest, 'y.md'), 'Y', 'utf8');
        const manifestBefore = fs.readFileSync(path.join(dest, DOCS_MANIFEST), 'utf8');

        // The clobber check runs once the server has said the argument is a doc in
        // another folder — after the list 404 and the read — but before anything is written.
        responseQueue = [
            makeMcpError('folder_path_not_found', 'No folder at that path'),
            makeMcpSuccess({ id: 7, title: 'notes', body: 'n', current_revision_id: 1, folder_path: 'marketing' }),
        ];

        try {
            const result = await runPullCli(['marketing/notes', dest, '--yes']);
            expect(result.code).toBe(1);

            expect(result.stderr).toContain('marketing/a');
            expect(result.stderr).toContain('marketing/notes');

            expect(allCaptures.length).toBe(2);
            expect(fs.readFileSync(path.join(dest, DOCS_MANIFEST), 'utf8')).toBe(manifestBefore);
            const finalManifest = readManifest(dest);
            expect(Object.keys(finalManifest.docs).length).toBe(2);
        } finally {
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Deletion propagation (orphan cleanup)
// ---------------------------------------------------------------------------

describe('docPullWithConfig — deletion propagation', () => {
    function writeManifest(dest: string, docs: DocsManifest['docs'], folderPath = 'marketing'): void {
        const manifest: DocsManifest = { folder_path: folderPath, docs };
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, DOCS_MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');
    }

    it('deletes an orphan whose bytes still match the manifest hash', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeManifest(dest, {
            'a.md': { id: 1, title: 'a', current_revision_id: 1, media: false, body_sha256: sha256Hex('A') },
            'gone.md': { id: 2, title: 'gone', current_revision_id: 2, media: false, body_sha256: sha256Hex('G') },
        });
        fs.writeFileSync(path.join(dest, 'a.md'), 'A', 'utf8');
        fs.writeFileSync(path.join(dest, 'gone.md'), 'G', 'utf8');

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'a', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'a', folder_path: 'marketing', current_revision_id: 1, properties: {}, body: 'A' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { lines: logLines, restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing', dest, { yes: true }, stubConfig()),
            );
            expect(code).toBe(0);

            expect(fs.existsSync(path.join(dest, 'gone.md'))).toBe(false);
            expect(fs.existsSync(path.join(dest, 'a.md'))).toBe(true);
            expect(logLines.join('\n')).toContain('gone.md');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('never deletes outside the destination, even for a manifest key that escapes it', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        // A sibling of `dest`, i.e. OUTSIDE the pull destination. `doc pull` never writes
        // such a manifest key (titles are sanitized), but a hand-edited manifest could.
        const outsideFile = path.join(tmpDest, 'outside.md');
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(outsideFile, 'G', 'utf8');

        writeManifest(dest, {
            'a.md': { id: 1, title: 'a', current_revision_id: 1, media: false, body_sha256: sha256Hex('A') },
            // Bytes match, so ONLY the containment check can save this file.
            '../outside.md': { id: 2, title: 'outside', current_revision_id: 2, media: false, body_sha256: sha256Hex('G') },
        });
        fs.writeFileSync(path.join(dest, 'a.md'), 'A', 'utf8');

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'a', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'a', folder_path: 'marketing', current_revision_id: 1, properties: {}, body: 'A' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing', dest, { yes: true }, stubConfig()),
            );
            expect(code).toBe(0);
            expect(fs.existsSync(outsideFile)).toBe(true);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('fails cleanly when a doc would be written over an existing directory', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        fs.mkdirSync(path.join(dest, 'a.md'), { recursive: true });

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'a', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'a', folder_path: 'marketing', current_revision_id: 1, properties: {}, body: 'A' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { lines: errLines, restore: restoreStderr } = captureStderr();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing', dest, { yes: true }, stubConfig()),
            );
            // A clean exit 1 with a named path, not an uncaught EISDIR stack trace.
            expect(code).toBe(1);
            expect(errLines.join('\n')).toMatch(/is not a regular file/);
            expect(errLines.join('\n')).toContain('a.md');
        } finally {
            restoreExit();
            restoreStderr();
            cleanup();
        }
    });

    it('never deletes a directory named by a corrupt manifest key', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeManifest(dest, {
            'a.md': { id: 1, title: 'a', current_revision_id: 1, media: false, body_sha256: sha256Hex('A') },
            'subdir': { id: 2, title: 'subdir', current_revision_id: 2, media: false, body_sha256: sha256Hex('G') },
        });
        fs.writeFileSync(path.join(dest, 'a.md'), 'A', 'utf8');
        fs.mkdirSync(path.join(dest, 'subdir'), { recursive: true });
        fs.writeFileSync(path.join(dest, 'subdir', 'keep.txt'), 'keep', 'utf8');

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'a', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'a', folder_path: 'marketing', current_revision_id: 1, properties: {}, body: 'A' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing', dest, { yes: true }, stubConfig()),
            );
            // A directory key must neither crash the pull nor remove the tree.
            expect(code).toBe(0);
            expect(fs.existsSync(path.join(dest, 'subdir', 'keep.txt'))).toBe(true);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('keeps and warns about an orphan that was modified locally', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeManifest(dest, {
            'a.md': { id: 1, title: 'a', current_revision_id: 1, media: false, body_sha256: sha256Hex('A') },
            'gone.md': { id: 2, title: 'gone', current_revision_id: 2, media: false, body_sha256: sha256Hex('G') },
        });
        fs.writeFileSync(path.join(dest, 'a.md'), 'A', 'utf8');
        fs.writeFileSync(path.join(dest, 'gone.md'), 'CHANGED', 'utf8');

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'a', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'a', folder_path: 'marketing', current_revision_id: 1, properties: {}, body: 'A' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            // --overwrite so the pre-existing local-modification refusal doesn't fire first.
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing', dest, { overwrite: true }, stubConfig()),
            );
            expect(code).toBe(0);

            expect(fs.readFileSync(path.join(dest, 'gone.md'), 'utf8')).toBe('CHANGED');
            const err = stderrLines.join('');
            expect(err).toContain('gone.md');
            expect(err).toContain('modified locally');
        } finally {
            restoreExit();
            restoreStdout();
            restoreStderr();
            cleanup();
        }
    });

    it('keeps an orphan whose manifest entry has body_sha256 null', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeManifest(dest, {
            'a.md': { id: 1, title: 'a', current_revision_id: 1, media: false, body_sha256: sha256Hex('A') },
            'gone.md': { id: 2, title: 'gone', current_revision_id: 2, media: false, body_sha256: null },
        });
        fs.writeFileSync(path.join(dest, 'a.md'), 'A', 'utf8');
        fs.writeFileSync(path.join(dest, 'gone.md'), 'anything', 'utf8');

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'a', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'a', folder_path: 'marketing', current_revision_id: 1, properties: {}, body: 'A' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing', dest, { overwrite: true }, stubConfig()),
            );
            expect(code).toBe(0);

            expect(fs.existsSync(path.join(dest, 'gone.md'))).toBe(true);
            expect(stderrLines.join('')).toContain('gone.md');
        } finally {
            restoreExit();
            restoreStdout();
            restoreStderr();
            cleanup();
        }
    });

    it('propagates no deletions when the manifest folder_path differs from the pull target', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeManifest(dest, {
            'unmodified.md': { id: 5, title: 'unmodified', current_revision_id: 1, media: false, body_sha256: sha256Hex('U') },
        }, 'other/folder');
        fs.writeFileSync(path.join(dest, 'unmodified.md'), 'U', 'utf8');

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'a', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'a', folder_path: 'marketing', current_revision_id: 1, properties: {}, body: 'A' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing', dest, { overwrite: true }, stubConfig()),
            );
            expect(code).toBe(0);

            // CRITICAL: the pre-existing unmodified file must survive — it belongs to a
            // DIFFERENT manifest folder_path than the one being pulled now.
            expect(fs.existsSync(path.join(dest, 'unmodified.md'))).toBe(true);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('propagates no deletions on the single-doc fallback path', async () => {
        // NOTE (cli#157, PM ruling 2): the orphan keeps a DIFFERENT id from the
        // pulled doc on purpose. Same id under a different path is a rename now
        // (removed when unmodified — see the cli#157 rename tests), so only a
        // true orphan (another id entirely) proves deletions are not propagated.
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeManifest(dest, {
            'unrelated.md': { id: 6, title: 'unrelated', current_revision_id: 1, media: false, body_sha256: sha256Hex('X') },
        }, 'notes');
        fs.writeFileSync(path.join(dest, 'unrelated.md'), 'X', 'utf8');

        responseQueue = [
            makeMcpError('folder_path_not_found', 'No folder at that path'),
            makeMcpSuccess({ id: 5, title: 'solo', body: 'x', current_revision_id: 3, folder_path: 'notes' }),
        ];

        try {
            const result = await runPullCli(['notes/solo', dest, '--overwrite']);
            expect(result.code).toBe(0);

            expect(fs.existsSync(path.join(dest, 'unrelated.md'))).toBe(true);
            expect(fs.readFileSync(path.join(dest, 'unrelated.md'), 'utf8')).toBe('X');
            expect(fs.readFileSync(path.join(dest, 'solo.md'), 'utf8')).toBe('x');
        } finally {
            cleanup();
        }
    });

    it('a media orphan whose bytes still match is deleted like any other orphan', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const mediaBytes = Buffer.from([1, 2, 3, 4]);
        writeManifest(dest, {
            'a.md': { id: 1, title: 'a', current_revision_id: 1, media: false, body_sha256: sha256Hex('A') },
            'hero.png': { id: 2, title: 'hero.png', current_revision_id: 2, media: true, body_sha256: sha256Hex(mediaBytes) },
        });
        fs.writeFileSync(path.join(dest, 'a.md'), 'A', 'utf8');
        fs.writeFileSync(path.join(dest, 'hero.png'), mediaBytes);

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'a', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'a', folder_path: 'marketing', current_revision_id: 1, properties: {}, body: 'A' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing', dest, { yes: true }, stubConfig()),
            );
            expect(code).toBe(0);

            expect(fs.existsSync(path.join(dest, 'hero.png'))).toBe(false);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('--json output contains removed and kept_modified', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeManifest(dest, {
            'a.md': { id: 1, title: 'a', current_revision_id: 1, media: false, body_sha256: sha256Hex('A') },
            'gone.md': { id: 2, title: 'gone', current_revision_id: 2, media: false, body_sha256: sha256Hex('G') },
            'kept.md': { id: 3, title: 'kept', current_revision_id: 3, media: false, body_sha256: sha256Hex('K') },
        });
        fs.writeFileSync(path.join(dest, 'a.md'), 'A', 'utf8');
        fs.writeFileSync(path.join(dest, 'gone.md'), 'G', 'utf8');
        fs.writeFileSync(path.join(dest, 'kept.md'), 'CHANGED', 'utf8');

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'a', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'a', folder_path: 'marketing', current_revision_id: 1, properties: {}, body: 'A' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { lines: logLines, restore: restoreStdout } = captureStdout();
        const { restore: restoreStderr } = captureStderr();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing', dest, { overwrite: true, json: true }, stubConfig()),
            );
            expect(code).toBe(0);

            const jsonLine = logLines.find((l) => l.trim().startsWith('{'));
            expect(jsonLine).toBeDefined();
            const parsed = JSON.parse(jsonLine!);
            expect(parsed.removed).toEqual(['gone.md']);
            expect(parsed.kept_modified).toEqual(['kept.md']);
        } finally {
            restoreExit();
            restoreStdout();
            restoreStderr();
            cleanup();
        }
    });

    it('never deletes through a directory symlink, even when the lexical path is contained', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const outsideDir = path.join(tmpDest, 'outside');
        fs.mkdirSync(outsideDir, { recursive: true });
        const outsideFile = path.join(outsideDir, 'x.png');
        const mediaBytes = Buffer.from([9, 9, 9]);
        fs.writeFileSync(outsideFile, mediaBytes);

        fs.mkdirSync(dest, { recursive: true });
        // dest/sub is a symlink to a directory OUTSIDE the pull destination.
        fs.symlinkSync(outsideDir, path.join(dest, 'sub'), 'dir');

        writeManifest(dest, {
            'a.md': { id: 1, title: 'a', current_revision_id: 1, media: false, body_sha256: sha256Hex('A') },
            // Lexically "dest/sub/x.png" is contained. Physically it resolves outside.
            'sub/x.png': { id: 2, title: 'x.png', current_revision_id: 2, media: true, body_sha256: sha256Hex(mediaBytes) },
        });
        fs.writeFileSync(path.join(dest, 'a.md'), 'A', 'utf8');

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'a', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'a', folder_path: 'marketing', current_revision_id: 1, properties: {}, body: 'A' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing', dest, { yes: true }, stubConfig()),
            );
            expect(code).toBe(0);

            // CRITICAL: the file outside the destination, reached only via the symlink,
            // must survive — the orphan's real parent directory is not under `dest`.
            expect(fs.existsSync(outsideFile)).toBe(true);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('a case-only rename over a hard-linked old name writes the new name by rename and removes the unmodified old name', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        fs.mkdirSync(dest, { recursive: true });

        // A hard link used to stand in for a case-only rename ("Readme" -> "readme") on a
        // case-insensitive filesystem. A pull now replaces a file through a rename, so the
        // link is an independent name: the new file is written at readme.md and the
        // unmodified old twin Readme.md is removed by rename cleanup.
        fs.writeFileSync(path.join(dest, 'readme.md'), 'BODY', 'utf8');
        fs.linkSync(path.join(dest, 'readme.md'), path.join(dest, 'Readme.md'));

        writeManifest(dest, {
            'Readme.md': { id: 1, title: 'Readme', current_revision_id: 1, media: false, body_sha256: sha256Hex('BODY') },
        });

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'readme', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'readme', folder_path: 'marketing', current_revision_id: 1, properties: {}, body: 'BODY' }],
            }),
        ];

        try {
            const result = await runPullCli(['marketing', dest, '--yes']);

            expect(result.code).toBe(0);
            expect(Object.keys(readManifest(dest).docs)).toEqual(['readme.md']);
            expect(fs.readFileSync(path.join(dest, 'readme.md'), 'utf8')).toBe('BODY');
            expect(fs.existsSync(path.join(dest, 'Readme.md'))).toBe(false);
        } finally {
            cleanup();
        }
    });

    it.skipIf(!caseInsensitiveFilesystem())('a case-only rename on one file under two names never deletes the file this pull just wrote (needs a case-insensitive filesystem; CI unit tests run on Linux)', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'Readme.md'), 'BODY', 'utf8');
        writeManifest(dest, {
            'Readme.md': { id: 1, title: 'Readme', current_revision_id: 1, media: false, body_sha256: sha256Hex('BODY') },
        });

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'readme', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'readme', folder_path: 'marketing', current_revision_id: 1, properties: {}, body: 'BODY' }],
            }),
        ];

        try {
            const result = await runPullCli(['marketing', dest, '--yes']);

            expect(result.code).toBe(0);
            expect(Object.keys(readManifest(dest).docs)).toEqual(['readme.md']);
            expect(fs.existsSync(path.join(dest, 'Readme.md'))).toBe(true);
            expect(fs.readFileSync(path.join(dest, 'readme.md'), 'utf8')).toBe('BODY');
        } finally {
            cleanup();
        }
    });

    it('a kept media orphan warns to use `doc upload`, not `doc push`, to re-create it', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const mediaBytes = Buffer.from([1, 2, 3]);
        writeManifest(dest, {
            'a.md': { id: 1, title: 'a', current_revision_id: 1, media: false, body_sha256: sha256Hex('A') },
            'hero.png': { id: 2, title: 'hero.png', current_revision_id: 2, media: true, body_sha256: sha256Hex(mediaBytes) },
        });
        fs.writeFileSync(path.join(dest, 'a.md'), 'A', 'utf8');
        // Locally modified: bytes no longer match the manifest hash.
        fs.writeFileSync(path.join(dest, 'hero.png'), Buffer.from([9, 9, 9, 9]));

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'a', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'a', folder_path: 'marketing', current_revision_id: 1, properties: {}, body: 'A' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing', dest, { overwrite: true }, stubConfig()),
            );
            expect(code).toBe(0);

            const err = stderrLines.join('');
            expect(err).toContain('hero.png');
            expect(err).toContain('doc upload');
            expect(err).not.toContain('doc push` will re-create it');
        } finally {
            restoreExit();
            restoreStdout();
            restoreStderr();
            cleanup();
        }
    });

    it('a kept non-media orphan still warns that `doc push` will re-create it', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeManifest(dest, {
            'a.md': { id: 1, title: 'a', current_revision_id: 1, media: false, body_sha256: sha256Hex('A') },
            'gone.md': { id: 2, title: 'gone', current_revision_id: 2, media: false, body_sha256: sha256Hex('G') },
        });
        fs.writeFileSync(path.join(dest, 'a.md'), 'A', 'utf8');
        fs.writeFileSync(path.join(dest, 'gone.md'), 'CHANGED', 'utf8');

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'a', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'a', folder_path: 'marketing', current_revision_id: 1, properties: {}, body: 'A' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing', dest, { overwrite: true }, stubConfig()),
            );
            expect(code).toBe(0);

            const err = stderrLines.join('');
            expect(err).toContain('gone.md');
            expect(err).toContain('doc push` will re-create it');
            expect(err).not.toContain('doc upload');
        } finally {
            restoreExit();
            restoreStdout();
            restoreStderr();
            cleanup();
        }
    });

    it('warns why deletions were not propagated: folder mismatch', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeManifest(dest, {
            'unmodified.md': { id: 5, title: 'unmodified', current_revision_id: 1, media: false, body_sha256: sha256Hex('U') },
        }, 'other/folder');
        fs.writeFileSync(path.join(dest, 'unmodified.md'), 'U', 'utf8');

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'a', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'a', folder_path: 'marketing', current_revision_id: 1, properties: {}, body: 'A' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing', dest, { overwrite: true }, stubConfig()),
            );
            expect(code).toBe(0);

            const err = stderrLines.join('');
            expect(err).toContain('deletions not propagated');
            expect(err).toContain('other/folder');
            expect(err).toContain('marketing');
        } finally {
            restoreExit();
            restoreStdout();
            restoreStderr();
            cleanup();
        }
    });

    it('warns why deletions were not propagated: single-doc fallback', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        writeManifest(dest, {
            'unrelated.md': { id: 5, title: 'unrelated', current_revision_id: 1, media: false, body_sha256: sha256Hex('X') },
        }, 'notes');
        fs.writeFileSync(path.join(dest, 'unrelated.md'), 'X', 'utf8');

        responseQueue = [
            makeMcpError('folder_path_not_found', 'No folder at that path'),
            makeMcpSuccess({ id: 5, title: 'solo', body: 'x', current_revision_id: 3, folder_path: 'notes' }),
        ];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('notes/solo', dest, { overwrite: true }, stubConfig()),
            );
            expect(code).toBe(0);

            const err = stderrLines.join('');
            expect(err).toContain('deletions not propagated');
            expect(err).toContain('single-doc pull');
        } finally {
            restoreExit();
            restoreStdout();
            restoreStderr();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// --json output
// ---------------------------------------------------------------------------

describe('docPullWithConfig — --json', () => {
    it('prints {manifest, files} JSON instead of chalk lines', async () => {
        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'brief', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'brief', folder_path: 'marketing/fb-campaign', current_revision_id: 10, properties: {}, body: '# Brief' }],
            }),
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const restoreExit = patchProcessExit();
        const { lines: logLines, restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing/fb-campaign', dest, { json: true }, stubConfig()),
            );
            expect(code).toBe(0);

            const jsonLine = logLines.find((l) => l.trim().startsWith('{'));
            expect(jsonLine).toBeDefined();
            const parsed = JSON.parse(jsonLine!);
            expect(parsed).toHaveProperty('manifest');
            expect(parsed).toHaveProperty('files');
            expect(parsed.files).toEqual([{ path: 'brief.md', action: 'written' }]);
            expect(parsed.manifest.docs['brief.md']).toEqual({ id: 1, title: 'brief', current_revision_id: 10, media: false, body_sha256: sha256Hex('# Brief') });
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Default destination
// ---------------------------------------------------------------------------

describe('docPullWithConfig — default destination', () => {
    it('defaults dest to ./<last-path-segment>/ when dest is omitted', async () => {
        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'brief', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'found', id: 1, title: 'brief', folder_path: 'marketing/fb-campaign', current_revision_id: 10, properties: {}, body: '# Brief' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const originalCwd = process.cwd();
        const { dir: tmpDest, cleanup } = makeTmpDir();
        process.chdir(tmpDest);

        try {
            const code = await runExpectingExit(() =>
                docPullWithConfig('marketing/fb-campaign', undefined, {}, stubConfig()),
            );
            expect(code).toBe(0);
            expect(fs.readFileSync(path.join(tmpDest, 'fb-campaign', 'brief.md'), 'utf8')).toBe('# Brief');
        } finally {
            process.chdir(originalCwd);
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Media docs
// ---------------------------------------------------------------------------

describe('docPullWithConfig — media docs', () => {
    it('downloads a media candidate confirmed by the media endpoint: bytes on disk, media: true, auth on confirm only', async () => {
        responseQueue = [
            makeMcpSuccess({
                folders: [],
                docs: [{ id: 7, title: 'hero.png', properties: { blob_sha: 'abc', mime: 'image/png', size: 3 } }],
            }),
            makeMcpSuccess({
                results: [{
                    index: 0, status: 'found', id: 7, title: 'hero.png', folder_path: '', current_revision_id: 9,
                    properties: { blob_sha: 'abc', mime: 'image/png', size: 3 }, body: '',
                }],
            }),
        ];
        mediaResponseQueue = [
            { status: 200, body: { url: `http://127.0.0.1:${stubPort}/blob/7`, mime: 'image/png', size: 3 } },
        ];
        const stubBytes = Buffer.from([1, 2, 3]);
        blobResponseQueue = [{ status: 200, bytes: stubBytes }];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() => docPullWithConfig('media', dest, {}, stubConfig()));
            expect(code).toBe(0);

            expect(fs.readFileSync(path.join(dest, 'hero.png'))).toEqual(stubBytes);

            const manifest = readManifest(dest);
            expect(manifest.docs['hero.png']).toEqual({ id: 7, title: 'hero.png', current_revision_id: 9, media: true, body_sha256: sha256Hex(stubBytes) });

            const confirmCall = allCaptures.find((c) => c.path === '/api/v1/docs/7/media');
            expect(confirmCall).toBeDefined();
            expect(confirmCall!.headers.authorization).toBe('Bearer test-api-key');

            const blobCall = allCaptures.find((c) => c.path === '/blob/7');
            expect(blobCall).toBeDefined();
            expect(blobCall!.headers.authorization).toBeUndefined();
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('false positive: candidate properties but media endpoint 404s media_not_found — falls back to writing the body as .md, media: false', async () => {
        responseQueue = [
            makeMcpSuccess({
                folders: [],
                docs: [{ id: 8, title: 'fake', properties: { blob_sha: 'abc', mime: 'image/png', size: 3 } }],
            }),
            makeMcpSuccess({
                results: [{
                    index: 0, status: 'found', id: 8, title: 'fake', folder_path: '', current_revision_id: 11,
                    properties: { blob_sha: 'abc', mime: 'image/png', size: 3 }, body: '',
                }],
            }),
        ];
        mediaResponseQueue = [
            { status: 404, body: { code: 'media_not_found', message: 'no media for this doc' } },
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() => docPullWithConfig('media', dest, {}, stubConfig()));
            expect(code).toBe(0);

            expect(fs.readFileSync(path.join(dest, 'fake.md'), 'utf8')).toBe('');

            const manifest = readManifest(dest);
            expect(manifest.docs['fake.md']).toEqual({ id: 8, title: 'fake', current_revision_id: 11, media: false, body_sha256: sha256Hex('') });

            // No signed-URL download was attempted.
            expect(allCaptures.find((c) => c.path?.startsWith('/blob/'))).toBeUndefined();
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('derives the file extension from mime when the title has none', async () => {
        responseQueue = [
            makeMcpSuccess({
                folders: [],
                docs: [{ id: 9, title: 'hero', properties: { blob_sha: 'abc', mime: 'image/png', size: 3 } }],
            }),
            makeMcpSuccess({
                results: [{
                    index: 0, status: 'found', id: 9, title: 'hero', folder_path: '', current_revision_id: 12,
                    properties: { blob_sha: 'abc', mime: 'image/png', size: 3 }, body: '',
                }],
            }),
        ];
        mediaResponseQueue = [
            { status: 200, body: { url: `http://127.0.0.1:${stubPort}/blob/9`, mime: 'image/png', size: 3 } },
        ];
        blobResponseQueue = [{ status: 200, bytes: Buffer.from([9, 9, 9]) }];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() => docPullWithConfig('media', dest, {}, stubConfig()));
            expect(code).toBe(0);

            expect(fs.existsSync(path.join(dest, 'hero.png'))).toBe(true);
            const manifest = readManifest(dest);
            expect(manifest.docs['hero.png']).toEqual({ id: 9, title: 'hero', current_revision_id: 12, media: true, body_sha256: sha256Hex(Buffer.from([9, 9, 9])) });
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('confirmed media whose signed-URL download fails: soft-skips the write, keeps the manifest entry, warns', async () => {
        responseQueue = [
            makeMcpSuccess({
                folders: [],
                docs: [{ id: 11, title: 'lost.png', properties: { blob_sha: 'abc', mime: 'image/png', size: 3 } }],
            }),
            makeMcpSuccess({
                results: [{
                    index: 0, status: 'found', id: 11, title: 'lost.png', folder_path: '', current_revision_id: 14,
                    properties: { blob_sha: 'abc', mime: 'image/png', size: 3 }, body: '',
                }],
            }),
        ];
        mediaResponseQueue = [
            { status: 200, body: { url: `http://127.0.0.1:${stubPort}/blob/11`, mime: 'image/png', size: 3 } },
        ];
        blobResponseQueue = [{ status: 500, bytes: Buffer.alloc(0) }];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            const code = await runExpectingExit(() => docPullWithConfig('media', dest, {}, stubConfig()));
            expect(code).toBe(0);

            expect(fs.existsSync(path.join(dest, 'lost.png'))).toBe(false);

            const manifest = readManifest(dest);
            expect(manifest.docs['lost.png']).toEqual({ id: 11, title: 'lost.png', current_revision_id: 14, media: true, body_sha256: null });

            expect(stderrLines.join('')).toContain('lost.png');
        } finally {
            restoreExit();
            restoreStdout();
            restoreStderr();
            cleanup();
        }
    });

    it('exits 1 on an unexpected media-confirm error (not the documented 404 media_not_found false positive)', async () => {
        responseQueue = [
            makeMcpSuccess({
                folders: [],
                docs: [{ id: 10, title: 'broken', properties: { blob_sha: 'abc', mime: 'image/png', size: 3 } }],
            }),
            makeMcpSuccess({
                results: [{
                    index: 0, status: 'found', id: 10, title: 'broken', folder_path: '', current_revision_id: 13,
                    properties: { blob_sha: 'abc', mime: 'image/png', size: 3 }, body: '',
                }],
            }),
        ];
        mediaResponseQueue = [
            { status: 500, body: { code: 'internal_error', message: 'boom' } },
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const restoreExit = patchProcessExit();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            const code = await runExpectingExit(() => docPullWithConfig('media', dest, {}, stubConfig()));
            expect(code).toBe(1);
            expect(stderrLines.join('')).toContain('internal_error');
            expect(fs.existsSync(path.join(dest, 'broken.md'))).toBe(false);
        } finally {
            restoreExit();
            restoreStderr();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Content hashes — body_sha256 recorded per manifest entry
// ---------------------------------------------------------------------------

describe('docPullWithConfig — content hashes', () => {
    it('records body_sha256 as the sha256 hex of the exact bytes written, for both a markdown doc and a media doc', async () => {
        const mdBody = '# Hashed Doc\n\nSome content.';
        const mediaBytes = Buffer.from([10, 20, 30, 40]);

        responseQueue = [
            makeMcpSuccess({
                folders: [],
                docs: [
                    { id: 1, title: 'hashed-doc', properties: {} },
                    { id: 2, title: 'hashed.png', properties: { blob_sha: 'abc', mime: 'image/png', size: mediaBytes.length } },
                ],
            }),
            makeMcpSuccess({
                results: [
                    { index: 0, status: 'found', id: 1, title: 'hashed-doc', folder_path: '', current_revision_id: 1, properties: {}, body: mdBody },
                    {
                        index: 1, status: 'found', id: 2, title: 'hashed.png', folder_path: '', current_revision_id: 2,
                        properties: { blob_sha: 'abc', mime: 'image/png', size: mediaBytes.length }, body: '',
                    },
                ],
            }),
        ];
        mediaResponseQueue = [
            { status: 200, body: { url: `http://127.0.0.1:${stubPort}/blob/2`, mime: 'image/png', size: mediaBytes.length } },
        ];
        blobResponseQueue = [{ status: 200, bytes: mediaBytes }];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() => docPullWithConfig('hash-tree', dest, {}, stubConfig()));
            expect(code).toBe(0);

            const manifest = readManifest(dest);
            expect(manifest.docs['hashed-doc.md'].body_sha256).toBe(sha256Hex(mdBody));
            expect(manifest.docs['hashed.png'].body_sha256).toBe(sha256Hex(mediaBytes));
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// bulk_read row-status guard
// ---------------------------------------------------------------------------

describe('docPullWithConfig — bulk_read row-status guard', () => {
    it('a non-ok status row and a row missing from results are both warned + skipped; the ok row still pulls', async () => {
        responseQueue = [
            makeMcpSuccess({
                folders: [],
                docs: [
                    { id: 1, title: 'good', properties: {} },
                    { id: 2, title: 'broken', properties: {} },
                    { id: 3, title: 'ghost', properties: {} },
                ],
            }),
            (body: any) => {
                const ids = body.params.arguments.items.map((i: any) => i.id);
                expect(ids).toEqual([1, 2, 3]);
                return makeMcpSuccess({
                    results: [
                        { index: 0, status: 'found', id: 1, title: 'good', folder_path: 'root', current_revision_id: 1, properties: {}, body: 'ok body' },
                        { index: 1, status: 'error', id: 2, title: 'broken', folder_path: 'root', error: 'boom' },
                        // id 3 ("ghost") is entirely absent from results.
                    ],
                });
            },
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            const code = await runExpectingExit(() => docPullWithConfig('root', dest, {}, stubConfig()));
            expect(code).toBe(0);

            expect(fs.readFileSync(path.join(dest, 'good.md'), 'utf8')).toBe('ok body');
            expect(fs.existsSync(path.join(dest, 'broken.md'))).toBe(false);
            expect(fs.existsSync(path.join(dest, 'ghost.md'))).toBe(false);

            const manifest = readManifest(dest);
            expect(Object.keys(manifest.docs)).toEqual(['good.md']);

            const err = stderrLines.join('');
            expect(err).toContain('broken');
            expect(err).toContain('ghost');
        } finally {
            restoreExit();
            restoreStdout();
            restoreStderr();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Folder-name path traversal (sanitizeSegment)
// ---------------------------------------------------------------------------

describe('docPullWithConfig — folder-name path traversal', () => {
    it('a folder named ".." is sanitized so the doc inside it lands under the destination', async () => {
        responseQueue = [
            makeMcpSuccess({
                folders: [{ id: 100, name: '..', parent_folder_id: 1, folder_path: 'evil/..' }],
                docs: [],
            }),
            makeMcpSuccess({
                folders: [],
                docs: [{ id: 1, title: 'gotcha', properties: {} }],
            }),
            makeMcpSuccess({
                results: [
                    { index: 0, status: 'found', id: 1, title: 'gotcha', folder_path: 'evil/..', current_revision_id: 1, properties: {}, body: 'x' },
                ],
            }),
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() => docPullWithConfig('evil', dest, {}, stubConfig()));
            expect(code).toBe(0);

            const manifest = readManifest(dest);
            const relPaths = Object.keys(manifest.docs);
            expect(relPaths.length).toBe(1);

            const writtenAbs = path.resolve(dest, relPaths[0]);
            expect(writtenAbs.startsWith(dest + path.sep)).toBe(true);
            expect(fs.existsSync(writtenAbs)).toBe(true);

            // Nothing was written outside the destination directory.
            const outsidePath = path.resolve(dest, '..', 'gotcha.md');
            expect(fs.existsSync(outsidePath)).toBe(false);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Destination resolves to an existing file
// ---------------------------------------------------------------------------

describe('docPullWithConfig — destination is a file', () => {
    it('exits 1 with a clear error instead of throwing ENOTDIR', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'not-a-dir');
        fs.writeFileSync(dest, 'i am a file', 'utf8');

        const restoreExit = patchProcessExit();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            const code = await runExpectingExit(() => docPullWithConfig('marketing/fb-campaign', dest, {}, stubConfig()));
            expect(code).toBe(1);
            expect(stderrLines.join('')).toMatch(/not a directory/i);
            expect(allCaptures.length).toBe(0);
        } finally {
            restoreExit();
            restoreStderr();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// cli#157: visual docs pull as .html, canvases as .canvas.json (spawned CLI)
// ---------------------------------------------------------------------------

describe('doc pull writes the right extension (cli#157)', () => {
    function mcpArgs(cap: CapturedRequest): any {
        return cap.body.params.arguments;
    }

    function readDocCalls(): CapturedRequest[] {
        return allCaptures.filter((cap) => cap.body?.params?.name === 'docs_read' && mcpArgs(cap).action === 'read_doc');
    }

    it('writes .html for visual, .canvas.json for canvas, .md otherwise', async () => {
        responseQueue = [
            (body: any) => {
                expect(body.params.arguments.action).toBe('list');
                return makeMcpSuccess({
                    folders: [],
                    docs: [
                        { id: 1, title: 'page', doc_type: { slug: 'visual' } },
                        { id: 2, title: 'board', doc_type: { slug: 'canvas' } },
                        { id: 3, title: 'notes', doc_type: null },
                        { id: 4, title: 'skill-doc', doc_type: { slug: 'skill' } },
                    ],
                });
            },
            (body: any) => {
                expect(body.params.arguments.action).toBe('bulk_read');
                return makeMcpSuccess({
                    results: [
                        { index: 0, status: 'found', id: 1, title: 'page', current_revision_id: 10, properties: {}, body: '<h1>Hi</h1>' },
                        { index: 1, status: 'found', id: 2, title: 'board', current_revision_id: 20, properties: {}, body: '{"nodes":[]}' },
                        { index: 2, status: 'found', id: 3, title: 'notes', current_revision_id: 30, properties: {}, body: '# Notes' },
                        { index: 3, status: 'found', id: 4, title: 'skill-doc', current_revision_id: 40, properties: {}, body: '# Skill' },
                    ],
                });
            },
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        try {
            const result = await runPullCli(['docs', path.join(tmpDest, 'out')]);
            expect(result.code).toBe(0);

            expect(fs.readFileSync(path.join(tmpDest, 'out', 'page.html'), 'utf8')).toBe('<h1>Hi</h1>');
            expect(fs.readFileSync(path.join(tmpDest, 'out', 'board.canvas.json'), 'utf8')).toBe('{"nodes":[]}');
            expect(fs.readFileSync(path.join(tmpDest, 'out', 'notes.md'), 'utf8')).toBe('# Notes');
            expect(fs.readFileSync(path.join(tmpDest, 'out', 'skill-doc.md'), 'utf8')).toBe('# Skill');

            const manifest = readManifest(path.join(tmpDest, 'out'));
            expect(Object.keys(manifest.docs).sort()).toEqual(['board.canvas.json', 'notes.md', 'page.html', 'skill-doc.md']);

            // Every row carried its type, so no read_doc backfill was needed.
            expect(readDocCalls()).toEqual([]);
        } finally {
            cleanup();
        }
    });

    it('asks read_doc for a list row without a doc_type key', async () => {
        responseQueue = [
            (body: any) => {
                expect(body.params.arguments.action).toBe('list');
                // Deliberately keyless (makeMcpSuccessRaw): the one fixture
                // that exercises the read_doc backfill for a row that omits
                // the key. Every other list fixture carries doc_type.
                return makeMcpSuccessRaw({
                    folders: [],
                    docs: [{ id: 5, title: 'mystery' }],
                });
            },
            (body: any) => {
                expect(body.params.arguments.action).toBe('bulk_read');
                return makeMcpSuccess({
                    results: [
                        { index: 0, status: 'found', id: 5, title: 'mystery', current_revision_id: 50, properties: {}, body: '{"cells":[]}' },
                    ],
                });
            },
            (body: any) => {
                expect(body.params.arguments.action).toBe('read_doc');
                expect(body.params.arguments.id).toBe(5);
                return makeMcpSuccess({ id: 5, title: 'mystery', doc_type: { slug: 'canvas' } });
            },
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        try {
            const result = await runPullCli(['docs', path.join(tmpDest, 'out')]);
            expect(result.code).toBe(0);

            expect(fs.readFileSync(path.join(tmpDest, 'out', 'mystery.canvas.json'), 'utf8')).toBe('{"cells":[]}');
            expect(readDocCalls().length).toBe(1);
        } finally {
            cleanup();
        }
    });

    it('a successful read_doc reporting doc_type null writes .md with no unreadable-type warning', async () => {
        responseQueue = [
            (body: any) => {
                expect(body.params.arguments.action).toBe('list');
                return makeMcpSuccessRaw({
                    folders: [],
                    docs: [{ id: 6, title: 'plain' }],
                });
            },
            (body: any) => {
                expect(body.params.arguments.action).toBe('bulk_read');
                return makeMcpSuccess({
                    results: [
                        { index: 0, status: 'found', id: 6, title: 'plain', current_revision_id: 60, properties: {}, body: '# Plain' },
                    ],
                });
            },
            (body: any) => {
                expect(body.params.arguments.action).toBe('read_doc');
                return makeMcpSuccess({ id: 6, title: 'plain', doc_type: null });
            },
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        try {
            const result = await runPullCli(['docs', path.join(tmpDest, 'out')]);
            expect(result.code).toBe(0);

            expect(fs.readFileSync(path.join(tmpDest, 'out', 'plain.md'), 'utf8')).toBe('# Plain');
            expect(readDocCalls().length).toBe(1);
            expect(result.stderr).not.toContain('could not read the type');
        } finally {
            cleanup();
        }
    });

    it('a failed read_doc still warns that the type could not be read', async () => {
        responseQueue = [
            (body: any) => {
                expect(body.params.arguments.action).toBe('list');
                return makeMcpSuccessRaw({
                    folders: [],
                    docs: [{ id: 7, title: 'broken-type' }],
                });
            },
            (body: any) => {
                expect(body.params.arguments.action).toBe('bulk_read');
                return makeMcpSuccess({
                    results: [
                        { index: 0, status: 'found', id: 7, title: 'broken-type', current_revision_id: 70, properties: {}, body: '# B' },
                    ],
                });
            },
            (body: any) => {
                expect(body.params.arguments.action).toBe('read_doc');
                return makeMcpError('type_unavailable', 'no type for you');
            },
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        try {
            const result = await runPullCli(['docs', path.join(tmpDest, 'out')]);
            expect(result.code).toBe(0);

            expect(fs.readFileSync(path.join(tmpDest, 'out', 'broken-type.md'), 'utf8')).toBe('# B');
            expect(result.stderr).toContain('could not read the type of doc 7 (broken-type)');
        } finally {
            cleanup();
        }
    });

    it('writes a single pulled visual doc as <title>.html', async () => {
        responseQueue = [
            (body: any) => {
                expect(body.params.arguments.action).toBe('list');
                return makeMcpError('folder_path_not_found', 'no such folder');
            },
            (body: any) => {
                expect(body.params.arguments.action).toBe('read_doc');
                return makeMcpSuccess({
                    id: 7, title: 'page', folder_path: 'docs', body: '<h1>Solo</h1>',
                    current_revision_id: 70, properties: {}, doc_type: { slug: 'visual' },
                });
            },
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        try {
            const result = await runPullCli(['docs/page', path.join(tmpDest, 'out')]);
            expect(result.code).toBe(0);

            expect(fs.readFileSync(path.join(tmpDest, 'out', 'page.html'), 'utf8')).toBe('<h1>Solo</h1>');
        } finally {
            cleanup();
        }
    });

    it('collides per extension: page.html + page.md, x.html + x-2.html', async () => {
        responseQueue = [
            (body: any) => {
                expect(body.params.arguments.action).toBe('list');
                return makeMcpSuccess({
                    folders: [],
                    docs: [
                        { id: 1, title: 'page', doc_type: { slug: 'visual' } },
                        { id: 2, title: 'page', doc_type: null },
                        { id: 3, title: 'x', doc_type: { slug: 'visual' } },
                        { id: 4, title: 'x', doc_type: { slug: 'visual' } },
                    ],
                });
            },
            (body: any) => {
                expect(body.params.arguments.action).toBe('bulk_read');
                return makeMcpSuccess({
                    results: [
                        { index: 0, status: 'found', id: 1, title: 'page', current_revision_id: 10, properties: {}, body: '<h1>P</h1>' },
                        { index: 1, status: 'found', id: 2, title: 'page', current_revision_id: 20, properties: {}, body: '# P' },
                        { index: 2, status: 'found', id: 3, title: 'x', current_revision_id: 30, properties: {}, body: '<h1>X1</h1>' },
                        { index: 3, status: 'found', id: 4, title: 'x', current_revision_id: 40, properties: {}, body: '<h1>X2</h1>' },
                    ],
                });
            },
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        try {
            const result = await runPullCli(['docs', path.join(tmpDest, 'out')]);
            expect(result.code).toBe(0);

            expect(fs.readFileSync(path.join(tmpDest, 'out', 'page.html'), 'utf8')).toBe('<h1>P</h1>');
            expect(fs.readFileSync(path.join(tmpDest, 'out', 'page.md'), 'utf8')).toBe('# P');
            expect(fs.readFileSync(path.join(tmpDest, 'out', 'x.html'), 'utf8')).toBe('<h1>X1</h1>');
            expect(fs.readFileSync(path.join(tmpDest, 'out', 'x-2.html'), 'utf8')).toBe('<h1>X2</h1>');
        } finally {
            cleanup();
        }
    });

    /** Pre-seed a destination whose manifest tracks doc 5 at page.md. */
    function seedRenameDir(dir: string, pageBody: string): void {
        const dest = path.join(dir, 'out');
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'page.md'), pageBody, 'utf8');
        const manifest: DocsManifest = {
            folder_path: 'docs',
            docs: {
                'page.md': { id: 5, title: 'page', current_revision_id: 7, media: false, body_sha256: sha256Hex('# Old') },
            },
        };
        fs.writeFileSync(path.join(dest, DOCS_MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    }

    function renameQueue(servedBody: string, extraListDoc?: object, extraBulkRow?: object): Array<string | ((body: any) => string)> {
        const docs: object[] = [{ id: 5, title: 'page', doc_type: { slug: 'visual' } }];
        const results: object[] = [
            { index: 0, status: 'found', id: 5, title: 'page', current_revision_id: 8, properties: {}, body: servedBody },
        ];
        if (extraListDoc !== undefined && extraBulkRow !== undefined) {
            docs.push(extraListDoc);
            results.push(extraBulkRow);
        }
        return [
            (body: any) => {
                expect(body.params.arguments.action).toBe('list');
                return makeMcpSuccess({ folders: [], docs });
            },
            (body: any) => {
                expect(body.params.arguments.action).toBe('bulk_read');
                return makeMcpSuccess({ results });
            },
        ];
    }

    it('rename, unmodified: stale page.md removed after page.html is written', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        try {
            seedRenameDir(tmpDest, '# Old');
            responseQueue = renameQueue('<h1>Old</h1>');

            const result = await runPullCli(['docs', path.join(tmpDest, 'out'), '--yes']);
            expect(result.code).toBe(0);

            expect(fs.readFileSync(path.join(tmpDest, 'out', 'page.html'), 'utf8')).toBe('<h1>Old</h1>');
            expect(fs.existsSync(path.join(tmpDest, 'out', 'page.md'))).toBe(false);

            const manifest = readManifest(path.join(tmpDest, 'out'));
            expect(Object.keys(manifest.docs)).toEqual(['page.html']);
            expect(manifest.docs['page.html'].id).toBe(5);

            expect(result.stdout).not.toContain('deleted remotely');
            expect(result.stderr).not.toContain('deleted remotely');
        } finally {
            cleanup();
        }
    });

    it('rename, unmodified: a new doc taking page.md keeps it', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        try {
            seedRenameDir(tmpDest, '# Old');
            responseQueue = renameQueue(
                '<h1>Old</h1>',
                { id: 6, title: 'page', doc_type: null },
                { index: 1, status: 'found', id: 6, title: 'page', current_revision_id: 60, properties: {}, body: '# Six' },
            );

            const result = await runPullCli(['docs', path.join(tmpDest, 'out'), '--yes']);
            expect(result.code).toBe(0);

            expect(fs.readFileSync(path.join(tmpDest, 'out', 'page.html'), 'utf8')).toBe('<h1>Old</h1>');
            expect(fs.readFileSync(path.join(tmpDest, 'out', 'page.md'), 'utf8')).toBe('# Six');

            const manifest = readManifest(path.join(tmpDest, 'out'));
            expect(manifest.docs['page.html'].id).toBe(5);
            expect(manifest.docs['page.md'].id).toBe(6);

            expect(result.stdout).not.toContain('deleted remotely');
            expect(result.stderr).not.toContain('deleted remotely');
        } finally {
            cleanup();
        }
    });

    it('rename, modified: refuses before anything is written', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        try {
            seedRenameDir(tmpDest, '# Old EDITED');
            responseQueue = renameQueue('<h1>Old</h1>');

            const result = await runPullCli(['docs', path.join(tmpDest, 'out'), '--yes']);
            expect(result.code).toBe(1);

            expect(result.stderr).toContain('page.md');
            expect(result.stderr).toContain('page.html');
            expect(result.stderr).toMatch(/push|move/i);
            expect(result.stderr).toContain('doc 5');

            expect(fs.existsSync(path.join(tmpDest, 'out', 'page.html'))).toBe(false);
            expect(fs.readFileSync(path.join(tmpDest, 'out', 'page.md'), 'utf8')).toBe('# Old EDITED');
            const manifest = readManifest(path.join(tmpDest, 'out'));
            expect(Object.keys(manifest.docs)).toEqual(['page.md']);
        } finally {
            cleanup();
        }
    });

    it('rename, modified with --overwrite: refuses and preserves the edited file and manifest', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        try {
            seedRenameDir(tmpDest, '# Old EDITED');
            const manifestBefore = fs.readFileSync(path.join(tmpDest, 'out', DOCS_MANIFEST), 'utf8');
            responseQueue = renameQueue('<h1>Old</h1>');

            const result = await runPullCli(['docs', path.join(tmpDest, 'out'), '--overwrite']);
            expect(result.code).toBe(1);

            expect(fs.existsSync(path.join(tmpDest, 'out', 'page.html'))).toBe(false);
            expect(fs.readFileSync(path.join(tmpDest, 'out', 'page.md'), 'utf8')).toBe('# Old EDITED');
            expect(result.stderr).toContain('page.md');
            expect(result.stderr).toContain('page.html');
            expect(result.stderr).toContain('doc 5');
            expect(result.stderr).toMatch(/push|move/i);
            expect(result.stderr).not.toMatch(/untracked/i);
            expect(result.stdout).not.toContain('pulled');
            expect(fs.readFileSync(path.join(tmpDest, 'out', DOCS_MANIFEST), 'utf8')).toBe(manifestBefore);

            const manifest = readManifest(path.join(tmpDest, 'out'));
            expect(Object.keys(manifest.docs)).toEqual(['page.md']);

            expect(result.stdout).not.toContain('deleted remotely');
            expect(result.stderr).not.toContain('deleted remotely');
        } finally {
            cleanup();
        }
    });

    it('rename collision with --overwrite: refuses before any write when another doc takes the edited source path', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        try {
            seedRenameDir(tmpDest, '# Old EDITED');
            // Doc 5 moves page.md -> page.html; a different doc (6) now takes page.md.
            responseQueue = renameQueue(
                '<h1>Old</h1>',
                { id: 6, title: 'page', doc_type: null },
                { index: 1, status: 'found', id: 6, title: 'page', current_revision_id: 60, properties: {}, body: '# Six' },
            );

            const result = await runPullCli(['docs', path.join(tmpDest, 'out'), '--overwrite']);
            expect(result.code).toBe(1);

            // Nothing was written: the edited bytes are unchanged, no new file
            // exists, and the manifest still tracks only the old path.
            expect(fs.readFileSync(path.join(tmpDest, 'out', 'page.md'), 'utf8')).toBe('# Old EDITED');
            expect(fs.existsSync(path.join(tmpDest, 'out', 'page.html'))).toBe(false);
            const manifest = readManifest(path.join(tmpDest, 'out'));
            expect(Object.keys(manifest.docs)).toEqual(['page.md']);
            expect(manifest.docs['page.md'].id).toBe(5);

            // The refusal names both docs and tells the user how to proceed.
            expect(result.stderr).toContain('page.md');
            expect(result.stderr).toContain('page.html');
            expect(result.stderr).toContain('doc 5');
            expect(result.stderr).toContain('doc 6');
            expect(result.stderr).toMatch(/push it first/);
            expect(result.stderr).not.toMatch(/untracked/);
        } finally {
            cleanup();
        }
    });

    it('single-doc rename, unmodified: no stale page.md twin', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        try {
            seedRenameDir(tmpDest, '# Old');
            responseQueue = [
                (body: any) => {
                    expect(body.params.arguments.action).toBe('list');
                    return makeMcpError('folder_path_not_found', 'no such folder');
                },
                (body: any) => {
                    expect(body.params.arguments.action).toBe('read_doc');
                    return makeMcpSuccess({
                        id: 5, title: 'page', folder_path: 'docs', body: '<h1>Old</h1>',
                        current_revision_id: 8, properties: {}, doc_type: { slug: 'visual' },
                    });
                },
            ];

            const result = await runPullCli(['docs/page', path.join(tmpDest, 'out'), '--yes']);
            expect(result.code).toBe(0);

            expect(fs.readFileSync(path.join(tmpDest, 'out', 'page.html'), 'utf8')).toBe('<h1>Old</h1>');
            expect(fs.existsSync(path.join(tmpDest, 'out', 'page.md'))).toBe(false);

            const manifest = readManifest(path.join(tmpDest, 'out'));
            expect(manifest.docs['page.html'].id).toBe(5);
            expect(manifest.docs['page.md']).toBeUndefined();
        } finally {
            cleanup();
        }
    });

    it('single-doc rename, modified: refuses', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        try {
            seedRenameDir(tmpDest, '# Old EDITED');
            responseQueue = [
                (body: any) => {
                    expect(body.params.arguments.action).toBe('list');
                    return makeMcpError('folder_path_not_found', 'no such folder');
                },
                (body: any) => {
                    expect(body.params.arguments.action).toBe('read_doc');
                    return makeMcpSuccess({
                        id: 5, title: 'page', folder_path: 'docs', body: '<h1>Old</h1>',
                        current_revision_id: 8, properties: {}, doc_type: { slug: 'visual' },
                    });
                },
            ];

            const result = await runPullCli(['docs/page', path.join(tmpDest, 'out'), '--yes']);
            expect(result.code).toBe(1);

            expect(result.stderr).toContain('page.md');
            expect(result.stderr).toContain('page.html');
            expect(fs.existsSync(path.join(tmpDest, 'out', 'page.html'))).toBe(false);
            expect(fs.readFileSync(path.join(tmpDest, 'out', 'page.md'), 'utf8')).toBe('# Old EDITED');
        } finally {
            cleanup();
        }
    });

    /** Pre-seed a destination whose manifest tracks media doc 7 at old.png. */
    function seedMediaRenameDir(dir: string, oldBytes: Buffer): void {
        const dest = path.join(dir, 'out');
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'old.png'), oldBytes);
        const manifest: DocsManifest = {
            folder_path: 'docs',
            docs: {
                'old.png': { id: 7, title: 'old.png', current_revision_id: 10, media: true, body_sha256: sha256Hex(oldBytes) },
            },
        };
        fs.writeFileSync(path.join(dest, DOCS_MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    }

    const MEDIA_BLOB_PROPS = { blob_sha: 'abc', mime: 'image/png', size: 4 };

    it('rename, failed media download (folder pull): keeps old.png bytes and tracks the old path', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        try {
            const oldBytes = Buffer.from([7, 7, 7, 7]);
            seedMediaRenameDir(tmpDest, oldBytes);
            responseQueue = [
                makeMcpSuccess({
                    folders: [],
                    docs: [{ id: 7, title: 'new.png', properties: MEDIA_BLOB_PROPS }],
                }),
                makeMcpSuccess({
                    results: [{
                        index: 0, status: 'found', id: 7, title: 'new.png', current_revision_id: 11,
                        properties: MEDIA_BLOB_PROPS, body: '',
                    }],
                }),
            ];
            mediaResponseQueue = [
                { status: 200, body: { url: `http://127.0.0.1:${stubPort}/blob/7`, mime: 'image/png', size: 4 } },
            ];
            blobResponseQueue = [{ status: 503, bytes: Buffer.alloc(0) }];

            const result = await runPullCli(['docs', path.join(tmpDest, 'out'), '--yes']);
            expect(result.code).toBe(0);
            expect(result.stderr).toContain('failed to download media');

            // The only good copy survives: old bytes unchanged, no replacement written.
            expect(fs.readFileSync(path.join(tmpDest, 'out', 'old.png'))).toEqual(oldBytes);
            expect(fs.existsSync(path.join(tmpDest, 'out', 'new.png'))).toBe(false);

            // Tracking stays recoverable: the old path with its old hash, no unwritten new path.
            const manifest = readManifest(path.join(tmpDest, 'out'));
            expect(Object.keys(manifest.docs)).toEqual(['old.png']);
            expect(manifest.docs['old.png']).toEqual({ id: 7, title: 'old.png', current_revision_id: 10, media: true, body_sha256: sha256Hex(oldBytes) });
        } finally {
            cleanup();
        }
    });

    it('rename, failed media download (single-doc pull): keeps old.png bytes and tracks the old path', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        try {
            const oldBytes = Buffer.from([7, 7, 7, 7]);
            seedMediaRenameDir(tmpDest, oldBytes);
            responseQueue = [
                (body: any) => {
                    expect(body.params.arguments.action).toBe('list');
                    return makeMcpError('folder_path_not_found', 'no such folder');
                },
                (body: any) => {
                    expect(body.params.arguments.action).toBe('read_doc');
                    return makeMcpSuccess({
                        id: 7, title: 'new.png', folder_path: 'docs', body: '',
                        current_revision_id: 11, properties: MEDIA_BLOB_PROPS, doc_type: null,
                    });
                },
            ];
            mediaResponseQueue = [
                { status: 200, body: { url: `http://127.0.0.1:${stubPort}/blob/7`, mime: 'image/png', size: 4 } },
            ];
            blobResponseQueue = [{ status: 503, bytes: Buffer.alloc(0) }];

            const result = await runPullCli(['docs/old', path.join(tmpDest, 'out'), '--yes']);
            expect(result.code).toBe(0);
            expect(result.stderr).toContain('failed to download media');

            expect(fs.readFileSync(path.join(tmpDest, 'out', 'old.png'))).toEqual(oldBytes);
            expect(fs.existsSync(path.join(tmpDest, 'out', 'new.png'))).toBe(false);

            const manifest = readManifest(path.join(tmpDest, 'out'));
            expect(Object.keys(manifest.docs)).toEqual(['old.png']);
            expect(manifest.docs['old.png']).toEqual({ id: 7, title: 'old.png', current_revision_id: 10, media: true, body_sha256: sha256Hex(oldBytes) });
        } finally {
            cleanup();
        }
    });
});

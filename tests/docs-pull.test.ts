/**
 * Tests for `solidactions docs pull <folder> [dest]`
 *
 * Uses a real in-process HTTP server (Node's http.createServer) to stub the
 * unified /mcp endpoint. No mock/spy/stub libraries — follows the pattern in
 * tests/docs-push.test.ts.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import prompts from 'prompts';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { docsPullWithConfig, sanitizeTitle, DOCS_MANIFEST } from '../src/commands/docs-pull';
import type { DocsManifest } from '../src/commands/docs-pull';
import type { Config } from '../src/utils/config';

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

/** Build a canned MCP success response wrapping toolData. */
function makeMcpSuccess(toolData: object): string {
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

describe('docsPullWithConfig — folder tree', () => {
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
                        { index: 0, status: 'ok', id: 1, title: 'brief', folder_path: 'marketing/fb-campaign', current_revision_id: 10, properties: {}, body: '# Brief' },
                        { index: 1, status: 'ok', id: 2, title: 'ad-a', folder_path: 'marketing/fb-campaign/ads', current_revision_id: 20, properties: {}, body: '# Ad A' },
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
                docsPullWithConfig('marketing/fb-campaign', dest, {}, stubConfig()),
            );
            expect(code).toBe(0);

            expect(fs.readFileSync(path.join(dest, 'brief.md'), 'utf8')).toBe('# Brief');
            expect(fs.readFileSync(path.join(dest, 'ads', 'ad-a.md'), 'utf8')).toBe('# Ad A');

            const manifest = readManifest(dest);
            expect(manifest.docs['brief.md']).toEqual({ id: 1, title: 'brief', current_revision_id: 10, media: false });
            expect(manifest.docs['ads/ad-a.md']).toEqual({ id: 2, title: 'ad-a', current_revision_id: 20, media: false });
            expect(manifest.folder_path).toBe('marketing/fb-campaign');

            // Manifest file itself is pretty-printed with a trailing newline
            const raw = fs.readFileSync(path.join(dest, DOCS_MANIFEST), 'utf8');
            expect(raw.endsWith('\n')).toBe(true);
            expect(raw).toContain('\n  ');

            // All requests hit /mcp with docs_vault
            expect(allCaptures.length).toBe(3);
            for (const cap of allCaptures) {
                expect(cap.path).toBe('/mcp');
                expect(cap.body.params.name).toBe('docs_vault');
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
                        index: i, status: 'ok', id: it.id, title: `doc-${it.id}`,
                        folder_path: 'many', current_revision_id: it.id * 10, properties: {}, body: `body-${it.id}`,
                    })),
                });
            },
            (body: any) => {
                const items = body.params.arguments.items;
                return makeMcpSuccess({
                    results: items.map((it: any, i: number) => ({
                        index: i, status: 'ok', id: it.id, title: `doc-${it.id}`,
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
            const code = await runExpectingExit(() => docsPullWithConfig('many', dest, {}, stubConfig()));
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

describe('docsPullWithConfig — title collisions', () => {
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
                        { index: 0, status: 'ok', id: 1, title: 'Same', folder_path: 'root', current_revision_id: 1, properties: {}, body: 'one' },
                        { index: 1, status: 'ok', id: 2, title: 'Same', folder_path: 'root', current_revision_id: 2, properties: {}, body: 'two' },
                        { index: 2, status: 'ok', id: 3, title: 'Same', folder_path: 'root/sub', current_revision_id: 3, properties: {}, body: 'three' },
                    ],
                });
            },
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() => docsPullWithConfig('root', dest, {}, stubConfig()));
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

describe('docsPullWithConfig — single-doc fallback', () => {
    it('falls back to a single read when list 404s with folder_path_not_found', async () => {
        responseQueue = [
            (body: any) => {
                expect(body.params.arguments.action).toBe('list');
                expect(body.params.arguments.folder_path).toBe('notes/solo');
                return makeMcpError('folder_path_not_found', 'No folder at that path');
            },
            (body: any) => {
                expect(body.params.arguments.action).toBe('read');
                expect(body.params.arguments.path).toEqual({ folder_path: 'notes', title: 'solo' });
                return makeMcpSuccess({ id: 5, title: 'solo', body: 'x', current_revision_id: 3, folder_path: 'notes' });
            },
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() => docsPullWithConfig('notes/solo', dest, {}, stubConfig()));
            expect(code).toBe(0);

            expect(fs.readFileSync(path.join(dest, 'solo.md'), 'utf8')).toBe('x');
            const manifest = readManifest(dest);
            expect(Object.keys(manifest.docs).length).toBe(1);
            expect(manifest.docs['solo.md']).toEqual({ id: 5, title: 'solo', current_revision_id: 3, media: false });

            expect(allCaptures.length).toBe(2);
        } finally {
            restoreExit();
            restoreStdout();
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
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() => docsPullWithConfig('solo', dest, {}, stubConfig()));
            expect(code).toBe(0);
            expect(fs.readFileSync(path.join(dest, 'solo.md'), 'utf8')).toBe('x');
        } finally {
            restoreExit();
            restoreStdout();
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
            const code = await runExpectingExit(() => docsPullWithConfig('notes/ghost', dest, {}, stubConfig()));
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
            const code = await runExpectingExit(() => docsPullWithConfig('marketing/fb-campaign', dest, {}, stubConfig()));
            expect(code).not.toBe(0);
            expect(allCaptures.length).toBe(1);
            expect(stderrLines.join('')).toContain('permission_denied');
        } finally {
            restoreExit();
            restoreStderr();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Overwrite confirmation
// ---------------------------------------------------------------------------

describe('docsPullWithConfig — overwrite confirm', () => {
    it('non-empty dest without --yes: declining the prompt exits 0 and writes nothing', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'existing.txt'), 'hi', 'utf8');

        responseQueue = [
            makeMcpSuccess({
                folders: [],
                docs: [{ id: 1, title: 'brief', properties: {} }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { lines: logLines, restore: restoreStdout } = captureStdout();

        try {
            prompts.inject([false]);
            const code = await runExpectingExit(() => docsPullWithConfig('marketing/fb-campaign', dest, {}, stubConfig()));
            expect(code).toBe(0);

            // No MCP calls at all — confirmation happens before any network I/O
            expect(allCaptures.length).toBe(0);
            // Existing file untouched, no manifest written
            expect(fs.existsSync(path.join(dest, 'existing.txt'))).toBe(true);
            expect(fs.existsSync(path.join(dest, DOCS_MANIFEST))).toBe(false);
            expect(fs.existsSync(path.join(dest, 'brief.md'))).toBe(false);
            expect(logLines.join('\n')).toContain('Cancelled');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('--yes bypasses the confirmation on a non-empty dest', async () => {
        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'existing.txt'), 'hi', 'utf8');

        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'brief', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'ok', id: 1, title: 'brief', folder_path: 'marketing/fb-campaign', current_revision_id: 10, properties: {}, body: '# Brief' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() =>
                docsPullWithConfig('marketing/fb-campaign', dest, { yes: true }, stubConfig()),
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
// --json output
// ---------------------------------------------------------------------------

describe('docsPullWithConfig — --json', () => {
    it('prints {manifest, files} JSON instead of chalk lines', async () => {
        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'brief', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'ok', id: 1, title: 'brief', folder_path: 'marketing/fb-campaign', current_revision_id: 10, properties: {}, body: '# Brief' }],
            }),
        ];

        const { dir: tmpDest, cleanup } = makeTmpDir();
        const dest = path.join(tmpDest, 'out');
        const restoreExit = patchProcessExit();
        const { lines: logLines, restore: restoreStdout } = captureStdout();

        try {
            const code = await runExpectingExit(() =>
                docsPullWithConfig('marketing/fb-campaign', dest, { json: true }, stubConfig()),
            );
            expect(code).toBe(0);

            const jsonLine = logLines.find((l) => l.trim().startsWith('{'));
            expect(jsonLine).toBeDefined();
            const parsed = JSON.parse(jsonLine!);
            expect(parsed).toHaveProperty('manifest');
            expect(parsed).toHaveProperty('files');
            expect(parsed.files).toEqual([{ path: 'brief.md', action: 'written' }]);
            expect(parsed.manifest.docs['brief.md']).toEqual({ id: 1, title: 'brief', current_revision_id: 10, media: false });
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

describe('docsPullWithConfig — default destination', () => {
    it('defaults dest to ./<last-path-segment>/ when dest is omitted', async () => {
        responseQueue = [
            makeMcpSuccess({ folders: [], docs: [{ id: 1, title: 'brief', properties: {} }] }),
            makeMcpSuccess({
                results: [{ index: 0, status: 'ok', id: 1, title: 'brief', folder_path: 'marketing/fb-campaign', current_revision_id: 10, properties: {}, body: '# Brief' }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const originalCwd = process.cwd();
        const { dir: tmpDest, cleanup } = makeTmpDir();
        process.chdir(tmpDest);

        try {
            const code = await runExpectingExit(() =>
                docsPullWithConfig('marketing/fb-campaign', undefined, {}, stubConfig()),
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

describe('docsPullWithConfig — media docs', () => {
    it('downloads a media candidate confirmed by the media endpoint: bytes on disk, media: true, auth on confirm only', async () => {
        responseQueue = [
            makeMcpSuccess({
                folders: [],
                docs: [{ id: 7, title: 'hero.png', properties: { blob_sha: 'abc', mime: 'image/png', size: 3 } }],
            }),
            makeMcpSuccess({
                results: [{
                    index: 0, status: 'ok', id: 7, title: 'hero.png', folder_path: '', current_revision_id: 9,
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
            const code = await runExpectingExit(() => docsPullWithConfig('media', dest, {}, stubConfig()));
            expect(code).toBe(0);

            expect(fs.readFileSync(path.join(dest, 'hero.png'))).toEqual(stubBytes);

            const manifest = readManifest(dest);
            expect(manifest.docs['hero.png']).toEqual({ id: 7, title: 'hero.png', current_revision_id: 9, media: true });

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
                    index: 0, status: 'ok', id: 8, title: 'fake', folder_path: '', current_revision_id: 11,
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
            const code = await runExpectingExit(() => docsPullWithConfig('media', dest, {}, stubConfig()));
            expect(code).toBe(0);

            expect(fs.readFileSync(path.join(dest, 'fake.md'), 'utf8')).toBe('');

            const manifest = readManifest(dest);
            expect(manifest.docs['fake.md']).toEqual({ id: 8, title: 'fake', current_revision_id: 11, media: false });

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
                    index: 0, status: 'ok', id: 9, title: 'hero', folder_path: '', current_revision_id: 12,
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
            const code = await runExpectingExit(() => docsPullWithConfig('media', dest, {}, stubConfig()));
            expect(code).toBe(0);

            expect(fs.existsSync(path.join(dest, 'hero.png'))).toBe(true);
            const manifest = readManifest(dest);
            expect(manifest.docs['hero.png']).toEqual({ id: 9, title: 'hero', current_revision_id: 12, media: true });
        } finally {
            restoreExit();
            restoreStdout();
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
                    index: 0, status: 'ok', id: 10, title: 'broken', folder_path: '', current_revision_id: 13,
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
            const code = await runExpectingExit(() => docsPullWithConfig('media', dest, {}, stubConfig()));
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

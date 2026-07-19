/**
 * Tests for `solidactions docs push <dir>`
 *
 * Uses a real in-process HTTP server (Node's http.createServer) to stub the
 * /mcp/docs endpoint.  No mock/spy/stub libraries — follows the pattern in
 * skill-push.test.ts.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { docsPushWithConfig } from '../src/commands/docs-push';
import type { DocsPushOptions } from '../src/commands/docs-push';
import type { Config } from '../src/utils/config';
import { DOCS_MANIFEST, sha256Hex } from '../src/commands/docs-pull';
import type { DocsManifest } from '../src/commands/docs-pull';

// ---------------------------------------------------------------------------
// Stub MCP server
// ---------------------------------------------------------------------------

interface CapturedRequest {
    method: string | undefined;
    path: string | undefined;
    headers: http.IncomingHttpHeaders;
    body: any;
    /** Populated only for multipart/form-data requests (the media POST). */
    parts?: MultipartPart[];
}

// ---------------------------------------------------------------------------
// Minimal multipart/form-data parser — just enough to assert field names,
// filenames, and values in tests. Pattern copied from docs-upload.test.ts.
// ---------------------------------------------------------------------------

interface MultipartPart {
    name: string;
    filename?: string;
    value: string;
}

function parseMultipart(body: Buffer, contentType: string | undefined): MultipartPart[] {
    const boundaryMatch = contentType?.match(/boundary=(.+)$/);
    if (!boundaryMatch) return [];
    const boundary = `--${boundaryMatch[1]}`;
    const bodyStr = body.toString('binary');
    const rawParts = bodyStr.split(boundary).slice(1, -1);

    const parts: MultipartPart[] = [];
    for (const rawPart of rawParts) {
        const part = rawPart.replace(/^\r\n/, '').replace(/\r\n$/, '');
        const headerEndIdx = part.indexOf('\r\n\r\n');
        if (headerEndIdx === -1) continue;
        const headerBlock = part.slice(0, headerEndIdx);
        const value = part.slice(headerEndIdx + 4);
        const nameMatch = headerBlock.match(/name="([^"]+)"/);
        const filenameMatch = headerBlock.match(/filename="([^"]*)"/);
        if (!nameMatch) continue;
        parts.push({ name: nameMatch[1], filename: filenameMatch?.[1], value });
    }
    return parts;
}

/** FIFO queue of canned {status, body} responses for the REST media POST endpoint. */
let mediaResponseQueue: Array<{ status: number; body: any }> = [];

function queueMedia(status: number, body: any): void {
    mediaResponseQueue.push({ status, body });
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

// Server state — a FIFO queue of canned responses; falls back to a default bulk_create success.
function makeDefaultBulkSuccess(count: number): string {
    const results = Array.from({ length: count }, (_, i) => ({
        index: i,
        status: 'created',
        id: `doc-${i}`,
        folder_path: '/root',
    }));
    return makeMcpSuccess({
        results,
        summary: { created: count, overwritten: 0, skipped: 0, renamed: 0, errors: 0, folders_created: 0 },
    });
}

let responseQueue: Array<string | ((body: any) => string)> = [];

function nextResponseBody(body: any): string {
    const entry = responseQueue.length > 0 ? responseQueue.shift()! : null;
    if (entry === null) {
        // Default: a bulk_create success for however many items were sent
        const items = body?.params?.arguments?.items ?? [];
        return makeDefaultBulkSuccess(items.length);
    }
    if (typeof entry === 'function') return entry(body);
    return entry;
}

beforeAll(async () => {
    stubServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => { chunks.push(chunk); });
        req.on('end', () => {
            const rawBody = Buffer.concat(chunks);
            const contentType = req.headers['content-type'];
            const isMultipart = contentType?.startsWith('multipart/form-data') ?? false;

            let parsedBody: any = null;
            let parts: MultipartPart[] | undefined;
            if (isMultipart) {
                parts = parseMultipart(rawBody, contentType);
            } else {
                try { parsedBody = JSON.parse(rawBody.toString('utf8')); } catch { /* ignore */ }
            }

            const capture: CapturedRequest = {
                method: req.method,
                path: req.url,
                headers: req.headers,
                body: parsedBody,
                parts,
            };

            allCaptures.push(capture);

            // Media POST (docs push replaces tracked media): /api/v1/docs/{id}/media
            if (req.method === 'POST' && /^\/api\/v1\/docs\/\d+\/media$/.test(req.url ?? '')) {
                const next = mediaResponseQueue.shift();
                if (!next) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ message: 'no stub media response queued for this request' }));
                    return;
                }
                res.writeHead(next.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(next.body));
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

/**
 * Build a temp directory with a nested markdown tree.
 * Returns the dir path and a cleanup function.
 */
function makeTmpDocsDir(files: Record<string, string>): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-docs-test-'));

    for (const [relPath, content] of Object.entries(files)) {
        const abs = path.join(dir, relPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
    }

    return {
        dir,
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
}

/** Write (or overwrite) a single binary file under an existing tmp dir. */
function writeBinaryFile(dir: string, relPath: string, bytes: Buffer): void {
    const abs = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
}

// ---------------------------------------------------------------------------
// Tests: chunking — 57 files → exactly 2 bulk_create calls (50 + 7)
// ---------------------------------------------------------------------------

describe('docsPushWithConfig — chunking', () => {
    it('sends exactly 2 bulk_create calls for 57 files (50 + 7), total items = 57', async () => {
        // Build 57 md files: 55 root-level + 2 in a subfolder
        const files: Record<string, string> = {};
        for (let i = 0; i < 55; i++) {
            files[`doc-${i}.md`] = `# Doc ${i}\n\nContent for doc ${i}.`;
        }
        files['sub/doc-55.md'] = '# Sub doc 55\n\nIn a subfolder.';
        files['sub/doc-56.md'] = '# Sub doc 56\n\nAlso in a subfolder.';

        const { dir, cleanup } = makeTmpDocsDir(files);
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            // Exactly 2 bulk_create calls
            expect(allCaptures.length).toBe(2);

            const firstItems = allCaptures[0].body.params.arguments.items;
            const secondItems = allCaptures[1].body.params.arguments.items;

            // First chunk: 50 items; second chunk: 7 items
            expect(firstItems.length).toBe(50);
            expect(secondItems.length).toBe(7);

            // Total = 57
            expect(firstItems.length + secondItems.length).toBe(57);

            // All calls go to /mcp/docs with tools/call method
            for (const cap of allCaptures) {
                expect(cap.path).toBe('/mcp');
                expect(cap.body.method).toBe('tools/call');
                expect(cap.body.params.name).toBe('docs_vault');
                expect(cap.body.params.arguments.action).toBe('bulk_create');
            }
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('a subfolder file carries the correct relative_folder_path using / separators', async () => {
        const files: Record<string, string> = {
            'root-doc.md': '# Root\n\nRoot content.',
            'guides/intro.md': '# Intro\n\nIntro content.',
            'guides/deep/nested.md': '# Nested\n\nNested content.',
        };

        const { dir, cleanup } = makeTmpDocsDir(files);
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            expect(allCaptures.length).toBe(1);

            const items: any[] = allCaptures[0].body.params.arguments.items;
            expect(items.length).toBe(3);

            // Root file: no relative_folder_path
            const rootItem = items.find((it: any) => it.title === 'root-doc');
            expect(rootItem).toBeDefined();
            expect(rootItem).not.toHaveProperty('relative_folder_path');

            // Subfolder file: relative_folder_path = 'guides'
            const guidesItem = items.find((it: any) => it.title === 'intro');
            expect(guidesItem).toBeDefined();
            expect(guidesItem.relative_folder_path).toBe('guides');

            // Deep nested file: relative_folder_path = 'guides/deep'
            const deepItem = items.find((it: any) => it.title === 'nested');
            expect(deepItem).toBeDefined();
            expect(deepItem.relative_folder_path).toBe('guides/deep');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('title is the filename stem (no .md extension)', async () => {
        const files: Record<string, string> = {
            'my-document.md': '# My Document\n\nSome content.',
            'another_file.md': '# Another\n\nMore content.',
        };

        const { dir, cleanup } = makeTmpDocsDir(files);
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            const items: any[] = allCaptures[0].body.params.arguments.items;
            const titles = items.map((it: any) => it.title);
            expect(titles).toContain('my-document');
            expect(titles).toContain('another_file');
            // Must NOT include the .md extension
            expect(titles).not.toContain('my-document.md');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('non-.md files are skipped', async () => {
        const files: Record<string, string> = {
            'keep.md': '# Keep',
            'ignore.txt': 'plain text',
            'ignore.json': '{"key": "value"}',
        };

        const { dir, cleanup } = makeTmpDocsDir(files);
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            const items: any[] = allCaptures[0].body.params.arguments.items;
            expect(items.length).toBe(1);
            expect(items[0].title).toBe('keep');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Tests: request shape — on_conflict, type, body content
// ---------------------------------------------------------------------------

describe('docsPushWithConfig — request shape', () => {
    it('sends on_conflict from options', async () => {
        const { dir, cleanup } = makeTmpDocsDir({ 'doc.md': '# Doc' });
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'overwrite' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            const args = allCaptures[0].body.params.arguments;
            expect(args.on_conflict).toBe('overwrite');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('sends type when --type option is set', async () => {
        const { dir, cleanup } = makeTmpDocsDir({ 'doc.md': '# Doc' });
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip', type: 'tutorial' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            const args = allCaptures[0].body.params.arguments;
            expect(args.type).toBe('tutorial');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('omits type when not set', async () => {
        const { dir, cleanup } = makeTmpDocsDir({ 'doc.md': '# Doc' });
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            const args = allCaptures[0].body.params.arguments;
            expect(args).not.toHaveProperty('type');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('sends body as raw file contents (UTF-8)', async () => {
        const content = '---\ntitle: My Doc\n---\n# My Document\n\nContent here.';
        const { dir, cleanup } = makeTmpDocsDir({ 'my-doc.md': content });
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            const items: any[] = allCaptures[0].body.params.arguments.items;
            const item = items.find((it: any) => it.title === 'my-doc');
            expect(item.body).toBe(content);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('sends X-Workspace-Id and Authorization headers', async () => {
        const { dir, cleanup } = makeTmpDocsDir({ 'doc.md': '# Doc' });
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig('ws-abc'));
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            expect(allCaptures[0].headers['x-workspace-id']).toBe('ws-abc');
            expect(allCaptures[0].headers['authorization']).toBe('Bearer test-api-key');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Tests: dry-run
// ---------------------------------------------------------------------------

describe('docsPushWithConfig — dry-run', () => {
    it('sends dry_run: true in bulk_create args and does not throw', async () => {
        // dry-run response uses planned status
        responseQueue = [(body: any) => {
            const items = body?.params?.arguments?.items ?? [];
            const results = items.map((_: any, i: number) => ({
                index: i,
                status: 'planned',
                action: 'create',
            }));
            return makeMcpSuccess({
                results,
                summary: { planned_create: items.length, planned_overwrite: 0, planned_skip: 0, planned_rename: 0, errors: 0, folders_created: 0 },
            });
        }];

        const { dir, cleanup } = makeTmpDocsDir({
            'doc1.md': '# Doc 1',
            'doc2.md': '# Doc 2',
        });

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip', dryRun: true }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            // Should exit 0 without throwing
            expect(caughtExit?.code).toBe(0);

            // bulk_create was called with dry_run: true
            expect(allCaptures.length).toBe(1);
            const args = allCaptures[0].body.params.arguments;
            expect(args.dry_run).toBe(true);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('prints a preview label in dry-run mode', async () => {
        responseQueue = [(body: any) => {
            const items = body?.params?.arguments?.items ?? [];
            const results = items.map((_: any, i: number) => ({ index: i, status: 'planned', action: 'create' }));
            return makeMcpSuccess({
                results,
                summary: { planned_create: items.length, planned_overwrite: 0, planned_skip: 0, planned_rename: 0, errors: 0, folders_created: 0 },
            });
        }];

        const { dir, cleanup } = makeTmpDocsDir({ 'doc.md': '# Doc' });
        const restoreExit = patchProcessExit();
        const { lines: logLines, restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip', dryRun: true }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            const out = logLines.join('');
            // Should include some kind of dry-run / preview label
            expect(out.toLowerCase()).toMatch(/dry.?run|preview/);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Tests: report output — properties pending section
// ---------------------------------------------------------------------------

describe('docsPushWithConfig — report: properties pending', () => {
    it('prints "Properties pending" section for files that have property_validation in their result', async () => {
        // Response with one pending result
        responseQueue = [makeMcpSuccess({
            results: [
                {
                    index: 0,
                    status: 'created',
                    id: 'doc-1',
                    property_validation: {
                        status: 'pending',
                        missing: ['author', 'category'],
                        invalid: [{ key: 'date', reason: 'must be ISO 8601' }],
                        schema: [],
                    },
                },
                {
                    index: 1,
                    status: 'created',
                    id: 'doc-2',
                    // no property_validation
                },
            ],
            summary: { created: 2, overwritten: 0, skipped: 0, renamed: 0, errors: 0, folders_created: 0 },
        })];

        const { dir, cleanup } = makeTmpDocsDir({
            'first.md': '# First',
            'second.md': '# Second',
        });

        const restoreExit = patchProcessExit();
        const { lines: logLines, restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            const out = logLines.join('\n');

            // Properties pending section must appear
            expect(out.toLowerCase()).toMatch(/properties pending/);

            // Must list the missing keys
            expect(out).toContain('author');
            expect(out).toContain('category');

            // Must list the invalid key + reason
            expect(out).toContain('date');
            expect(out).toContain('must be ISO 8601');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('does not print "Properties pending" section when no results have property_validation', async () => {
        responseQueue = [makeMcpSuccess({
            results: [
                { index: 0, status: 'created', id: 'doc-1' },
                { index: 1, status: 'created', id: 'doc-2' },
            ],
            summary: { created: 2, overwritten: 0, skipped: 0, renamed: 0, errors: 0, folders_created: 0 },
        })];

        const { dir, cleanup } = makeTmpDocsDir({
            'first.md': '# First',
            'second.md': '# Second',
        });

        const restoreExit = patchProcessExit();
        const { lines: logLines, restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            const out = logLines.join('\n');
            expect(out.toLowerCase()).not.toMatch(/properties pending/);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Tests: --json flag
// ---------------------------------------------------------------------------

describe('docsPushWithConfig — --json flag', () => {
    it('outputs a single JSON object with summary, pending, and results fields', async () => {
        responseQueue = [makeMcpSuccess({
            results: [
                {
                    index: 0,
                    status: 'created',
                    id: 'doc-1',
                    property_validation: {
                        status: 'pending',
                        missing: ['author'],
                        invalid: [],
                        schema: [],
                    },
                },
                { index: 1, status: 'skipped', id: 'doc-2' },
            ],
            summary: { created: 1, overwritten: 0, skipped: 1, renamed: 0, errors: 0, folders_created: 0 },
        })];

        const { dir, cleanup } = makeTmpDocsDir({
            'alpha.md': '# Alpha',
            'beta.md': '# Beta',
        });

        const restoreExit = patchProcessExit();
        const { lines: logLines, restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip', json: true }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            // Should have printed exactly one JSON line
            const jsonLine = logLines.find((l) => l.trim().startsWith('{'));
            expect(jsonLine).toBeDefined();

            const parsed = JSON.parse(jsonLine!);
            expect(parsed).toHaveProperty('summary');
            expect(parsed).toHaveProperty('pending');
            expect(parsed).toHaveProperty('results');

            // pending should include the file that had property_validation
            expect(parsed.pending.length).toBe(1);
            expect(parsed.pending[0]).toHaveProperty('file');
            expect(parsed.pending[0]).toHaveProperty('missing');
            expect(parsed.pending[0].missing).toContain('author');

            // results should have file names attached
            expect(parsed.results.length).toBe(2);
            expect(parsed.results[0]).toHaveProperty('file');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Tests: report totals output
// ---------------------------------------------------------------------------

describe('docsPushWithConfig — report totals', () => {
    it('prints totals from aggregated summaries across multiple chunks', async () => {
        // 57 files: 50 + 7
        const files: Record<string, string> = {};
        for (let i = 0; i < 57; i++) {
            files[`doc-${i}.md`] = `# Doc ${i}`;
        }

        // Chunk 1: 40 created, 10 skipped
        responseQueue.push(makeMcpSuccess({
            results: Array.from({ length: 50 }, (_, i) => ({
                index: i,
                status: i < 40 ? 'created' : 'skipped',
                id: `doc-${i}`,
            })),
            summary: { created: 40, overwritten: 0, skipped: 10, renamed: 0, errors: 0, folders_created: 2 },
        }));

        // Chunk 2: 5 created, 2 skipped
        responseQueue.push(makeMcpSuccess({
            results: Array.from({ length: 7 }, (_, i) => ({
                index: i,
                status: i < 5 ? 'created' : 'skipped',
                id: `doc-${i + 50}`,
            })),
            summary: { created: 5, overwritten: 0, skipped: 2, renamed: 0, errors: 0, folders_created: 0 },
        }));

        const { dir, cleanup } = makeTmpDocsDir(files);
        const restoreExit = patchProcessExit();
        const { lines: logLines, restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            const out = logLines.join('\n');

            // Total created: 45, skipped: 12
            expect(out).toContain('45');
            expect(out).toContain('12');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Tests: error handling
// ---------------------------------------------------------------------------

describe('docsPushWithConfig — error handling', () => {
    it('exits non-zero with an error message when the directory does not exist', async () => {
        const restoreExit = patchProcessExit();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig('/nonexistent/path/that/does/not/exist', { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit).not.toBeNull();
            expect(caughtExit!.code).not.toBe(0);
            expect(stderrLines.join('')).toMatch(/not a directory|does not exist/i);
        } finally {
            restoreExit();
            restoreStderr();
        }
    });

    it('exits non-zero when the directory has no .md files', async () => {
        const { dir, cleanup } = makeTmpDocsDir({ 'readme.txt': 'not a markdown file' });
        const restoreExit = patchProcessExit();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit).not.toBeNull();
            expect(caughtExit!.code).not.toBe(0);
            expect(stderrLines.join('')).toMatch(/no .md files|nothing to push/i);
        } finally {
            restoreExit();
            restoreStderr();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Tests: --folder <base> nests the whole upload under a base folder path
// ---------------------------------------------------------------------------

describe('docsPushWithConfig — --folder base', () => {
    it('forwards --folder as the top-level folder_path on every bulk_create call', async () => {
        const { dir, cleanup } = makeTmpDocsDir({
            'root.md': '# Root',
            'sub/nested.md': '# Nested',
        });
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip', folder: '4 MomentFactory' }, stubConfig());
            } catch (e) {
                if (!(e instanceof ProcessExitError)) throw e;
            }

            expect(allCaptures.length).toBe(1);
            const args = allCaptures[0].body.params.arguments;
            expect(args.folder_path).toBe('4 MomentFactory');
            // relative_folder_path on nested item is still relative to <dir> (server appends under base)
            const nested = args.items.find((i: any) => i.title === 'nested');
            expect(nested.relative_folder_path).toBe('sub');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('omits folder_path when --folder is not given', async () => {
        const { dir, cleanup } = makeTmpDocsDir({ 'root.md': '# Root' });
        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (!(e instanceof ProcessExitError)) throw e;
            }

            expect(allCaptures.length).toBe(1);
            expect(allCaptures[0].body.params.arguments).not.toHaveProperty('folder_path');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Tests: untracked docs in a pulled dir default to the manifest's folder_path
// (regression: docs push used to always create untracked docs at the docs
// root, ignoring the pulled folder — see issue #433).
// ---------------------------------------------------------------------------

describe('docsPushWithConfig — untracked docs inherit the manifest folder_path', () => {
    function manifestFile(folder_path: string, docs: DocsManifest['docs'] = {}): string {
        return JSON.stringify({ folder_path, docs }, null, 2);
    }

    it('pulled dir + untracked new.md + no --folder → bulk_create carries the manifest folder_path', async () => {
        const { dir, cleanup } = makeTmpDocsDir({
            'new.md': '# New\n\nUntracked content.',
            [DOCS_MANIFEST]: manifestFile('marketing/fb'),
        });

        const restoreExit = patchProcessExit();
        const { lines: logLines, restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            expect(allCaptures.length).toBe(1);
            expect(allCaptures[0].body.params.arguments.folder_path).toBe('marketing/fb');

            // The inferred base is surfaced to the user.
            expect(logLines.some((l) => l.includes('marketing/fb') && l.includes(DOCS_MANIFEST))).toBe(true);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('an explicit --folder always wins over the manifest folder_path', async () => {
        const { dir, cleanup } = makeTmpDocsDir({
            'new.md': '# New\n\nUntracked content.',
            [DOCS_MANIFEST]: manifestFile('marketing/fb'),
        });

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip', folder: 'other/place' }, stubConfig());
            } catch (e) {
                if (!(e instanceof ProcessExitError)) throw e;
            }

            expect(allCaptures.length).toBe(1);
            expect(allCaptures[0].body.params.arguments.folder_path).toBe('other/place');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('no manifest in the dir → folder_path is absent, exactly as today', async () => {
        const { dir, cleanup } = makeTmpDocsDir({ 'new.md': '# New\n\nUntracked content.' });

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (!(e instanceof ProcessExitError)) throw e;
            }

            expect(allCaptures.length).toBe(1);
            expect(allCaptures[0].body.params.arguments).not.toHaveProperty('folder_path');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('a nested untracked file keeps a relative_folder_path relative to <dir> — no double-prefix under the inferred base', async () => {
        const { dir, cleanup } = makeTmpDocsDir({
            'sub/deep.md': '# Deep\n\nNested untracked content.',
            [DOCS_MANIFEST]: manifestFile('marketing/fb'),
        });

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (!(e instanceof ProcessExitError)) throw e;
            }

            expect(allCaptures.length).toBe(1);
            const args = allCaptures[0].body.params.arguments;
            expect(args.folder_path).toBe('marketing/fb');

            const item = args.items.find((i: any) => i.title === 'deep');
            expect(item).toBeDefined();
            // Relative to <dir>, NOT pre-joined with the manifest folder_path — the
            // server composes folder_path + relative_folder_path itself.
            expect(item.relative_folder_path).toBe('sub');
            expect(item.relative_folder_path).not.toBe('marketing/fb/sub');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('delete-recovery shape: a tracked doc missing from the manifest but present on disk is bulk_created under the manifest folder_path', async () => {
        // Simulates the post-re-pull state described in the bug report: `gone.md` was
        // deleted remotely, re-pulling untracked it (dropped from manifest.docs), but
        // the local file is still on disk — so it's picked up as untracked and must be
        // recreated under the pulled folder, not the docs root.
        const trackedContent = '# Still Tracked';
        const { dir, cleanup } = makeTmpDocsDir({
            'gone.md': '# Gone\n\nWas deleted remotely; now untracked.',
            'still-tracked.md': trackedContent,
            [DOCS_MANIFEST]: manifestFile('marketing/fb', {
                'still-tracked.md': { id: 1, title: 'still-tracked', current_revision_id: 10, media: false, body_sha256: sha256Hex(trackedContent) },
            }),
        });

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            const bulkCalls = allCaptures.filter((c) => c.body.params.arguments.action === 'bulk_create');
            expect(bulkCalls.length).toBe(1);
            expect(bulkCalls[0].body.params.arguments.folder_path).toBe('marketing/fb');

            const items = bulkCalls[0].body.params.arguments.items;
            expect(items.length).toBe(1);
            expect(items[0].title).toBe('gone');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Tests: drift guard — tracked docs (manifest-backed) use docs_edit write
// ---------------------------------------------------------------------------

describe('docsPushWithConfig — drift guard (tracked docs)', () => {
    function manifestFile(docs: DocsManifest['docs']): string {
        return JSON.stringify({ folder_path: '/some/folder', docs }, null, 2);
    }

    it('tracked file uses docs_edit write with base_revision from the manifest; untracked file still uses bulk_create', async () => {
        const { dir, cleanup } = makeTmpDocsDir({
            'a.md': '# A\n\nTracked content.',
            'b.md': '# B\n\nUntracked content.',
            [DOCS_MANIFEST]: manifestFile({
                'a.md': { id: 1, title: 'a', current_revision_id: 10, media: false },
            }),
        });

        responseQueue = [makeMcpSuccess({ id: 1, current_revision_id: 11 })];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            const editCalls = allCaptures.filter((c) => c.body.params.name === 'docs_edit');
            expect(editCalls.length).toBe(1);
            expect(editCalls[0].body.params.arguments.action).toBe('write');
            expect(editCalls[0].body.params.arguments.id).toBe(1);
            expect(editCalls[0].body.params.arguments.base_revision).toBe(10);
            expect(editCalls[0].body.params.arguments.body).toBe('# A\n\nTracked content.');

            const bulkCalls = allCaptures.filter(
                (c) => c.body.params.name === 'docs_vault' && c.body.params.arguments.action === 'bulk_create',
            );
            expect(bulkCalls.length).toBe(1);
            const items = bulkCalls[0].body.params.arguments.items;
            expect(items.length).toBe(1);
            expect(items[0].title).toBe('b');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('a stale write response reports drift and exits 1, naming the file, both revisions, and --force', async () => {
        const { dir, cleanup } = makeTmpDocsDir({
            'a.md': '# A',
            [DOCS_MANIFEST]: manifestFile({
                'a.md': { id: 1, title: 'a', current_revision_id: 10, media: false },
            }),
        });

        responseQueue = [makeMcpSuccess({
            stale: true,
            code: 'stale_revision',
            current_revision_id: 12,
            base_revision: 10,
        })];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(1);
            const err = stderrLines.join('\n');
            expect(err).toContain('a.md');
            expect(err).toContain('10');
            expect(err).toContain('12');
            expect(err.toLowerCase()).toContain('--force');
            expect(err.toLowerCase()).toContain('re-pull');
            // Pin the exact value read from the drift response's current_revision_id —
            // a wrong key would leave `their: null` ("server now at null") and this line
            // alone would catch it.
            expect(err).toContain('server now at 12');
        } finally {
            restoreExit();
            restoreStdout();
            restoreStderr();
            cleanup();
        }
    });

    it('--force omits base_revision entirely from the docs_edit write call', async () => {
        const { dir, cleanup } = makeTmpDocsDir({
            'a.md': '# A',
            [DOCS_MANIFEST]: manifestFile({
                'a.md': { id: 1, title: 'a', current_revision_id: 10, media: false },
            }),
        });

        responseQueue = [makeMcpSuccess({ id: 1, current_revision_id: 11 })];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip', force: true }, stubConfig());
            } catch (e) {
                if (!(e instanceof ProcessExitError)) throw e;
            }

            const editCalls = allCaptures.filter((c) => c.body.params.name === 'docs_edit');
            expect(editCalls.length).toBe(1);
            expect(editCalls[0].body.params.arguments).not.toHaveProperty('base_revision');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('rewrites the manifest on disk with the new current_revision_id after a successful write', async () => {
        const { dir, cleanup } = makeTmpDocsDir({
            'a.md': '# A',
            [DOCS_MANIFEST]: manifestFile({
                'a.md': { id: 1, title: 'a', current_revision_id: 10, media: false },
            }),
        });

        responseQueue = [makeMcpSuccess({ id: 1, current_revision_id: 11 })];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (!(e instanceof ProcessExitError)) throw e;
            }

            const manifestRaw = fs.readFileSync(path.join(dir, DOCS_MANIFEST), 'utf8');
            const manifest: DocsManifest = JSON.parse(manifestRaw);
            expect(manifest.docs['a.md'].current_revision_id).toBe(11);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('--dry-run never calls docs_edit for tracked files; only bulk_create (dry_run: true) runs for untracked, tracked file reported as planned, exits 0, manifest untouched', async () => {
        const { dir, cleanup } = makeTmpDocsDir({
            'a.md': '# A\n\nTracked content.',
            'b.md': '# B\n\nUntracked content.',
            [DOCS_MANIFEST]: manifestFile({
                'a.md': { id: 1, title: 'a', current_revision_id: 10, media: false },
            }),
        });
        const manifestBefore = fs.readFileSync(path.join(dir, DOCS_MANIFEST), 'utf8');

        responseQueue = [(body: any) => {
            const items = body?.params?.arguments?.items ?? [];
            const results = items.map((_: any, i: number) => ({ index: i, status: 'planned', action: 'create' }));
            return makeMcpSuccess({
                results,
                summary: { planned_create: items.length, planned_overwrite: 0, planned_skip: 0, planned_rename: 0, errors: 0, folders_created: 0 },
            });
        }];

        const restoreExit = patchProcessExit();
        const { lines: logLines, restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip', dryRun: true, json: true }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            // No docs_edit call was ever made for the tracked file.
            const editCalls = allCaptures.filter((c) => c.body.params.name === 'docs_edit');
            expect(editCalls.length).toBe(0);

            // Only the untracked file went through bulk_create, with dry_run threaded.
            const bulkCalls = allCaptures.filter(
                (c) => c.body.params.name === 'docs_vault' && c.body.params.arguments.action === 'bulk_create',
            );
            expect(bulkCalls.length).toBe(1);
            expect(bulkCalls[0].body.params.arguments.dry_run).toBe(true);
            const items = bulkCalls[0].body.params.arguments.items;
            expect(items.length).toBe(1);
            expect(items[0].title).toBe('b');

            // The tracked file is reported as a planned write in the JSON payload.
            const jsonLine = logLines.find((l) => l.trim().startsWith('{'));
            expect(jsonLine).toBeDefined();
            const parsed = JSON.parse(jsonLine!);
            expect(parsed.tracked).toHaveProperty('planned');
            expect(parsed.tracked.planned).toEqual([{ file: 'a.md', id: 1 }]);
            expect(parsed.tracked.written).toEqual([]);
            expect(parsed.tracked.drifted).toEqual([]);

            // The manifest file on disk is untouched.
            const manifestAfter = fs.readFileSync(path.join(dir, DOCS_MANIFEST), 'utf8');
            expect(manifestAfter).toBe(manifestBefore);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Tracked doc deleted remotely (docs_edit write / media POST -> doc_not_found)
// ---------------------------------------------------------------------------

describe('docsPushWithConfig — tracked doc deleted remotely', () => {
    function manifestFile(docs: DocsManifest['docs']): string {
        return JSON.stringify({ folder_path: '/some/folder', docs }, null, 2);
    }

    it('a tracked markdown doc whose docs_edit write returns doc_not_found: clear per-file message, exit 0, other tracked files still pushed', async () => {
        const { dir, cleanup } = makeTmpDocsDir({
            'gone.md': '# Gone, edited locally',
            'still-here.md': '# Still here, edited locally',
            [DOCS_MANIFEST]: manifestFile({
                'gone.md': { id: 1, title: 'gone', current_revision_id: 10, media: false, body_sha256: sha256Hex('# Gone, original') },
                'still-here.md': { id: 2, title: 'still-here', current_revision_id: 10, media: false, body_sha256: sha256Hex('# Still here, original') },
            }),
        });

        // Keyed off the request's doc id rather than call order — directory read order
        // isn't guaranteed, so gone.md (id 1) and still-here.md (id 2) may be processed
        // in either order.
        const respond = (body: any) => {
            const id = body.params.arguments.id;
            if (id === 1) return makeMcpError('doc_not_found', 'Doc not found');
            return makeMcpSuccess({ id, current_revision_id: 11 });
        };
        responseQueue = [respond, respond];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            const err = stderrLines.join('\n');
            expect(err).toContain('gone.md');
            expect(err).toContain('doc 1');
            expect(err).toContain('no longer exists');
            expect(err.toLowerCase()).toContain('re-pull');

            // The other tracked file was still written despite the doc_not_found.
            const editCalls = allCaptures.filter((c) => c.body?.params?.name === 'docs_edit');
            expect(editCalls.length).toBe(2);
            expect(editCalls.some((c) => c.body.params.arguments.id === 2)).toBe(true);

            const manifest: DocsManifest = JSON.parse(fs.readFileSync(path.join(dir, DOCS_MANIFEST), 'utf8'));
            // gone.md's entry is untouched — still tracked at its old revision — so a
            // re-pull can untrack it (the deletion-propagation path in `docs pull`).
            expect(manifest.docs['gone.md'].current_revision_id).toBe(10);
            expect(manifest.docs['still-here.md'].current_revision_id).toBe(11);
        } finally {
            restoreExit();
            restoreStdout();
            restoreStderr();
            cleanup();
        }
    });

    it('a tracked media doc whose replace POST returns 404 doc_not_found: clear per-file message, exit 0', async () => {
        const bytes = 'new bytes, changed from the pull-time original';
        const { dir, cleanup } = makeTmpDocsDir({
            'hero.png': bytes,
            [DOCS_MANIFEST]: manifestFile({
                'hero.png': { id: 42, title: 'hero.png', current_revision_id: 7, media: true, body_sha256: sha256Hex('old bytes') },
            }),
        });

        queueMedia(404, { code: 'doc_not_found', message: 'Doc not found' });

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            const err = stderrLines.join('\n');
            expect(err).toContain('hero.png');
            expect(err).toContain('doc 42');
            expect(err).toContain('no longer exists');
        } finally {
            restoreExit();
            restoreStdout();
            restoreStderr();
            cleanup();
        }
    });

    it('the pre-existing drift test still exits 1 (doc_not_found handling does not weaken genuine drift)', async () => {
        const { dir, cleanup } = makeTmpDocsDir({
            'a.md': '# A, edited',
            [DOCS_MANIFEST]: manifestFile({
                'a.md': { id: 1, title: 'a', current_revision_id: 10, media: false, body_sha256: sha256Hex('# A, original') },
            }),
        });

        responseQueue = [makeMcpSuccess({ stale: true, code: 'stale_revision', current_revision_id: 12, base_revision: 10 })];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const { restore: restoreStderr } = captureStderr();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }
            expect(caughtExit?.code).toBe(1);
        } finally {
            restoreExit();
            restoreStdout();
            restoreStderr();
            cleanup();
        }
    });

    it('a media-only successful push prints no "done: 0 docs" line', async () => {
        const oldBytes = 'old png bytes';
        const newBytes = 'new png bytes, totally different from the old ones';
        const { dir, cleanup } = makeTmpDocsDir({
            'hero.png': newBytes,
            [DOCS_MANIFEST]: manifestFile({
                'hero.png': { id: 42, title: 'hero.png', current_revision_id: 7, media: true, body_sha256: sha256Hex(oldBytes) },
            }),
        });

        queueMedia(200, { doc: { id: 42, current_version_id: 8 } });

        const restoreExit = patchProcessExit();
        const { lines: logLines, restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            expect(logLines.some((l) => l.includes('done:'))).toBe(false);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Tests: incremental manifest refresh — a later failure must not lose an
// earlier tracked write's already-persisted revision.
// ---------------------------------------------------------------------------

describe('docsPushWithConfig — incremental manifest refresh', () => {
    function manifestFile(docs: DocsManifest['docs']): string {
        return JSON.stringify({ folder_path: '/some/folder', docs }, null, 2);
    }

    it('persists the manifest after each successful tracked write, so a later write failure does not lose an earlier one', async () => {
        const { dir, cleanup } = makeTmpDocsDir({
            'a.md': '# A',
            'b.md': '# B',
            [DOCS_MANIFEST]: manifestFile({
                'a.md': { id: 1, title: 'a', current_revision_id: 10, media: false },
                'b.md': { id: 2, title: 'b', current_revision_id: 20, media: false },
            }),
        });

        // First docs_edit call succeeds (bumping that doc's revision), the second
        // fails with an MCP error — regardless of which tracked file (a or b) is
        // processed first, since directory read order isn't guaranteed.
        let callCount = 0;
        const respond = (body: any) => {
            callCount++;
            if (callCount === 1) {
                const id = body.params.arguments.id;
                return makeMcpSuccess({ id, current_revision_id: id * 10 + 1 });
            }
            return makeMcpError('internal_error', 'boom');
        };
        responseQueue = [respond, respond];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const { restore: restoreStderr } = captureStderr();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(1);

            const manifest: DocsManifest = JSON.parse(fs.readFileSync(path.join(dir, DOCS_MANIFEST), 'utf8'));
            const revisions = {
                'a.md': manifest.docs['a.md'].current_revision_id,
                'b.md': manifest.docs['b.md'].current_revision_id,
            };

            // Exactly one tracked file's revision advanced (the one written first,
            // and persisted to disk immediately); the other's manifest entry is
            // untouched at its original value.
            const advanced = Object.entries(revisions).filter(([file, rev]) => {
                const original = file === 'a.md' ? 10 : 20;
                return rev !== original;
            });
            expect(advanced.length).toBe(1);
        } finally {
            restoreExit();
            restoreStdout();
            restoreStderr();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Tests: unparseable manifest warns once, downgrades everything to untracked
// ---------------------------------------------------------------------------

describe('docsPushWithConfig — unparseable manifest', () => {
    it('warns on stderr when the manifest exists but fails to parse, and treats all files as untracked', async () => {
        const { dir, cleanup } = makeTmpDocsDir({
            'a.md': '# A',
            [DOCS_MANIFEST]: '{ not valid json',
        });

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            expect(stderrLines.join('')).toMatch(/could not be parsed/i);

            // Everything went through bulk_create as untracked — no docs_edit call.
            const editCalls = allCaptures.filter((c) => c.body.params.name === 'docs_edit');
            expect(editCalls.length).toBe(0);
        } finally {
            restoreExit();
            restoreStdout();
            restoreStderr();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Tests: content hashes — skip-unchanged tracked files
// ---------------------------------------------------------------------------

describe('docsPushWithConfig — content hash skip-unchanged', () => {
    function manifestFile(docs: DocsManifest['docs']): string {
        return JSON.stringify({ folder_path: '/some/folder', docs }, null, 2);
    }

    it('skips a tracked file whose content hash matches the manifest (zero docs_edit calls, reported as unchanged) while writing a changed one', async () => {
        const unchangedContent = '# A\n\nUnchanged content.';
        const changedContent = '# B\n\nNew content, differs from manifest hash.';
        const { dir, cleanup } = makeTmpDocsDir({
            'a.md': unchangedContent,
            'b.md': changedContent,
            [DOCS_MANIFEST]: manifestFile({
                'a.md': { id: 1, title: 'a', current_revision_id: 10, media: false, body_sha256: sha256Hex(unchangedContent) },
                'b.md': { id: 2, title: 'b', current_revision_id: 20, media: false, body_sha256: sha256Hex('# B\n\nOld content.') },
            }),
        });

        responseQueue = [makeMcpSuccess({ id: 2, current_revision_id: 21 })];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip', json: true }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            // Exactly one docs_edit call, for the changed file only.
            const editCalls = allCaptures.filter((c) => c.body.params.name === 'docs_edit');
            expect(editCalls.length).toBe(1);
            expect(editCalls[0].body.params.arguments.id).toBe(2);
            expect(editCalls[0].body.params.arguments.body).toBe(changedContent);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('reports the unchanged file in tracked.unchanged and the written file in tracked.written via --json', async () => {
        const unchangedContent = '# A\n\nUnchanged content.';
        const changedContent = '# B\n\nNew content.';
        const { dir, cleanup } = makeTmpDocsDir({
            'a.md': unchangedContent,
            'b.md': changedContent,
            [DOCS_MANIFEST]: manifestFile({
                'a.md': { id: 1, title: 'a', current_revision_id: 10, media: false, body_sha256: sha256Hex(unchangedContent) },
                'b.md': { id: 2, title: 'b', current_revision_id: 20, media: false, body_sha256: sha256Hex('# B\n\nOld.') },
            }),
        });

        responseQueue = [makeMcpSuccess({ id: 2, current_revision_id: 21 })];

        const restoreExit = patchProcessExit();
        const { lines: logLines, restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip', json: true }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            const jsonLine = logLines.find((l) => l.trim().startsWith('{'));
            const parsed = JSON.parse(jsonLine!);

            expect(parsed.tracked.unchanged).toEqual([{ file: 'a.md', id: 1 }]);
            expect(parsed.tracked.written).toEqual([{ file: 'b.md', id: 2, current_revision_id: 21 }]);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('skip-unchanged applies even under --force (force answers drift, not staleness)', async () => {
        const unchangedContent = '# A\n\nUnchanged content.';
        const { dir, cleanup } = makeTmpDocsDir({
            'a.md': unchangedContent,
            [DOCS_MANIFEST]: manifestFile({
                'a.md': { id: 1, title: 'a', current_revision_id: 10, media: false, body_sha256: sha256Hex(unchangedContent) },
            }),
        });

        const restoreExit = patchProcessExit();
        const { lines: logLines, restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip', force: true, json: true }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            const editCalls = allCaptures.filter((c) => c.body.params.name === 'docs_edit');
            expect(editCalls.length).toBe(0);

            const jsonLine = logLines.find((l) => l.trim().startsWith('{'));
            const parsed = JSON.parse(jsonLine!);
            expect(parsed.tracked.unchanged).toEqual([{ file: 'a.md', id: 1 }]);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('a tracked entry from an old manifest (no body_sha256 field) is always written, never falsely reported unchanged', async () => {
        const content = '# A\n\nSame content the manifest was pulled with.';
        const { dir, cleanup } = makeTmpDocsDir({
            'a.md': content,
            [DOCS_MANIFEST]: manifestFile({
                // No body_sha256 field at all — simulates a manifest from before this feature.
                'a.md': { id: 1, title: 'a', current_revision_id: 10, media: false },
            }),
        });

        responseQueue = [makeMcpSuccess({ id: 1, current_revision_id: 11 })];

        const restoreExit = patchProcessExit();
        const { lines: logLines, restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip', json: true }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            const editCalls = allCaptures.filter((c) => c.body.params.name === 'docs_edit');
            expect(editCalls.length).toBe(1);
            expect(editCalls[0].body.params.arguments.body).toBe(content);

            const jsonLine = logLines.find((l) => l.trim().startsWith('{'));
            const parsed = JSON.parse(jsonLine!);
            expect(parsed.tracked.unchanged).toEqual([]);
            expect(parsed.tracked.written).toEqual([{ file: 'a.md', id: 1, current_revision_id: 11 }]);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('refreshes body_sha256 on disk (hash of the body just sent) after a successful tracked write', async () => {
        const newContent = '# A\n\nBrand new content.';
        const { dir, cleanup } = makeTmpDocsDir({
            'a.md': newContent,
            [DOCS_MANIFEST]: manifestFile({
                'a.md': { id: 1, title: 'a', current_revision_id: 10, media: false, body_sha256: sha256Hex('# A\n\nOld content.') },
            }),
        });

        responseQueue = [makeMcpSuccess({ id: 1, current_revision_id: 11 })];

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (!(e instanceof ProcessExitError)) throw e;
            }

            const manifest: DocsManifest = JSON.parse(fs.readFileSync(path.join(dir, DOCS_MANIFEST), 'utf8'));
            expect(manifest.docs['a.md'].body_sha256).toBe(sha256Hex(newContent));
            expect(manifest.docs['a.md'].current_revision_id).toBe(11);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('--dry-run distinguishes would-write from would-skip (unchanged) without any docs_edit calls', async () => {
        const unchangedContent = '# A\n\nUnchanged.';
        const changedContent = '# B\n\nChanged.';
        const { dir, cleanup } = makeTmpDocsDir({
            'a.md': unchangedContent,
            'b.md': changedContent,
            [DOCS_MANIFEST]: manifestFile({
                'a.md': { id: 1, title: 'a', current_revision_id: 10, media: false, body_sha256: sha256Hex(unchangedContent) },
                'b.md': { id: 2, title: 'b', current_revision_id: 20, media: false, body_sha256: sha256Hex('# B\n\nOld.') },
            }),
        });

        const restoreExit = patchProcessExit();
        const { lines: logLines, restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip', dryRun: true, json: true }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            const editCalls = allCaptures.filter((c) => c.body.params.name === 'docs_edit');
            expect(editCalls.length).toBe(0);

            const jsonLine = logLines.find((l) => l.trim().startsWith('{'));
            const parsed = JSON.parse(jsonLine!);
            expect(parsed.tracked.unchanged).toEqual([{ file: 'a.md', id: 1 }]);
            expect(parsed.tracked.planned).toEqual([{ file: 'b.md', id: 2 }]);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Tests: media pass — tracked binaries replace via POST /api/v1/docs/{id}/media
// ---------------------------------------------------------------------------

describe('docsPushWithConfig — media pass (tracked binaries)', () => {
    function manifestFile(docs: DocsManifest['docs']): string {
        return JSON.stringify({ folder_path: '/some/folder', docs }, null, 2);
    }

    it('replaces a tracked media file whose bytes changed, sending base_revision; manifest on disk gets the new revision + hash', async () => {
        const oldBytes = 'old png bytes';
        const newBytes = 'new png bytes, totally different from the old ones';
        const { dir, cleanup } = makeTmpDocsDir({
            'hero.png': newBytes,
            [DOCS_MANIFEST]: manifestFile({
                'hero.png': { id: 42, title: 'hero.png', current_revision_id: 7, media: true, body_sha256: sha256Hex(oldBytes) },
            }),
        });

        queueMedia(200, { doc: { id: 42, current_version_id: 8 } });

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            const mediaCalls = allCaptures.filter((c) => c.path === '/api/v1/docs/42/media');
            expect(mediaCalls.length).toBe(1);
            expect(mediaCalls[0].method).toBe('POST');

            const filePart = mediaCalls[0].parts!.find((p) => p.name === 'file');
            expect(filePart?.filename).toBe('hero.png');
            expect(filePart?.value).toBe(newBytes);

            const baseRevisionPart = mediaCalls[0].parts!.find((p) => p.name === 'base_revision');
            expect(baseRevisionPart?.value).toBe('7');

            const manifest: DocsManifest = JSON.parse(fs.readFileSync(path.join(dir, DOCS_MANIFEST), 'utf8'));
            expect(manifest.docs['hero.png'].current_revision_id).toBe(8);
            expect(manifest.docs['hero.png'].body_sha256).toBe(sha256Hex(newBytes));
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('reads the new revision from doc.current_version_id (not doc.current_revision_id, absent from the response), then sends it as base_revision on the next push', async () => {
        const oldBytes = 'v1 bytes';
        const v2Bytes = 'v2 bytes, changed';
        const v3Bytes = 'v3 bytes, changed again';
        const { dir, cleanup } = makeTmpDocsDir({
            'hero.png': v2Bytes,
            [DOCS_MANIFEST]: manifestFile({
                'hero.png': { id: 42, title: 'hero.png', current_revision_id: 7, media: true, body_sha256: sha256Hex(oldBytes) },
            }),
        });

        // The stub's 200 body returns ONLY { doc: { id, current_version_id } } — no current_revision_id key.
        queueMedia(200, { doc: { id: 42, current_version_id: 8 } });

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (!(e instanceof ProcessExitError)) throw e;
            }

            const manifestAfterFirst: DocsManifest = JSON.parse(fs.readFileSync(path.join(dir, DOCS_MANIFEST), 'utf8'));
            expect(manifestAfterFirst.docs['hero.png'].current_revision_id).toBe(8);

            // Second push, different bytes — must send base_revision=8.
            fs.writeFileSync(path.join(dir, 'hero.png'), v3Bytes, 'utf8');
            queueMedia(200, { doc: { id: 42, current_version_id: 9 } });

            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (!(e instanceof ProcessExitError)) throw e;
            }

            const mediaCalls = allCaptures.filter((c) => c.path === '/api/v1/docs/42/media');
            expect(mediaCalls.length).toBe(2);
            const secondBaseRevision = mediaCalls[1].parts!.find((p) => p.name === 'base_revision');
            expect(secondBaseRevision?.value).toBe('8');
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('skips a tracked media file whose bytes match the manifest hash (zero requests, reported unchanged)', async () => {
        const bytes = 'unchanged bytes';
        const { dir, cleanup } = makeTmpDocsDir({
            'hero.png': bytes,
            [DOCS_MANIFEST]: manifestFile({
                'hero.png': { id: 42, title: 'hero.png', current_revision_id: 7, media: true, body_sha256: sha256Hex(bytes) },
            }),
        });

        const restoreExit = patchProcessExit();
        const { lines: logLines, restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip', json: true }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            expect(allCaptures.filter((c) => c.path === '/api/v1/docs/42/media').length).toBe(0);

            const jsonLine = logLines.find((l) => l.trim().startsWith('{'));
            const parsed = JSON.parse(jsonLine!);
            expect(parsed.tracked.unchanged).toEqual([{ file: 'hero.png', id: 42 }]);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('skips a tracked media entry with no local file (pull-time download failure) — zero requests, no crash', async () => {
        const { dir, cleanup } = makeTmpDocsDir({
            [DOCS_MANIFEST]: manifestFile({
                'hero.png': { id: 42, title: 'hero.png', current_revision_id: 7, media: true, body_sha256: null },
            }),
        });

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            expect(allCaptures.filter((c) => c.path === '/api/v1/docs/42/media').length).toBe(0);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('skips a tracked media entry whose local path is a directory instead of a file — zero requests, no crash', async () => {
        const { dir, cleanup } = makeTmpDocsDir({
            [DOCS_MANIFEST]: manifestFile({
                'hero.png': { id: 42, title: 'hero.png', current_revision_id: 7, media: true, body_sha256: sha256Hex('old bytes') },
            }),
        });
        fs.mkdirSync(path.join(dir, 'hero.png'));

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            expect(allCaptures.filter((c) => c.path === '/api/v1/docs/42/media').length).toBe(0);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('--force omits base_revision entirely from the media multipart body', async () => {
        const oldBytes = 'old bytes';
        const newBytes = 'new bytes, changed';
        const { dir, cleanup } = makeTmpDocsDir({
            'hero.png': newBytes,
            [DOCS_MANIFEST]: manifestFile({
                'hero.png': { id: 42, title: 'hero.png', current_revision_id: 7, media: true, body_sha256: sha256Hex(oldBytes) },
            }),
        });

        queueMedia(200, { doc: { id: 42, current_version_id: 8 } });

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip', force: true }, stubConfig());
            } catch (e) {
                if (!(e instanceof ProcessExitError)) throw e;
            }

            const mediaCalls = allCaptures.filter((c) => c.path === '/api/v1/docs/42/media');
            expect(mediaCalls.length).toBe(1);
            expect(mediaCalls[0].parts!.find((p) => p.name === 'base_revision')).toBeUndefined();
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('--force does not bypass skip-unchanged in the media pass: zero requests when hashes match, a write with no base_revision when they differ', async () => {
        const bytes = 'unchanged image bytes for force test';
        const { dir, cleanup } = makeTmpDocsDir({
            'hero.png': bytes,
            [DOCS_MANIFEST]: manifestFile({
                'hero.png': { id: 42, title: 'hero.png', current_revision_id: 7, media: true, body_sha256: sha256Hex(bytes) },
            }),
        });

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            // Phase 1: local bytes match the manifest hash — --force must not bypass skip-unchanged.
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip', force: true }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }
            expect(caughtExit?.code).toBe(0);
            expect(allCaptures.length).toBe(0);

            // Phase 2: bytes changed on disk — --force still triggers a write, but omits base_revision.
            const changedBytes = 'changed image bytes for force test';
            fs.writeFileSync(path.join(dir, 'hero.png'), changedBytes, 'utf8');
            queueMedia(200, { doc: { id: 42, current_version_id: 8 } });

            caughtExit = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip', force: true }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }
            expect(caughtExit?.code).toBe(0);

            const mediaCalls = allCaptures.filter((c) => c.path === '/api/v1/docs/42/media');
            expect(mediaCalls.length).toBe(1);
            expect(mediaCalls[0].parts!.find((p) => p.name === 'base_revision')).toBeUndefined();
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('reports drift and exits 1 on a 409 stale_revision from the media endpoint', async () => {
        const oldBytes = 'old bytes';
        const newBytes = 'new bytes, changed';
        const { dir, cleanup } = makeTmpDocsDir({
            'hero.png': newBytes,
            [DOCS_MANIFEST]: manifestFile({
                'hero.png': { id: 42, title: 'hero.png', current_revision_id: 7, media: true, body_sha256: sha256Hex(oldBytes) },
            }),
        });

        queueMedia(409, { code: 'stale_revision', current_revision_id: 9 });

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(1);
            const err = stderrLines.join('\n');
            expect(err).toContain('hero.png');
            // Pin the exact value read from the 409 body's current_revision_id — a wrong
            // key would leave `their: null` ("server now at null") and the suite would
            // stay green without this assertion.
            expect(err).toContain('server now at 9');
        } finally {
            restoreExit();
            restoreStdout();
            restoreStderr();
            cleanup();
        }
    });

    it('a media doc titled notes.md holding binary bytes is never sent through docs_edit; a media POST is made instead', async () => {
        const oldBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
        const newBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0xfd]);
        const { dir, cleanup } = makeTmpDocsDir({
            [DOCS_MANIFEST]: manifestFile({
                'notes.md': { id: 5, title: 'notes.md', current_revision_id: 3, media: true, body_sha256: sha256Hex(oldBytes) },
            }),
        });
        writeBinaryFile(dir, 'notes.md', newBytes);

        queueMedia(200, { doc: { id: 5, current_version_id: 4 } });

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            const editCalls = allCaptures.filter((c) => c.body?.params?.name === 'docs_edit');
            expect(editCalls.length).toBe(0);

            const mediaCalls = allCaptures.filter((c) => c.path === '/api/v1/docs/5/media');
            expect(mediaCalls.length).toBe(1);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('pushes a folder containing only images (no .md files) without tripping the "no .md files" exit', async () => {
        const bytes = 'unchanged image bytes';
        const { dir, cleanup } = makeTmpDocsDir({
            'hero.png': bytes,
            [DOCS_MANIFEST]: manifestFile({
                'hero.png': { id: 42, title: 'hero.png', current_revision_id: 7, media: true, body_sha256: sha256Hex(bytes) },
            }),
        });

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('--dry-run performs zero media requests', async () => {
        const oldBytes = 'old bytes';
        const newBytes = 'new bytes, changed';
        const { dir, cleanup } = makeTmpDocsDir({
            'hero.png': newBytes,
            [DOCS_MANIFEST]: manifestFile({
                'hero.png': { id: 42, title: 'hero.png', current_revision_id: 7, media: true, body_sha256: sha256Hex(oldBytes) },
            }),
        });

        const restoreExit = patchProcessExit();
        const { lines: logLines, restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip', dryRun: true, json: true }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            expect(allCaptures.filter((c) => c.path === '/api/v1/docs/42/media').length).toBe(0);

            const jsonLine = logLines.find((l) => l.trim().startsWith('{'));
            const parsed = JSON.parse(jsonLine!);
            expect(parsed.tracked.planned).toEqual([{ file: 'hero.png', id: 42 }]);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Tests: untracked binaries — warn, never upload
// ---------------------------------------------------------------------------

describe('docsPushWithConfig — untracked binaries', () => {
    it('warns once per untracked binary and never uploads it', async () => {
        const { dir, cleanup } = makeTmpDocsDir({
            'doc.md': '# Doc',
            'diagram.png': 'some binary-ish content',
        });

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            expect(stderrLines.join('')).toMatch(/diagram\.png: not pushed — use `solidactions docs upload`/);
            expect(allCaptures.filter((c) => c.path?.includes('/media')).length).toBe(0);
        } finally {
            restoreExit();
            restoreStdout();
            restoreStderr();
            cleanup();
        }
    });

    it('does not warn about files under node_modules or dot-directories', async () => {
        const { dir, cleanup } = makeTmpDocsDir({
            'doc.md': '# Doc',
            'node_modules/some-pkg/lib.bin': 'ignored',
            '.cache/data.bin': 'ignored',
        });

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);
            expect(stderrLines.join('')).not.toMatch(/not pushed/);
        } finally {
            restoreExit();
            restoreStdout();
            restoreStderr();
            cleanup();
        }
    });

    it('never pushes untracked .md files under node_modules or dot-directories', async () => {
        const { dir, cleanup } = makeTmpDocsDir({
            'real.md': '# Real',
            'node_modules/some-pkg/readme.md': '# Should be ignored',
            '.cache/notes.md': '# Also ignored',
        });

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            // Only `real.md` reaches bulk_create; the excluded trees are never sent.
            const bulkItems = allCaptures
                .flatMap((c) => c.body?.params?.arguments?.items ?? []);
            const titles = bulkItems.map((i: any) => i.title);
            expect(titles).toEqual(['real']);

            // And they must not be warned about as untracked binaries either.
            expect(stderrLines.join('')).not.toMatch(/not pushed/);
        } finally {
            restoreExit();
            restoreStdout();
            restoreStderr();
            cleanup();
        }
    });

    it('exposes untracked_media in the --json payload, excluding tracked files and the manifest sidecar', async () => {
        const trackedContent = '# Doc';
        const { dir, cleanup } = makeTmpDocsDir({
            'doc.md': trackedContent,
            [DOCS_MANIFEST]: JSON.stringify({
                folder_path: '/some/folder',
                docs: {
                    'doc.md': { id: 1, title: 'doc', current_revision_id: 10, media: false, body_sha256: sha256Hex(trackedContent) },
                },
            }, null, 2),
        });
        writeBinaryFile(dir, 'images/new-hero.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));

        const restoreExit = patchProcessExit();
        const { lines: logLines, restore: restoreStdout } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip', json: true }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            const jsonLine = logLines.find((l) => l.trim().startsWith('{'));
            const parsed = JSON.parse(jsonLine!);

            expect(parsed.untracked_media).toContain('images/new-hero.png');
            expect(parsed.untracked_media).not.toContain('doc.md');
            expect(parsed.untracked_media).not.toContain('.solidactions-docs.json');

            expect(allCaptures.filter((c) => c.path?.includes('/media')).length).toBe(0);
        } finally {
            restoreExit();
            restoreStdout();
            cleanup();
        }
    });

    it('caps the human-mode untracked-binary warning at 10 lines and prints "… and N more" for the rest', async () => {
        const files: Record<string, string> = { 'doc.md': '# Doc' };
        for (let i = 0; i < 13; i++) {
            files[`img-${i}.png`] = `binary content ${i}`;
        }
        const { dir, cleanup } = makeTmpDocsDir(files);

        const restoreExit = patchProcessExit();
        const { restore: restoreStdout } = captureStdout();
        const { lines: stderrLines, restore: restoreStderr } = captureStderr();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            const warningLines = stderrLines.filter((l) => l.includes('not pushed — use `solidactions docs upload`'));
            expect(warningLines.length).toBe(10);
            expect(stderrLines.some((l) => /… and 3 more/.test(l))).toBe(true);

            expect(allCaptures.filter((c) => c.path?.includes('/media')).length).toBe(0);
        } finally {
            restoreExit();
            restoreStdout();
            restoreStderr();
            cleanup();
        }
    });
});

describe('docsPushWithConfig — server-side bulk_create errors', () => {
    it('names the file and the server reason instead of a bare "N errors" count, and exits 1', async () => {
        const { dir, cleanup } = makeTmpDocsDir({ 'note2.md': 'body' });
        responseQueue = [
            makeMcpSuccess({
                summary: { errors: 1 },
                results: [{
                    index: 0,
                    status: 'error',
                    code: 'trashed_title_conflict',
                    error: "A deleted doc titled 'note2' is still in the trash in this folder.",
                }],
            }),
        ];

        const restoreExit = patchProcessExit();
        const { lines: errLines, restore: restoreStderr } = captureStderr();
        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await docsPushWithConfig(dir, { onConflict: 'skip' }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }
            const err = errLines.join('\n');
            expect(err).toContain('note2.md');
            expect(err).toContain('still in the trash');
            // A push where every untracked file errored must not exit 0 — that hides a
            // genuine failure from CI/scripts polling the exit code.
            expect(caughtExit?.code).toBe(1);
        } finally {
            restoreExit();
            restoreStderr();
            cleanup();
        }
    });
});

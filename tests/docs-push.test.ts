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
        let rawBody = '';
        req.on('data', (chunk) => { rawBody += chunk; });
        req.on('end', () => {
            let parsedBody: any = null;
            try { parsedBody = JSON.parse(rawBody); } catch { /* ignore */ }

            const capture: CapturedRequest = {
                method: req.method,
                path: req.url,
                headers: req.headers,
                body: parsedBody,
            };

            allCaptures.push(capture);

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
                expect(cap.path).toBe('/mcp/docs');
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

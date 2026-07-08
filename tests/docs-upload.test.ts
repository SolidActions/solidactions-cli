/**
 * Tests for `solidactions docs upload <file...>`.
 *
 * Uses a real in-process HTTP server (Node's http.createServer) to stub the
 * POST /api/v1/docs/media endpoint — no mock/spy/stub libraries. Pattern
 * copied from tests/crew-env.test.ts (FIFO response queue + request
 * capture); config is written to a real temp config file since docsUpload
 * resolves config via requireConfigWithWorkspace(), not an injected Config
 * param. Since the request body is multipart/form-data (not JSON), the raw
 * body is captured and parsed with a small hand-rolled multipart parser.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { docsUpload } from '../src/commands/docs-upload';
import { makeTmpEnv, writeGlobal } from './helpers';

// ---------------------------------------------------------------------------
// Minimal multipart/form-data parser — just enough to assert field names,
// filenames, and text-field values in tests. Not a general-purpose parser.
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

// ---------------------------------------------------------------------------
// Stub REST server — FIFO queue of canned responses; records every request
// (raw body + headers) so multipart requests can be parsed per-test.
// ---------------------------------------------------------------------------

interface CapturedRequest {
    method: string | undefined;
    path: string | undefined;
    headers: http.IncomingHttpHeaders;
    parts: MultipartPart[];
}

interface QueuedResponse {
    status: number;
    body: any;
}

let stubServer: http.Server;
let stubPort: number;
let allCaptures: CapturedRequest[] = [];
let responseQueue: QueuedResponse[] = [];

function queue(status: number, body: any): void {
    responseQueue.push({ status, body });
}

beforeAll(async () => {
    stubServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => { chunks.push(chunk); });
        req.on('end', () => {
            const rawBody = Buffer.concat(chunks);
            const parts = parseMultipart(rawBody, req.headers['content-type']);

            allCaptures.push({ method: req.method, path: req.url, headers: req.headers, parts });

            const next = responseQueue.shift();
            if (!next) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'no stub response queued for this request' }));
                return;
            }
            res.writeHead(next.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(next.body));
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

/** Write a real config file pointing at the stub server. */
function setupConfig(): { cleanup: () => void } {
    const { cleanup } = makeTmpEnv();
    const tmpHome = process.env.HOME!;
    writeGlobal(tmpHome, {
        host: `http://127.0.0.1:${stubPort}`,
        apiKey: 'test-api-key',
        workspaceId: 'ws-test',
    });
    return { cleanup };
}

class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

function patchProcessExit(): () => void {
    const orig = process.exit.bind(process);
    (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };
    return () => { (process as any).exit = orig; };
}

function captureConsole(): { logs: string[]; errors: string[]; restore: () => void } {
    const logs: string[] = [];
    const errors: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args: any[]) => { logs.push(args.map(String).join(' ')); };
    console.error = (...args: any[]) => { errors.push(args.map(String).join(' ')); };
    return { logs, errors, restore: () => { console.log = origLog; console.error = origError; } };
}

async function runExpectingExit(fn: () => Promise<void>): Promise<number | undefined> {
    const restoreExit = patchProcessExit();
    try {
        await fn();
        return undefined;
    } catch (e) {
        if (e instanceof ProcessExitError) return e.code;
        throw e;
    } finally {
        restoreExit();
    }
}

function writeTmpFile(name: string, content: string): { file: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-doc-upload-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, content, 'utf8');
    return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Integration: docsUpload
// ---------------------------------------------------------------------------

describe('docsUpload', () => {
    it('single file: POSTs multipart with file + folder_path fields, sends auth + workspace headers, prints a ✓ result line', async () => {
        const { cleanup } = setupConfig();
        const { file, cleanup: cleanupFile } = writeTmpFile('chart.png', 'binary-ish content');
        const { logs, restore } = captureConsole();
        try {
            queue(201, { id: 42, title: 'chart.png', folder_path: 'LOD/Reports' });

            const code = await runExpectingExit(() => docsUpload([file], { folder: 'LOD/Reports' }));
            expect(code).toBeUndefined();

            expect(allCaptures).toHaveLength(1);
            const req = allCaptures[0];
            expect(req.method).toBe('POST');
            expect(req.path).toBe('/api/v1/docs/media');
            expect(req.headers['authorization']).toBe('Bearer test-api-key');
            expect(req.headers['x-workspace-id']).toBe('ws-test');
            expect(req.headers['content-type']).toMatch(/^multipart\/form-data/);

            const filePart = req.parts.find((p) => p.name === 'file');
            expect(filePart).toBeDefined();
            expect(filePart!.filename).toBe('chart.png');
            expect(filePart!.value).toBe('binary-ish content');

            const folderPart = req.parts.find((p) => p.name === 'folder_path');
            expect(folderPart).toBeDefined();
            expect(folderPart!.value).toBe('LOD/Reports');

            // No title field was sent (not provided).
            expect(req.parts.find((p) => p.name === 'title')).toBeUndefined();

            expect(logs.join('\n')).toContain('✓ chart.png → LOD/Reports (doc 42)');
        } finally {
            restore();
            cleanupFile();
            cleanup();
        }
    });

    it('single file with --title: sends the title field', async () => {
        const { cleanup } = setupConfig();
        const { file, cleanup: cleanupFile } = writeTmpFile('report.pdf', 'pdf content');
        const { restore } = captureConsole();
        try {
            queue(201, { id: 7, title: 'Quarterly Report', folder_path: '' });

            await runExpectingExit(() => docsUpload([file], { title: 'Quarterly Report' }));

            const titlePart = allCaptures[0].parts.find((p) => p.name === 'title');
            expect(titlePart?.value).toBe('Quarterly Report');
        } finally {
            restore();
            cleanupFile();
            cleanup();
        }
    });

    it('multiple files: uploads sequentially, one POST per file, and prints a ✓ result line per file', async () => {
        const { cleanup } = setupConfig();
        const { file: file1, cleanup: cleanup1 } = writeTmpFile('a.txt', 'aaa');
        const { file: file2, cleanup: cleanup2 } = writeTmpFile('b.txt', 'bbb');
        const { logs, restore } = captureConsole();
        try {
            queue(201, { id: 1, title: 'a.txt', folder_path: 'Notes' });
            queue(201, { id: 2, title: 'b.txt', folder_path: 'Notes' });

            const code = await runExpectingExit(() => docsUpload([file1, file2], { folder: 'Notes' }));
            expect(code).toBeUndefined();

            expect(allCaptures).toHaveLength(2);
            const first = allCaptures[0].parts.find((p) => p.name === 'file');
            const second = allCaptures[1].parts.find((p) => p.name === 'file');
            expect(first!.filename).toBe('a.txt');
            expect(second!.filename).toBe('b.txt');

            const out = logs.join('\n');
            expect(out).toContain('✓ a.txt → Notes (doc 1)');
            expect(out).toContain('✓ b.txt → Notes (doc 2)');
        } finally {
            restore();
            cleanup1();
            cleanup2();
            cleanup();
        }
    });

    it('--title with multiple files: errors before any request is made', async () => {
        const { cleanup } = setupConfig();
        const { file: file1, cleanup: cleanup1 } = writeTmpFile('a.txt', 'aaa');
        const { file: file2, cleanup: cleanup2 } = writeTmpFile('b.txt', 'bbb');
        const { errors, restore } = captureConsole();
        try {
            const code = await runExpectingExit(() => docsUpload([file1, file2], { title: 'One Title For All' }));

            expect(code).toBe(1);
            expect(allCaptures).toHaveLength(0);
            expect(errors.join('\n')).toContain('--title can only be used when uploading a single file.');
        } finally {
            restore();
            cleanup1();
            cleanup2();
            cleanup();
        }
    });

    it('413 media_too_large: surfaces the server message cleanly and exits 1', async () => {
        const { cleanup } = setupConfig();
        const { file, cleanup: cleanupFile } = writeTmpFile('huge.bin', 'x'.repeat(100));
        const { errors, restore } = captureConsole();
        try {
            queue(413, { code: 'media_too_large', message: 'File exceeds the 20MB upload limit.' });

            const code = await runExpectingExit(() => docsUpload([file], {}));

            expect(code).toBe(1);
            expect(allCaptures).toHaveLength(1);
            const out = errors.join('\n');
            expect(out).toContain('huge.bin');
            expect(out).toContain('File exceeds the 20MB upload limit.');
        } finally {
            restore();
            cleanupFile();
            cleanup();
        }
    });

    it('mixed success/failure across multiple files: continues past a failed file and exits 1 at the end', async () => {
        const { cleanup } = setupConfig();
        const { file: file1, cleanup: cleanup1 } = writeTmpFile('good.txt', 'ok');
        const { file: file2, cleanup: cleanup2 } = writeTmpFile('bad.txt', 'nope');
        const { logs, errors, restore } = captureConsole();
        try {
            queue(201, { id: 5, title: 'good.txt', folder_path: '' });
            queue(500, { message: 'Internal server error.' });

            const code = await runExpectingExit(() => docsUpload([file1, file2], {}));

            expect(code).toBe(1);
            expect(allCaptures).toHaveLength(2);
            expect(logs.join('\n')).toContain('✓ good.txt');
            expect(errors.join('\n')).toContain('bad.txt');
        } finally {
            restore();
            cleanup1();
            cleanup2();
            cleanup();
        }
    });

    it('local file not found: prints ✗ file not found, makes no request for it, continues to the next file, exits 1', async () => {
        const { cleanup } = setupConfig();
        const { file: goodFile, cleanup: cleanupFile } = writeTmpFile('exists.txt', 'hello');
        const missingFile = path.join(path.dirname(goodFile), 'missing.txt');
        const { logs, errors, restore } = captureConsole();
        try {
            queue(201, { id: 9, title: 'exists.txt', folder_path: '' });

            const code = await runExpectingExit(() => docsUpload([missingFile, goodFile], {}));

            expect(code).toBe(1);
            // Only ONE request — the missing file never hit the server.
            expect(allCaptures).toHaveLength(1);
            const filePart = allCaptures[0].parts.find((p) => p.name === 'file');
            expect(filePart!.filename).toBe('exists.txt');

            expect(errors.join('\n')).toContain('✗ missing.txt — file not found');
            expect(logs.join('\n')).toContain('✓ exists.txt');
        } finally {
            restore();
            cleanupFile();
            cleanup();
        }
    });
});

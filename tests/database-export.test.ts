import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { gzipSync } from 'zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { databaseExportWithConfig } from '../src/commands/database-export';

const ID = '01990000-0000-7000-8000-000000000171';
const CREATED = '2026-09-01T12:34:56Z';
const EXPIRES = '2026-09-02T12:34:56Z';
const parquet = Buffer.from('PAR1-real-export-bytes');
const digest = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const manifestDocument = {
    version: 1, export_id: ID, database_id: '01990000-0000-7000-8000-000000000001', database_name: 'warehouse', attempt: 1,
    generation: 4, snapshot_id: 3762, created_at: CREATED, expires_at: EXPIRES,
    files: [{ table: 'events', ordinal: 1, filename: 'events.parquet', rows: 1, bytes: parquet.length, sha256: digest(parquet), destination_etag: 'etag-events' }],
    export_bytes: parquet.length, row_count: 1,
};
const manifest = Buffer.from(JSON.stringify(manifestDocument));
const roots: string[] = [];

afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

type Reply = { status?: number; json?: unknown; bytes?: Buffer; headers?: Record<string, string>; stream?: (response: http.ServerResponse) => void };
type Responder = (request: http.IncomingMessage, body: Record<string, unknown>, attempt: number) => Reply;

async function serve(responder: Responder) {
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    const attempts = new Map<string, number>();
    const server = http.createServer((request, response) => {
        let raw = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => { raw += chunk; });
        request.on('end', () => {
            const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
            const key = request.method === 'POST' ? String(body.operation) : String(request.url);
            const attempt = (attempts.get(key) ?? 0) + 1;
            attempts.set(key, attempt);
            calls.push({ method: request.method ?? '', url: request.url ?? '', body });
            const reply = responder(request, body, attempt);
            if (reply.stream) {
                reply.stream(response);
                return;
            }
            const payload = reply.bytes ?? Buffer.from(JSON.stringify(reply.json ?? {}));
            response.writeHead(reply.status ?? 200, { 'Content-Length': String(payload.length), ...(reply.headers ?? {}) });
            response.end(payload);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, calls, attempts, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

function normal(getOrigin: () => string, request: http.IncomingMessage, body: Record<string, unknown>): Reply {
    if (request.method === 'GET') return { bytes: request.url === '/manifest' ? manifest : parquet };
    if (body.operation === 'show') return { json: { database: { name: 'Sales / 2026', kind: 'duckdb', status: 'ready', size_bytes: 1, deleted_at: null, purge_at: null } } };
    if (body.operation === 'export') return { json: { export_id: ID, state: 'ready', created_at: CREATED, expires_at: EXPIRES, manifest_digest: digest(manifest), tables: body.tables ?? null } };
    if (body.operation === 'export_status') return { json: { export_id: ID, state: 'ready', created_at: CREATED, expires_at: EXPIRES, manifest_digest: digest(manifest) } };
    return { json: { export_id: ID, expires_at: EXPIRES, manifest: { filename: 'manifest.json', digest: digest(manifest), url: `${getOrigin()}/manifest` }, files: [{ table: 'events', filename: 'events.parquet', rows: 1, bytes: parquet.length, sha256: digest(parquet), url: `${getOrigin()}/events` }] } };
}

async function scenario(responder: Responder, run: (remote: Awaited<ReturnType<typeof serve>>) => Promise<void>) {
    const remote = await serve(responder);
    try { await run(remote); } finally { await new Promise<void>((resolve) => remote.server.close(() => resolve())); }
}

function tmp(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-export-'));
    roots.push(root);
    return root;
}

const config = (origin: string) => ({ host: origin, apiKey: 'pat', workspaceId: 'ws' });
const quiet = { stdout: () => undefined };

describe('database export with real HTTP and filesystem I/O', () => {
    it('normalizes repeated tables and verifies a deterministic safe directory', async () => {
        let origin = '';
        await scenario((request, body) => normal(() => origin, request, body), async (remote) => {
            origin = remote.origin;
            const root = tmp();
            const result = await databaseExportWithConfig('Sales / 2026', { table: ['Events', 'events', ' EVENTS '] }, config(origin), { cwd: root, ...quiet });
            expect(result.directory).toBe(path.join(root, 'sales-2026-20260901T123456Z-01990000'));
            expect(fs.readFileSync(path.join(result.directory, 'events.parquet'))).toEqual(parquet);
            expect(fs.readFileSync(path.join(result.directory, 'manifest.json'))).toEqual(manifest);
            expect(remote.calls.find((call) => call.body.operation === 'export')?.body).toMatchObject({ tables: ['events'], replace: false });
        });
    });

    it.each([false, true])('accepts gzip transport framing and retains SHA-256 verification (corrupt=%s)', async (corrupt) => {
        let origin = '';
        await scenario((request, body) => {
            if (request.method === 'GET' && request.url === '/manifest') {
                const encoded = gzipSync(manifest);
                return { bytes: encoded, headers: { 'Content-Encoding': 'gzip', 'Content-Length': String(encoded.length) } };
            }
            if (request.method === 'GET' && request.url === '/events') {
                const decoded = corrupt ? Buffer.alloc(parquet.length, 0x78) : parquet;
                const encoded = gzipSync(decoded);
                return { bytes: encoded, headers: { 'Content-Encoding': 'gzip', 'Content-Length': String(encoded.length) } };
            }
            return normal(() => origin, request, body);
        }, async (remote) => {
            origin = remote.origin;
            const output = path.join(tmp(), corrupt ? 'gzip-corrupt' : 'gzip-valid');
            const run = databaseExportWithConfig('warehouse', { output }, config(origin), quiet);
            if (corrupt) {
                await expect(run).rejects.toMatchObject({ code: 'download_corrupt' });
            } else {
                await run;
                expect(fs.readFileSync(path.join(output, 'events.parquet'))).toEqual(parquet);
            }
        });
    });

    it.each([false, true])('accepts gzip chunked responses without Content-Length (corrupt=%s)', async (corrupt) => {
        let origin = '';
        await scenario((request, body) => {
            if (request.method === 'GET' && request.url === '/manifest') {
                const encoded = gzipSync(manifest);
                return { stream: (response) => {
                    response.writeHead(200, { 'Content-Encoding': 'gzip' });
                    response.write(encoded.subarray(0, 3));
                    response.end(encoded.subarray(3));
                } };
            }
            if (request.method === 'GET' && request.url === '/events') {
                const decoded = corrupt ? Buffer.alloc(parquet.length, 0x78) : parquet;
                const encoded = gzipSync(decoded);
                return { stream: (response) => {
                    response.writeHead(200, { 'Content-Encoding': 'gzip' });
                    response.write(encoded.subarray(0, 3));
                    response.end(encoded.subarray(3));
                } };
            }
            return normal(() => origin, request, body);
        }, async (remote) => {
            origin = remote.origin;
            const output = path.join(tmp(), corrupt ? 'chunked-corrupt' : 'chunked-valid');
            const run = databaseExportWithConfig('warehouse', { output }, config(origin), quiet);
            if (corrupt) {
                await expect(run).rejects.toMatchObject({ code: 'download_corrupt' });
            } else {
                await run;
                expect(fs.readFileSync(path.join(output, 'events.parquet'))).toEqual(parquet);
            }
        });
    });

    it('returns the accepted API body for JSON no-wait without polling or downloads', async () => {
        let origin = '';
        await scenario((request, body) => body.operation === 'export'
            ? { json: { export_id: ID, state: 'queued', created_at: CREATED, replayed: false, reused: false, tables: null } }
            : normal(() => origin, request, body), async (remote) => {
            origin = remote.origin;
            const output: string[] = [];
            await databaseExportWithConfig('warehouse', { wait: false, json: true, table: [] }, config(origin), { stdout: (line) => output.push(line) });
            expect(JSON.parse(output.join('\n'))).toEqual({ export_id: ID, state: 'queued', created_at: CREATED, replayed: false, reused: false, tables: null });
            expect(remote.calls.map((call) => call.body.operation).filter(Boolean)).toEqual(['show', 'export']);
            expect(remote.calls.find((call) => call.body.operation === 'export')?.body).not.toHaveProperty('tables');
        });
    });

    it('resumes, skips a verified file, and deletes stale partials', async () => {
        let origin = '';
        await scenario((request, body) => normal(() => origin, request, body), async (remote) => {
            origin = remote.origin;
            const output = path.join(tmp(), 'resume');
            fs.mkdirSync(output);
            fs.writeFileSync(path.join(output, 'manifest.json'), manifest);
            fs.writeFileSync(path.join(output, 'events.parquet'), parquet);
            fs.writeFileSync(path.join(output, 'events.parquet.part'), 'partial');
            fs.writeFileSync(path.join(output, 'notes.part'), 'mine');
            await databaseExportWithConfig('warehouse', { resume: ID, output }, config(origin), quiet);
            expect(fs.existsSync(path.join(output, 'events.parquet.part'))).toBe(false);
            expect(fs.readFileSync(path.join(output, 'notes.part'), 'utf8')).toBe('mine');
            expect(remote.calls.filter((call) => call.method === 'GET')).toEqual([]);
        });
    });

    it('refuses a resume directory owned by another export before touching any files', async () => {
        let origin = '';
        await scenario((request, body) => normal(() => origin, request, body), async (remote) => {
            origin = remote.origin;
            const output = path.join(tmp(), 'other-export');
            fs.mkdirSync(output);
            const otherManifest = `${JSON.stringify({ version: 1, export_id: '01990000-0000-7000-8000-000000000999' })}\n`;
            fs.writeFileSync(path.join(output, 'manifest.json'), otherManifest);
            fs.writeFileSync(path.join(output, 'events.parquet'), 'valuable');
            fs.writeFileSync(path.join(output, 'events.parquet.part'), 'unfinished');
            fs.writeFileSync(path.join(output, 'notes.part'), 'mine');

            await expect(databaseExportWithConfig('warehouse', { resume: ID, output }, config(origin), quiet)).rejects.toMatchObject({ code: 'resume_destination_mismatch' });

            expect(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8')).toBe(otherManifest);
            expect(fs.readFileSync(path.join(output, 'events.parquet'), 'utf8')).toBe('valuable');
            expect(fs.readFileSync(path.join(output, 'events.parquet.part'), 'utf8')).toBe('unfinished');
            expect(fs.readFileSync(path.join(output, 'notes.part'), 'utf8')).toBe('mine');
            expect(remote.calls.some((call) => call.method === 'GET')).toBe(false);
        });
    });

    it('preserves a differing resume target and unrelated files when replacement verification fails', async () => {
        let origin = '';
        await scenario((request, body) => {
            const reply = normal(() => origin, request, body);
            if (request.method === 'GET' && request.url === '/events') return { bytes: Buffer.from('corrupt') };
            return reply;
        }, async (remote) => {
            origin = remote.origin;
            const output = path.join(tmp(), 'failed-replacement');
            fs.mkdirSync(output);
            fs.writeFileSync(path.join(output, 'manifest.json'), manifest);
            fs.writeFileSync(path.join(output, 'events.parquet'), 'valuable-old-copy');
            fs.writeFileSync(path.join(output, 'unrelated.part'), 'mine');

            await expect(databaseExportWithConfig('warehouse', { resume: ID, output }, config(origin), quiet)).rejects.toMatchObject({ code: 'download_corrupt' });

            expect(fs.readFileSync(path.join(output, 'events.parquet'), 'utf8')).toBe('valuable-old-copy');
            expect(fs.readFileSync(path.join(output, 'unrelated.part'), 'utf8')).toBe('mine');
            expect(fs.readdirSync(output).filter((name) => name.includes('.tmp-'))).toEqual([]);
        });
    });

    it('atomically renames verified temporary bytes over a differing resume target', async () => {
        let origin = '';
        let started!: () => void;
        let release!: () => void;
        const downloadStarted = new Promise<void>((resolve) => { started = resolve; });
        const finishDownload = new Promise<void>((resolve) => { release = resolve; });
        await scenario((request, body) => {
            if (request.method === 'GET' && request.url === '/events') {
                return { stream: (response) => {
                    response.writeHead(200, { 'Content-Length': String(parquet.length) });
                    response.write(parquet.subarray(0, 4));
                    started();
                    void finishDownload.then(() => response.end(parquet.subarray(4)));
                } };
            }
            return normal(() => origin, request, body);
        }, async (remote) => {
            origin = remote.origin;
            const output = path.join(tmp(), 'verified-replacement');
            fs.mkdirSync(output);
            fs.writeFileSync(path.join(output, 'manifest.json'), manifest);
            const target = path.join(output, 'events.parquet');
            fs.writeFileSync(target, 'old-copy');
            fs.writeFileSync(path.join(output, 'unrelated.part'), 'mine');
            const exporting = databaseExportWithConfig('warehouse', { resume: ID, output }, config(origin), quiet);
            await downloadStarted;

            let inspectionError: unknown;
            try {
                expect(fs.readFileSync(target, 'utf8')).toBe('old-copy');
                await expect.poll(() => fs.readdirSync(output).filter((name) => /events\.parquet\.tmp-/.test(name))).toHaveLength(1);
                expect(fs.readFileSync(path.join(output, 'unrelated.part'), 'utf8')).toBe('mine');
            } catch (error) {
                inspectionError = error;
            } finally {
                release();
            }
            await exporting;
            if (inspectionError) throw inspectionError;
            expect(fs.readFileSync(target)).toEqual(parquet);
            expect(fs.readdirSync(output).filter((name) => name.includes('.tmp-'))).toEqual([]);
            expect(fs.readFileSync(path.join(output, 'unrelated.part'), 'utf8')).toBe('mine');
        });
    });

    it('refuses a nonempty fresh target without overwriting it', async () => {
        let origin = '';
        await scenario((request, body) => normal(() => origin, request, body), async (remote) => {
            origin = remote.origin;
            const output = path.join(tmp(), 'occupied');
            fs.mkdirSync(output);
            fs.writeFileSync(path.join(output, 'keep'), 'mine');
            await expect(databaseExportWithConfig('warehouse', { output }, config(origin), quiet)).rejects.toMatchObject({ code: 'output_not_empty' });
            expect(fs.readFileSync(path.join(output, 'keep'), 'utf8')).toBe('mine');
        });
    });

    it.each(['length', 'sha'] as const)('rejects an API/manifest %s mismatch before downloading parquet', async (failure) => {
        let origin = '';
        await scenario((request, body) => {
            const reply = normal(() => origin, request, body);
            if (body.operation === 'export_downloads') {
                if (failure === 'length') (reply.json as any).files[0].bytes++;
                else (reply.json as any).files[0].sha256 = '0'.repeat(64);
            }
            return reply;
        }, async (remote) => {
            origin = remote.origin;
            const output = path.join(tmp(), failure);
            await expect(databaseExportWithConfig('warehouse', { output }, config(origin), quiet)).rejects.toMatchObject({ code: 'manifest_mismatch' });
            expect(fs.existsSync(path.join(output, 'events.parquet'))).toBe(false);
            expect(fs.existsSync(path.join(output, 'events.parquet.part'))).toBe(false);
            expect(remote.calls.some((call) => call.url === '/events')).toBe(false);
        });
    });

    it('refreshes once after a signed URL returns 403', async () => {
        let origin = '';
        await scenario((request, body, attempt) => request.method === 'GET' && request.url === '/events' && attempt === 1
            ? { status: 403, json: {} }
            : normal(() => origin, request, body), async (remote) => {
            origin = remote.origin;
            await databaseExportWithConfig('warehouse', { output: path.join(tmp(), 'refresh') }, config(origin), quiet);
            expect(remote.attempts.get('/events')).toBe(2);
            expect(remote.attempts.get('export_downloads')).toBeGreaterThanOrEqual(3);
        });
    });

    it('rejects a reminted listing whose authenticated row metadata changed', async () => {
        let origin = '';
        await scenario((request, body, attempt) => {
            if (request.method === 'GET' && request.url === '/events') return { status: 403, json: {} };
            const reply = normal(() => origin, request, body);
            if (body.operation === 'export_downloads' && attempt >= 3) (reply.json as any).files[0].rows = 2;
            return reply;
        }, async (remote) => {
            origin = remote.origin;
            await expect(databaseExportWithConfig('warehouse', { output: path.join(tmp(), 'changed-remint') }, config(origin), quiet)).rejects.toMatchObject({ code: 'export_superseded' });
        });
    });

    it('polls at five seconds by default and honors Retry-After', async () => {
        let origin = '';
        await scenario((request, body) => body.operation === 'export'
            ? { json: { export_id: ID, state: 'queued', created_at: CREATED } }
            : normal(() => origin, request, body), async (remote) => {
            origin = remote.origin;
            const sleeps: number[] = [];
            await databaseExportWithConfig('warehouse', { output: path.join(tmp(), 'default-poll') }, config(origin), { ...quiet, sleep: async (milliseconds) => { sleeps.push(milliseconds); } });
            expect(sleeps).toEqual([5_000]);
        });

        origin = '';
        await scenario((request, body, attempt) => {
            if (body.operation === 'export') return { headers: { 'Retry-After': '0' }, json: { export_id: ID, state: 'queued', created_at: CREATED } };
            if (body.operation === 'export_status' && attempt === 1) return { headers: { 'Retry-After': '0' }, json: { export_id: ID, state: 'running', created_at: CREATED } };
            return normal(() => origin, request, body);
        }, async (remote) => {
            origin = remote.origin;
            const sleeps: number[] = [];
            await databaseExportWithConfig('warehouse', { output: path.join(tmp(), 'poll') }, config(origin), { ...quiet, sleep: async (milliseconds) => { sleeps.push(milliseconds); } });
            expect(remote.attempts.get('export_status')).toBe(2);
            expect(sleeps).toEqual([0, 0]);
        });
    });

    it.each([
        ['export_in_progress', 'export', 409, { code: 'export_in_progress', message: 'busy', export_id: ID }, '--resume'],
        ['export_expired', 'export_status', 410, { code: 'export_expired', message: 'expired', export_id: ID }, 'Start a new export'],
        ['export_failed', 'export_status', 200, { export_id: ID, state: 'failed', created_at: CREATED, error_code: 'export_failed', error_message: 'materialization failed' }, 'Start a new export'],
    ] as const)('provides teaching copy for %s', async (code, phase, status, response, teaching) => {
        let origin = '';
        await scenario((request, body) => body.operation === phase ? { status, json: response } : normal(() => origin, request, body), async (remote) => {
            origin = remote.origin;
            const options = phase === 'export' ? {} : { resume: ID };
            await expect(databaseExportWithConfig('warehouse', options, config(origin), quiet)).rejects.toMatchObject({ code, message: expect.stringContaining(teaching) });
        });
    });

    it('distinguishes an artifact superseded after a download URL expires', async () => {
        let origin = '';
        await scenario((request, body, attempt) => {
            if (request.method === 'GET' && request.url === '/events') return { status: 403, json: {} };
            if (body.operation === 'export_downloads' && attempt >= 3) return { status: 410, json: { code: 'export_expired', message: 'expired', export_id: ID } };
            return normal(() => origin, request, body);
        }, async (remote) => {
            origin = remote.origin;
            await expect(databaseExportWithConfig('warehouse', { output: path.join(tmp(), 'superseded') }, config(origin), quiet)).rejects.toMatchObject({ code: 'export_superseded' });
        });
    });

    it('requires --replace without a TTY and confirms/resends with the same request id on a TTY', async () => {
        let origin = '';
        const replacement = (request: http.IncomingMessage, body: Record<string, unknown>, attempt: number) => body.operation === 'export' && attempt === 1
            ? { status: 409, json: { code: 'export_replace_required', message: 'replace it', current_export_id: ID } }
            : normal(() => origin, request, body);
        await scenario(replacement, async (remote) => {
            origin = remote.origin;
            await expect(databaseExportWithConfig('warehouse', { wait: false }, config(origin), { ...quiet, isTTY: false })).rejects.toMatchObject({ code: 'export_replace_required', message: expect.stringContaining('--replace') });
        });
        origin = '';
        await scenario(replacement, async (remote) => {
            origin = remote.origin;
            await databaseExportWithConfig('warehouse', { wait: false }, config(origin), { ...quiet, isTTY: true, confirm: async () => true });
            const requests = remote.calls.filter((call) => call.body.operation === 'export').map((call) => call.body);
            expect(requests[1]).toMatchObject({ replace: true, request_id: requests[0].request_id });
        });
        origin = '';
        await scenario((request, body) => normal(() => origin, request, body), async (remote) => {
            origin = remote.origin;
            await databaseExportWithConfig('warehouse', { wait: false, replace: true }, config(origin), { ...quiet, isTTY: false });
            expect(remote.calls.find((call) => call.body.operation === 'export')?.body.replace).toBe(true);
        });
    });

    it('downloads an empty export as manifest-only', async () => {
        let origin = '';
        const emptyManifest = Buffer.from(JSON.stringify({ ...manifestDocument, files: [], export_bytes: 0, row_count: 0 }));
        await scenario((request, body) => {
            const reply = normal(() => origin, request, body);
            if (request.method === 'GET' && request.url === '/manifest') return { bytes: emptyManifest };
            if (body.operation === 'export' || body.operation === 'export_status') (reply.json as any).manifest_digest = digest(emptyManifest);
            if (body.operation === 'export_downloads') {
                (reply.json as any).manifest.digest = digest(emptyManifest);
                (reply.json as any).files = [];
            }
            return reply;
        }, async (remote) => {
            origin = remote.origin;
            const result = await databaseExportWithConfig('warehouse', { output: path.join(tmp(), 'empty') }, config(origin), quiet);
            expect(result.files.map((file) => file.filename)).toEqual(['manifest.json']);
        });
    });

    it.each([
        ['wrong export', { export_id: '01990000-0000-7000-8000-000000000999' }, {}],
        ['wrong version', { version: 2 }, {}],
        ['duplicate manifest file', { files: [manifestDocument.files[0], manifestDocument.files[0]] }, {}],
        ['missing manifest file', { files: [] }, {}],
        ['extra manifest file', { files: [...manifestDocument.files, { ...manifestDocument.files[0], table: 'users', filename: 'users.parquet' }] }, {}],
        ['table mismatch', { files: [{ ...manifestDocument.files[0], table: 'users' }] }, {}],
        ['filename mismatch', { files: [{ ...manifestDocument.files[0], filename: 'other.parquet' }] }, {}],
        ['rows mismatch', { files: [{ ...manifestDocument.files[0], rows: 2 }] }, {}],
        ['bytes mismatch', { files: [{ ...manifestDocument.files[0], bytes: parquet.length + 1 }] }, {}],
        ['sha mismatch', { files: [{ ...manifestDocument.files[0], sha256: '0'.repeat(64) }] }, {}],
        ['duplicate API file', {}, { duplicateApiFile: true }],
    ] as const)('rejects a verified manifest with %s before downloading parquet', async (_case, manifestChanges, apiChanges) => {
        let origin = '';
        const changedManifest = Buffer.from(JSON.stringify({ ...manifestDocument, ...manifestChanges }));
        await scenario((request, body) => {
            const reply = normal(() => origin, request, body);
            if (request.method === 'GET' && request.url === '/manifest') return { bytes: changedManifest };
            if (body.operation === 'export' || body.operation === 'export_status') (reply.json as any).manifest_digest = digest(changedManifest);
            if (body.operation === 'export_downloads') {
                (reply.json as any).manifest.digest = digest(changedManifest);
                if ('duplicateApiFile' in apiChanges) (reply.json as any).files.push({ ...(reply.json as any).files[0] });
            }
            return reply;
        }, async (remote) => {
            origin = remote.origin;
            const output = path.join(tmp(), 'manifest-mismatch');
            await expect(databaseExportWithConfig('warehouse', { output }, config(origin), quiet)).rejects.toMatchObject({ code: 'manifest_mismatch' });
            expect(remote.calls.some((call) => call.url === '/events')).toBe(false);
        });
    });

    it.each(['wrong manifest', 'duplicate file'] as const)('rejects hostile %s metadata before writing', async (attack) => {
        let origin = '';
        await scenario((request, body) => {
            const reply = normal(() => origin, request, body);
            if (body.operation === 'export_downloads') {
                if (attack === 'wrong manifest') (reply.json as any).manifest.filename = 'other.json';
                else (reply.json as any).files.push({ ...(reply.json as any).files[0] });
            }
            return reply;
        }, async (remote) => {
            origin = remote.origin;
            const output = path.join(tmp(), 'hostile');
            await expect(databaseExportWithConfig('warehouse', { output }, config(origin), quiet)).rejects.toMatchObject({ code: attack === 'wrong manifest' ? 'upstream_unavailable' : 'manifest_mismatch' });
            expect(fs.existsSync(output)).toBe(attack === 'duplicate file');
            expect(remote.calls.some((call) => call.url === '/events')).toBe(false);
        });
    });

    it('rejects symlink output directories and symlink resume files', async () => {
        let origin = '';
        await scenario((request, body) => normal(() => origin, request, body), async (remote) => {
            origin = remote.origin;
            const root = tmp();
            const outside = path.join(root, 'outside');
            fs.mkdirSync(outside);
            const linkedDirectory = path.join(root, 'linked');
            fs.symlinkSync(outside, linkedDirectory, 'dir');
            await expect(databaseExportWithConfig('warehouse', { output: linkedDirectory }, config(origin), quiet)).rejects.toMatchObject({ code: 'unsafe_destination' });

            const resume = path.join(root, 'resume-safe');
            fs.mkdirSync(resume);
            fs.writeFileSync(path.join(resume, 'manifest.json'), manifest);
            const outsideFile = path.join(outside, 'valuable');
            fs.writeFileSync(outsideFile, parquet);
            fs.symlinkSync(outsideFile, path.join(resume, 'events.parquet'));
            await expect(databaseExportWithConfig('warehouse', { resume: ID, output: resume }, config(origin), quiet)).rejects.toMatchObject({ code: 'unsafe_destination' });
            expect(fs.readFileSync(outsideFile)).toEqual(parquet);
        });
    });

    it.each([{ resume: ID, replace: true }, { resume: ID, wait: false }])('rejects contradictory resume flags: %j', async (options) => {
        await expect(databaseExportWithConfig('warehouse', options, config('http://127.0.0.1:1'), quiet)).rejects.toMatchObject({ code: 'invalid_arguments' });
    });
});

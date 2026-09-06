import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { databaseExportWithConfig } from '../src/commands/database-export';

const ID = '01990000-0000-7000-8000-000000000171';
const CREATED = '2026-09-01T12:34:56Z';
const EXPIRES = '2026-09-02T12:34:56Z';
const parquet = Buffer.from('PAR1-real-export-bytes');
const manifest = Buffer.from('{"version":1}\n');
const digest = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const roots: string[] = [];

afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

type Reply = { status?: number; json?: unknown; bytes?: Buffer; headers?: Record<string, string> };
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
            fs.writeFileSync(path.join(output, 'events.parquet'), parquet);
            fs.writeFileSync(path.join(output, 'events.parquet.part'), 'partial');
            fs.writeFileSync(path.join(output, 'notes.part'), 'mine');
            await databaseExportWithConfig('warehouse', { resume: ID, output }, config(origin), quiet);
            expect(fs.existsSync(path.join(output, 'events.parquet.part'))).toBe(false);
            expect(fs.readFileSync(path.join(output, 'notes.part'), 'utf8')).toBe('mine');
            expect(remote.calls.filter((call) => call.method === 'GET').map((call) => call.url)).toEqual(['/manifest']);
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

    it.each(['length', 'sha'] as const)('removes the partial after a %s mismatch', async (failure) => {
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
            await expect(databaseExportWithConfig('warehouse', { output }, config(origin), quiet)).rejects.toMatchObject({ code: 'download_corrupt', message: expect.stringContaining(`--resume ${ID}`) });
            expect(fs.existsSync(path.join(output, 'events.parquet'))).toBe(false);
            expect(fs.existsSync(path.join(output, 'events.parquet.part'))).toBe(false);
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
        await scenario((request, body) => {
            const reply = normal(() => origin, request, body);
            if (body.operation === 'export_downloads') (reply.json as any).files = [];
            return reply;
        }, async (remote) => {
            origin = remote.origin;
            const result = await databaseExportWithConfig('warehouse', { output: path.join(tmp(), 'empty') }, config(origin), quiet);
            expect(result.files.map((file) => file.filename)).toEqual(['manifest.json']);
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
            await expect(databaseExportWithConfig('warehouse', { output }, config(origin), quiet)).rejects.toMatchObject({ code: 'upstream_unavailable' });
            expect(fs.existsSync(output)).toBe(false);
            expect(remote.calls.some((call) => call.method === 'GET')).toBe(false);
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

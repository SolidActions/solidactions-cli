import fs from 'fs';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { createClient } from '@libsql/client';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertCountableTableLimit, normalizeDatabaseForPush, databasePushWithConfig } from '../src/commands/database-push';

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(empty = false): Promise<string> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-push-test-'));
    roots.push(root);
    const source = path.join(root, 'source.db');
    const client = createClient({ url: pathToFileURL(source).href });
    await client.execute('PRAGMA page_size=8192');
    await client.execute('PRAGMA auto_vacuum=FULL');
    await client.execute('VACUUM');
    await client.execute('PRAGMA journal_mode=DELETE');
    await client.execute('CREATE TABLE "123 odd" (id INTEGER PRIMARY KEY, value TEXT)');
    await client.execute('CREATE INDEX "hostile""index" ON "123 odd" (value)');
    await client.execute('CREATE VIEW visible AS SELECT value FROM "123 odd"');
    if (!empty) await client.execute({ sql: 'INSERT INTO "123 odd" (value) VALUES (?)', args: ['committed WAL'] });
    await client.close();
    return source;
}

describe('database push normalization', () => {
    it('normalizes an immutable coherent snapshot and leaves source bytes and timestamps unchanged', async () => {
        const source = await fixture();
        const before = fs.statSync(source);
        const bytes = fs.readFileSync(source);
        const sidecars = ['-wal', '-shm'].map((suffix) => ({ file: `${source}${suffix}`, exists: fs.existsSync(`${source}${suffix}`) }));
        const normalized = await normalizeDatabaseForPush(source);
        try {
            expect(normalized.inputBytes).toBe(normalized.pageCount * 4096);
            expect(normalized.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(normalized.manifest.schema_sha256).toBe('f27e592b31ce881238da558ef70e09c7affb77bc0533f446a8ea2bca11b05bb4');
            expect(normalized.manifest.tables).toEqual({ '123 odd': 1 });
            expect(createHash('sha256').update(fs.readFileSync(normalized.file)).digest('hex')).toBe(normalized.manifest.sha256);
            expect(fs.existsSync(`${normalized.file}-wal`)).toBe(false);
            expect(fs.existsSync(`${normalized.file}-shm`)).toBe(false);
            const artifact = createClient({ url: pathToFileURL(normalized.file).href });
            expect((await artifact.execute('PRAGMA page_size')).rows[0][0]).toBe(4096);
            expect((await artifact.execute('PRAGMA auto_vacuum')).rows[0][0]).toBe(0);
            expect(String((await artifact.execute('PRAGMA journal_mode')).rows[0][0]).toLowerCase()).toBe('wal');
            await artifact.close();
            expect(fs.readFileSync(source)).toEqual(bytes);
            expect(fs.statSync(source).mtimeMs).toBe(before.mtimeMs);
            sidecars.forEach(({ file, exists }) => expect(fs.existsSync(file)).toBe(exists));
        } finally {
            await normalized.cleanup();
        }
    });

    it('sanitizes corrupt input and insufficient temporary space before prepare', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-push-invalid-'));
        roots.push(root);
        const corrupt = path.join(root, 'corrupt.db');
        fs.writeFileSync(corrupt, 'not an sqlite database');
        await expect(normalizeDatabaseForPush(corrupt)).rejects.toMatchObject({ code: 'invalid_bulk_database', message: expect.stringContaining('source database was not changed') });
        const source = await fixture();
        await expect(normalizeDatabaseForPush(source, { statfs: async () => ({ bavail: 0, bsize: 4096 } as any) }))
            .rejects.toMatchObject({ code: 'invalid_bulk_database', message: expect.stringContaining('disk space') });
    });

    it('reports a missing source path as file not found', async () => {
        await expect(normalizeDatabaseForPush(path.join(os.tmpdir(), `missing-${Date.now()}.db`)))
            .rejects.toMatchObject({ code: 'invalid_bulk_database', message: expect.stringMatching(/file.*not found/i) });
    });

    it('captures committed WAL rows without changing the main database or WAL', async () => {
        const source = await fixture();
        const writer = createClient({ url: pathToFileURL(source).href });
        await writer.execute('PRAGMA journal_mode=WAL');
        await writer.execute({ sql: 'INSERT INTO "123 odd" (value) VALUES (?)', args: ['committed in WAL'] });
        const wal = `${source}-wal`;
        expect(fs.existsSync(wal)).toBe(true);
        const mainBefore = fs.readFileSync(source);
        const walBefore = fs.readFileSync(wal);
        const mainMtime = fs.statSync(source).mtimeMs;
        const walMtime = fs.statSync(wal).mtimeMs;
        const normalized = await normalizeDatabaseForPush(source);
        try {
            expect(normalized.manifest.tables['123 odd']).toBe(2);
            expect(fs.readFileSync(source)).toEqual(mainBefore);
            expect(fs.readFileSync(wal)).toEqual(walBefore);
            expect(fs.statSync(source).mtimeMs).toBe(mainMtime);
            expect(fs.statSync(wal).mtimeMs).toBe(walMtime);
        } finally {
            await normalized.cleanup();
            await writer.close();
        }
    });

    it('rejects 1,001 countable tables through the pure preflight cap', () => {
        expect(() => assertCountableTableLimit(1_000)).not.toThrow();
        expect(() => assertCountableTableLimit(1_001)).toThrow(expect.objectContaining({ code: 'invalid_bulk_database' }));
    });

    it('matches the PHP hostile schema and count predicates exactly', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-push-manifest-'));
        roots.push(root);
        const source = path.join(root, 'hostile.db');
        const client = createClient({ url: pathToFileURL(source).href });
        await client.executeMultiple?.(`
            CREATE TABLE "123" (value TEXT);
            CREATE TABLE sqliteXfoo (value TEXT);
            CREATE TABLE "z" (value TEXT);
            CREATE TABLE "é" (value TEXT);
            CREATE TABLE "_LITESTREAM_hidden" (value TEXT);
            CREATE TABLE "LIBSQL_hidden" (value TEXT);
            CREATE INDEX ordinary_attached_name ON "_LITESTREAM_hidden" (value);
            CREATE INDEX "quoted""index" ON "123" (value);
            CREATE TRIGGER "quoted""trigger" AFTER INSERT ON "123" BEGIN UPDATE "123" SET value = value; END;
            CREATE VIRTUAL TABLE search USING fts5(body);
            INSERT INTO "123" VALUES ('one');
            INSERT INTO sqliteXfoo VALUES ('two');
            INSERT INTO "é" VALUES ('three');
            INSERT INTO search VALUES ('virtual row');
        `);
        await client.close();
        const normalized = await normalizeDatabaseForPush(source);
        try {
            expect(normalized.manifest.tables).toEqual({ '123': 1, sqliteXfoo: 1, z: 0, 'é': 1 });
            expect(normalized.manifest.schema_sha256).toBe('79deb17965469297f642b24619a3ff0e33a525ded08dfc41191bb5a30d219d34');
        } finally {
            await normalized.cleanup();
        }
    });
});

// The analytical-name guard (#1700 Plan D Task 5) mints a `show` before any
// other work in `databasePushWithConfig`; every case in this describe block
// targets a libsql database named 'analytics', so each `post` mock below
// answers it with this stable row before falling through to its own
// bulk-load-specific behavior.
const SHOW_ROW = { data: { database: { name: 'analytics', kind: 'libsql', status: 'ready', size_bytes: 0, deleted_at: null, purge_at: null } } };

describe('database push workflow', () => {
    it('prepares, uploads exact bytes with a candidate bearer, promotes, and polls without logging credentials', async () => {
        const source = await fixture();
        const posts: Array<Record<string, unknown>> = [];
        const upload = vi.fn(async (_url, body, options) => {
            expect(options.headers.Authorization).toBe('Bearer candidate-secret');
            // posts[0] is the analytical-name guard's `show` (#1700 Plan D
            // Task 5); posts[1] is the `bulk_load_prepare` body.
            expect(options.headers['Content-Length']).toBe(String(posts[1].input_bytes));
            expect(body).toBeDefined();
            return { status: 200, data: { secret: 'must-not-log' } };
        });
        const post = vi.fn(async (_url, body: Record<string, unknown>) => {
            posts.push(body);
            if (body.operation === 'show') return SHOW_ROW;
            if (body.operation === 'bulk_load_prepare') return { data: { operation: { id: '11111111-1111-4111-8111-111111111111', phase: 'uploading' }, upload: { url: 'https://candidate.test/v1/upload', token: 'candidate-secret', expires_at: '2099-01-01T00:00:00Z' } }, status: 202 };
            if (body.operation === 'bulk_load_promote') return { data: { operation: { id: body.operation_id, phase: 'validating' } }, status: 202 };
            return { data: { operation: { id: body.operation_id, phase: 'promoted', rows_loaded: 1, measured_bytes: 16384, cleanup_state: 'complete', failure_code: null } }, status: 200 };
        });
        const output: string[] = [];
        await databasePushWithConfig('analytics', source, { yes: true }, { host: 'https://app.test', apiKey: 'control-secret', workspaceId: 'w1' }, { post, upload, stdout: (line) => output.push(line), sleep: async () => undefined });
        expect(posts.map((body) => body.operation)).toEqual(['show', 'bulk_load_prepare', 'bulk_load_promote', 'bulk_load_status']);
        expect(posts[1]).toMatchObject({ bulk_mode: 'replace', allow_empty: false });
        expect(posts[2]).toMatchObject({ upload_http_status: 200 });
        expect(output.join('\n')).not.toContain('candidate-secret').not.toContain('must-not-log');
        expect(output.join('\n').toLowerCase()).toContain('reacquire');
        expect(output.join('\n')).toContain('countable rows');
        expect(output.join('\n')).toMatch(/WAL.*4096.*auto-vacuum NONE.*source file is unchanged/i);
    });

    it('uses POST for the default Turso /v1/upload transport', async () => {
        const source = await fixture();
        const uploadPost = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {} });
        const uploadPut = vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: {} });
        const operationId = '0198f36e-7b2a-7cc2-8f1a-123456789abc';
        const post = vi.fn(async (_url, body: Record<string, unknown>) => {
            if (body.operation === 'show') return SHOW_ROW;
            if (body.operation === 'bulk_load_prepare') return { data: { operation: { id: operationId, phase: 'uploading' }, upload: { url: 'https://candidate.test/v1/upload', token: 'candidate-secret' } } };
            if (body.operation === 'bulk_load_promote') return { data: { operation: { id: operationId, phase: 'validating' } } };
            return { data: { operation: { id: operationId, phase: 'promoted' } } };
        });
        try {
            await databasePushWithConfig('analytics', source, { yes: true }, { host: 'https://app.test', apiKey: 'secret' }, { post });
            expect(uploadPost).toHaveBeenCalledWith('https://candidate.test/v1/upload', expect.anything(), expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer candidate-secret' }) }));
            expect(uploadPut).not.toHaveBeenCalled();
        } finally {
            uploadPost.mockRestore();
            uploadPut.mockRestore();
        }
    });

    it('accepts canonical UUIDv7 operation and explicit idempotency identifiers', async () => {
        const source = await fixture();
        const operationId = '0198f36e-7b2a-7cc2-8f1a-123456789abc';
        const idempotencyKey = '0198f36e-7b2b-7dd3-9a2b-abcdef012345';
        const post = vi.fn(async (_url, body: Record<string, unknown>) => {
            if (body.operation === 'show') return SHOW_ROW;
            if (body.operation === 'bulk_load_prepare') return { data: { operation: { id: operationId, phase: 'uploading' }, upload: { url: 'https://candidate.test/v1/upload', token: 'candidate-secret' } } };
            if (body.operation === 'bulk_load_promote') return { data: { operation: { id: operationId, phase: 'validating' } } };
            return { data: { operation: { id: operationId, phase: 'promoted' } } };
        });
        await expect(databasePushWithConfig('analytics', source, { yes: true, idempotencyKey }, { host: 'https://app.test', apiKey: 'secret' }, { post, upload: async () => ({ status: 200 }) })).resolves.toBeUndefined();
        expect(post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ operation: 'bulk_load_prepare', idempotency_key: idempotencyKey }), expect.any(Object));
    });

    it('rejects malformed operation identifiers without reflecting them', async () => {
        const source = await fixture();
        const leaked = 'secret-operation-id-candidate-token';
        const output: string[] = [];
        const post = vi.fn(async (_url: string, body: Record<string, unknown>) => body.operation === 'show'
            ? SHOW_ROW
            : { data: { operation: { id: leaked, phase: 'uploading' }, upload: { url: 'https://candidate.test/v1/upload', token: 'candidate-secret' } } });
        await expect(databasePushWithConfig('analytics', source, { yes: true }, { host: 'https://app.test', apiKey: 'secret' }, { post, stdout: (line) => output.push(line) }))
            .rejects.toMatchObject({ code: 'upstream_unavailable', message: expect.not.stringContaining(leaked) });
        expect(output.join('\n')).not.toContain(leaked).not.toContain('candidate-secret');
    });

    it('rejects zero countable rows unless --allow-empty is explicit', async () => {
        const source = await fixture(true);
        const post = vi.fn(async (_url: string, body: Record<string, unknown>) => body.operation === 'show' ? SHOW_ROW : undefined);
        await expect(databasePushWithConfig('analytics', source, { yes: true }, { host: 'https://app.test', apiKey: 'secret' }, { post }))
            .rejects.toMatchObject({ code: 'invalid_bulk_database' });
        // Only the analytical-name guard's `show` runs before the
        // zero-row rejection (#1700 Plan D Task 5) — no bulk-load request.
        expect(post).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ operation: 'show' }), expect.any(Object));
    });

    it('rejects a sparse file above the decimal 20 GB ceiling before loading SQLite', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-push-sparse-'));
        roots.push(root);
        const source = path.join(root, 'too-large.db');
        fs.closeSync(fs.openSync(source, 'w'));
        fs.truncateSync(source, 20_000_000_001);
        await expect(normalizeDatabaseForPush(source)).rejects.toMatchObject({ code: 'bulk_load_too_large' });
    });

    it('does not abort after promotion is accepted when status polling transiently fails', async () => {
        const source = await fixture();
        const bodies: Record<string, unknown>[] = [];
        const post = vi.fn(async (_url, body: Record<string, unknown>) => {
            bodies.push(body);
            if (body.operation === 'show') return SHOW_ROW;
            if (body.operation === 'bulk_load_prepare') return { data: { operation: { id: '11111111-1111-4111-8111-111111111111', phase: 'uploading' }, upload: { url: 'https://candidate.test/v1/upload', token: 'secret' } } };
            if (body.operation === 'bulk_load_promote') return { data: { operation: { id: body.operation_id, phase: 'validating' } } };
            throw new Error('transient status transport details');
        });
        await expect(databasePushWithConfig('analytics', source, { yes: true, idempotencyKey: '22222222-2222-4222-8222-222222222222' }, { host: 'https://app.test', apiKey: 'secret' }, { post, upload: async () => ({ status: 200 }) }))
            .rejects.toThrow(/11111111-1111-4111-8111-111111111111.*22222222-2222-4222-8222-222222222222/i);
        expect(bodies.some((body) => body.operation === 'bulk_load_abort')).toBe(false);
    });

    it('aborts a prepared operation when upload fails before promotion acceptance', async () => {
        const source = await fixture();
        const bodies: Record<string, unknown>[] = [];
        const post = vi.fn(async (_url, body: Record<string, unknown>) => {
            bodies.push(body);
            if (body.operation === 'show') return SHOW_ROW;
            if (body.operation === 'bulk_load_prepare') return { data: { operation: { id: '11111111-1111-4111-8111-111111111111', phase: 'uploading' }, upload: { url: 'https://candidate.test/v1/upload', token: 'secret' } } };
            return { data: { operation: { id: body.operation_id, phase: 'aborted' } } };
        });
        await expect(databasePushWithConfig('analytics', source, { yes: true }, { host: 'https://app.test', apiKey: 'secret' }, { post, upload: async () => { throw new Error('secret upstream body'); } }))
            .rejects.toMatchObject({ code: 'upstream_unavailable' });
        expect(bodies.map((body) => body.operation)).toEqual(['show', 'bulk_load_prepare', 'bulk_load_abort']);
    });

    it('renews every five minutes during a deferred upload and stops before promote', async () => {
        const source = await fixture();
        vi.useFakeTimers();
        try {
            let finishUpload!: () => void;
            const upload = vi.fn(() => new Promise<{ status: number }>((resolve) => { finishUpload = () => resolve({ status: 200 }); }));
            const bodies: Record<string, unknown>[] = [];
            let prepares = 0;
            const post = vi.fn(async (_url, body: Record<string, unknown>) => {
                bodies.push(body);
                if (body.operation === 'show') return SHOW_ROW;
                if (body.operation === 'bulk_load_prepare') {
                    prepares++;
                    // Only the FIRST prepare carries a credential; a renewal
                    // replay extends the lease and returns none (#1287 R9b).
                    return prepares === 1
                        ? { data: { operation: { id: '11111111-1111-4111-8111-111111111111', phase: 'uploading' }, upload: { url: 'https://candidate.test/v1/upload', token: 'fresh-secret-1' } } }
                        : { data: { operation: { id: '11111111-1111-4111-8111-111111111111', phase: 'uploading' } } };
                }
                if (body.operation === 'bulk_load_promote') return { data: { operation: { id: body.operation_id, phase: 'validating' } } };
                return { data: { operation: { id: body.operation_id, phase: 'promoted' } } };
            });
            const output: string[] = [];
            const running = databasePushWithConfig('analytics', source, { yes: true }, { host: 'https://app.test', apiKey: 'secret' }, { post, upload, stdout: (line) => output.push(line), sleep: async () => undefined });
            await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
            await vi.advanceTimersByTimeAsync(10 * 60_000);
            const prepareBodies = bodies.filter((body) => body.operation === 'bulk_load_prepare');
            expect(prepareBodies).toHaveLength(3);
            expect(prepareBodies.every((body) => body.idempotency_key === prepareBodies[0].idempotency_key)).toBe(true);
            finishUpload();
            await running;
            const count = bodies.filter((body) => body.operation === 'bulk_load_prepare').length;
            await vi.advanceTimersByTimeAsync(10 * 60_000);
            expect(bodies.filter((body) => body.operation === 'bulk_load_prepare')).toHaveLength(count);
            expect(output.join('\n')).not.toContain('fresh-secret');
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps polling past its own upload deadline while the server reports a live validation deadline', async () => {
        const source = await fixture();
        let clock = 1_000_000;
        const statuses: string[] = [];
        const post = vi.fn(async (_url, body: Record<string, unknown>) => {
            if (body.operation === 'show') return SHOW_ROW;
            if (body.operation === 'bulk_load_prepare') return { data: { operation: { id: '11111111-1111-4111-8111-111111111111', phase: 'uploading' }, upload: { url: 'https://candidate.test/v1/upload', token: 'secret' } }, status: 202 };
            if (body.operation === 'bulk_load_promote') return { data: { operation: { id: body.operation_id, phase: 'validating' } }, status: 202 };
            statuses.push('poll');
            // Every poll pushes the client past its own upload deadline; the
            // server keeps reporting a live validation deadline (#1287 R18).
            clock += 20 * 60_000;
            return statuses.length < 3
                ? { data: { operation: { id: body.operation_id, phase: 'validating', deadline_at: new Date(clock + 10 * 60_000).toISOString() } }, status: 200 }
                : { data: { operation: { id: body.operation_id, phase: 'promoted', rows_loaded: 1 } }, status: 200 };
        });

        await expect(databasePushWithConfig('analytics', source, { yes: true }, { host: 'https://app.test', apiKey: 'secret' }, {
            post, upload: async () => ({ status: 200 }), sleep: async () => undefined, now: () => clock,
        })).resolves.toBeUndefined();
        expect(statuses).toHaveLength(3);
    });

    it('gives up on its own upload deadline when the server publishes no later deadline', async () => {
        const source = await fixture();
        let clock = 1_000_000;
        const post = vi.fn(async (_url, body: Record<string, unknown>) => {
            if (body.operation === 'show') return SHOW_ROW;
            if (body.operation === 'bulk_load_prepare') return { data: { operation: { id: '11111111-1111-4111-8111-111111111111', phase: 'uploading' }, upload: { url: 'https://candidate.test/v1/upload', token: 'secret' } }, status: 202 };
            if (body.operation === 'bulk_load_promote') return { data: { operation: { id: body.operation_id, phase: 'validating' } }, status: 202 };
            clock += 20 * 60_000;
            return { data: { operation: { id: body.operation_id, phase: 'validating' } }, status: 200 };
        });

        await expect(databasePushWithConfig('analytics', source, { yes: true }, { host: 'https://app.test', apiKey: 'secret' }, {
            post, upload: async () => ({ status: 200 }), sleep: async () => undefined, now: () => clock,
        })).rejects.toMatchObject({ code: 'upstream_unavailable' });
    });

    it('maps upload 413 to bulk_load_too_large without exposing its body', async () => {
        const source = await fixture();
        const post = vi.fn(async (_url, body: Record<string, unknown>) => {
            if (body.operation === 'show') return SHOW_ROW;
            return body.operation === 'bulk_load_prepare'
                ? { data: { operation: { id: '11111111-1111-4111-8111-111111111111', phase: 'uploading' }, upload: { url: 'https://candidate.test/v1/upload', token: 'secret' } } }
                : { data: { operation: { id: body.operation_id, phase: 'aborted' } } };
        });
        await expect(databasePushWithConfig('analytics', source, { yes: true }, { host: 'https://app.test', apiKey: 'secret' }, { post, upload: async (_url, _body, options) => {
            expect(options.validateStatus(413)).toBe(true);
            return { status: 413, data: 'private upstream rejection' };
        } })).rejects.toMatchObject({ code: 'bulk_load_too_large', message: expect.not.stringContaining('private upstream') });
    });
});

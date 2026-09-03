import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it, afterEach } from 'vitest';

interface Config { host: string; apiKey: string; workspaceId: string; }
const CONFIG: Config = { host: 'https://app.example.test', apiKey: 'pat', workspaceId: 'ws' };
const DUCKDB_ROW = {
    database: {
        id: '11111111-1111-1111-1111-111111111111',
        name: 'orders',
        kind: 'duckdb',
        status: 'ready',
        size_bytes: 0,
        deleted_at: null,
        purge_at: null,
    },
};
const LIBSQL_ROW = {
    database: {
        id: '22222222-2222-2222-2222-222222222222',
        name: 'main',
        kind: 'libsql',
        status: 'ready',
        size_bytes: 0,
        deleted_at: null,
        purge_at: null,
    },
};

// The real `put` (axios) always drains the body stream as it sends the
// request; these mocks don't send anything over the wire, so they must
// drain it themselves — otherwise the `fs.ReadStream` handed to `put` stays
// open past the test, and a later test's `afterEach` unlinking the same
// tmpFile path can race its still-pending internal `open()` into an
// unhandled ENOENT.
function drainIfStream(body: unknown): void {
    if (body && typeof (body as { resume?: () => void }).resume === 'function') {
        const stream = body as NodeJS.ReadableStream;
        // The mock never actually reads the stream's data, and its
        // internal `open()` can still be pending when this test's
        // `afterEach` unlinks the same tmpFile path — harmlessly emitting
        // an ENOENT 'error' this mock doesn't care about, but which would
        // otherwise crash as an unhandled exception with no listener.
        stream.on('error', () => undefined);
        stream.resume();
    }
}

async function loadDatabaseCommands(): Promise<Record<string, unknown>> {
    const moduleUrl = pathToFileURL(path.resolve(__dirname, '../src/commands/database.ts')).href;
    return await import(moduleUrl) as Record<string, unknown>;
}

describe('database ingest', () => {
    const tmpFile = path.join(os.tmpdir(), `solidactions-ingest-${process.pid}.csv`);
    const CONTENT = 'id,category,amount\n1,a,2.5\n';

    afterEach(() => {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    });

    it('hashes the file, prepares, uploads with exactly the server-signed headers, commits, and polls to acked', async () => {
        fs.writeFileSync(tmpFile, CONTENT);
        const module = await loadDatabaseCommands();
        const databaseIngestWithConfig = module.databaseIngestWithConfig as Function;

        const calls: Array<Record<string, unknown>> = [];
        const putCalls: Array<{ url: string; headers: Record<string, string> }> = [];
        let statusPolls = 0;
        const stdout: string[] = [];

        const dependencies = {
            post: async (_url: string, body: Record<string, unknown>) => {
                calls.push(body);
                if (body.operation === 'show') return { data: DUCKDB_ROW };
                if (body.operation === 'ingest_prepare') {
                    return {
                        data: {
                            batch_id: body.batch_id,
                            upload_url: 'https://r2.example.test/staging/x.csv',
                            upload_headers: { 'Content-Length': String(CONTENT.length), 'x-amz-checksum-sha256': 'YmFzZTY0' },
                            expires_at: '2026-09-02T00:00:00Z',
                        },
                    };
                }
                if (body.operation === 'ingest_commit') {
                    return { data: { batch_id: body.batch_id, state: 'applying' } };
                }
                if (body.operation === 'ingest_status') {
                    statusPolls += 1;
                    if (statusPolls < 2) return { data: { batch_id: body.batch_id, state: 'applying' } };
                    return { data: { batch_id: body.batch_id, state: 'acked', rows: 1, durable: true, live_bytes: 4096, acked_at: '2026-09-02T00:00:01Z' } };
                }
                throw new Error(`unexpected operation ${body.operation}`);
            },
            put: async (url: string, body: unknown, options: { headers: Record<string, string> }) => {
                putCalls.push({ url, headers: options.headers });
                drainIfStream(body);
                return { data: '', status: 200 };
            },
            stdout: (line: string) => stdout.push(line),
            stderr: () => undefined,
            isTTY: false,
            sleep: async () => undefined,
            filesystem: fs.promises,
        };

        await databaseIngestWithConfig('orders', tmpFile, { table: 'events' }, CONFIG, dependencies);

        expect(calls[0]).toEqual({ operation: 'show', name: 'orders' });
        expect(calls[1]).toMatchObject({
            operation: 'ingest_prepare',
            name: 'orders',
            table: 'events',
            mode: 'append',
            format: 'csv',
            batch_id: 'ba2245e691043668f70b69e6217e9bfb',
            content_sha256: 'e4ae373336c660c0fd28bbb4ebb5c97fcb5d10258e82620c76562890a2105945',
            declared_bytes: CONTENT.length,
        });
        // Exactly the two server-signed headers — nothing added, nothing renamed.
        expect(putCalls).toEqual([{
            url: 'https://r2.example.test/staging/x.csv',
            headers: { 'Content-Length': String(CONTENT.length), 'x-amz-checksum-sha256': 'YmFzZTY0' },
        }]);
        expect(calls[2]).toEqual({ operation: 'ingest_commit', name: 'orders', batch_id: 'ba2245e691043668f70b69e6217e9bfb' });
        expect(calls[3]).toEqual({ operation: 'ingest_status', name: 'orders', batch_id: 'ba2245e691043668f70b69e6217e9bfb' });
        expect(calls[4]).toEqual({ operation: 'ingest_status', name: 'orders', batch_id: 'ba2245e691043668f70b69e6217e9bfb' });
        expect(statusPolls).toBe(2);
        expect(stdout.join('\n')).toMatch(/1 row.*4\.0 KiB/is);
    });

    it('threads dataPlaneTimeoutMs into the presigned R2 PUT so a stalled upload cannot hang forever (C-3)', async () => {
        fs.writeFileSync(tmpFile, CONTENT);
        const module = await loadDatabaseCommands();
        const databaseIngestWithConfig = module.databaseIngestWithConfig as Function;

        let putTimeout: number | undefined;
        const dependencies = {
            post: async (_url: string, body: Record<string, unknown>) => {
                if (body.operation === 'show') return { data: DUCKDB_ROW };
                if (body.operation === 'ingest_prepare') {
                    return {
                        data: {
                            batch_id: body.batch_id,
                            upload_url: 'https://r2.example.test/staging/x.csv',
                            upload_headers: { 'Content-Length': String(CONTENT.length), 'x-amz-checksum-sha256': 'YmFzZTY0' },
                            expires_at: '2026-09-02T00:00:00Z',
                        },
                    };
                }
                if (body.operation === 'ingest_commit') {
                    return { data: { batch_id: body.batch_id, state: 'applying' } };
                }
                if (body.operation === 'ingest_status') {
                    return { data: { batch_id: body.batch_id, state: 'acked', rows: 1, durable: true, live_bytes: 4096, acked_at: '2026-09-02T00:00:01Z' } };
                }
                throw new Error(`unexpected operation ${body.operation}`);
            },
            put: async (_url: string, body: unknown, options: { headers: Record<string, string>; timeout?: number }) => {
                putTimeout = options.timeout;
                drainIfStream(body);
                return { data: '', status: 200 };
            },
            stdout: () => undefined,
            stderr: () => undefined,
            isTTY: false,
            sleep: async () => undefined,
            filesystem: fs.promises,
            dataPlaneTimeoutMs: 45_000,
        };

        await databaseIngestWithConfig('orders', tmpFile, { table: 'events' }, CONFIG, dependencies);

        expect(putTimeout).toBe(45_000);
    });

    it('normalizes --json output to the stable IngestOutcome shape, stripping unknown server fields', async () => {
        // `ingest`'s `--json` body was the only new-verb response never run through a stable
        // normalizer — this pins that `ingest_commit`'s response is validated/narrowed the
        // same way every other mutation response is, not written to stdout verbatim.
        fs.writeFileSync(tmpFile, CONTENT);
        const module = await loadDatabaseCommands();
        const databaseIngestWithConfig = module.databaseIngestWithConfig as Function;
        const stdout: string[] = [];

        const dependencies = {
            post: async (_url: string, body: Record<string, unknown>) => {
                if (body.operation === 'show') return { data: DUCKDB_ROW };
                if (body.operation === 'ingest_prepare') {
                    return {
                        data: {
                            batch_id: body.batch_id,
                            upload_url: 'https://r2.example.test/staging/x.csv',
                            upload_headers: { 'Content-Length': String(CONTENT.length), 'x-amz-checksum-sha256': 'YmFzZTY0' },
                            expires_at: '2026-09-02T00:00:00Z',
                        },
                    };
                }
                if (body.operation === 'ingest_commit') {
                    return {
                        data: {
                            batch_id: body.batch_id,
                            state: 'acked',
                            rows: 1,
                            durable: true,
                            live_bytes: 4096,
                            acked_at: '2026-09-02T00:00:01Z',
                            // Not part of `IngestOutcome` — must not reach `--json` stdout.
                            internal_debug_trace: 'server-only diagnostic',
                        },
                    };
                }
                throw new Error(`unexpected operation ${body.operation}`);
            },
            put: async (_url: string, body: unknown) => { drainIfStream(body); return { data: '', status: 200 }; },
            stdout: (line: string) => stdout.push(line),
            stderr: () => undefined,
            isTTY: false,
            sleep: async () => undefined,
            filesystem: fs.promises,
        };

        await databaseIngestWithConfig('orders', tmpFile, { table: 'events', json: true }, CONFIG, dependencies);

        expect(JSON.parse(stdout.join('\n'))).toEqual({
            batch_id: 'ba2245e691043668f70b69e6217e9bfb',
            state: 'acked',
            rows: 1,
            durable: true,
            live_bytes: 4096,
            acked_at: '2026-09-02T00:00:01Z',
        });
    });

    it('uses an explicit --batch-id when given instead of the canonical default, and sends mode=replace when requested', async () => {
        fs.writeFileSync(tmpFile, CONTENT);
        const module = await loadDatabaseCommands();
        const databaseIngestWithConfig = module.databaseIngestWithConfig as Function;
        const calls: Array<Record<string, unknown>> = [];

        const dependencies = {
            post: async (_url: string, body: Record<string, unknown>) => {
                calls.push(body);
                if (body.operation === 'show') return { data: DUCKDB_ROW };
                if (body.operation === 'ingest_prepare') return { data: { batch_id: body.batch_id, upload_url: 'https://r2.example.test/staging/x.csv', upload_headers: { 'Content-Length': '1', 'x-amz-checksum-sha256': 'x' }, expires_at: '2026-09-02T00:00:00Z' } };
                if (body.operation === 'ingest_commit') return { data: { batch_id: body.batch_id, state: 'acked', rows: 1, durable: true, live_bytes: 1, acked_at: 'now' } };
                throw new Error(`unexpected operation ${body.operation}`);
            },
            put: async (_url: string, body: unknown) => { drainIfStream(body); return { data: '', status: 200 }; },
            stdout: () => undefined,
            stderr: () => undefined,
            isTTY: false,
            sleep: async () => undefined,
        };

        await databaseIngestWithConfig('orders', tmpFile, { table: 'events', mode: 'replace', batchId: 'my-custom-batch' }, CONFIG, dependencies);

        expect(calls[1]).toMatchObject({ batch_id: 'my-custom-batch', mode: 'replace' });
    });

    it('prints failed schema_mismatch outcomes and rejects with the server error_code/message', async () => {
        fs.writeFileSync(tmpFile, CONTENT);
        const module = await loadDatabaseCommands();
        const databaseIngestWithConfig = module.databaseIngestWithConfig as Function;

        const dependencies = {
            post: async (_url: string, body: Record<string, unknown>) => {
                if (body.operation === 'show') return { data: DUCKDB_ROW };
                if (body.operation === 'ingest_prepare') return { data: { batch_id: body.batch_id, upload_url: 'https://r2.example.test/staging/x.csv', upload_headers: { 'Content-Length': '1', 'x-amz-checksum-sha256': 'x' }, expires_at: 'now' } };
                if (body.operation === 'ingest_commit') {
                    return { data: { batch_id: body.batch_id, state: 'failed', error_code: 'schema_mismatch', message: 'column total: existing DOUBLE, incoming VARCHAR', column: 'total', existing_type: 'DOUBLE', incoming_type: 'VARCHAR' } };
                }
                throw new Error(`unexpected operation ${body.operation}`);
            },
            put: async (_url: string, body: unknown) => { drainIfStream(body); return { data: '', status: 200 }; },
            stdout: () => undefined,
            stderr: () => undefined,
            isTTY: false,
            sleep: async () => undefined,
        };

        await expect(databaseIngestWithConfig('orders', tmpFile, { table: 'events' }, CONFIG, dependencies))
            .rejects.toMatchObject({ code: 'schema_mismatch', message: expect.stringContaining('existing DOUBLE, incoming VARCHAR') });
    });

    it('skips upload/commit on a same-digest replay of an in-progress batch and just polls the returned outcome to acked', async () => {
        fs.writeFileSync(tmpFile, CONTENT);
        const module = await loadDatabaseCommands();
        const databaseIngestWithConfig = module.databaseIngestWithConfig as Function;

        let putCalled = false;
        let commitCalled = false;
        let statusPolls = 0;

        const dependencies = {
            post: async (_url: string, body: Record<string, unknown>) => {
                if (body.operation === 'show') return { data: DUCKDB_ROW };
                if (body.operation === 'ingest_prepare') {
                    // Real ingest_prepare replay shape (spec:571): no
                    // upload_url/upload_headers at all — this IS the A.5
                    // outcome body already.
                    return { data: { batch_id: body.batch_id, state: 'dispatching' } };
                }
                if (body.operation === 'ingest_commit') {
                    commitCalled = true;
                    throw new Error('ingest_commit must not be called for a same-digest replay');
                }
                if (body.operation === 'ingest_status') {
                    statusPolls += 1;
                    if (statusPolls < 2) return { data: { batch_id: body.batch_id, state: 'applying' } };
                    return { data: { batch_id: body.batch_id, state: 'acked', rows: 3, durable: true, live_bytes: 8192, acked_at: 'now' } };
                }
                throw new Error(`unexpected operation ${body.operation}`);
            },
            put: async (_url: string, body: unknown) => { putCalled = true; drainIfStream(body); return { data: '', status: 200 }; },
            stdout: () => undefined,
            stderr: () => undefined,
            isTTY: false,
            sleep: async () => undefined,
        };

        await databaseIngestWithConfig('orders', tmpFile, { table: 'events' }, CONFIG, dependencies);

        expect(putCalled).toBe(false);
        expect(commitCalled).toBe(false);
        expect(statusPolls).toBe(2);
    });

    it('surfaces size_limit_exceeded from ingest_prepare with the limit included in the message', async () => {
        fs.writeFileSync(tmpFile, CONTENT);
        const module = await loadDatabaseCommands();
        const databaseIngestWithConfig = module.databaseIngestWithConfig as Function;

        const dependencies = {
            post: async (_url: string, body: Record<string, unknown>) => {
                if (body.operation === 'show') return { data: DUCKDB_ROW };
                if (body.operation === 'ingest_prepare') {
                    const error: any = new Error('Request failed with status code 403');
                    error.response = {
                        status: 403,
                        data: {
                            code: 'size_limit_exceeded',
                            message: 'This database is at its storage limit. Free space with a replace load or delete unused tables.',
                            size_limit_bytes: 1_073_741_824,
                            size_bytes: 1_073_600_000,
                            declared_bytes: CONTENT.length,
                        },
                    };
                    throw error;
                }
                throw new Error(`unexpected operation ${body.operation}`);
            },
            put: async (_url: string, body: unknown) => { drainIfStream(body); return { data: '', status: 200 }; },
            stdout: () => undefined,
            stderr: () => undefined,
            isTTY: false,
            sleep: async () => undefined,
        };

        await expect(databaseIngestWithConfig('orders', tmpFile, { table: 'events' }, CONFIG, dependencies))
            .rejects.toMatchObject({
                code: 'size_limit_exceeded',
                message: expect.stringMatching(/storage limit.*\(limit 1\.0 GiB\)/is),
            });
    });

    it('surfaces outcome_unknown as its own state — not success, not a plain failure', async () => {
        fs.writeFileSync(tmpFile, CONTENT);
        const module = await loadDatabaseCommands();
        const databaseIngestWithConfig = module.databaseIngestWithConfig as Function;

        const dependencies = {
            post: async (_url: string, body: Record<string, unknown>) => {
                if (body.operation === 'show') return { data: DUCKDB_ROW };
                if (body.operation === 'ingest_prepare') return { data: { batch_id: body.batch_id, upload_url: 'https://r2.example.test/staging/x.csv', upload_headers: { 'Content-Length': '1', 'x-amz-checksum-sha256': 'x' }, expires_at: 'now' } };
                if (body.operation === 'ingest_commit') {
                    return { data: { batch_id: body.batch_id, state: 'outcome_unknown', message: 'The apply job stopped reporting progress; its outcome could not be confirmed.' } };
                }
                throw new Error(`unexpected operation ${body.operation}`);
            },
            put: async (_url: string, body: unknown) => { drainIfStream(body); return { data: '', status: 200 }; },
            stdout: () => undefined,
            stderr: () => undefined,
            isTTY: false,
            sleep: async () => undefined,
        };

        await expect(databaseIngestWithConfig('orders', tmpFile, { table: 'events' }, CONFIG, dependencies))
            .rejects.toMatchObject({
                code: 'outcome_unknown',
                message: expect.stringContaining('outcome could not be confirmed'),
            });
    });

    it('reports outcome_unknown with actionable re-run guidance when the server gives no message', async () => {
        fs.writeFileSync(tmpFile, CONTENT);
        const module = await loadDatabaseCommands();
        const databaseIngestWithConfig = module.databaseIngestWithConfig as Function;

        const dependencies = {
            post: async (_url: string, body: Record<string, unknown>) => {
                if (body.operation === 'show') return { data: DUCKDB_ROW };
                if (body.operation === 'ingest_prepare') return { data: { batch_id: body.batch_id, upload_url: 'https://r2.example.test/staging/x.csv', upload_headers: { 'Content-Length': '1', 'x-amz-checksum-sha256': 'x' }, expires_at: 'now' } };
                if (body.operation === 'ingest_commit') return { data: { batch_id: body.batch_id, state: 'outcome_unknown' } };
                throw new Error(`unexpected operation ${body.operation}`);
            },
            put: async (_url: string, body: unknown) => { drainIfStream(body); return { data: '', status: 200 }; },
            stdout: () => undefined,
            stderr: () => undefined,
            isTTY: false,
            sleep: async () => undefined,
        };

        await expect(databaseIngestWithConfig('orders', tmpFile, { table: 'events' }, CONFIG, dependencies))
            .rejects.toMatchObject({
                code: 'outcome_unknown',
                message: expect.stringMatching(/re-run this same command.*not re-upload/is),
            });
    });

    it('refuses a libsql database before reading the file at all', async () => {
        // Points at a file that does not exist — if the code read the file
        // before checking `kind`, it would fail with ENOENT, not kind_mismatch.
        const missingFile = path.join(os.tmpdir(), `solidactions-ingest-missing-${process.pid}.csv`);
        expect(fs.existsSync(missingFile)).toBe(false);

        const module = await loadDatabaseCommands();
        const databaseIngestWithConfig = module.databaseIngestWithConfig as Function;

        let statCalled = false;
        const dependencies = {
            post: async (_url: string, body: Record<string, unknown>) => {
                if (body.operation === 'show') return { data: LIBSQL_ROW };
                throw new Error(`unexpected operation ${body.operation}`);
            },
            put: async (_url: string, body: unknown) => { drainIfStream(body); return { data: '', status: 200 }; },
            stdout: () => undefined,
            stderr: () => undefined,
            isTTY: false,
            sleep: async () => undefined,
            filesystem: { ...fs.promises, stat: async (...args: any[]) => { statCalled = true; return (fs.promises.stat as any)(...args); } },
        };

        await expect(databaseIngestWithConfig('main', missingFile, { table: 'events' }, CONFIG, dependencies))
            .rejects.toMatchObject({
                code: 'kind_mismatch',
                message: expect.stringContaining('is not an analytical database'),
            });
        expect(statCalled).toBe(false);
    });

    // Ground truth (App\Domains\Databases\Analytical\Actions\HandleAnalyticalDatabaseOperation):
    // `ingest_prepare`/`ingest_commit`/`ingest_status` never call the admission
    // gate and so never return a `waking` response — a paused database is woken
    // transparently inside the async AdvanceIngestBatch job, which self-redispatches
    // on a `waking` refusal without ever surfacing it on this poll (unlike
    // `query`'s synchronous admission gate). From the CLI's side this shows up
    // only as the row's state machine taking longer to leave `dispatching` —
    // this test proves the poll loop rides that out to a terminal state instead
    // of giving up early.
    it('keeps polling through an extended dispatching state (a paused database waking transparently) to a terminal outcome', async () => {
        fs.writeFileSync(tmpFile, CONTENT);
        const module = await loadDatabaseCommands();
        const databaseIngestWithConfig = module.databaseIngestWithConfig as Function;

        let statusPolls = 0;
        const sleeps: number[] = [];
        const stdout: string[] = [];

        const dependencies = {
            post: async (_url: string, body: Record<string, unknown>) => {
                if (body.operation === 'show') return { data: DUCKDB_ROW };
                if (body.operation === 'ingest_prepare') return { data: { batch_id: body.batch_id, upload_url: 'https://r2.example.test/staging/x.csv', upload_headers: { 'Content-Length': String(CONTENT.length), 'x-amz-checksum-sha256': 'x' }, expires_at: 'now' } };
                if (body.operation === 'ingest_commit') return { data: { batch_id: body.batch_id, state: 'copying' } };
                if (body.operation === 'ingest_status') {
                    statusPolls += 1;
                    if (statusPolls === 1) return { data: { batch_id: body.batch_id, state: 'dispatching' } };
                    if (statusPolls === 2) return { data: { batch_id: body.batch_id, state: 'dispatching' } };
                    if (statusPolls === 3) return { data: { batch_id: body.batch_id, state: 'applying' } };
                    return { data: { batch_id: body.batch_id, state: 'acked', rows: 5, durable: true, live_bytes: 2048, acked_at: 'now' } };
                }
                throw new Error(`unexpected operation ${body.operation}`);
            },
            put: async (_url: string, body: unknown) => { drainIfStream(body); return { data: '', status: 200 }; },
            stdout: (line: string) => stdout.push(line),
            stderr: () => undefined,
            isTTY: false,
            sleep: async (ms: number) => { sleeps.push(ms); },
        };

        await databaseIngestWithConfig('orders', tmpFile, { table: 'events' }, CONFIG, dependencies);

        expect(statusPolls).toBe(4);
        expect(sleeps.length).toBe(4);
        expect(stdout.join('\n')).toMatch(/5 row.*2\.0 KiB/is);
    });
});

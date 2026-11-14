import { execFile } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
    databaseConnectWithConfig,
    databaseCreateWithConfig,
    databaseExecWithConfig,
    databaseIngestWithConfig,
    databaseListWithConfig,
    databaseOptimizeWithConfig,
    databasePullWithConfig,
    databaseQueryWithConfig,
    databaseRollbackWithConfig,
    databaseSchemaWithConfig,
    databaseShowWithConfig,
    databaseVersionsWithConfig,
    databaseWakeWithConfig,
} from '../src/commands/database';
import { databaseExportWithConfig } from '../src/commands/database-export';
import { makeTmpEnv, writeGlobal } from './helpers';

const pkg = require('../package.json');
const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

// Pulling a DuckDB database needs zlib's zstd (Node 22.15+/23.8+); the CI
// matrix also runs Node 20, where the rows that decompress are registered and
// skipped (describe.skipIf) and every other row still runs.
const hasZstd = typeof (zlib as unknown as { zstdCompressSync?: unknown }).zstdCompressSync === 'function';
const zstdCompress = (input: Buffer): Buffer =>
    (zlib as unknown as { zstdCompressSync: (buffer: Buffer) => Buffer }).zstdCompressSync(input);

const ID = '01990000-0000-7000-8000-000000000241';
const NAME = 'metrics';
const SUPPLIERS = /\b(R2|S3|Cloudflare|Daytona|Blaxel|Turso|MotherDuck)\b/i;
const digest = (body: Buffer) => createHash('sha256').update(body).digest('hex');

const raw = Buffer.concat([Buffer.from('DUCK-real-file-header-'), Buffer.alloc(9000, 'row-data-')]);
const stored = hasZstd ? zstdCompress(raw) : Buffer.from('no-zstd-on-this-node');
const storedSha = digest(stored);

const duckdbFileRow = (overrides: Record<string, unknown> = {}) => ({
    id: ID,
    name: NAME,
    kind: 'duckdb_file',
    status: 'ready',
    bytes: 12288,
    cap_bytes: 1073741824,
    latest_version: 3,
    last_published_at: '2026-11-13T10:00:00Z',
    deleted_at: null,
    purge_at: null,
    ...overrides,
});
const libsqlRow = {
    id: '01990000-0000-7000-8000-000000000001', name: 'orders', kind: 'libsql', status: 'ready',
    deleted_at: null, purge_at: null, size_bytes: 4096,
};

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function tmp(): string {
    // The pull refuses a destination with a symlink anywhere in its path, and
    // the system temp dir is one on macOS (/var -> /private/var).
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-duckdb-file-')));
    roots.push(root);
    return root;
}

function filesUnder(root: string): string[] {
    const found: string[] = [];
    const walk = (directory: string) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(full);
            else found.push(path.relative(root, full));
        }
    };
    walk(root);
    return found.sort();
}

type Reply = { status?: number; json?: unknown; bytes?: Buffer; stream?: (response: http.ServerResponse) => void };
type Responder = (request: http.IncomingMessage, body: Record<string, unknown>, attempt: number) => Reply;
type Remote = Awaited<ReturnType<typeof serve>>;

async function serve(responder: Responder) {
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    const attempts = new Map<string, number>();
    const server = http.createServer((request, response) => {
        let text = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => { text += chunk; });
        request.on('end', () => {
            const body = text ? JSON.parse(text) as Record<string, unknown> : {};
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
            response.writeHead(reply.status ?? 200, { 'Content-Length': String(payload.length) });
            response.end(payload);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return {
        server,
        calls,
        origin,
        operations: () => calls.filter((call) => call.method === 'POST').map((call) => String(call.body.operation)),
        downloads: () => calls.filter((call) => call.method === 'GET'),
    };
}

async function scenario(responder: Responder, run: (remote: Remote) => Promise<void>) {
    const remote = await serve(responder);
    try {
        await run(remote);
    } finally {
        await new Promise<void>((resolve) => remote.server.close(() => resolve()));
    }
}

const config = (origin: string) => ({ host: origin, apiKey: 'pat', workspaceId: 'ws' });

function output() {
    const lines: string[] = [];
    return { lines, text: () => lines.join('\n'), stdout: (line: string) => { lines.push(line); }, stderr: (line: string) => { lines.push(line); } };
}

/** A control-plane server that answers `show` with the DuckDB database row and everything else from `extra`. */
function database(extra: (operation: string, body: Record<string, unknown>, attempt: number, request: http.IncomingMessage) => Reply, row = duckdbFileRow()): Responder {
    return (request, body, attempt) => {
        if (request.method === 'POST' && body.operation === 'show') return { json: { database: row } };
        return extra(String(body.operation ?? ''), body, attempt, request);
    };
}

const pullFacts = (origin: string, overrides: Record<string, unknown> = {}) => ({
    name: NAME,
    file_name: 'metrics.duckdb',
    version: 3,
    bytes: raw.length,
    stored_bytes: stored.length,
    sha256: storedSha,
    url: `${origin}/object/3`,
    expires_at: '2026-11-13T11:00:00Z',
    ...overrides,
});

describe('duckdb_file rows on create, list and show', () => {
    it('create --kind duckdb_file posts the kind, prints the row and does not poll for provisioning', async () => {
        await scenario(() => ({ json: { database: duckdbFileRow({ status: 'provisioning' }) } }), async (remote) => {
            const out = output();

            await databaseCreateWithConfig(NAME, { kind: 'duckdb_file' as never }, config(remote.origin), { stdout: out.stdout });

            expect(remote.calls).toHaveLength(1);
            expect(remote.calls[0].body).toEqual({ operation: 'create', name: NAME, kind: 'duckdb_file' });
            expect(out.text()).toContain('Database "metrics" created.');
            expect(out.text()).toContain('duckdb_file');
        });
    });

    it('create --kind duckdb_file --from is refused before any request', async () => {
        await scenario(() => ({ json: { database: duckdbFileRow() } }), async (remote) => {
            await expect(databaseCreateWithConfig(NAME, { kind: 'duckdb_file' as never, from: 'seed.sql' }, config(remote.origin), { stdout: () => undefined }))
                .rejects.toMatchObject({ code: 'invalid_flag_combination' });

            expect(remote.calls).toHaveLength(0);
        });
    });

    it('create --kind duckdb_file --json prints exactly the app row fields', async () => {
        await scenario(() => ({ json: { database: duckdbFileRow() } }), async (remote) => {
            const out = output();

            await databaseCreateWithConfig(NAME, { kind: 'duckdb_file' as never, json: true }, config(remote.origin), { stdout: out.stdout });

            expect(JSON.parse(out.text())).toEqual({ database: duckdbFileRow() });
        });
    });

    it('list renders the duckdb_file row next to a libsql row and --kind duckdb_file filters to it', async () => {
        const body = {
            databases: [libsqlRow, duckdbFileRow()],
            quota: { libsql: { used: 1, limit: 5, scope: 'workspace' }, duckdb: { used: 0, limit: 1, scope: 'org' } },
        };
        await scenario(() => ({ json: body }), async (remote) => {
            const all = output();
            const filtered = output();

            await databaseListWithConfig({}, config(remote.origin), { stdout: all.stdout });
            await databaseListWithConfig({ kind: 'duckdb_file' as never }, config(remote.origin), { stdout: filtered.stdout });

            expect(all.text()).toContain('orders');
            expect(all.text()).toMatch(/metrics\s+duckdb_file\s+ready/);
            expect(all.text()).toContain('12.0 KiB / 1.0 GiB');
            expect(filtered.text()).toContain('metrics');
            expect(filtered.text()).not.toContain('orders');
        });
    });

    it('show prints the size, the cap and the latest version of a duckdb_file database', async () => {
        await scenario(database(() => ({})), async (remote) => {
            const out = output();

            await databaseShowWithConfig(NAME, {}, config(remote.origin), { stdout: out.stdout });

            expect(out.text()).toContain('Kind: DuckDB (analytics)');
            expect(out.text()).toContain('Size: 12.0 KiB of 1.0 GiB');
            expect(out.text()).toContain('Latest version: 3');
            expect(out.text()).toContain('Last published: 2026-11-13T10:00:00Z');
        });
    });

    it('show says "none" for a duckdb_file database that has never been published', async () => {
        await scenario(database(() => ({}), duckdbFileRow({ bytes: 0, latest_version: null, last_published_at: null })), async (remote) => {
            const out = output();

            await databaseShowWithConfig(NAME, {}, config(remote.origin), { stdout: out.stdout });

            expect(out.text()).toContain('Latest version: none');
            expect(out.text()).toContain('Last published: never');
        });
    });

    it('an unknown kind still fails closed with upstream_unavailable', async () => {
        await scenario(database(() => ({}), duckdbFileRow({ kind: 'mystery_kind' })), async (remote) => {
            await expect(databaseShowWithConfig(NAME, {}, config(remote.origin), { stdout: () => undefined }))
                .rejects.toMatchObject({ code: 'upstream_unavailable' });
        });
    });

    it('a duckdb_file row whose cap_bytes is not a number fails closed with upstream_unavailable', async () => {
        await scenario(database(() => ({}), duckdbFileRow({ cap_bytes: '1073741824' })), async (remote) => {
            await expect(databaseShowWithConfig(NAME, {}, config(remote.origin), { stdout: () => undefined }))
                .rejects.toMatchObject({ code: 'upstream_unavailable' });
        });
    });
});

describe('database versions', () => {
    const versionsBody = {
        database: duckdbFileRow(),
        versions: [
            { version: 3, state: 'published', bytes: 12288, stored_bytes: 2048, published_at: '2026-11-13T10:00:00Z', run_uuid: '0199aaaa-0000-7000-8000-000000000003', latest: true },
            { version: 2, state: 'published', bytes: 8192, stored_bytes: 1500, published_at: '2026-11-12T10:00:00Z', run_uuid: '0199aaaa-0000-7000-8000-000000000002', latest: false },
        ],
    };

    it('prints a table of version, published time, size and run, newest first, with no link or supplier name', async () => {
        await scenario(() => ({ json: versionsBody }), async (remote) => {
            const out = output();

            await databaseVersionsWithConfig(NAME, {}, config(remote.origin), { stdout: out.stdout });

            expect(remote.calls[0].body).toEqual({ operation: 'versions', name: NAME });
            expect(out.text()).toMatch(/VERSION\s+PUBLISHED\s+SIZE\s+RUN/);
            expect(out.text()).toMatch(/3 \(latest\)\s+2026-11-13T10:00:00Z\s+12\.0 KiB\s+0199aaaa-0000-7000-8000-000000000003/);
            expect(out.text()).toMatch(/\n2\s+2026-11-12T10:00:00Z\s+8\.0 KiB/);
            expect(out.text().indexOf('2026-11-13')).toBeLessThan(out.text().indexOf('2026-11-12'));
            expect(out.text()).not.toContain('http');
            expect(out.text()).not.toMatch(SUPPLIERS);
        });
    });

    it('--limit is sent as limit and --json prints the app body unchanged', async () => {
        await scenario(() => ({ json: versionsBody }), async (remote) => {
            const out = output();

            await databaseVersionsWithConfig(NAME, { limit: 5, json: true }, config(remote.origin), { stdout: out.stdout });

            expect(remote.calls[0].body).toEqual({ operation: 'versions', name: NAME, limit: 5 });
            expect(JSON.parse(out.text())).toEqual(versionsBody);
            expect(out.text()).not.toContain('http');
        });
    });

    it('prints a plain sentence when nothing is published yet', async () => {
        await scenario(() => ({ json: { database: duckdbFileRow({ bytes: 0, latest_version: null, last_published_at: null }), versions: [] } }), async (remote) => {
            const out = output();

            await databaseVersionsWithConfig(NAME, {}, config(remote.origin), { stdout: out.stdout });

            expect(out.text()).toBe('No published versions yet.');
        });
    });

    it.each([0, 201, 1.5, Number.NaN])('rejects --limit %s before any request', async (limit) => {
        await scenario(() => ({ json: versionsBody }), async (remote) => {
            await expect(databaseVersionsWithConfig(NAME, { limit }, config(remote.origin), { stdout: () => undefined }))
                .rejects.toMatchObject({ code: 'invalid_limit' });

            expect(remote.calls).toHaveLength(0);
        });
    });

    it('relays the app refusal for a database that is not a DuckDB database', async () => {
        await scenario(() => ({ status: 422, json: { code: 'kind_mismatch', message: '"orders" is not a DuckDB database.' } }), async (remote) => {
            await expect(databaseVersionsWithConfig('orders', {}, config(remote.origin), { stdout: () => undefined }))
                .rejects.toMatchObject({ code: 'kind_mismatch', message: '"orders" is not a DuckDB database.' });
        });
    });
});

describe('database rollback', () => {
    it('without --yes and without a terminal fails with confirmation_required and sends no request', async () => {
        await scenario(() => ({ json: { database: duckdbFileRow() } }), async (remote) => {
            await expect(databaseRollbackWithConfig(NAME, '2', {}, config(remote.origin), { stdout: () => undefined, isTTY: false }))
                .rejects.toMatchObject({ code: 'confirmation_required' });
            await expect(databaseRollbackWithConfig(NAME, '2', { json: true }, config(remote.origin), { stdout: () => undefined, isTTY: true }))
                .rejects.toMatchObject({ code: 'confirmation_required' });

            expect(remote.calls).toHaveLength(0);
        });
    });

    it('with --yes posts rollback with the integer version and prints the row', async () => {
        await scenario(() => ({ json: { database: duckdbFileRow({ latest_version: 4 }) } }), async (remote) => {
            const out = output();

            await databaseRollbackWithConfig(NAME, '2', { yes: true }, config(remote.origin), { stdout: out.stdout, isTTY: false });

            expect(remote.calls).toHaveLength(1);
            expect(remote.calls[0].body).toEqual({ operation: 'rollback', name: NAME, version: 2 });
            expect(out.text()).toContain('Database "metrics" rolled back to version 2.');
        });
    });

    it('--json prints the app body', async () => {
        await scenario(() => ({ json: { database: duckdbFileRow({ latest_version: 4 }) } }), async (remote) => {
            const out = output();

            await databaseRollbackWithConfig(NAME, '2', { yes: true, json: true }, config(remote.origin), { stdout: out.stdout, isTTY: false });

            expect(JSON.parse(out.text())).toEqual({ database: duckdbFileRow({ latest_version: 4 }) });
        });
    });

    it.each(['0', '-1', 'abc', '1.5', '', '2x', '1e0', '0x2', ' 3 '])('rejects version %j before any request', async (version) => {
        await scenario(() => ({ json: { database: duckdbFileRow() } }), async (remote) => {
            await expect(databaseRollbackWithConfig(NAME, version, { yes: true }, config(remote.origin), { stdout: () => undefined }))
                .rejects.toMatchObject({ code: 'invalid_version' });

            expect(remote.calls).toHaveLength(0);
        });
    });

    it.each([
        [409, 'write_in_progress', 'A workflow is writing to this database right now.'],
        [404, 'version_not_found', 'Version 9 does not exist.'],
    ])('relays the app %s %s answer', async (status, code, message) => {
        await scenario(() => ({ status, json: { code, message } }), async (remote) => {
            await expect(databaseRollbackWithConfig(NAME, '9', { yes: true }, config(remote.origin), { stdout: () => undefined }))
                .rejects.toMatchObject({ code, message, status });
        });
    });
});

type PullExtra = (request: http.IncomingMessage, body: Record<string, unknown>, attempt: number) => Reply | undefined;
type PullFacts = (origin: string) => Record<string, unknown>;

function pullServer(extra: PullExtra = () => undefined, facts: PullFacts = (origin) => pullFacts(origin)): (getOrigin: () => string) => Responder {
    return (getOrigin) => (request, body, attempt) => {
        const custom = extra(request, body, attempt);
        if (custom) return custom;
        if (request.method === 'GET') return { bytes: stored };
        if (body.operation === 'show') return { json: { database: duckdbFileRow() } };
        if (body.operation === 'pull_url') return { json: facts(getOrigin()) };
        return { status: 500, json: { code: 'unexpected', message: `unexpected ${String(body.operation)}` } };
    };
}

async function pullScenario(
    responder: (getOrigin: () => string) => Responder,
    run: (remote: Remote, cwd: string) => Promise<void>,
) {
    let origin = '';
    const cwd = tmp();
    const remote = await serve(responder(() => origin));
    origin = remote.origin;
    try {
        await run(remote, cwd);
    } finally {
        await new Promise<void>((resolve) => remote.server.close(() => resolve()));
    }
}

// `zstdAvailable: true` is the default input so the rows that never decompress
// also run on a Node without zstd; the one row about a missing zstd passes false.
const pull = (remote: Remote, cwd: string, destination: string | undefined, options: Record<string, unknown>, out = output(), extra: Record<string, unknown> = {}) =>
    databasePullWithConfig(NAME, destination, options as never, config(remote.origin), { stdout: out.stdout, cwd, isTTY: false, zstdAvailable: true, ...extra });

describe('database pull of a duckdb_file database (rows that never decompress)', () => {
    it('relays no_published_version and writes nothing', async () => {
        await pullScenario(pullServer((_request, body) => (body.operation === 'pull_url' ? { status: 404, json: { code: 'no_published_version', message: 'Nothing has been published yet.' } } : undefined)), async (remote, cwd) => {
            await expect(pull(remote, cwd, undefined, {})).rejects.toMatchObject({ code: 'no_published_version', message: 'Nothing has been published yet.', status: 404 });

            expect(remote.downloads()).toHaveLength(0);
            expect(filesUnder(cwd)).toEqual([]);
        });
    });

    it('a link that is still refused (403) after one refresh fails with download_failed, asks for pull_url exactly twice and never prints the link', async () => {
        await pullScenario(pullServer((request) => (request.method === 'GET' ? { status: 403, json: {} } : undefined)), async (remote, cwd) => {
            const failure = await pull(remote, cwd, undefined, {}).then(() => null, (error) => error);

            expect(failure).toMatchObject({ code: 'download_failed' });
            expect(String(failure.message)).not.toContain(remote.origin);
            expect(remote.operations()).toEqual(['show', 'pull_url', 'pull_url']);
            expect(remote.downloads()).toHaveLength(2);
            expect(filesUnder(cwd)).toEqual([]);
        });
    });

    it('an existing target without --yes fails with confirmation_required before pull_url and keeps the file', async () => {
        await pullScenario(pullServer(), async (remote, cwd) => {
            const target = path.join(cwd, 'keep.duckdb');
            fs.writeFileSync(target, 'old contents');

            await expect(pull(remote, cwd, 'keep.duckdb', {})).rejects.toMatchObject({ code: 'confirmation_required' });

            expect(remote.operations()).toEqual(['show']);
            expect(fs.readFileSync(target, 'utf8')).toBe('old contents');
            expect(filesUnder(cwd)).toEqual(['keep.duckdb']);
        });
    });

    it.skipIf(process.platform === 'win32')('a symlink target is refused with unsafe_destination and the link target is untouched [POSIX symlinks]', async () => {
        await pullScenario(pullServer(), async (remote, cwd) => {
            fs.writeFileSync(path.join(cwd, 'real.duckdb'), 'real');
            fs.symlinkSync(path.join(cwd, 'real.duckdb'), path.join(cwd, 'link.duckdb'));

            await expect(pull(remote, cwd, 'link.duckdb', { yes: true })).rejects.toMatchObject({ code: 'unsafe_destination' });

            expect(fs.readFileSync(path.join(cwd, 'real.duckdb'), 'utf8')).toBe('real');
            expect(remote.downloads()).toHaveLength(0);
        });
    });

    it('--writable is refused for this kind before pull_url', async () => {
        await pullScenario(pullServer(), async (remote, cwd) => {
            await expect(pull(remote, cwd, undefined, { writable: true })).rejects.toMatchObject({
                code: 'invalid_flag_combination',
                message: expect.stringContaining('--writable is only for standard databases'),
            });

            expect(remote.operations()).toEqual(['show']);
        });
    });

    it('on a Node without zstd fails with zstd_unsupported before pull_url and before any download', async () => {
        await pullScenario(pullServer(), async (remote, cwd) => {
            const failure = await pull(remote, cwd, undefined, {}, output(), { zstdAvailable: false }).then(() => null, (error) => error);

            expect(failure).toMatchObject({ code: 'zstd_unsupported' });
            expect(failure.message).toBe(`Pulling a DuckDB database needs Node 22.15 or newer. This is Node ${process.version}.`);
            expect(remote.operations()).toEqual(['show']);
            expect(remote.downloads()).toHaveLength(0);
            expect(filesUnder(cwd)).toEqual([]);
        });
    });

    it.each([0, -1, 1.5, Number.NaN])('rejects --version %s before any request', async (version) => {
        await pullScenario(pullServer(), async (remote, cwd) => {
            await expect(pull(remote, cwd, undefined, { version })).rejects.toMatchObject({ code: 'invalid_version' });

            expect(remote.calls).toHaveLength(0);
        });
    });

    it('--version on a libsql database is refused after show and nothing else is requested', async () => {
        await pullScenario(() => (_request, body) => (body.operation === 'show' ? { json: { database: libsqlRow } } : { status: 500, json: { code: 'unexpected', message: String(body.operation) } }), async (remote, cwd) => {
            await expect(databasePullWithConfig('orders', undefined, { version: 2 } as never, config(remote.origin), { stdout: () => undefined, cwd, isTTY: false }))
                .rejects.toMatchObject({ code: 'invalid_flag_combination' });

            expect(remote.operations()).toEqual(['show']);
        });
    });
});

describe('database pull refuses a write-ahead file beside the target (rows that never decompress)', () => {
    it.each([
        ['with --yes over an existing file', { yes: true }, true],
        ['without --yes over an existing file', {}, true],
        ['with --yes when only the write-ahead file exists', { yes: true }, false],
    ])('%s fails with target_has_wal before pull_url and changes nothing', async (_label, options, targetExists) => {
        await pullScenario(pullServer(), async (remote, cwd) => {
            const target = path.join(cwd, 'keep.duckdb');
            if (targetExists) fs.writeFileSync(target, 'old contents');
            fs.writeFileSync(`${target}.wal`, 'left by a live session');
            expect(fs.existsSync(`${target}.wal`)).toBe(true);

            const failure = await pull(remote, cwd, 'keep.duckdb', options).then(() => null, (error) => error);

            expect(failure).toMatchObject({ code: 'target_has_wal' });
            expect(failure.message).toBe('A DuckDB write-ahead file sits beside keep.duckdb. Close the program that has the database open (or remove keep.duckdb.wal) and run the pull again.');
            expect(remote.operations()).toEqual(['show']);
            expect(remote.downloads()).toHaveLength(0);
            expect(fs.readFileSync(`${target}.wal`, 'utf8')).toBe('left by a live session');
            expect(filesUnder(cwd)).toEqual(targetExists ? ['keep.duckdb', 'keep.duckdb.wal'] : ['keep.duckdb.wal']);
            if (targetExists) expect(fs.readFileSync(target, 'utf8')).toBe('old contents');
        });
    });
});

describe.skipIf(!hasZstd)('database pull of a duckdb_file database (real zstd) [needs Node zlib zstd]', () => {
    it('asks for pull_url, downloads from the returned link, decompresses, writes the file and leaves no temp file', async () => {
        await pullScenario(pullServer(), async (remote, cwd) => {
            const out = output();

            await pull(remote, cwd, undefined, {}, out);

            const target = path.join(cwd, '.solidactions', 'databases', 'metrics.duckdb');
            expect(remote.operations()).toEqual(['show', 'pull_url']);
            expect(remote.calls.find((call) => call.body.operation === 'pull_url')?.body).toEqual({ operation: 'pull_url', name: NAME });
            expect(remote.downloads().map((call) => call.url)).toEqual(['/object/3']);
            expect(fs.readFileSync(target).equals(raw)).toBe(true);
            expect(filesUnder(cwd)).toEqual([path.join('.solidactions', 'databases', 'metrics.duckdb')]);
            expect(out.text()).toBe(`Database saved to ${path.join('.solidactions', 'databases', 'metrics.duckdb')} (version 3, ${raw.length} bytes)`);
            expect(out.text()).not.toContain('http');
        });
    });

    it.skipIf(process.platform === 'win32')('the file is mode 0644 so DuckDB can write its WAL beside it [POSIX file modes]', async () => {
        await pullScenario(pullServer(), async (remote, cwd) => {
            await pull(remote, cwd, 'local.duckdb', {});

            expect((fs.statSync(path.join(cwd, 'local.duckdb')).mode & 0o777).toString(8)).toBe('644');
        });
    });

    it('--version 2 sends version 2 in pull_url and reports the version the app returned', async () => {
        await pullScenario(pullServer(undefined, (origin) => pullFacts(origin, { version: 2 })), async (remote, cwd) => {
            const out = output();

            await pull(remote, cwd, 'v2.duckdb', { version: 2 }, out);

            expect(remote.calls.find((call) => call.body.operation === 'pull_url')?.body).toEqual({ operation: 'pull_url', name: NAME, version: 2 });
            expect(out.text()).toBe(`Database saved to v2.duckdb (version 2, ${raw.length} bytes)`);
        });
    });

    it.each([
        ['a wrong sha256', (origin: string) => pullFacts(origin, { sha256: digest(Buffer.from('another object')) }), stored],
        ['a wrong stored_bytes', (origin: string) => pullFacts(origin, { stored_bytes: stored.length + 5 }), stored],
        ['a wrong bytes (decompressed length)', (origin: string) => pullFacts(origin, { bytes: raw.length + 1 }), stored],
        ['a short body', (origin: string) => pullFacts(origin), stored.subarray(0, Math.floor(stored.length / 2))],
    ])('%s fails with download_corrupt, leaves no file and no partial, and never prints the link', async (_label, facts, served) => {
        await pullScenario(pullServer((request) => (request.method === 'GET' ? { bytes: served } : undefined), facts), async (remote, cwd) => {
            const failure = await pull(remote, cwd, undefined, {}).then(() => null, (error) => error);

            expect(failure).toMatchObject({ code: 'download_corrupt' });
            expect(String(failure.message)).not.toContain(remote.origin);
            expect(remote.downloads()).toHaveLength(1);
            expect(filesUnder(cwd)).toEqual([]);
        });
    });

    it('a corrupt download over an existing file keeps the old file and leaves no partial', async () => {
        await pullScenario(pullServer((request) => (request.method === 'GET' ? { bytes: stored.subarray(0, 20) } : undefined)), async (remote, cwd) => {
            fs.writeFileSync(path.join(cwd, 'keep.duckdb'), 'old contents');

            await expect(pull(remote, cwd, 'keep.duckdb', { yes: true })).rejects.toMatchObject({ code: 'download_corrupt' });

            expect(fs.readFileSync(path.join(cwd, 'keep.duckdb'), 'utf8')).toBe('old contents');
            expect(filesUnder(cwd)).toEqual(['keep.duckdb']);
        });
    });

    it('a body that stops before its declared length fails with download_failed and leaves nothing behind', async () => {
        const cut: PullExtra = (request) => (request.method === 'GET'
            ? { stream: (response) => {
                response.writeHead(200, { 'Content-Length': String(stored.length) });
                response.write(stored.subarray(0, 10));
                setTimeout(() => response.destroy(), 20);
            } }
            : undefined);
        await pullScenario(pullServer(cut), async (remote, cwd) => {
            const failure = await pull(remote, cwd, undefined, {}).then(() => null, (error) => error);

            expect(failure).toMatchObject({ code: 'download_failed' });
            expect(String(failure.message)).not.toContain(remote.origin);
            expect(filesUnder(cwd)).toEqual([]);
        });
    });

    it('a corrupt zstd body of the recorded length and checksum fails with download_corrupt, not download_failed, and leaves no file', async () => {
        // Same length, matching sha256 and stored_bytes: only the decoder can tell. The decode error makes the
        // pipeline destroy the download, and that follow-on transport error must not be reported as the cause.
        const corrupted = Buffer.from(stored);
        corrupted.fill(0xff, 4);
        expect(corrupted.length).toBe(stored.length);
        await pullScenario(pullServer(
            (request) => (request.method === 'GET' ? { bytes: corrupted } : undefined),
            (origin) => pullFacts(origin, { sha256: digest(corrupted) }),
        ), async (remote, cwd) => {
            const failure = await pull(remote, cwd, undefined, {}).then(() => null, (error) => error);

            expect(failure).toMatchObject({ code: 'download_corrupt' });
            expect(String(failure.message)).not.toContain(remote.origin);
            expect(remote.downloads()).toHaveLength(1);
            expect(filesUnder(cwd)).toEqual([]);
        });
    });

    it('a server that sends headers and then stalls fails with download_failed within the timeout and leaves nothing behind', async () => {
        const stall: PullExtra = (request) => (request.method === 'GET'
            ? { stream: (response) => {
                response.writeHead(200, { 'Content-Length': String(stored.length) });
                response.flushHeaders();
            } }
            : undefined);
        await pullScenario(pullServer(stall), async (remote, cwd) => {
            const startedAt = Date.now();

            const failure = await pull(remote, cwd, undefined, {}, output(), { dataPlaneTimeoutMs: 400 }).then(() => null, (error) => error);

            expect(failure).toMatchObject({ code: 'download_failed' });
            expect(String(failure.message)).not.toContain(remote.origin);
            expect(remote.downloads()).toHaveLength(1);
            expect(Date.now() - startedAt).toBeLessThan(4000);
            expect(filesUnder(cwd)).toEqual([]);
        });
    });

    it('an expired link (403) asks for pull_url again once and then succeeds', async () => {
        let refused = false;
        const expireOnce: PullExtra = (request) => {
            if (request.method !== 'GET' || refused) return undefined;
            refused = true;
            return { status: 403, json: { message: 'expired' } };
        };
        await pullScenario(pullServer(expireOnce), async (remote, cwd) => {
            await pull(remote, cwd, 'again.duckdb', {});

            expect(remote.operations()).toEqual(['show', 'pull_url', 'pull_url']);
            expect(remote.downloads()).toHaveLength(2);
            expect(fs.readFileSync(path.join(cwd, 'again.duckdb')).equals(raw)).toBe(true);
            expect(filesUnder(cwd)).toEqual(['again.duckdb']);
        });
    });

    it('--yes replaces an existing target through the temp file', async () => {
        await pullScenario(pullServer(), async (remote, cwd) => {
            const target = path.join(cwd, 'keep.duckdb');
            fs.writeFileSync(target, 'old contents');

            await pull(remote, cwd, 'keep.duckdb', { yes: true });

            expect(fs.readFileSync(target).equals(raw)).toBe(true);
            expect(filesUnder(cwd)).toEqual(['keep.duckdb']);
        });
    });
});

describe('query, schema and exec on a duckdb_file database', () => {
    it.each([
        ['query', (name: string, remote: Remote) => databaseQueryWithConfig(name, 'select 1', {}, config(remote.origin), { stdout: () => undefined })],
        ['schema', (name: string, remote: Remote) => databaseSchemaWithConfig(name, {}, config(remote.origin), { stdout: () => undefined })],
    ])('%s relays the app not_available answer and never mints a data-plane credential', async (operation, invoke) => {
        const message = 'Queries on DuckDB databases arrive with the next release.';
        await scenario(database((op) => (op === operation ? { status: 422, json: { code: 'not_available', message } } : { status: 500, json: { code: 'unexpected', message: op } })), async (remote) => {
            await expect(invoke(NAME, remote)).rejects.toMatchObject({ code: 'not_available', message, status: 422 });

            expect(remote.operations()).toEqual(['show', operation]);
        });
    });

    it('exec is refused with read_only and the workflow instruction, without confirmation or a data-plane credential', async () => {
        await scenario(database(() => ({ status: 500, json: { code: 'unexpected', message: 'unexpected' } })), async (remote) => {
            const failure = await databaseExecWithConfig(NAME, 'delete from t', { yes: true }, config(remote.origin), { stdout: () => undefined })
                .then(() => null, (error) => error);

            expect(failure).toMatchObject({ code: 'read_only' });
            expect(failure.message).toContain('change it from a workflow: open, change, publish');
            expect(remote.operations()).toEqual(['show']);
        });
    });
});

describe('analytical-only verbs on a duckdb_file database', () => {
    it.each([
        ['wake', (remote: Remote) => databaseWakeWithConfig(NAME, {}, config(remote.origin), { stdout: () => undefined })],
        ['connect', (remote: Remote) => databaseConnectWithConfig(NAME, {}, config(remote.origin), { stdout: () => undefined })],
        ['optimize', (remote: Remote) => databaseOptimizeWithConfig(NAME, {}, config(remote.origin), { stdout: () => undefined })],
        ['ingest', (remote: Remote) => databaseIngestWithConfig(NAME, 'data.csv', { table: 'events' }, config(remote.origin), { stdout: () => undefined })],
        ['export', (remote: Remote) => databaseExportWithConfig(NAME, {}, config(remote.origin), { stdout: () => undefined, stderr: () => undefined })],
    ])('%s gets the existing kind_mismatch refusal and sends nothing but show', async (_verb, invoke) => {
        await scenario(database(() => ({ status: 500, json: { code: 'unexpected', message: 'unexpected' } })), async (remote) => {
            await expect(invoke(remote)).rejects.toMatchObject({ code: 'kind_mismatch' });

            expect(remote.operations()).toEqual(['show']);
        });
    });
});

describe('the built binary', () => {
    function runCli(args: string[], home: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
        return new Promise((resolve) => {
            const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1' };
            for (const key of ['SOLIDACTIONS_HOST', 'SOLIDACTIONS_API_KEY', 'SOLIDACTIONS_WORKSPACE_ID', 'DEBUG', 'NODE_DEBUG']) delete env[key];
            execFile(process.execPath, [CLI_BINARY, ...args], { cwd, env, timeout: 30_000 }, (error, stdout, stderr) => {
                resolve({ stdout, stderr, code: error ? Number((error as { code?: number }).code ?? 1) : 0 });
            });
        });
    }

    it.skipIf(!hasZstd)('database pull <name> --version 2 reaches the pull command instead of printing the CLI version [needs Node zlib zstd]', async () => {
        expect(fs.existsSync(CLI_BINARY)).toBe(true); // CLI not built — run `npm run build` first
        let origin = '';
        const env = makeTmpEnv();
        const remote = await serve((request, body) => {
            if (request.method === 'GET') return { bytes: stored };
            if (body.operation === 'show') return { json: { database: duckdbFileRow() } };
            return { json: pullFacts(origin, { version: 2 }) };
        });
        origin = remote.origin;
        try {
            writeGlobal(env.home, { host: remote.origin, apiKey: 'pat', workspaceId: 'ws-1', workspace: 'ws-1' });

            const result = await runCli(['database', 'pull', NAME, 'out.duckdb', '--version', '2'], env.home, fs.realpathSync(env.cwd));

            expect(result.code).toBe(0);
            expect(result.stdout.trim()).toBe(`Database saved to out.duckdb (version 2, ${raw.length} bytes)`);
            expect(remote.calls.find((call) => call.body.operation === 'pull_url')?.body).toEqual({ operation: 'pull_url', name: NAME, version: 2 });
        } finally {
            await new Promise<void>((resolve) => remote.server.close(() => resolve()));
            env.cleanup();
        }
    });

    // These rows never decompress, so they run on every Node. The command line is parsed by the real
    // binary: a bad number must stop at the parser and the server must see no request at all.
    it.each(['0', '-1', 'abc', '1e0', '0x2', ' 3 '])('database pull <name> --version %j prints the invalid_version refusal and sends no request', async (value) => {
        expect(fs.existsSync(CLI_BINARY)).toBe(true); // CLI not built — run `npm run build` first
        const env = makeTmpEnv();
        const remote = await serve(() => ({ status: 500, json: { code: 'unexpected', message: 'unexpected' } }));
        try {
            writeGlobal(env.home, { host: remote.origin, apiKey: 'pat', workspaceId: 'ws-1', workspace: 'ws-1' });

            const result = await runCli(['database', 'pull', NAME, 'out.duckdb', '--version', value], env.home, fs.realpathSync(env.cwd));

            expect(result.code).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toContain('--version must be a whole number of 1 or more.');
            expect(result.stderr).not.toContain(pkg.version);
            expect(remote.calls).toHaveLength(0);
        } finally {
            await new Promise<void>((resolve) => remote.server.close(() => resolve()));
            env.cleanup();
        }
    });

    it.each(['0', '201', '-1', 'abc', '1e0', '0x2', ' 3 '])('database versions <name> --limit %j prints the invalid_limit refusal and sends no request', async (value) => {
        expect(fs.existsSync(CLI_BINARY)).toBe(true); // CLI not built — run `npm run build` first
        const env = makeTmpEnv();
        const remote = await serve(() => ({ status: 500, json: { code: 'unexpected', message: 'unexpected' } }));
        try {
            writeGlobal(env.home, { host: remote.origin, apiKey: 'pat', workspaceId: 'ws-1', workspace: 'ws-1' });

            const result = await runCli(['database', 'versions', NAME, '--limit', value], env.home, fs.realpathSync(env.cwd));

            expect(result.code).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toContain('--limit must be a whole number between 1 and 200');
            expect(remote.calls).toHaveLength(0);
        } finally {
            await new Promise<void>((resolve) => remote.server.close(() => resolve()));
            env.cleanup();
        }
    });

    it('database versions <name> --limit 5 still reaches the command with the number 5 (positive control for the refusals above)', async () => {
        expect(fs.existsSync(CLI_BINARY)).toBe(true); // CLI not built — run `npm run build` first
        const env = makeTmpEnv();
        const remote = await serve(() => ({ json: { database: duckdbFileRow(), versions: [] } }));
        try {
            writeGlobal(env.home, { host: remote.origin, apiKey: 'pat', workspaceId: 'ws-1', workspace: 'ws-1' });

            const result = await runCli(['database', 'versions', NAME, '--limit', '5'], env.home, fs.realpathSync(env.cwd));

            expect(result.code).toBe(0);
            expect(result.stdout.trim()).toBe('No published versions yet.');
            expect(remote.calls.map((call) => call.body)).toEqual([{ operation: 'versions', name: NAME, limit: 5 }]);
        } finally {
            await new Promise<void>((resolve) => remote.server.close(() => resolve()));
            env.cleanup();
        }
    });

    it('the root --version still prints the CLI version', async () => {
        expect(fs.existsSync(CLI_BINARY)).toBe(true); // CLI not built — run `npm run build` first
        const env = makeTmpEnv();
        try {
            const result = await runCli(['--version'], env.home, env.cwd);

            expect(result.code).toBe(0);
            expect(result.stdout.trim()).toBe(pkg.version);
        } finally {
            env.cleanup();
        }
    });
});

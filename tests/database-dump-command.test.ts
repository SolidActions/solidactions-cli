import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Config {
    host: string;
    apiKey: string;
    workspaceId: string;
}

const CONFIG: Config = {
    host: 'https://app.example.test',
    apiKey: 'control-plane-pat-sentinel',
    workspaceId: 'workspace-1146',
};

// The analytical-name guard (#1700 Plan D Task 5) mints a `show` before any
// other work; every case below is exercised against a libsql database, so
// the guard observes this row and lets the dump proceed.
function showRow(name: string): unknown {
    return {
        database: { id: 'db-dump', name, kind: 'libsql', status: 'ready', size_bytes: 0, deleted_at: null, purge_at: null },
    };
}

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

async function requireDump(): Promise<Function> {
    const url = pathToFileURL(path.resolve(__dirname, '../src/commands/database.ts')).href;
    let module: Record<string, unknown> = {};
    try {
        module = await import(url) as Record<string, unknown>;
    } catch {
        // The first TDD slice intentionally lands before the production export.
    }
    expect(module.databaseDumpWithConfig, 'databaseDumpWithConfig export').toBeTypeOf('function');
    return module.databaseDumpWithConfig as Function;
}

function tempRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-database-dump-'));
    roots.push(root);
    return root;
}

function chunks(...values: string[]): AsyncIterable<Buffer> {
    return (async function* stream() {
        for (const value of values) yield Buffer.from(value);
    })();
}

function failingChunks(secret: string): AsyncIterable<Buffer> {
    return (async function* stream() {
        yield Buffer.from('CREATE TABLE preserved (id INTEGER);\n');
        throw new Error(`stream exploded ${secret}`);
    })();
}

function dumpHarness(root: string, data: unknown = chunks('SELECT 1;\n')) {
    const posts: Array<{ url: string; body: Record<string, unknown>; options: Record<string, unknown> }> = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const confirm = vi.fn(async () => true as boolean | undefined);
    const dependencies = {
        cwd: root,
        tempPath: (target: string) => path.join(path.dirname(target), `.${path.basename(target)}.solidactions-task7.tmp`),
        post: async (url: string, body: Record<string, unknown>, options: Record<string, unknown>) => {
            posts.push({ url, body, options });
            if (body.operation === 'show') {
                return { status: 200, data: showRow(String(body.name)) };
            }
            return { status: 200, data };
        },
        stdout: (line: string) => stdout.push(line),
        stderr: (line: string) => stderr.push(line),
        confirm,
        isTTY: true,
    };

    return { posts, stdout, stderr, confirm, dependencies };
}

function expectShowPost(post: { url: string; body: Record<string, unknown>; options: Record<string, unknown> }, name: string): void {
    expect(post.url).toBe('https://app.example.test/api/v1/databases');
    expect(post.body).toEqual({ operation: 'show', name });
}

function expectDumpPost(post: { url: string; body: Record<string, unknown>; options: Record<string, unknown> }, name: string): void {
    expect(post.url).toBe('https://app.example.test/api/v1/databases');
    expect(post.body).toEqual({ operation: 'dump', name });
    expect(post.options).toMatchObject({
        responseType: 'stream',
        headers: {
            Accept: expect.stringMatching(/sql|octet-stream/i),
            Authorization: 'Bearer control-plane-pat-sentinel',
            'Content-Type': 'application/json',
            'X-Workspace-Id': 'workspace-1146',
        },
    });
}

describe('database dump atomic file contract', () => {
    it.each([
        { name: '../../', expected: 'database.sql' },
        { name: '../../Customer Data/2026', expected: 'customer-data-2026.sql' },
        { name: '/tmp/Root DB', expected: 'tmp-root-db.sql' },
    ])('keeps the safe default for $name inside cwd as $expected', async ({ name, expected }) => {
        const databaseDumpWithConfig = await requireDump();
        const root = tempRoot();
        const test = dumpHarness(root, chunks('-- complete\n'));

        await databaseDumpWithConfig(name, undefined, {}, CONFIG, test.dependencies);

        const target = path.join(root, expected);
        expect(fs.readFileSync(target, 'utf8')).toBe('-- complete\n');
        expect(path.dirname(target)).toBe(root);
        expect(test.posts).toHaveLength(2);
        expectShowPost(test.posts[0], name);
        expectDumpPost(test.posts[1], name);
        expect(test.stdout.join('\n')).toContain(expected);
        expect(test.stderr).toEqual([]);
    });

    it('streams to an exclusively-created sibling temp and renames only after the stream closes', async () => {
        const databaseDumpWithConfig = await requireDump();
        const root = tempRoot();
        const target = path.join(root, 'chosen.sql');
        const events: string[] = [];
        const realPromises = fs.promises;
        const data = (async function* stream() {
            try {
                yield Buffer.from('CREATE TABLE events (id INTEGER);\n');
                yield Buffer.from('INSERT INTO events VALUES (1);\n');
            } finally {
                events.push('stream-close');
            }
        })();
        const test = dumpHarness(root, data);
        const open = vi.fn(async (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
            events.push(`open:${String(flags)}`);
            return realPromises.open(file, flags, mode);
        });
        const rename = vi.fn(async (from: fs.PathLike, to: fs.PathLike) => {
            events.push('rename');
            return realPromises.rename(from, to);
        });
        const chmod = vi.fn(async (file: fs.PathLike, mode: fs.Mode) => {
            events.push(`chmod:${Number(mode).toString(8)}`);
            return realPromises.chmod(file, mode);
        });
        test.dependencies = {
            ...test.dependencies,
            filesystem: { ...realPromises, open, rename, chmod },
        } as any;

        await databaseDumpWithConfig('Analytics', target, {}, CONFIG, test.dependencies);

        expect(open).toHaveBeenCalled();
        expect(open.mock.calls[0][1]).toBe('wx');
        expect(rename).toHaveBeenCalledOnce();
        expect(events.indexOf('stream-close')).toBeLessThan(events.indexOf('rename'));
        expect(chmod).toHaveBeenCalledWith(target, 0o444);
        expect(events.indexOf('rename')).toBeLessThan(events.indexOf('chmod:444'));
        expect(fs.readFileSync(target, 'utf8')).toContain('INSERT INTO events VALUES (1)');
        expect(fs.statSync(target).mode & 0o777).toBe(0o444);
        expect(fs.readdirSync(root)).toEqual(['chosen.sql']);
    });

    it.each([
        { label: 'non-TTY', isTTY: false, answer: true },
        { label: 'decline', isTTY: true, answer: false },
        { label: 'EOF', isTTY: true, answer: undefined },
    ])('$label refuses an existing target before any write', async ({ isTTY, answer }) => {
        const databaseDumpWithConfig = await requireDump();
        const root = tempRoot();
        const target = path.join(root, 'existing.sql');
        fs.writeFileSync(target, 'OLD DUMP');
        const test = dumpHarness(root);
        test.dependencies.isTTY = isTTY;
        test.dependencies.confirm = vi.fn(async () => answer);

        const outcome = databaseDumpWithConfig('Analytics', target, {}, CONFIG, test.dependencies);
        if (isTTY) await outcome;
        else await expect(outcome).rejects.toMatchObject({ code: 'confirmation_required' });

        // Only the analytical-name guard's `show` runs before the
        // overwrite confirmation (#1700 Plan D Task 5) — no dump request.
        expect(test.posts).toHaveLength(1);
        expectShowPost(test.posts[0], 'Analytics');
        expect(fs.readFileSync(target, 'utf8')).toBe('OLD DUMP');
        expect(fs.readdirSync(root)).toEqual(['existing.sql']);
    });

    it('refuses a destination symlink before prompting or writing, even with --yes', async () => {
        const databaseDumpWithConfig = await requireDump();
        const root = tempRoot();
        const outside = path.join(root, 'outside.sql');
        const target = path.join(root, 'linked.sql');
        fs.writeFileSync(outside, 'DO NOT REPLACE');
        fs.symlinkSync(outside, target);
        const test = dumpHarness(root);

        await expect(databaseDumpWithConfig('Analytics', target, { yes: true }, CONFIG, test.dependencies))
            .rejects.toThrow(/symbolic link/i);

        // Only the analytical-name guard's `show` runs first (#1700 Plan D
        // Task 5) — the symlink refusal happens before any dump request.
        expect(test.posts).toHaveLength(1);
        expectShowPost(test.posts[0], 'Analytics');
        expect(test.confirm).not.toHaveBeenCalled();
        expect(fs.readFileSync(outside, 'utf8')).toBe('DO NOT REPLACE');
        expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    });

    it('refuses a symlinked destination parent before creating files', async () => {
        const databaseDumpWithConfig = await requireDump();
        const root = tempRoot();
        const outside = path.join(root, 'outside');
        const linkedParent = path.join(root, 'backups');
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, 'analytics.sql'), 'OUTSIDE DUMP');
        fs.symlinkSync(outside, linkedParent, 'dir');
        const test = dumpHarness(root);

        await expect(databaseDumpWithConfig(
            'Analytics',
            path.join(linkedParent, 'analytics.sql'),
            { yes: true },
            CONFIG,
            test.dependencies,
        )).rejects.toThrow(/symbolic link/i);

        // Only the analytical-name guard's `show` runs first (#1700 Plan D
        // Task 5) — the symlink refusal happens before any dump request.
        expect(test.posts).toHaveLength(1);
        expectShowPost(test.posts[0], 'Analytics');
        expect(test.confirm).not.toHaveBeenCalled();
        expect(fs.readFileSync(path.join(outside, 'analytics.sql'), 'utf8')).toBe('OUTSIDE DUMP');
        expect(fs.readdirSync(outside)).toEqual(['analytics.sql']);
    });

    it('reserves its deterministic sibling temp exclusively without a dump post or removing a collision', async () => {
        const databaseDumpWithConfig = await requireDump();
        const root = tempRoot();
        const target = path.join(root, 'analytics.sql');
        const temp = path.join(root, '.analytics.sql.solidactions-task7.tmp');
        fs.writeFileSync(temp, 'PRE-EXISTING TEMP OWNED BY SOMEONE ELSE');
        const test = dumpHarness(root);

        await expect(databaseDumpWithConfig('Analytics', target, {}, CONFIG, test.dependencies))
            .rejects.toThrow(/temporary|already exists|failed/i);

        // Only the analytical-name guard's `show` runs before the
        // collision is detected (#1700 Plan D Task 5) — no dump post.
        expect(test.posts).toHaveLength(1);
        expectShowPost(test.posts[0], 'Analytics');
        expect(fs.existsSync(target)).toBe(false);
        expect(fs.readFileSync(temp, 'utf8')).toBe('PRE-EXISTING TEMP OWNED BY SOMEONE ELSE');
    });

    it.each([
        {
            label: 'stream failure',
            stream: failingChunks('RAW_STREAM_TOKEN_AND_HOST_SENTINEL'),
        },
        {
            label: 'incomplete marker split across chunks',
            stream: chunks('SELECT 1;\n-- DOWNLOAD ', 'INCOMPLETE\n'),
        },
    ])('$label preserves the old target and removes only its own temp', async ({ stream }) => {
        const databaseDumpWithConfig = await requireDump();
        const root = tempRoot();
        const target = path.join(root, 'existing.sql');
        const ownTemp = path.join(root, '.existing.sql.solidactions-task7.tmp');
        const unrelated = path.join(root, '.other.sql.solidactions-someone-else.tmp');
        fs.writeFileSync(target, 'OLD DUMP');
        fs.writeFileSync(unrelated, 'NOT OUR FILE');
        const test = dumpHarness(root, stream);

        let caught: any;
        try {
            await databaseDumpWithConfig('Analytics', target, { yes: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeDefined();
        expect(String(caught?.message)).toMatch(/failed|incomplete/i);
        expect(JSON.stringify(caught)).not.toContain('RAW_STREAM_TOKEN_AND_HOST_SENTINEL');
        expect(String(caught?.stack ?? '')).not.toContain('RAW_STREAM_TOKEN_AND_HOST_SENTINEL');
        expect(String(caught?.message)).not.toContain(CONFIG.apiKey);
        expect(fs.readFileSync(target, 'utf8')).toBe('OLD DUMP');
        expect(fs.existsSync(ownTemp)).toBe(false);
        expect(fs.readFileSync(unrelated, 'utf8')).toBe('NOT OUR FILE');
    });

    it('scrubs HTTP response bodies and credentials while preserving an existing target', async () => {
        const databaseDumpWithConfig = await requireDump();
        const root = tempRoot();
        const target = path.join(root, 'existing.sql');
        fs.writeFileSync(target, 'OLD DUMP');
        const test = dumpHarness(root);
        test.dependencies.post = async () => {
            throw {
                message: `request failed ${CONFIG.apiKey}`,
                response: { data: 'RAW_UPSTREAM_BODY_SENTINEL' },
                config: { headers: { Authorization: `Bearer ${CONFIG.apiKey}` } },
            };
        };

        let caught: any;
        try {
            await databaseDumpWithConfig('Analytics', target, { yes: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({ code: 'upstream_unavailable' });
        const publicError = `${caught?.message ?? ''} ${caught?.stack ?? ''} ${JSON.stringify(caught)}`;
        expect(publicError).not.toContain(CONFIG.apiKey);
        expect(publicError).not.toContain('RAW_UPSTREAM_BODY_SENTINEL');
        expect(fs.readFileSync(target, 'utf8')).toBe('OLD DUMP');
        expect(fs.readdirSync(root)).toEqual(['existing.sql']);
    });

    it('rolls back only its own temp when final rename fails and scrubs filesystem details', async () => {
        const databaseDumpWithConfig = await requireDump();
        const root = tempRoot();
        const target = path.join(root, 'existing.sql');
        const ownTemp = path.join(root, '.existing.sql.solidactions-task7.tmp');
        const unrelated = path.join(root, '.unrelated.solidactions-other.tmp');
        fs.writeFileSync(target, 'OLD DUMP');
        fs.writeFileSync(unrelated, 'NOT OUR FILE');
        const test = dumpHarness(root, chunks('COMPLETE NEW DUMP'));
        test.dependencies.filesystem = {
            ...fs.promises,
            rename: async () => {
                throw new Error(`rename leaked ${CONFIG.apiKey} RAW_RENAME_PATH_SENTINEL`);
            },
        } as any;

        let caught: any;
        try {
            await databaseDumpWithConfig('Analytics', target, { yes: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({ code: 'upstream_unavailable' });
        const publicError = `${caught?.message ?? ''} ${caught?.stack ?? ''} ${JSON.stringify(caught)}`;
        expect(publicError).not.toContain(CONFIG.apiKey);
        expect(publicError).not.toContain('RAW_RENAME_PATH_SENTINEL');
        expect(fs.readFileSync(target, 'utf8')).toBe('OLD DUMP');
        expect(fs.existsSync(ownTemp)).toBe(false);
        expect(fs.readFileSync(unrelated, 'utf8')).toBe('NOT OUR FILE');
    });
});

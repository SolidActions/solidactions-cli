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
            return { status: 200, data };
        },
        stdout: (line: string) => stdout.push(line),
        stderr: (line: string) => stderr.push(line),
        confirm,
        isTTY: true,
    };

    return { posts, stdout, stderr, confirm, dependencies };
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
        expect(test.posts).toHaveLength(1);
        expectDumpPost(test.posts[0], name);
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
        test.dependencies = {
            ...test.dependencies,
            filesystem: { ...realPromises, open, rename },
        } as any;

        await databaseDumpWithConfig('Analytics', target, {}, CONFIG, test.dependencies);

        expect(open).toHaveBeenCalled();
        expect(open.mock.calls[0][1]).toBe('wx');
        expect(rename).toHaveBeenCalledOnce();
        expect(events.indexOf('stream-close')).toBeLessThan(events.indexOf('rename'));
        expect(fs.readFileSync(target, 'utf8')).toContain('INSERT INTO events VALUES (1)');
        expect(fs.readdirSync(root)).toEqual(['chosen.sql']);
    });

    it.each([
        { label: 'non-TTY', isTTY: false, answer: true },
        { label: 'decline', isTTY: true, answer: false },
        { label: 'EOF', isTTY: true, answer: undefined },
    ])('$label refuses an existing target before any request or write', async ({ isTTY, answer }) => {
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

        expect(test.posts).toEqual([]);
        expect(fs.readFileSync(target, 'utf8')).toBe('OLD DUMP');
        expect(fs.readdirSync(root)).toEqual(['existing.sql']);
    });

    it('refuses a destination symlink before prompting or requesting, even with --yes', async () => {
        const databaseDumpWithConfig = await requireDump();
        const root = tempRoot();
        const outside = path.join(root, 'outside.sql');
        const target = path.join(root, 'linked.sql');
        fs.writeFileSync(outside, 'DO NOT REPLACE');
        fs.symlinkSync(outside, target);
        const test = dumpHarness(root);

        await expect(databaseDumpWithConfig('Analytics', target, { yes: true }, CONFIG, test.dependencies))
            .rejects.toThrow(/symbolic link/i);

        expect(test.posts).toEqual([]);
        expect(test.confirm).not.toHaveBeenCalled();
        expect(fs.readFileSync(outside, 'utf8')).toBe('DO NOT REPLACE');
        expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
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
});

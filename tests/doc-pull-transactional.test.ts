/**
 * `doc pull` stops at the first error and records exactly what it wrote (cli#168, cli#188, cli#182; spec §1, PM ruling 12).
 *
 * Every case runs the built CLI (`node dist/index.js`) against a real in-process HTTP server with a
 * temp HOME and real files. A first pull writes `a.md`, `pic.png` and `sub/b.md`; each case then serves
 * new bytes and pulls again, sometimes with a failure injected through the module's own test-only
 * switch (`SOLIDACTIONS_TEST_HOOKS=1` plus `SOLIDACTIONS_DOC_PULL_TEST_FAULT`). A failed pull exits 1 with the
 * matching line; the files before the failure are updated AND tracked in the manifest with their own hashes,
 * the failing file and the ones after it keep their bytes and their earlier entries, nothing outside the
 * destination is touched, nothing the pull did not create is deleted, and the next pull completes the job.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeGlobal } from './helpers';
import { LOCK_FILE, MANIFEST_FILE, cannotWriteLine, changedLine, expectResult, failed, folderLine, killed, lockLine, manifestNotWrittenLine, pulledStdout, sha256 } from './doc-pull-inv-harness';
import type { CliResult, Expected } from './doc-pull-inv-harness';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

interface ServedDoc {
    id: number;
    title: string;
    revision: number;
    relative?: string;
    body?: string;
    media?: Buffer;
}

let server: http.Server;
let port: number;
let served: ServedDoc[] = [];

function mcpResult(data: object, isError = false): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError, content: [{ type: 'text', text: JSON.stringify(data) }] } });
}

function mediaProps(doc: ServedDoc): Record<string, unknown> {
    return doc.media === undefined ? {} : { blob_sha: `sha-${doc.id}`, mime: 'image/png', size: 4 };
}

function answerMcp(args: Record<string, any>): string {
    if (args.action === 'list') {
        const relative = String(args.folder_path).slice('docs'.length).replace(/^\//, '');
        const prefix = relative ? `${relative}/` : '';
        const folders = new Set(served
            .map((d) => d.relative ?? '')
            .filter((dir) => dir.startsWith(prefix) && dir !== relative)
            .map((dir) => dir.slice(prefix.length).split('/')[0]));
        return mcpResult({
            folders: [...folders].map((name) => ({ name, folder_path: `docs/${prefix}${name}` })),
            docs: served.filter((d) => (d.relative ?? '') === relative).map((d) => ({ id: d.id, title: d.title, doc_type: null })),
        });
    }
    if (args.action === 'bulk_read') {
        const ids: number[] = (args.items ?? []).map((item: { id: number }) => item.id);
        return mcpResult({
            results: ids.map((id, index) => {
                const d = served.find((doc) => doc.id === id)!;
                return { index, status: 'found', id, title: d.title, current_revision_id: d.revision, properties: mediaProps(d), body: d.media === undefined ? (d.body ?? '') : '' };
            }),
        });
    }
    return mcpResult({ code: 'unexpected', message: `unexpected action ${String(args.action)}` }, true);
}

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const url = req.url ?? '';
            const mediaConfirm = url.match(/^\/api\/v1\/docs\/(\d+)\/media$/);
            if (mediaConfirm) {
                const d = served.find((doc) => doc.id === Number(mediaConfirm[1]));
                if (!d || d.media === undefined) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ code: 'media_not_found', message: 'no media' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ url: `http://127.0.0.1:${port}/blob/${d.id}`, mime: 'image/png', size: 4 }));
                return;
            }
            const blob = url.match(/^\/blob\/(\d+)$/);
            if (blob) {
                const d = served.find((doc) => doc.id === Number(blob[1]));
                if (!d || d.media === undefined) {
                    res.writeHead(503);
                    res.end();
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
                res.end(d.media);
                return;
            }
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(answerMcp(body.params.arguments));
        });
    });
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))));

/**
 * Run the built CLI with a temp HOME pointing at the server; `extraEnv` sets the test hooks on purpose.
 * Every call must end as `expected` says: exit status (or killing signal), stdout and stderr, in full.
 */
function runCli(root: string, args: string[], expected: Expected, extraEnv: Record<string, string> = {}): Promise<CliResult> {
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    writeGlobal(home, { host: `http://127.0.0.1:${port}`, apiKey: 'test-api-key', workspaceId: 'ws-test-uuid' });
    return new Promise<CliResult>((resolve, reject) => {
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
        for (const key of ['SOLIDACTIONS_HOST', 'SOLIDACTIONS_API_KEY', 'SOLIDACTIONS_WORKSPACE_ID', 'DEBUG', 'NODE_DEBUG', 'FORCE_COLOR', 'SOLIDACTIONS_TEST_HOOKS', 'SOLIDACTIONS_DOC_PULL_TEST_FAULT']) {
            delete env[key];
        }
        // The product's own opt-out: a background update check could otherwise print an `AGENT NOTE` line on stderr.
        env.SOLIDACTIONS_NO_AGENT_NUDGES = '1';
        Object.assign(env, extraEnv);
        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`CLI timed out. stdout: ${stdout} stderr: ${stderr}`));
        }, 30_000);
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            try {
                expectResult({ code, signal, stdout, stderr }, expected);
                resolve({ code, signal, stdout, stderr });
            } catch (error) {
                reject(error);
            }
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

const fault = (spec: string): Record<string, string> => ({ SOLIDACTIONS_TEST_HOOKS: '1', SOLIDACTIONS_DOC_PULL_TEST_FAULT: spec });

interface Snapshot {
    entries: Record<string, string>;
    inodes: Record<string, number>;
}

/** Every entry under `dir` (dot-entries included): files by bytes, links by target, folders as `D`; plus every regular file's inode. */
function snapshot(dir: string): Snapshot {
    const entries: Record<string, string> = {};
    const inodes: Record<string, number> = {};
    const walk = (abs: string, prefix: string): void => {
        for (const name of fs.readdirSync(abs).sort()) {
            const full = path.join(abs, name);
            const rel = prefix === '' ? name : `${prefix}/${name}`;
            const stat = fs.lstatSync(full);
            if (stat.isSymbolicLink()) {
                entries[rel] = `L:${fs.readlinkSync(full)}`;
            } else if (stat.isDirectory()) {
                entries[rel] = 'D';
                walk(full, rel);
            } else {
                entries[rel] = `F:${fs.readFileSync(full).toString('latin1')}`;
                inodes[rel] = stat.ino;
            }
        }
    };
    walk(dir, '');
    return { entries, inodes };
}

function docsV(version: 1 | 2, extra: ServedDoc[] = []): ServedDoc[] {
    return [
        ...extra,
        { id: 1, title: 'a', revision: version, body: `A${version}` },
        { id: 2, title: 'b', revision: version, relative: 'sub', body: `B${version}` },
        { id: 3, title: 'pic', revision: version, media: Buffer.from(`P${version}`) },
    ];
}

/** The files a pull of `docsV` writes, in the order it writes them (root docs, then the folder's). */
const TRIO = ['a.md', 'pic.png', 'sub/b.md'];
const WITH_N = ['n.md', ...TRIO];

/** What the manifest says about one of the three files after a pull of `docsV(version)`. */
function entryOf(rel: string, version: 1 | 2): Record<string, unknown> {
    const spec: Record<string, { id: number; title: string; media: boolean; bytes: string }> = {
        'a.md': { id: 1, title: 'a', media: false, bytes: `A${version}` },
        'pic.png': { id: 3, title: 'pic', media: true, bytes: `P${version}` },
        'sub/b.md': { id: 2, title: 'b', media: false, bytes: `B${version}` },
    };
    const { id, title, media, bytes } = spec[rel];
    return { id, title, current_revision_id: version, media, body_sha256: sha256(bytes) };
}

const bytesOf = (rel: string, version: 1 | 2): string => ({ 'a.md': `A${version}`, 'pic.png': `P${version}`, 'sub/b.md': `B${version}` })[rel] as string;

describe('doc pull stops at the first error and records exactly what it wrote', { timeout: 60_000 }, () => {
    let root: string;
    let out: string;
    let before: Snapshot;

    beforeEach(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-pull-tx-'));
        out = path.join(root, 'out');
        served = docsV(1);
        await runCli(root, ['doc', 'pull', 'docs', out, '-y'], { code: 0, stdout: pulledStdout(out, TRIO), stderr: '' });
        served = docsV(2);
        before = snapshot(out);
    });

    afterEach(() => {
        fs.chmodSync(out, 0o755);
        fs.rmSync(root, { recursive: true, force: true });
    });

    const manifestDocs = (): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(out, MANIFEST_FILE), 'utf8')).docs;
    const internals = (): string[] => fs.readdirSync(out).filter((name) => name === LOCK_FILE || name.startsWith('.sa-write-'));

    /**
     * What a pull that stopped after writing the first `written` of the three files must have left: those files at their new
     * bytes with entries of their own, the rest untouched (bytes, inodes) and still tracked as before; no lock, no temp file.
     */
    const expectStoppedAfter = (written: number): void => {
        const after = snapshot(out);
        const expectedDocs: Record<string, unknown> = {};
        TRIO.forEach((rel, index) => {
            const isWritten = index < written;
            expect(after.entries[rel], rel).toBe(`F:${bytesOf(rel, isWritten ? 2 : 1)}`);
            if (!isWritten) expect(after.inodes[rel], `${rel} inode`).toBe(before.inodes[rel]);
            expectedDocs[rel] = entryOf(rel, isWritten ? 2 : 1);
        });
        expect(manifestDocs()).toEqual(expectedDocs);
        expect(internals()).toEqual([]);
        expect(Object.keys(after.entries).filter((rel) => !TRIO.includes(rel)).sort()).toEqual(['sub', MANIFEST_FILE].sort());
        expect(fs.readdirSync(root).sort()).toEqual(['home', 'out']);
    };

    it.each([1, 2, 3])('fail-rename:%i stops at that file: the ones before it are updated and tracked, it and the ones after keep their bytes and entries', async (n) => {
        await runCli(root, ['doc', 'pull', 'docs', out, '-y'], failed(cannotWriteLine(TRIO[n - 1], 'rename', n - 1, 3)), fault(`fail-rename:${n}`));

        expectStoppedAfter(n - 1);
    });

    it('a doc after the failed one is not written at all, and its temp file was removed', async () => {
        await runCli(root, ['doc', 'pull', 'docs', out, '-y'], failed(cannotWriteLine('pic.png', 'rename', 1, 3)), fault('fail-rename:2'));

        expect(fs.readFileSync(path.join(out, 'sub', 'b.md'), 'utf8')).toBe('B1');
        expect(fs.readdirSync(out).filter((name) => name.startsWith('.sa-write-'))).toEqual([]);
        expect(fs.readdirSync(path.join(out, 'sub'))).toEqual(['b.md']);
    });

    it('the next pull, with no fault, completes the job and every entry matches its file', async () => {
        await runCli(root, ['doc', 'pull', 'docs', out, '-y'], failed(cannotWriteLine('pic.png', 'rename', 1, 3)), fault('fail-rename:2'));

        await runCli(root, ['doc', 'pull', 'docs', out, '-y'], { code: 0, stdout: pulledStdout(out, TRIO), stderr: '' });

        expectStoppedAfter(3);
    });

    it('fails when the manifest temp file cannot be written: every file is written, the manifest is as it was, and the line says so', async () => {
        await runCli(root, ['doc', 'pull', 'docs', out, '-y'], failed(manifestNotWrittenLine('open manifest temp', 3, 3)), fault('fail-manifest-temp'));

        const after = snapshot(out);
        for (const rel of TRIO) expect(after.entries[rel]).toBe(`F:${bytesOf(rel, 2)}`);
        expect(after.entries[MANIFEST_FILE]).toBe(before.entries[MANIFEST_FILE]);
        expect(internals()).toEqual([]);
    });

    it('fails when the manifest cannot be renamed into place: its temp file is removed and the manifest is as it was', async () => {
        await runCli(root, ['doc', 'pull', 'docs', out, '-y'], failed(manifestNotWrittenLine('rename manifest', 3, 3)), fault('fail-manifest-rename'));

        const after = snapshot(out);
        for (const rel of TRIO) expect(after.entries[rel]).toBe(`F:${bytesOf(rel, 2)}`);
        expect(after.entries[MANIFEST_FILE]).toBe(before.entries[MANIFEST_FILE]);
        expect(internals()).toEqual([]);
    });

    it('after a manifest failure the files hold their new bytes under the old manifest, and the next pull adopts them instead of calling them local edits', async () => {
        await runCli(root, ['doc', 'pull', 'docs', out, '-y'], failed(manifestNotWrittenLine('rename manifest', 3, 3)), fault('fail-manifest-rename'));

        await runCli(root, ['doc', 'pull', 'docs', out, '-y'], { code: 0, stdout: pulledStdout(out, TRIO), stderr: '' });

        expectStoppedAfter(3);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('names the lock and changes nothing when the lock cannot be created (a really read-only destination)', async () => {
        fs.chmodSync(out, 0o555);

        await runCli(root, ['doc', 'pull', 'docs', out, '-y'], failed(/^error: cannot write \.solidactions-docs\.json\.lock: EACCES[^\n]* — nothing was changed\.\n$/));

        fs.chmodSync(out, 0o755);
        expect(snapshot(out)).toEqual(before);
    });

    describe('a target that changes after the check', () => {
        /** Everything but `rels` is as it was before the failed pull (the manifest file is compared by its entries). */
        const expectOnlyChanged = (rels: string[]): void => {
            const after = snapshot(out);
            for (const rel of rels) {
                delete after.entries[rel];
                delete after.inodes[rel];
            }
            const beforeEntries = { ...before.entries };
            const beforeInodes = { ...before.inodes };
            for (const rel of [...rels, MANIFEST_FILE]) {
                delete beforeEntries[rel];
                delete beforeInodes[rel];
            }
            delete after.entries[MANIFEST_FILE];
            delete after.inodes[MANIFEST_FILE];
            expect(after.entries).toEqual(beforeEntries);
            expect(after.inodes).toEqual(beforeInodes);
            expect(internals()).toEqual([]);
        };

        it('refuses a doc that appeared after the check, keeps the racing file, and tracks the files it did not get to as before', async () => {
            served = docsV(2, [{ id: 9, title: 'n', revision: 1, body: 'N1' }]);

            await runCli(root, ['doc', 'pull', 'docs', out, '-y'], failed(changedLine('n.md', 0, 4)), fault('create-before-commit:n.md'));

            expect(fs.readFileSync(path.join(out, 'n.md'), 'utf8')).toBe('RACE');
            expectOnlyChanged(['n.md']);
            expect(manifestDocs()).toEqual(Object.fromEntries(TRIO.map((rel) => [rel, entryOf(rel, 1)])));
        });

        it('refuses a tracked file rewritten after the check, after the files before it were written and tracked', async () => {
            await runCli(root, ['doc', 'pull', 'docs', out, '-y'], failed(changedLine('sub/b.md', 2, 3)), fault('create-before-commit:sub/b.md'));

            expect(fs.readFileSync(path.join(out, 'sub', 'b.md'), 'utf8')).toBe('RACE');
            expect(fs.readFileSync(path.join(out, 'a.md'), 'utf8')).toBe('A2');
            expect(fs.readFileSync(path.join(out, 'pic.png'), 'utf8')).toBe('P2');
            expect(manifestDocs()).toEqual({ 'a.md': entryOf('a.md', 2), 'pic.png': entryOf('pic.png', 2), 'sub/b.md': entryOf('sub/b.md', 1) });
            expect(internals()).toEqual([]);
        });

        it('replaces the racing file with the served bytes when --overwrite is given', async () => {
            served = docsV(2, [{ id: 9, title: 'n', revision: 1, body: 'N1' }]);

            await runCli(root, ['doc', 'pull', 'docs', out, '--overwrite'], { code: 0, stdout: pulledStdout(out, WITH_N), stderr: '' }, fault('create-before-commit:n.md'));

            expect(fs.readFileSync(path.join(out, 'n.md'), 'utf8')).toBe('N1');
            expect(fs.readFileSync(path.join(out, 'a.md'), 'utf8')).toBe('A2');
            expect(internals()).toEqual([]);
        });

        it('refuses a symbolic link that appeared at a new doc, leaves the link and the file it points at alone', async () => {
            served = docsV(2, [{ id: 9, title: 'n', revision: 1, body: 'N1' }]);
            const outside = path.join(root, 'outside.txt');
            fs.writeFileSync(outside, 'OUTSIDE');

            await runCli(root, ['doc', 'pull', 'docs', out, '-y'], failed(changedLine('n.md', 0, 4)), fault(`link-before-commit:n.md>${outside}`));

            expect(fs.readFileSync(outside, 'utf8')).toBe('OUTSIDE');
            expect(snapshot(out).entries['n.md']).toBe(`L:${outside}`);
            expectOnlyChanged(['n.md']);
        });

        it('replaces a symbolic link that appeared at a new doc with a regular file under --overwrite, without writing through it', async () => {
            served = docsV(2, [{ id: 9, title: 'n', revision: 1, body: 'N1' }]);
            const outside = path.join(root, 'outside.txt');
            fs.writeFileSync(outside, 'OUTSIDE');

            await runCli(root, ['doc', 'pull', 'docs', out, '--overwrite'], { code: 0, stdout: pulledStdout(out, WITH_N), stderr: '' }, fault(`link-before-commit:n.md>${outside}`));

            expect(fs.lstatSync(path.join(out, 'n.md')).isFile()).toBe(true);
            expect(fs.readFileSync(path.join(out, 'n.md'), 'utf8')).toBe('N1');
            expect(fs.readFileSync(outside, 'utf8')).toBe('OUTSIDE');
        });

        it('leaves a folder that appeared at a target alone (with its contents), writes nothing else and says so, even under --overwrite (ruling 9)', async () => {
            served = docsV(2, [{ id: 9, title: 'n', revision: 1, body: 'N1' }]);

            await runCli(root, ['doc', 'pull', 'docs', out, '--overwrite'], failed(folderLine('n.md', 0, 4)), fault('mkdir-before-commit:n.md'));

            expect(fs.readFileSync(path.join(out, 'n.md', 'user.txt'), 'utf8')).toBe('USER');
            expectOnlyChanged(['n.md', 'n.md/user.txt']);
        });

        it('a link on the way to a later doc stops there with the link refusal; the files before it are written and tracked, and nothing lands behind the link', async () => {
            served = docsV(2, [{ id: 9, title: 'n', revision: 1, relative: 'newdir', body: 'N1' }]);
            const outside = path.join(root, 'outside');
            fs.mkdirSync(outside);
            fs.writeFileSync(path.join(outside, 'keep.txt'), 'KEEP');

            await runCli(root, ['doc', 'pull', 'docs', out, '-y'], failed('error: newdir/n.md is a symbolic link (or sits under one: newdir); this pull would write doc 9 ("n") through it.\nReplace it with a regular file or folder and pull again.\n'), fault(`link-before-commit:newdir>${outside}`));

            expect(fs.readdirSync(outside)).toEqual(['keep.txt']);
            expect(fs.readFileSync(path.join(out, 'a.md'), 'utf8')).toBe('A2');
            expect(fs.readFileSync(path.join(out, 'pic.png'), 'utf8')).toBe('P2');
            expect(fs.readFileSync(path.join(out, 'sub', 'b.md'), 'utf8')).toBe('B1');
            expect(manifestDocs()).toEqual({ 'a.md': entryOf('a.md', 2), 'pic.png': entryOf('pic.png', 2), 'sub/b.md': entryOf('sub/b.md', 1) });
            expect(internals()).toEqual([]);
        });
    });

    describe('a renamed doc', () => {
        const renamed = (): ServedDoc[] => docsV(2).map((d) => (d.id === 1 ? { ...d, title: 'a2' } : d));

        it('written before the stop keeps its old file tracked beside the new one; the next pull finishes the rename and removes the old file', async () => {
            served = renamed();

            await runCli(root, ['doc', 'pull', 'docs', out, '-y'], failed(cannotWriteLine('pic.png', 'rename', 1, 3)), fault('fail-rename:2'));

            expect(fs.readFileSync(path.join(out, 'a.md'), 'utf8')).toBe('A1');
            expect(fs.readFileSync(path.join(out, 'a2.md'), 'utf8')).toBe('A2');
            expect(manifestDocs()).toEqual({
                'a.md': entryOf('a.md', 1),
                'a2.md': { ...entryOf('a.md', 2), title: 'a2' },
                'pic.png': entryOf('pic.png', 1),
                'sub/b.md': entryOf('sub/b.md', 1),
            });
            await runCli(root, ['doc', 'pull', 'docs', out, '-y'], { code: 0, stdout: pulledStdout(out, ['a2.md', 'pic.png', 'sub/b.md']), stderr: '' });

            expect(fs.existsSync(path.join(out, 'a.md'))).toBe(false);
            expect(fs.readFileSync(path.join(out, 'a2.md'), 'utf8')).toBe('A2');
            expect(manifestDocs()).toEqual({
                'a2.md': { ...entryOf('a.md', 2), title: 'a2' },
                'pic.png': entryOf('pic.png', 2),
                'sub/b.md': entryOf('sub/b.md', 2),
            });
            expect(internals()).toEqual([]);
        });

        it('written before one stop and not reached by a second keeps every earlier entry of the doc, old and new path', async () => {
            served = renamed();
            await runCli(root, ['doc', 'pull', 'docs', out, '-y'], failed(cannotWriteLine('pic.png', 'rename', 1, 3)), fault('fail-rename:2'));
            const afterFirst = manifestDocs();

            await runCli(root, ['doc', 'pull', 'docs', out, '-y'], failed(cannotWriteLine('a2.md', 'rename', 0, 3)), fault('fail-rename:1'));

            expect(manifestDocs()).toEqual(afterFirst);
            expect(fs.readFileSync(path.join(out, 'a.md'), 'utf8')).toBe('A1');
            expect(fs.readFileSync(path.join(out, 'a2.md'), 'utf8')).toBe('A2');
        });
    });

    describe('what a pull never touches (build rule 1)', () => {
        it('leaves user files and folders named like the old staging folders alone, through a successful pull and a failed one', async () => {
            const folder = path.join(out, '.solidactions-pull-900123');
            fs.mkdirSync(path.join(folder, 'backup'), { recursive: true });
            fs.writeFileSync(path.join(folder, 'backup', 'a.md'), 'MY OLD DOC');
            fs.writeFileSync(path.join(out, '.solidactions-pull-7'), 'MY FILE');
            const userEntries = snapshot(out).entries;
            const mine = Object.fromEntries(Object.entries(userEntries).filter(([rel]) => rel.startsWith('.solidactions-pull-')));

            await runCli(root, ['doc', 'pull', 'docs', out, '-y'], failed(cannotWriteLine('pic.png', 'rename', 1, 3)), fault('fail-rename:2'));
            const afterFailed = snapshot(out).entries;
            await runCli(root, ['doc', 'pull', 'docs', out, '-y'], { code: 0, stdout: pulledStdout(out, TRIO), stderr: '' });
            const afterOk = snapshot(out).entries;

            for (const after of [afterFailed, afterOk]) {
                for (const [rel, state] of Object.entries(mine)) expect(after[rel], rel).toBe(state);
            }
        });

        it('a folder where a doc goes is never moved or deleted, and the pull stops there without --overwrite as well', async () => {
            fs.rmSync(path.join(out, 'pic.png'));
            fs.mkdirSync(path.join(out, 'pic.png'));
            fs.writeFileSync(path.join(out, 'pic.png', 'mine.txt'), 'MINE');
            const manifest = JSON.parse(fs.readFileSync(path.join(out, MANIFEST_FILE), 'utf8'));
            manifest.docs = Object.fromEntries(Object.entries(manifest.docs).filter(([rel]) => rel !== 'pic.png'));
            fs.writeFileSync(path.join(out, MANIFEST_FILE), JSON.stringify(manifest));

            await runCli(root, ['doc', 'pull', 'docs', out, '-y'], failed('error: "pic.png" exists and is not a regular file — cannot write doc 3 (pic).\n'));

            expect(fs.readFileSync(path.join(out, 'pic.png', 'mine.txt'), 'utf8')).toBe('MINE');
            expect(fs.readFileSync(path.join(out, 'a.md'), 'utf8')).toBe('A1');
        });
    });

    describe('an interrupted pull', () => {
        it('a killed pull leaves its lock, the files it placed and the old manifest; the next pull refuses naming the lock; once the lock is deleted the pull completes', async () => {
            await runCli(root, ['doc', 'pull', 'docs', out, '-y'], killed(), fault('kill-after-renames:1'));

            expect(fs.readFileSync(path.join(out, LOCK_FILE), 'utf8')).toMatch(/^\d+\n$/);
            expect(fs.readFileSync(path.join(out, MANIFEST_FILE), 'utf8')).toBe(before.entries[MANIFEST_FILE].slice(2));
            expect(fs.readFileSync(path.join(out, 'a.md'), 'utf8')).toBe('A2');
            expect(fs.readFileSync(path.join(out, 'sub', 'b.md'), 'utf8')).toBe('B1');
            const killedState = snapshot(out);

            await runCli(root, ['doc', 'pull', 'docs', out, '-y'], failed(lockLine(out)));

            expect(snapshot(out)).toEqual(killedState);
            fs.rmSync(path.join(out, LOCK_FILE));
            await runCli(root, ['doc', 'pull', 'docs', out, '-y'], { code: 0, stdout: pulledStdout(out, TRIO), stderr: '' });

            expectStoppedAfter(3);
        });

        it('a pull killed after publishing only a new file: after the lock is deleted the next pull adopts that file and tracks it', async () => {
            served = docsV(2, [{ id: 9, title: 'n', revision: 1, body: 'N1' }]);

            await runCli(root, ['doc', 'pull', 'docs', out, '-y'], killed(), fault('kill-after-renames:1'));

            expect(fs.readFileSync(path.join(out, 'n.md'), 'utf8')).toBe('N1');
            fs.rmSync(path.join(out, LOCK_FILE));
            await runCli(root, ['doc', 'pull', 'docs', out, '-y'], { code: 0, stdout: pulledStdout(out, WITH_N), stderr: '' });

            expect(fs.readFileSync(path.join(out, 'n.md'), 'utf8')).toBe('N1');
            expect(fs.readFileSync(path.join(out, 'a.md'), 'utf8')).toBe('A2');
            expect(manifestDocs()['n.md']).toEqual({ id: 9, title: 'n', current_revision_id: 1, media: false, body_sha256: sha256('N1') });
            expect(internals()).toEqual([]);
        });
    });

    describe('what a rename replaces', () => {
        it('replaces a hard-linked tracked file by a new inode, so the other name keeps the old bytes (cli#188)', async () => {
            const other = path.join(root, 'outside.md');
            fs.linkSync(path.join(out, 'a.md'), other);

            await runCli(root, ['doc', 'pull', 'docs', out, '-y'], { code: 0, stdout: pulledStdout(out, TRIO), stderr: '' });

            expect(fs.readFileSync(path.join(out, 'a.md'), 'utf8')).toBe('A2');
            expect(fs.readFileSync(other, 'utf8')).toBe('A1');
        });

        it('keeps the permission bits of a replaced file', async () => {
            fs.chmodSync(path.join(out, 'a.md'), 0o600);

            await runCli(root, ['doc', 'pull', 'docs', out, '-y'], { code: 0, stdout: pulledStdout(out, TRIO), stderr: '' });

            expect(fs.readFileSync(path.join(out, 'a.md'), 'utf8')).toBe('A2');
            expect(fs.statSync(path.join(out, 'a.md')).mode & 0o7777).toBe(0o600);
        });
    });
});

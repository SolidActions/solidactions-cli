/**
 * `doc pull` never writes outside the destination or through a link (cli#169).
 *
 * A symbolic link in the destination (a file, a folder, or the path to a doc's
 * folder) used to be written through: the pull overwrote a file outside the
 * destination, created directories outside it, or crashed with an uncaught
 * ELOOP. Every case runs the built CLI (`node dist/index.js`) against a real
 * in-process HTTP server with a temp HOME and real files, and asserts the exit
 * status, stderr, and the bytes of EVERYTHING under the temp root (the
 * destination, the files outside it, and the manifest), so a refusal proves
 * that nothing was written, created or changed anywhere.
 */
import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');
const MANIFEST_FILE = '.solidactions-docs.json';

function sha256Hex(data: Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Server: serves whatever docs the current case puts in `served`.
// ---------------------------------------------------------------------------

interface ServedDoc {
    id: number;
    title: string;
    revision: number;
    /** Folder below `docs/`, e.g. `sub/deeper`; the root when absent. */
    relative?: string;
    /** Body for a markdown doc. */
    body?: Buffer;
    /** Media bytes, or 'fail' for a signed-URL download that answers 503. */
    media?: Buffer | 'fail';
}

let server: http.Server;
let port: number;
let served: ServedDoc[] = [];
/** When true the list answers folder_path_not_found so the pull takes the single-doc fallback. */
let singleForm = false;

function mcpResult(data: object, isError = false): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError, content: [{ type: 'text', text: JSON.stringify(data) }] } });
}

function mediaProps(doc: ServedDoc): Record<string, unknown> {
    return doc.media === undefined ? {} : { blob_sha: `sha-${doc.id}`, mime: 'image/png', size: 4 };
}

function bodyOf(doc: ServedDoc): string {
    return doc.media === undefined ? (doc.body ?? Buffer.alloc(0)).toString('utf8') : '';
}

function answerMcp(args: Record<string, any>): string {
    if (args.action === 'list' && singleForm) {
        return mcpResult({ code: 'folder_path_not_found', message: 'no such folder' }, true);
    }
    if (args.action === 'list') {
        const relative = String(args.folder_path).slice('docs'.length).replace(/^\//, '');
        const prefix = relative ? `${relative}/` : '';
        const folders = new Set(served
            .map((d) => d.relative ?? '')
            .filter((dir) => dir.startsWith(prefix) && dir !== relative)
            .map((dir) => dir.slice(prefix.length).split('/')[0]));
        return mcpResult({
            folders: [...folders].map((name) => ({ name, folder_path: `docs/${prefix}${name}` })),
            docs: served.filter((d) => (d.relative ?? '') === relative)
                .map((d) => ({ id: d.id, title: d.title, doc_type: null })),
        });
    }
    if (args.action === 'read_doc' && args.id === undefined) {
        // Single-doc fallback lookup by path title. Reads by id (the
        // doc-type backfill) keep the legacy unexpected-error below so the
        // warning path stays covered.
        const title = args.path?.title;
        const d = served.find((doc) => doc.title === title);
        if (!d) return mcpResult({ code: 'doc_not_found', message: 'no such doc' }, true);
        return mcpResult({
            id: d.id, title: d.title, folder_path: 'docs', body: bodyOf(d), current_revision_id: d.revision,
            properties: mediaProps(d),
        });
    }
    if (args.action === 'bulk_read') {
        const ids: number[] = (args.items ?? []).map((item: { id: number }) => item.id);
        return mcpResult({
            results: ids.map((id, index) => {
                const d = served.find((doc) => doc.id === id)!;
                return { index, status: 'found', id, title: d.title, current_revision_id: d.revision, properties: mediaProps(d), body: bodyOf(d) };
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
                if (!d || d.media === undefined || d.media === 'fail') {
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

interface CliResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

/** Run `doc pull` with arbitrary args through the built CLI with a temp HOME pointing at the server. */
function runPullArgs(root: string, args: string[]): Promise<CliResult> {
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    writeGlobal(home, { host: `http://127.0.0.1:${port}`, apiKey: 'test-api-key', workspaceId: 'ws-test-uuid' });
    return new Promise<CliResult>((resolve, reject) => {
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
        delete env.SOLIDACTIONS_HOST;
        delete env.SOLIDACTIONS_API_KEY;
        delete env.SOLIDACTIONS_WORKSPACE_ID;
        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`CLI timed out. stdout: ${stdout} stderr: ${stderr}`));
        }, 30_000);
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

/** Run `doc pull docs <dest>` through the built CLI with a temp HOME pointing at the server. */
function runPull(root: string, dest: string, overwrite: boolean): Promise<CliResult> {
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    writeGlobal(home, { host: `http://127.0.0.1:${port}`, apiKey: 'test-api-key', workspaceId: 'ws-test-uuid' });
    return new Promise<CliResult>((resolve, reject) => {
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
        delete env.SOLIDACTIONS_HOST;
        delete env.SOLIDACTIONS_API_KEY;
        delete env.SOLIDACTIONS_WORKSPACE_ID;
        const args = ['doc', 'pull', 'docs', dest, overwrite ? '--overwrite' : '--yes'];
        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], { cwd: root, env });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`CLI timed out. stdout: ${stdout} stderr: ${stderr}`));
        }, 30_000);
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOTE_BYTES = Buffer.from('# note from the server');
const DEEP_BYTES = Buffer.from('# deep from the server');
const PIC_BYTES = Buffer.from([1, 2, 3, 4]);
const OUTSIDE_BYTES = Buffer.from('OUTSIDE FILE, NOT OURS');

const NOTE: ServedDoc = { id: 1, title: 'Note', revision: 10, body: NOTE_BYTES };
const PIC: ServedDoc = { id: 2, title: 'pic.png', revision: 11, media: PIC_BYTES };
const DEEP: ServedDoc = { id: 3, title: 'Deep', revision: 12, relative: 'sub/deeper', body: DEEP_BYTES };

type Entry = Buffer | string;

/** Everything under `dir`, links NOT followed: files as bytes, directories as 'dir', links by target. */
function snapshot(dir: string, prefix = ''): Record<string, Entry> {
    const out: Record<string, Entry> = {};
    for (const name of fs.readdirSync(dir).sort()) {
        const abs = path.join(dir, name);
        const rel = prefix === '' ? name : `${prefix}/${name}`;
        const stat = fs.lstatSync(abs);
        if (stat.isSymbolicLink()) out[rel] = `symlink:${fs.readlinkSync(abs)}`;
        else if (stat.isDirectory()) {
            out[rel] = 'dir';
            Object.assign(out, snapshot(abs, rel));
        } else out[rel] = fs.readFileSync(abs);
    }
    return out;
}

/** What the home directory the runner creates adds; excluded so snapshots compare the world the case set up. */
function world(root: string): Record<string, Entry> {
    return Object.fromEntries(Object.entries(snapshot(root)).filter(([rel]) => rel !== 'home' && !rel.startsWith('home/')));
}

function manifestOf(entries: Array<{ rel: string; doc: ServedDoc; bytes: Buffer }>): string {
    const docs: Record<string, object> = {};
    for (const { rel, doc, bytes } of entries) {
        docs[rel] = { id: doc.id, title: doc.title, current_revision_id: doc.revision, media: doc.media !== undefined, body_sha256: sha256Hex(bytes) };
    }
    return `${JSON.stringify({ folder_path: 'docs', docs }, null, 2)}\n`;
}

describe('doc pull never writes outside the destination or through a link (cli#169)', () => {
    let root: string;
    let dest: string;
    let outside: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pull-safety-'));
        dest = path.join(root, 'out');
        outside = path.join(root, 'elsewhere');
        fs.mkdirSync(dest);
        fs.mkdirSync(outside);
        served = [NOTE, PIC, DEEP];
        singleForm = false;
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    /** Expect a refusal: exit 1, the message, and not one byte changed anywhere under the root. */
    async function expectRefusal(overwrite: boolean, messages: RegExp[]): Promise<void> {
        const before = world(root);

        const result = await runPull(root, dest, overwrite);

        expect(result.stderr).not.toMatch(/\n\s+at /);
        expect(result.code).toBe(1);
        for (const message of messages) {
            expect(result.stderr).toMatch(message);
        }
        expect(result.stdout).not.toContain('pulled');
        expect(world(root)).toEqual(before);
    }

    describe.each([false, true])('with overwrite=%s', (overwrite) => {
        it('refuses a file that is a symlink to a file outside the destination', async () => {
            fs.writeFileSync(path.join(outside, 'target.txt'), OUTSIDE_BYTES);
            fs.symlinkSync(path.join(outside, 'target.txt'), path.join(dest, 'Note.md'));

            await expectRefusal(overwrite, [/Note\.md is a symbolic link; this pull would write doc 1 \("Note"\) through it/]);

            expect(fs.readFileSync(path.join(outside, 'target.txt'))).toEqual(OUTSIDE_BYTES);
        });

        it('refuses a folder that is a symlink to a directory outside, creating nothing there', async () => {
            fs.symlinkSync(outside, path.join(dest, 'sub'));

            await expectRefusal(overwrite, [/sub\/deeper\/Deep\.md is a symbolic link \(or sits under one: sub\); this pull would write doc 3 \("Deep"\) through it/]);

            expect(fs.existsSync(path.join(outside, 'deeper'))).toBe(false);
        });

        it('refuses a symlink that points at another file inside the destination', async () => {
            fs.writeFileSync(path.join(dest, 'other.md'), 'other local file');
            fs.symlinkSync('other.md', path.join(dest, 'Note.md'));

            await expectRefusal(overwrite, [/Note\.md is a symbolic link/]);

            expect(fs.readFileSync(path.join(dest, 'other.md'), 'utf8')).toBe('other local file');
        });

        it('refuses a tracked doc at an unchanged path whose file was replaced by a symlink', async () => {
            fs.writeFileSync(path.join(outside, 'target.txt'), OUTSIDE_BYTES);
            fs.writeFileSync(path.join(dest, MANIFEST_FILE), manifestOf([{ rel: 'Note.md', doc: NOTE, bytes: NOTE_BYTES }]));
            fs.symlinkSync(path.join(outside, 'target.txt'), path.join(dest, 'Note.md'));

            await expectRefusal(overwrite, [/Note\.md is a symbolic link; this pull would write doc 1/]);

            expect(fs.readFileSync(path.join(outside, 'target.txt'))).toEqual(OUTSIDE_BYTES);
        });
    });

    it('pulls into a destination that is itself a symlink to a real directory', async () => {
        const real = path.join(root, 'real');
        fs.rmdirSync(dest);
        fs.mkdirSync(real);
        fs.symlinkSync(real, dest);

        const result = await runPull(root, dest, false);

        expect(result.code).toBe(0);
        expect(fs.readFileSync(path.join(real, 'Note.md'))).toEqual(NOTE_BYTES);
        expect(fs.readFileSync(path.join(real, 'pic.png'))).toEqual(PIC_BYTES);
        expect(fs.readFileSync(path.join(real, 'sub', 'deeper', 'Deep.md'))).toEqual(DEEP_BYTES);
        expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);
    });

    it('pulls into a destination that does not exist yet when its parent is a symlink to a real directory', async () => {
        const realParent = path.join(root, 'realparent');
        fs.mkdirSync(realParent);
        fs.symlinkSync(realParent, path.join(root, 'parentlink'));
        fs.rmdirSync(dest);
        const through = path.join(root, 'parentlink', 'out');

        const result = await runPull(root, through, false);

        expect(result.code).toBe(0);
        expect(fs.readFileSync(path.join(realParent, 'out', 'Note.md'))).toEqual(NOTE_BYTES);
        expect(fs.readFileSync(path.join(realParent, 'out', 'sub', 'deeper', 'Deep.md'))).toEqual(DEEP_BYTES);
    });

    it.each([false, true])('refuses a failed media download planned under a folder symlink, creating no directory outside (overwrite=%s)', async (overwrite) => {
        const failing: ServedDoc = { id: 2, title: 'pic.png', revision: 11, relative: 'sub/deeper', media: 'fail' };
        served = [NOTE, failing];
        fs.symlinkSync(outside, path.join(dest, 'sub'));

        await expectRefusal(overwrite, [/sub\/deeper\/pic\.png is a symbolic link \(or sits under one: sub\); this pull would write doc 2 \("pic\.png"\) through it/]);

        expect(fs.existsSync(path.join(outside, 'deeper'))).toBe(false);
    });

    describe('-y never overwrites bytes it does not own (cli#167)', () => {
        const OLD5 = Buffer.from('# five v1');
        const NEW5 = Buffer.from('# five v2');
        const NEW6B = Buffer.from('# six v2');
        const COMMON = Buffer.from('# common old bytes');
        const UNRELATED = Buffer.from('unrelated local file');

        function seedManifest(entries: Array<{ rel: string; doc: ServedDoc; bytes: Buffer }>): void {
            fs.writeFileSync(path.join(dest, MANIFEST_FILE), manifestOf(entries));
        }

        function manifestJson(): { folder_path: string; docs: Record<string, { id: number; current_revision_id: number; body_sha256: string; media: boolean }> } {
            return JSON.parse(fs.readFileSync(path.join(dest, MANIFEST_FILE), 'utf8'));
        }

        it('folder pull with -y refuses an untracked file at the planned path instead of silently replacing it', async () => {
            served = [
                { id: 5, title: 'Page', revision: 8, body: OLD5 },
                { id: 6, title: 'Page2', revision: 9, body: NEW6B },
            ];
            fs.writeFileSync(path.join(dest, 'page.md'), OLD5);
            fs.writeFileSync(path.join(dest, 'Page2.md'), UNRELATED);
            seedManifest([{ rel: 'page.md', doc: served[0], bytes: OLD5 }]);
            const before = world(root);

            const result = await runPull(root, dest, false);

            expect(result.code).toBe(1);
            expect(result.stderr).toMatch(/1 file exists locally but is not tracked:\n {2}Page2\.md\n/);
            expect(result.stderr).toMatch(/pass --overwrite to replace them/);
            expect(world(root)).toEqual(before);
        });

        it('single-doc pull with -y refuses an untracked file at the planned path instead of silently replacing it', async () => {
            singleForm = true;
            served = [{ id: 6, title: 'Page2', revision: 9, body: NEW6B }];
            fs.writeFileSync(path.join(dest, 'page.md'), OLD5);
            fs.writeFileSync(path.join(dest, 'Page2.md'), UNRELATED);
            seedManifest([{ rel: 'page.md', doc: { id: 5, title: 'Page', revision: 8, body: OLD5 }, bytes: OLD5 }]);
            const before = world(root);

            const result = await runPullArgs(root, ['doc', 'pull', 'docs/Page2', dest, '--yes']);

            expect(result.code).toBe(1);
            expect(result.stderr).toMatch(/1 file exists locally but is not tracked:\n {2}Page2\.md\n/);
            expect(world(root)).toEqual(before);
        });

        it('adopts an untracked file that already holds exactly the pulled bytes', async () => {
            served = [
                { id: 5, title: 'Page', revision: 8, body: OLD5 },
                { id: 6, title: 'Page2', revision: 9, body: NEW6B },
            ];
            fs.writeFileSync(path.join(dest, 'page.md'), OLD5);
            fs.writeFileSync(path.join(dest, 'Page2.md'), NEW6B);
            seedManifest([{ rel: 'page.md', doc: served[0], bytes: OLD5 }]);

            const result = await runPull(root, dest, false);

            expect(result.code).toBe(0);
            expect(fs.readFileSync(path.join(dest, 'Page2.md'))).toEqual(NEW6B);
            expect(manifestJson().docs['Page2.md'].id).toBe(6);
            expect(manifestJson().docs['Page2.md'].body_sha256).toBe(sha256Hex(NEW6B));
        });

        it('a same-file case-only rename adopts instead of refusing, with no --overwrite', async () => {
            served = [{ id: 5, title: 'page', revision: 9, body: NEW5 }];
            fs.writeFileSync(path.join(dest, 'Page.md'), OLD5);
            fs.linkSync(path.join(dest, 'Page.md'), path.join(dest, 'page.md'));
            seedManifest([{ rel: 'Page.md', doc: { id: 5, title: 'Page', revision: 8, body: OLD5 }, bytes: OLD5 }]);

            const result = await runPull(root, dest, false);

            expect(result.code).toBe(0);
            expect(fs.readFileSync(path.join(dest, 'Page.md'))).toEqual(NEW5);
            expect(fs.readFileSync(path.join(dest, 'page.md'))).toEqual(NEW5);
            expect(Object.keys(manifestJson().docs)).toEqual(['page.md']);
            expect(result.stderr).not.toMatch(/not tracked/);
            expect(result.stderr).not.toMatch(/kept .*same file/);
        });

        it('a cross-alias hard link under --overwrite keeps both old paths with a warning naming the written path', async () => {
            const COMMON_B = Buffer.from('# other old bytes');
            served = [
                { id: 5, title: 'new5', revision: 9, body: NEW5 },
                { id: 6, title: 'new6', revision: 10, body: NEW6B },
            ];
            fs.writeFileSync(path.join(dest, 'page.md'), COMMON);
            fs.writeFileSync(path.join(dest, 'other.md'), COMMON_B);
            fs.linkSync(path.join(dest, 'other.md'), path.join(dest, 'new5.md'));
            fs.linkSync(path.join(dest, 'page.md'), path.join(dest, 'new6.md'));
            seedManifest([
                { rel: 'page.md', doc: { id: 5, title: 'Page', revision: 8, body: COMMON }, bytes: COMMON },
                { rel: 'other.md', doc: { id: 6, title: 'Other', revision: 9, body: COMMON_B }, bytes: COMMON_B },
            ]);

            const result = await runPull(root, dest, true);

            expect(result.code).toBe(0);
            expect(result.stderr).toMatch(/! kept page\.md: it is the same file as new6\.md \(a link\)/);
            expect(result.stderr).toMatch(/! kept other\.md: it is the same file as new5\.md \(a link\)/);
            expect(fs.readFileSync(path.join(dest, 'new5.md'))).toEqual(NEW5);
            expect(fs.readFileSync(path.join(dest, 'new6.md'))).toEqual(NEW6B);
            expect(fs.readFileSync(path.join(dest, 'page.md'))).toEqual(NEW6B);
            expect(fs.readFileSync(path.join(dest, 'other.md'))).toEqual(NEW5);
            const docs = manifestJson().docs;
            expect(Object.keys(docs).sort()).toEqual(['new5.md', 'new6.md']);
            expect(docs['new5.md'].id).toBe(5);
            expect(docs['new6.md'].id).toBe(6);
            expect(docs['new5.md'].body_sha256).toBe(sha256Hex(NEW5));
            expect(docs['new6.md'].body_sha256).toBe(sha256Hex(NEW6B));
        });

        it('refuses a manifest sidecar that is a symbolic link, with or without --overwrite, changing nothing', async () => {
            served = [NOTE];
            fs.writeFileSync(path.join(dest, 'Note.md'), NOTE_BYTES);
            const seedOutside = path.join(outside, 'seed.json');
            fs.writeFileSync(seedOutside, manifestOf([{ rel: 'Note.md', doc: NOTE, bytes: NOTE_BYTES }]));
            fs.symlinkSync(seedOutside, path.join(dest, MANIFEST_FILE));
            const before = world(root);

            const plain = await runPull(root, dest, false);
            const overwriting = await runPull(root, dest, true);

            for (const result of [plain, overwriting]) {
                expect(result.code).toBe(1);
                expect(result.stderr).toMatch(/\.solidactions-docs\.json is a symbolic link; this pull would write the docs manifest through it/);
            }
            expect(world(root)).toEqual(before);
        });

        describe('first pull and untracked bytes', () => {
            const LOCAL = Buffer.from('# local bytes the server never sent');

            beforeEach(() => {
                served = [NOTE];
            });

            it('refuses an untracked file with different bytes even with -y, writing no manifest', async () => {
                fs.writeFileSync(path.join(dest, 'Note.md'), LOCAL);
                const before = world(root);

                const result = await runPull(root, dest, false);

                expect(result.code).toBe(1);
                expect(result.stderr).toContain('1 file exists locally but is not tracked:\n  Note.md\n');
                expect(result.stderr).toContain('Move them aside and pull again, or pass --overwrite to replace them.');
                expect(world(root)).toEqual(before);
                expect(fs.existsSync(path.join(dest, MANIFEST_FILE))).toBe(false);
            });

            it('replaces the untracked file with the server bytes under --overwrite', async () => {
                fs.writeFileSync(path.join(dest, 'Note.md'), LOCAL);

                const result = await runPull(root, dest, true);

                expect(result.code).toBe(0);
                expect(fs.readFileSync(path.join(dest, 'Note.md'))).toEqual(NOTE_BYTES);
            });

            it('adopts an untracked file that already holds exactly the server bytes, recording its hash', async () => {
                fs.writeFileSync(path.join(dest, 'Note.md'), NOTE_BYTES);

                const result = await runPull(root, dest, false);

                expect(result.code).toBe(0);
                expect(fs.readFileSync(path.join(dest, 'Note.md'))).toEqual(NOTE_BYTES);
                expect(manifestJson().docs['Note.md'].id).toBe(1);
                expect(manifestJson().docs['Note.md'].body_sha256).toBe(sha256Hex(NOTE_BYTES));
            });

            it('refuses a tracked entry with no recorded hash over a file with other bytes, without --overwrite', async () => {
                fs.writeFileSync(path.join(dest, 'Note.md'), LOCAL);
                const manifest = JSON.parse(manifestOf([{ rel: 'Note.md', doc: NOTE, bytes: NOTE_BYTES }]));
                manifest.docs['Note.md'].body_sha256 = null;
                fs.writeFileSync(path.join(dest, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
                const before = world(root);

                const result = await runPull(root, dest, false);

                expect(result.code).toBe(1);
                expect(result.stderr).toContain('1 file exists locally but is not tracked:\n  Note.md\n');
                expect(world(root)).toEqual(before);
            });

            it('does not track a failed media download over an untracked local file, and leaves the file alone', async () => {
                served = [{ id: 2, title: 'pic.png', revision: 11, media: 'fail' }];
                fs.writeFileSync(path.join(dest, 'pic.png'), LOCAL);

                const result = await runPull(root, dest, false);

                expect(result.code).toBe(0);
                expect(result.stderr).toContain('! doc 2 ("pic.png") failed to download and pic.png holds a local file; not tracking it');
                expect(fs.readFileSync(path.join(dest, 'pic.png'))).toEqual(LOCAL);
                expect(Object.keys(manifestJson().docs)).not.toContain('pic.png');
            });

            it('prints the prompt text naming the untracked-file refusal when the destination is not empty', async () => {
                fs.writeFileSync(path.join(dest, 'Note.md'), NOTE_BYTES);

                const result = await runPullArgs(root, ['doc', 'pull', 'docs', dest]);

                expect(result.stdout).toContain("Pulling overwrites tracked files; local files the folder doesn't track are refused unless --overwrite.");
            });
        });
    });

    describe('an existing target that cannot be read is not owned (cli#167)', () => {
        const LOCAL = Buffer.from('# local bytes in a write-only file');
        const isRoot = process.getuid?.() === 0; // root reads mode-0200 files, so nothing is unreadable to it

        function manifestJson(): { docs: Record<string, { id: number; body_sha256: string | null }> } {
            return JSON.parse(fs.readFileSync(path.join(dest, MANIFEST_FILE), 'utf8'));
        }

        /** A write-only file: the pull can replace it but never read it. */
        function writeOnly(rel: string): void {
            fs.writeFileSync(path.join(dest, rel), LOCAL);
            fs.chmodSync(path.join(dest, rel), 0o200);
        }

        function bytesAfter(rel: string): Buffer {
            fs.chmodSync(path.join(dest, rel), 0o600);
            return fs.readFileSync(path.join(dest, rel));
        }

        beforeEach(() => {
            served = [NOTE];
        });

        it.skipIf(isRoot)('a first pull with -y refuses a write-only untracked file, naming the read error, leaving the bytes and writing no manifest', async () => {
            writeOnly('Note.md');

            const result = await runPull(root, dest, false);

            expect(result.code).toBe(1);
            expect(result.stderr).toContain('1 file exists locally but is not tracked:\n  Note.md (cannot be read: EACCES)\n');
            expect(result.stderr).toContain('Move them aside and pull again, or pass --overwrite to replace them.');
            expect(result.stdout).not.toContain('pulled');
            expect(bytesAfter('Note.md')).toEqual(LOCAL);
            expect(fs.existsSync(path.join(dest, MANIFEST_FILE))).toBe(false);
        });

        it.skipIf(isRoot)('refuses a tracked entry with no recorded hash over a write-only file, leaving the bytes', async () => {
            writeOnly('Note.md');
            const manifest = JSON.parse(manifestOf([{ rel: 'Note.md', doc: NOTE, bytes: NOTE_BYTES }]));
            manifest.docs['Note.md'].body_sha256 = null;
            const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
            fs.writeFileSync(path.join(dest, MANIFEST_FILE), manifestText);

            const result = await runPull(root, dest, false);

            expect(result.code).toBe(1);
            expect(result.stderr).toContain('1 file exists locally but is not tracked:\n  Note.md (cannot be read: EACCES)\n');
            expect(bytesAfter('Note.md')).toEqual(LOCAL);
            expect(fs.readFileSync(path.join(dest, MANIFEST_FILE), 'utf8')).toBe(manifestText);
        });

        it.skipIf(isRoot)('refuses a rename whose target is a write-only file, leaving the bytes, the old file and the manifest', async () => {
            const OLD = Buffer.from('# page v1');
            served = [{ id: 5, title: 'Renamed', revision: 9, body: Buffer.from('# page v2') }];
            fs.writeFileSync(path.join(dest, 'Page.md'), OLD);
            writeOnly('Renamed.md');
            const manifestText = manifestOf([{ rel: 'Page.md', doc: { id: 5, title: 'Page', revision: 8, body: OLD }, bytes: OLD }]);
            fs.writeFileSync(path.join(dest, MANIFEST_FILE), manifestText);

            const result = await runPull(root, dest, false);

            expect(result.code).toBe(1);
            expect(result.stderr).toMatch(/Renamed\.md exists locally but is not tracked/);
            expect(bytesAfter('Renamed.md')).toEqual(LOCAL);
            expect(fs.readFileSync(path.join(dest, 'Page.md'))).toEqual(OLD);
            expect(fs.readFileSync(path.join(dest, MANIFEST_FILE), 'utf8')).toBe(manifestText);
        });

        it.skipIf(isRoot)('replaces a write-only file under --overwrite', async () => {
            writeOnly('Note.md');

            const result = await runPull(root, dest, true);

            expect(result.code).toBe(0);
            expect(bytesAfter('Note.md')).toEqual(NOTE_BYTES);
            expect(manifestJson().docs['Note.md'].body_sha256).toBe(sha256Hex(NOTE_BYTES));
        });
    });

    describe('a self-referential symlink', () => {
        it('is refused as a symbolic link when there is no previous manifest', async () => {
            fs.symlinkSync('Note.md', path.join(dest, 'Note.md'));

            await expectRefusal(false, [/Note\.md is a symbolic link; this pull would write doc 1 \("Note"\) through it/]);
        });

        it('is refused as a symbolic link when a previous manifest exists', async () => {
            const first = await runPull(root, dest, false);
            expect(first.code).toBe(0);
            fs.rmSync(path.join(dest, 'Note.md'));
            fs.symlinkSync('Note.md', path.join(dest, 'Note.md'));

            await expectRefusal(false, [/Note\.md is a symbolic link; this pull would write doc 1 \("Note"\) through it/]);
        });

        it('in the old path of a failed renamed-media download gets the one-line ELOOP message (ruling 10)', async () => {
            const renamed: ServedDoc = { id: 2, title: 'pic2.png', revision: 12, media: 'fail' };
            served = [renamed];
            fs.writeFileSync(path.join(dest, MANIFEST_FILE), manifestOf([{ rel: 'pic.png', doc: PIC, bytes: PIC_BYTES }]));
            fs.symlinkSync('pic.png', path.join(dest, 'pic.png'));

            await expectRefusal(false, [/cannot resolve pic\.png: too many symbolic links \(ELOOP\)/]);
        });

        it('as the destination itself gets the one-line ELOOP message, no stack trace, nothing written', async () => {
            const loop = path.join(root, 'loop');
            fs.symlinkSync('loop', loop);
            const before = world(root);

            const result = await runPull(root, loop, false);

            expect(result.stderr).not.toMatch(/\n\s+at /);
            expect(result.code).toBe(1);
            expect(result.stderr.trim().split('\n')).toEqual([
                `error: cannot resolve ${loop}: too many symbolic links (ELOOP). Fix or remove the link and pull again.`,
            ]);
            expect(result.stdout).not.toContain('pulled');
            expect(world(root)).toEqual(before);
        });
    });
});

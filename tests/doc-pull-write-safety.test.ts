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

    it('refuses a failed media download planned under a folder symlink, creating no directory outside', async () => {
        const failing: ServedDoc = { id: 2, title: 'pic.png', revision: 11, relative: 'sub/deeper', media: 'fail' };
        served = [NOTE, failing];
        fs.symlinkSync(outside, path.join(dest, 'sub'));

        await expectRefusal(false, [/sub\/deeper\/pic\.png is a symbolic link \(or sits under one: sub\); this pull would write doc 2 \("pic\.png"\) through it/]);

        expect(fs.existsSync(path.join(outside, 'deeper'))).toBe(false);
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
    });
});

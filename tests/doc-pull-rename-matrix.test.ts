/**
 * The `doc pull` rename matrix (cli#157, final review 3 FR3-C1).
 *
 * One real-process test per rename path: the built CLI (`node dist/index.js`)
 * against a real in-process HTTP server, a temp HOME and a temp destination
 * with real files. A doc the previous manifest tracks under a different path
 * than this pull plans is a rename; every case must end in one of:
 *
 *   (a) the old file is removed only after its replacement was written;
 *   (b) the old file and its tracking are kept;
 *   (c) the pull refuses before any write: nothing written, manifest unchanged.
 *
 * Each case asserts the bytes of every file in the destination, the whole
 * manifest (path -> id, revision, hash), the exit status, and the refusal
 * message when it refuses.
 */

import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    docType: 'visual' | 'canvas' | null;
    /** Body for a non-media doc. */
    body?: Buffer;
    /** Media bytes, or 'fail' for a signed-URL download that answers 503. */
    media?: Buffer | 'fail';
}

let server: http.Server;
let port: number;
let served: { form: 'folder' | 'single'; docs: ServedDoc[] } = { form: 'folder', docs: [] };

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
        if (served.form === 'single') return mcpResult({ code: 'folder_path_not_found', message: 'no such folder' }, true);
        return mcpResult({
            folders: [],
            docs: served.docs.map((d) => ({ id: d.id, title: d.title, doc_type: d.docType === null ? null : { slug: d.docType } })),
        });
    }
    if (args.action === 'bulk_read') {
        const ids: number[] = (args.items ?? []).map((item: { id: number }) => item.id);
        return mcpResult({
            results: ids.map((id, index) => {
                const d = served.docs.find((doc) => doc.id === id)!;
                return { index, status: 'found', id, title: d.title, current_revision_id: d.revision, properties: mediaProps(d), body: bodyOf(d) };
            }),
        });
    }
    if (args.action === 'read_doc') {
        const d = served.docs[0];
        return mcpResult({
            id: d.id, title: d.title, folder_path: 'docs', body: bodyOf(d), current_revision_id: d.revision,
            properties: mediaProps(d), doc_type: d.docType === null ? null : { slug: d.docType },
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
                const d = served.docs.find((doc) => doc.id === Number(mediaConfirm[1]));
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
                const d = served.docs.find((doc) => doc.id === Number(blob[1]));
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

/** Run `doc pull` through the built CLI with a temp HOME pointing at the server. */
async function runPull(args: string[]): Promise<CliResult> {
    const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pull-matrix-home-'));
    const home = path.join(homeRoot, 'home');
    fs.mkdirSync(home, { recursive: true });
    writeGlobal(home, { host: `http://127.0.0.1:${port}`, apiKey: 'test-api-key', workspaceId: 'ws-test-uuid' });
    try {
        return await new Promise<CliResult>((resolve, reject) => {
            const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
            delete env.SOLIDACTIONS_HOST;
            delete env.SOLIDACTIONS_API_KEY;
            delete env.SOLIDACTIONS_WORKSPACE_ID;
            const child = childProcess.spawn(process.execPath, [CLI_BINARY, 'doc', 'pull', ...args], { cwd: homeRoot, env });
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
    } finally {
        fs.rmSync(homeRoot, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------
// Fixtures: the three rename kinds and the docs a case can add around them.
// ---------------------------------------------------------------------------

interface TrackedFile {
    id: number;
    title: string;
    revision: number;
    media: boolean;
    bytes: Buffer;
}

interface Kind {
    label: string;
    media: boolean;
    /** Doc 5's tracked path before the pull, and the path this pull plans for it. */
    oldRel: string;
    newRel: string;
    /** Where a single-doc pull puts doc 5 when doc 9 still tracks newRel. */
    suffixedRel: string;
    oldTitle: string;
    oldBytes: Buffer;
    editedBytes: Buffer;
    renamed: (media?: Buffer | 'fail') => ServedDoc;
    /** Doc 6: a different doc that this pull places at oldRel. */
    reuser: (media?: Buffer | 'fail') => ServedDoc;
    /** Doc 9: tracked at newRel before the pull; this pull moves it to movedRel. */
    targetTitle: string;
    targetOldBytes: Buffer;
    movedRel: string;
    mover: (media?: Buffer | 'fail') => ServedDoc;
}

const RENAMED_NEW_BYTES: Record<string, Buffer> = {
    visual: Buffer.from('<h1>five v2</h1>'),
    canvas: Buffer.from('{"nodes":[{"id":"five-v2"}]}'),
    media: Buffer.from([5, 5, 5, 5]),
};
const REUSER_BYTES: Record<string, Buffer> = {
    visual: Buffer.from('# six'),
    canvas: Buffer.from('# six'),
    media: Buffer.from([6, 6, 6, 6]),
};
const MOVER_NEW_BYTES: Record<string, Buffer> = {
    visual: Buffer.from('<h1>nine v2</h1>'),
    canvas: Buffer.from('{"nodes":[{"id":"nine-v2"}]}'),
    media: Buffer.from([9, 9, 9, 2]),
};
const UNTRACKED_BYTES = Buffer.from('UNTRACKED LOCAL FILE');

function typedKind(slug: 'visual' | 'canvas', ext: string): Kind {
    return {
        label: `markdown -> ${ext} (${slug})`,
        media: false,
        oldRel: 'page.md',
        newRel: `page${ext}`,
        suffixedRel: `page-2${ext}`,
        oldTitle: 'page',
        oldBytes: Buffer.from('# five v1'),
        editedBytes: Buffer.from('# five v1 EDITED'),
        renamed: () => ({ id: 5, title: 'page', revision: 8, docType: slug, body: RENAMED_NEW_BYTES[slug] }),
        reuser: () => ({ id: 6, title: 'page', revision: 60, docType: null, body: REUSER_BYTES[slug] }),
        targetTitle: 'page',
        targetOldBytes: Buffer.from(`nine v1 ${slug}`),
        movedRel: `moved${ext}`,
        mover: () => ({ id: 9, title: 'moved', revision: 91, docType: slug, body: MOVER_NEW_BYTES[slug] }),
    };
}

const MEDIA_KIND: Kind = {
    label: 'media old.png -> new.png',
    media: true,
    oldRel: 'old.png',
    newRel: 'new.png',
    suffixedRel: 'new-2.png',
    oldTitle: 'old.png',
    oldBytes: Buffer.from([5, 5, 5, 1]),
    editedBytes: Buffer.from([5, 5, 5, 0xee]),
    renamed: (media = RENAMED_NEW_BYTES.media) => ({ id: 5, title: 'new.png', revision: 8, docType: null, media }),
    reuser: (media = REUSER_BYTES.media) => ({ id: 6, title: 'old.png', revision: 60, docType: null, media }),
    targetTitle: 'new.png',
    targetOldBytes: Buffer.from([9, 9, 9, 1]),
    movedRel: 'moved.png',
    mover: (media = MOVER_NEW_BYTES.media) => ({ id: 9, title: 'moved.png', revision: 91, docType: null, media }),
};

const KINDS: Kind[] = [typedKind('visual', '.html'), typedKind('canvas', '.canvas.json'), MEDIA_KIND];

/** The bytes a served doc writes to disk. */
function servedBytes(doc: ServedDoc): Buffer {
    return doc.media instanceof Buffer ? doc.media : (doc.body as Buffer);
}

function newBytesOf(kind: Kind): Buffer {
    return servedBytes(kind.renamed());
}

/** An earlier, successful rename in the same folder pull: doc 4 early.md -> early.html. */
const EARLY_OLD = Buffer.from('# four v1');
const EARLY_NEW = Buffer.from('<h1>four v2</h1>');
const EARLY_TRACKED: TrackedFile = { id: 4, title: 'early', revision: 40, media: false, bytes: EARLY_OLD };
const EARLY_SERVED: ServedDoc = { id: 4, title: 'early', revision: 41, docType: 'visual', body: EARLY_NEW };

// ---------------------------------------------------------------------------
// A case: the destination before the pull, what the server serves, the flags,
// and the destination expected after it.
// ---------------------------------------------------------------------------

interface ManifestExpectation {
    id: number;
    current_revision_id: number | null;
    body_sha256: string | null;
}

interface MatrixCase {
    name: string;
    outcome: 'a' | 'b' | 'c';
    form: 'folder' | 'single';
    overwrite: boolean;
    /** Tracked files (path -> tracked doc and the bytes on disk). The manifest hash is of `hashOf` when given, else of `bytes`. */
    tracked: Record<string, TrackedFile & { hashOf?: Buffer }>;
    /** Untracked local files (path -> bytes) or directories (path -> 'dir'). */
    untracked?: Record<string, Buffer | 'dir'>;
    served: ServedDoc[];
    /** Expected files after a non-refused pull, and the expected manifest. Omitted for (c). */
    after?: { files: Record<string, Buffer>; manifest: Record<string, ManifestExpectation> };
    /** Expected refusal or warning text on stderr. */
    stderr?: RegExp[];
}

function tracked(kind: Kind, bytes: Buffer, hashOf: Buffer = kind.oldBytes): TrackedFile & { hashOf: Buffer } {
    return { id: 5, title: kind.oldTitle, revision: 7, media: kind.media, bytes, hashOf };
}

function targetTracked(kind: Kind, bytes: Buffer = kind.targetOldBytes): TrackedFile & { hashOf: Buffer } {
    return { id: 9, title: kind.targetTitle, revision: 90, media: kind.media, bytes, hashOf: kind.targetOldBytes };
}

function entry(id: number, revision: number, bytes: Buffer | null): ManifestExpectation {
    return { id, current_revision_id: revision, body_sha256: bytes === null ? null : sha256Hex(bytes) };
}

function caseName(kind: Kind, form: 'folder' | 'single', text: string, overwrite: boolean): string {
    return `${form} pull, ${kind.label}: ${text}, ${overwrite ? '--overwrite' : 'no --overwrite'}`;
}

function kindCases(kind: Kind): MatrixCase[] {
    const cases: MatrixCase[] = [];
    const newBytes = newBytesOf(kind);
    const { oldRel, newRel } = kind;

    for (const overwrite of [false, true]) {
        // Folder pull --------------------------------------------------------
        cases.push({
            name: caseName(kind, 'folder', 'unmodified source, free target, old path not reused', overwrite),
            outcome: 'a', form: 'folder', overwrite,
            tracked: { [oldRel]: tracked(kind, kind.oldBytes) },
            served: [kind.renamed()],
            after: { files: { [newRel]: newBytes }, manifest: { [newRel]: entry(5, 8, newBytes) } },
        });
        cases.push({
            name: caseName(kind, 'folder', 'modified source, free target, old path not reused', overwrite),
            outcome: overwrite ? 'b' : 'c', form: 'folder', overwrite,
            tracked: { [oldRel]: tracked(kind, kind.editedBytes) },
            served: [kind.renamed()],
            ...(overwrite
                ? {
                    // Ruled (cli#157 issuecomment-5962166707): the edited bytes stay, untracked.
                    after: { files: { [oldRel]: kind.editedBytes, [newRel]: newBytes }, manifest: { [newRel]: entry(5, 8, newBytes) } },
                    stderr: [new RegExp(`kept ${escape(oldRel)}.*untracked`)],
                }
                : { stderr: [new RegExp(`rename ${escape(oldRel)} to ${escape(newRel)}`), /--overwrite/] }),
        });
        cases.push({
            name: caseName(kind, 'folder', 'unmodified source, free target, old path written by another doc', overwrite),
            outcome: 'a', form: 'folder', overwrite,
            tracked: { [oldRel]: tracked(kind, kind.oldBytes) },
            served: [kind.renamed(), kind.reuser()],
            after: {
                files: { [newRel]: newBytes, [oldRel]: servedBytes(kind.reuser()) },
                manifest: { [newRel]: entry(5, 8, newBytes), [oldRel]: entry(6, 60, servedBytes(kind.reuser())) },
            },
        });
        cases.push({
            name: caseName(kind, 'folder', 'modified source, old path written by another doc', overwrite),
            outcome: 'c', form: 'folder', overwrite,
            tracked: { [oldRel]: tracked(kind, kind.editedBytes) },
            served: [kind.renamed(), kind.reuser()],
            stderr: [/doc 5/, /doc 6/, new RegExp(escape(oldRel)), /push it first/],
        });
        cases.push({
            name: caseName(kind, 'folder', 'target taken by another tracked doc this pull moves away', overwrite),
            outcome: 'a', form: 'folder', overwrite,
            tracked: { [oldRel]: tracked(kind, kind.oldBytes), [newRel]: targetTracked(kind) },
            served: [kind.renamed(), kind.mover()],
            after: {
                files: { [newRel]: newBytes, [kind.movedRel]: servedBytes(kind.mover()) },
                manifest: { [newRel]: entry(5, 8, newBytes), [kind.movedRel]: entry(9, 91, servedBytes(kind.mover())) },
            },
        });
        cases.push({
            name: caseName(kind, 'folder', 'target taken by another tracked doc whose file is modified', overwrite),
            outcome: 'c', form: 'folder', overwrite,
            tracked: { [oldRel]: tracked(kind, kind.oldBytes), [newRel]: targetTracked(kind, Buffer.from('nine EDITED')) },
            served: [kind.renamed(), kind.mover()],
            stderr: [/doc 9/, /doc 5/, new RegExp(escape(newRel))],
        });
        cases.push({
            name: caseName(kind, 'folder', 'unmodified source, target taken by an untracked local file', overwrite),
            outcome: overwrite ? 'a' : 'c', form: 'folder', overwrite,
            tracked: { [oldRel]: tracked(kind, kind.oldBytes) },
            untracked: { [newRel]: UNTRACKED_BYTES },
            served: [kind.renamed()],
            ...(overwrite
                ? { after: { files: { [newRel]: newBytes }, manifest: { [newRel]: entry(5, 8, newBytes) } } }
                : { stderr: [new RegExp(`${escape(newRel)} exists locally but is not tracked`), /doc 5/, /--overwrite/] }),
        });
        cases.push({
            name: caseName(kind, 'folder', 'modified source, target taken by an untracked local file', overwrite),
            outcome: overwrite ? 'b' : 'c', form: 'folder', overwrite,
            tracked: { [oldRel]: tracked(kind, kind.editedBytes) },
            untracked: { [newRel]: UNTRACKED_BYTES },
            served: [kind.renamed()],
            ...(overwrite
                ? { after: { files: { [oldRel]: kind.editedBytes, [newRel]: newBytes }, manifest: { [newRel]: entry(5, 8, newBytes) } } }
                : { stderr: [new RegExp(escape(oldRel)), /--overwrite/] }),
        });

        // Single-doc pull ----------------------------------------------------
        cases.push({
            name: caseName(kind, 'single', 'unmodified source, free target', overwrite),
            outcome: 'a', form: 'single', overwrite,
            tracked: { [oldRel]: tracked(kind, kind.oldBytes) },
            served: [kind.renamed()],
            after: { files: { [newRel]: newBytes }, manifest: { [newRel]: entry(5, 8, newBytes) } },
        });
        cases.push({
            name: caseName(kind, 'single', 'modified source, free target', overwrite),
            outcome: overwrite ? 'b' : 'c', form: 'single', overwrite,
            tracked: { [oldRel]: tracked(kind, kind.editedBytes) },
            served: [kind.renamed()],
            ...(overwrite
                ? {
                    after: { files: { [oldRel]: kind.editedBytes, [newRel]: newBytes }, manifest: { [newRel]: entry(5, 8, newBytes) } },
                    stderr: [new RegExp(`kept ${escape(oldRel)}.*untracked`)],
                }
                : { stderr: [new RegExp(`rename ${escape(oldRel)} to ${escape(newRel)}`), /--overwrite/] }),
        });
        cases.push({
            name: caseName(kind, 'single', 'target taken by another tracked doc (not pulled)', overwrite),
            outcome: 'a', form: 'single', overwrite,
            tracked: { [oldRel]: tracked(kind, kind.oldBytes), [newRel]: targetTracked(kind) },
            served: [kind.renamed()],
            after: {
                files: { [newRel]: kind.targetOldBytes, [kind.suffixedRel]: newBytes },
                manifest: { [newRel]: entry(9, 90, kind.targetOldBytes), [kind.suffixedRel]: entry(5, 8, newBytes) },
            },
        });
        cases.push({
            name: caseName(kind, 'single', 'unmodified source, target taken by an untracked local file', overwrite),
            outcome: overwrite ? 'a' : 'c', form: 'single', overwrite,
            tracked: { [oldRel]: tracked(kind, kind.oldBytes) },
            untracked: { [newRel]: UNTRACKED_BYTES },
            served: [kind.renamed()],
            ...(overwrite
                ? { after: { files: { [newRel]: newBytes }, manifest: { [newRel]: entry(5, 8, newBytes) } } }
                : { stderr: [new RegExp(`${escape(newRel)} exists locally but is not tracked`), /--overwrite/] }),
        });
    }

    // A file this pull would write anyway (identical bytes, e.g. left by an
    // interrupted earlier pull) is not a loss: no refusal.
    cases.push({
        name: caseName(kind, 'folder', 'target holds an untracked file with the same bytes', false),
        outcome: 'a', form: 'folder', overwrite: false,
        tracked: { [oldRel]: tracked(kind, kind.oldBytes) },
        untracked: { [newRel]: newBytes },
        served: [kind.renamed()],
        after: { files: { [newRel]: newBytes }, manifest: { [newRel]: entry(5, 8, newBytes) } },
    });

    // A later rename's target is a directory: the refusal comes before the
    // earlier rename is written.
    cases.push({
        name: caseName(kind, 'folder', 'earlier rename succeeds, this rename\'s target is a directory', false),
        outcome: 'c', form: 'folder', overwrite: false,
        tracked: { 'early.md': EARLY_TRACKED, [oldRel]: tracked(kind, kind.oldBytes) },
        untracked: { [newRel]: 'dir' },
        served: [EARLY_SERVED, kind.renamed()],
        stderr: [new RegExp(`${escape(newRel)}" exists and is not a regular file`)],
    });

    return cases;
}

function escape(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The failed-download rows: doc 5's renamed media download answers 503. */
function failedMediaCases(): MatrixCase[] {
    const kind = MEDIA_KIND;
    const cases: MatrixCase[] = [];
    const keptOld = { 'old.png': entry(5, 7, kind.oldBytes) };

    for (const overwrite of [false, true]) {
        for (const form of ['folder', 'single'] as const) {
            cases.push({
                name: caseName(kind, form, 'download fails, unmodified source, free target', overwrite),
                outcome: 'b', form, overwrite,
                tracked: { 'old.png': tracked(kind, kind.oldBytes) },
                served: [kind.renamed('fail')],
                after: { files: { 'old.png': kind.oldBytes }, manifest: keptOld },
                stderr: [/failed to download media for doc 5/, /kept old\.png/],
            });
            cases.push({
                name: caseName(kind, form, 'download fails, modified source', overwrite),
                outcome: 'c', form, overwrite,
                tracked: { 'old.png': tracked(kind, kind.editedBytes) },
                served: [kind.renamed('fail')],
                stderr: [/old\.png holds unpublished edits for doc 5/, /download failed/, /pull again once the download succeeds/i],
            });
            cases.push({
                name: caseName(kind, form, 'download fails, target taken by an untracked local file', overwrite),
                outcome: 'b', form, overwrite,
                tracked: { 'old.png': tracked(kind, kind.oldBytes) },
                untracked: { 'new.png': UNTRACKED_BYTES },
                served: [kind.renamed('fail')],
                after: { files: { 'old.png': kind.oldBytes, 'new.png': UNTRACKED_BYTES }, manifest: keptOld },
            });
        }

        cases.push({
            name: caseName(kind, 'folder', 'download fails, old path written by another doc', overwrite),
            outcome: 'c', form: 'folder', overwrite,
            tracked: { 'old.png': tracked(kind, kind.oldBytes) },
            served: [kind.renamed('fail'), kind.reuser()],
            stderr: [/doc 5/, /doc 6/, /old\.png/, /new\.png/, /pull again once the download succeeds/i],
        });
        cases.push({
            name: caseName(kind, 'folder', 'download fails, old path claimed by another doc whose download also fails', overwrite),
            outcome: 'c', form: 'folder', overwrite,
            tracked: { 'old.png': tracked(kind, kind.oldBytes) },
            served: [kind.renamed('fail'), kind.reuser('fail')],
            stderr: [/doc 5/, /doc 6/, /pull again once the download succeeds/i],
        });
        cases.push({
            name: caseName(kind, 'folder', 'download fails, target tracked by another doc this pull moves away', overwrite),
            outcome: 'b', form: 'folder', overwrite,
            tracked: { 'old.png': tracked(kind, kind.oldBytes), 'new.png': targetTracked(kind) },
            served: [kind.renamed('fail'), kind.mover()],
            after: {
                files: { 'old.png': kind.oldBytes, 'moved.png': MOVER_NEW_BYTES.media },
                manifest: { ...keptOld, 'moved.png': entry(9, 91, MOVER_NEW_BYTES.media) },
            },
        });
        cases.push({
            name: caseName(kind, 'folder', 'the moved-away target doc\'s download fails while this rename takes its path', overwrite),
            outcome: 'c', form: 'folder', overwrite,
            tracked: { 'old.png': tracked(kind, kind.oldBytes), 'new.png': targetTracked(kind) },
            served: [kind.renamed(), kind.mover('fail')],
            stderr: [/doc 9/, /doc 5/, /new\.png/, /pull again once the download succeeds/i],
        });
        cases.push({
            name: caseName(kind, 'folder', 'an earlier rename succeeds, a later renamed download fails', overwrite),
            outcome: 'b', form: 'folder', overwrite,
            tracked: { 'early.md': EARLY_TRACKED, 'old.png': tracked(kind, kind.oldBytes) },
            served: [EARLY_SERVED, kind.renamed('fail')],
            after: {
                files: { 'early.html': EARLY_NEW, 'old.png': kind.oldBytes },
                manifest: { 'early.html': entry(4, 41, EARLY_NEW), ...keptOld },
            },
        });
        cases.push({
            name: caseName(kind, 'folder', 'an earlier rename succeeds, a later renamed download fails and its old path is written by another doc', overwrite),
            outcome: 'c', form: 'folder', overwrite,
            tracked: { 'early.md': EARLY_TRACKED, 'old.png': tracked(kind, kind.oldBytes) },
            served: [EARLY_SERVED, kind.renamed('fail'), kind.reuser()],
            stderr: [/doc 5/, /doc 6/, /pull again once the download succeeds/i],
        });
    }
    return cases;
}

const MATRIX: MatrixCase[] = [...KINDS.flatMap(kindCases), ...failedMediaCases()];

// ---------------------------------------------------------------------------
// Running and checking a case
// ---------------------------------------------------------------------------

function seed(dest: string, testCase: MatrixCase): { manifestText: string } {
    fs.mkdirSync(dest, { recursive: true });
    const docs: Record<string, object> = {};
    for (const [rel, file] of Object.entries(testCase.tracked)) {
        fs.writeFileSync(path.join(dest, rel), file.bytes);
        docs[rel] = { id: file.id, title: file.title, current_revision_id: file.revision, media: file.media, body_sha256: sha256Hex(file.hashOf ?? file.bytes) };
    }
    for (const [rel, content] of Object.entries(testCase.untracked ?? {})) {
        if (content === 'dir') fs.mkdirSync(path.join(dest, rel));
        else fs.writeFileSync(path.join(dest, rel), content);
    }
    const manifestText = `${JSON.stringify({ folder_path: 'docs', docs }, null, 2)}\n`;
    fs.writeFileSync(path.join(dest, MANIFEST_FILE), manifestText);
    return { manifestText };
}

/** Every entry in the destination except the manifest: files as bytes, directories as 'dir'. */
function snapshot(dest: string): Record<string, Buffer | 'dir'> {
    const out: Record<string, Buffer | 'dir'> = {};
    for (const name of fs.readdirSync(dest).sort()) {
        if (name === MANIFEST_FILE) continue;
        const abs = path.join(dest, name);
        out[name] = fs.statSync(abs).isDirectory() ? 'dir' : fs.readFileSync(abs);
    }
    return out;
}

function seededSnapshot(testCase: MatrixCase): Record<string, Buffer | 'dir'> {
    const out: Record<string, Buffer | 'dir'> = {};
    for (const [rel, file] of Object.entries(testCase.tracked)) out[rel] = file.bytes;
    for (const [rel, content] of Object.entries(testCase.untracked ?? {})) out[rel] = content;
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function pullArgs(testCase: MatrixCase, dest: string): string[] {
    const target = testCase.form === 'single' ? `docs/${testCase.served[0].title}` : 'docs';
    return [target, dest, testCase.overwrite ? '--overwrite' : '--yes'];
}

function expectStderr(result: CliResult, testCase: MatrixCase): void {
    for (const pattern of testCase.stderr ?? []) {
        expect(result.stderr).toMatch(pattern);
    }
}

describe('doc pull rename matrix (cli#157)', () => {
    it.each(MATRIX.map((c) => [`(${c.outcome}) ${c.name}`, c] as const))('%s', async (_label, testCase) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pull-matrix-'));
        const dest = path.join(root, 'out');
        try {
            const { manifestText } = seed(dest, testCase);
            served = { form: testCase.form, docs: testCase.served };

            const result = await runPull(pullArgs(testCase, dest));

            if (testCase.outcome === 'c') {
                expect(snapshot(dest)).toEqual(seededSnapshot(testCase));
                expect(fs.readFileSync(path.join(dest, MANIFEST_FILE), 'utf8')).toBe(manifestText);
                expect(result.code).toBe(1);
                expectStderr(result, testCase);
                return;
            }

            expect(result.code).toBe(0);
            const after = testCase.after!;
            const expectedFiles = Object.fromEntries(Object.entries(after.files).sort(([a], [b]) => a.localeCompare(b)));
            expect(snapshot(dest)).toEqual(expectedFiles);

            const manifest = JSON.parse(fs.readFileSync(path.join(dest, MANIFEST_FILE), 'utf8'));
            expect(manifest.folder_path).toBe('docs');
            const actual = Object.fromEntries(
                Object.entries(manifest.docs as Record<string, ManifestExpectation>).map(([rel, e]) => [rel, { id: e.id, current_revision_id: e.current_revision_id, body_sha256: e.body_sha256 }]),
            );
            expect(actual).toEqual(after.manifest);

            // Every tracked file's bytes match its recorded hash: no doc's
            // tracking sits on another doc's (or a stale) file.
            for (const [rel, e] of Object.entries(after.manifest)) {
                if (e.body_sha256 === null) continue;
                expect(sha256Hex(fs.readFileSync(path.join(dest, rel)))).toBe(e.body_sha256);
            }
            expectStderr(result, testCase);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

/**
 * The `doc pull` rename matrix (cli#157, final reviews 3–5: FR3-C1, FR4-C1, FR5-C1).
 *
 * One real-process test per rename path: the built CLI (`node dist/index.js`)
 * against a real in-process HTTP server, a temp HOME and a temp destination
 * with real files. A doc the previous manifest tracks under a different path
 * than this pull plans is a rename, whatever is on disk at the old path; every
 * case must end in one of:
 *
 *   (a) the old file is removed only after its replacement was written;
 *   (b) the old file and its tracking are kept;
 *   (c) the pull refuses before any write: nothing written, manifest unchanged.
 *
 * When the old file is absent there is nothing to keep or remove, and the
 * target rules alone decide. The cross product is source (unmodified /
 * modified / absent) x target (free / tracked by another doc / untracked with
 * different bytes / untracked with the same bytes) x --overwrite x folder or
 * single-doc pull, for every rename kind and for a failed media download.
 *
 * An edited rename source always refuses, even with --overwrite. Preserved
 * sources must not alias another doc's planned target. New allocations compare
 * names case-insensitively while tracked unchanged docs keep exact paths.
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
    relative?: string;
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
        const relative = String(args.folder_path).slice('docs'.length).replace(/^\//, '');
        const prefix = relative ? `${relative}/` : '';
        const folders = new Set(served.docs
            .map((d) => d.relative ?? '')
            .filter((dir) => dir.startsWith(prefix) && dir !== relative)
            .map((dir) => dir.slice(prefix.length).split('/')[0]));
        return mcpResult({
            folders: [...folders].map((name) => ({ name, folder_path: `docs/${prefix}${name}` })),
            docs: served.docs.filter((d) => (d.relative ?? '') === relative)
                .map((d) => ({ id: d.id, title: d.title, doc_type: d.docType === null ? null : { slug: d.docType } })),
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
// Fixtures: the rename kinds and the docs a case can add around them.
// ---------------------------------------------------------------------------

interface TrackedFile {
    id: number;
    title: string;
    revision: number;
    media: boolean;
    bytes: Buffer;
}

/**
 * What the seed leaves at a tracked path: the file (default), nothing, a
 * directory, or a symlink to another name in the destination.
 */
type SeedState = 'file' | 'absent' | 'dir' | { symlinkTo: string } | { hardlinkTo: string };

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
    caseOnly: Buffer.from('# five v2'),
};
const REUSER_BYTES: Record<string, Buffer> = {
    visual: Buffer.from('# six'),
    canvas: Buffer.from('# six'),
    media: Buffer.from([6, 6, 6, 6]),
    caseOnly: Buffer.from('# six'),
};
const MOVER_NEW_BYTES: Record<string, Buffer> = {
    visual: Buffer.from('<h1>nine v2</h1>'),
    canvas: Buffer.from('{"nodes":[{"id":"nine-v2"}]}'),
    media: Buffer.from([9, 9, 9, 2]),
    caseOnly: Buffer.from('# nine v2'),
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

/**
 * A case-only retitle, "Page" -> "page": on Linux `Page.md` and `page.md`
 * are distinct paths, so this pins the case-only path change as a rename.
 */
const CASE_KIND: Kind = {
    label: 'markdown Page.md -> page.md (case-only)',
    media: false,
    oldRel: 'Page.md',
    newRel: 'page.md',
    suffixedRel: 'page-2.md',
    oldTitle: 'Page',
    oldBytes: Buffer.from('# five v1'),
    editedBytes: Buffer.from('# five v1 EDITED'),
    renamed: () => ({ id: 5, title: 'page', revision: 8, docType: null, body: RENAMED_NEW_BYTES.caseOnly }),
    reuser: () => ({ id: 6, title: 'Page', revision: 60, docType: null, body: REUSER_BYTES.caseOnly }),
    targetTitle: 'page',
    targetOldBytes: Buffer.from('nine v1 md'),
    movedRel: 'moved.md',
    mover: () => ({ id: 9, title: 'moved', revision: 91, docType: null, body: MOVER_NEW_BYTES.caseOnly }),
};

const VISUAL_KIND = typedKind('visual', '.html');
const KINDS: Kind[] = [VISUAL_KIND, typedKind('canvas', '.canvas.json'), MEDIA_KIND, CASE_KIND];

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

/** A destination entry: file bytes, a directory, or `symlink:<target>`. */
type Entry = Buffer | 'dir' | `symlink:${string}`;

/** `hashless` records the entry with `body_sha256: null`. */
type TrackedSeed = TrackedFile & { hashOf?: Buffer; state?: SeedState; hashless?: boolean };

interface MatrixCase {
    name: string;
    outcome: 'a' | 'b' | 'c';
    form: 'folder' | 'single';
    overwrite: boolean;
    /** Tracked paths (path -> tracked doc and what is on disk). The manifest hash is of `hashOf` when given, else of `bytes`. */
    tracked: Record<string, TrackedSeed>;
    /** Untracked local entries: bytes, a directory, a hard link to another seeded name, or a symlink. */
    untracked?: Record<string, Buffer | 'dir' | { hardlinkTo: string } | { symlinkTo: string }>;
    /** Directory aliases installed before the tracked files. */
    directoryAliases?: Record<string, string>;
    served: ServedDoc[];
    /** Expected entries after a non-refused pull, and the expected manifest. Omitted for (c). */
    after?: { files: Record<string, Entry>; manifest: Record<string, ManifestExpectation> };
    /** Expected refusal or warning text on stderr. */
    stderr?: RegExp[];
}

type SourceState = 'unmodified' | 'modified' | 'absent';
type TargetState = 'free' | 'tracked' | 'untracked' | 'same';

const SOURCE_STATES: SourceState[] = ['unmodified', 'modified', 'absent'];
const TARGET_STATES: TargetState[] = ['free', 'tracked', 'untracked', 'same'];

function tracked(kind: Kind, bytes: Buffer, hashOf: Buffer = kind.oldBytes): TrackedSeed & { hashOf: Buffer } {
    return { id: 5, title: kind.oldTitle, revision: 7, media: kind.media, bytes, hashOf };
}

/** Doc 5's tracked source in the given state: its old bytes, edited bytes, or no file at all. */
function source(kind: Kind, state: SourceState): TrackedSeed {
    if (state === 'modified') return tracked(kind, kind.editedBytes);
    if (state === 'absent') return { ...tracked(kind, kind.oldBytes), state: 'absent' };
    return tracked(kind, kind.oldBytes);
}

function targetTracked(kind: Kind, bytes: Buffer = kind.targetOldBytes): TrackedSeed & { hashOf: Buffer } {
    return { id: 9, title: kind.targetTitle, revision: 90, media: kind.media, bytes, hashOf: kind.targetOldBytes };
}

function entry(id: number, revision: number, bytes: Buffer | null): ManifestExpectation {
    return { id, current_revision_id: revision, body_sha256: bytes === null ? null : sha256Hex(bytes) };
}

function caseName(kind: Kind, form: 'folder' | 'single', text: string, overwrite: boolean): string {
    return `${form} pull, ${kind.label}: ${text}, ${overwrite ? '--overwrite' : 'no --overwrite'}`;
}

function escape(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function targetText(target: TargetState, form: 'folder' | 'single'): string {
    switch (target) {
        case 'free': return 'free target';
        case 'tracked': return form === 'folder' ? 'target tracked by another doc this pull moves away' : 'target tracked by another doc (not pulled)';
        case 'untracked': return 'target holds an untracked file with different bytes';
        case 'same': return 'target holds an untracked file with the same bytes';
    }
}

/**
 * One cell of the source x target x --overwrite x form cross product, for a
 * rename whose replacement is written. The source state decides only what
 * happens to the old path; the target rules apply to every state.
 */
function crossCase(kind: Kind, form: 'folder' | 'single', src: SourceState, target: TargetState, overwrite: boolean): MatrixCase {
    const newBytes = newBytesOf(kind);
    const { oldRel, newRel } = kind;
    const docRel = form === 'single' && target === 'tracked' ? kind.suffixedRel : newRel;
    const trackedSeed: Record<string, TrackedSeed> = { [oldRel]: source(kind, src) };
    const untracked: Record<string, Buffer> = {};
    const served: ServedDoc[] = [kind.renamed()];
    const files: Record<string, Entry> = {};
    const manifest: Record<string, ManifestExpectation> = {};

    if (target === 'tracked') {
        trackedSeed[newRel] = targetTracked(kind);
        if (form === 'folder') {
            served.push(kind.mover());
            files[kind.movedRel] = servedBytes(kind.mover());
            manifest[kind.movedRel] = entry(9, 91, servedBytes(kind.mover()));
        } else {
            files[newRel] = kind.targetOldBytes;
            manifest[newRel] = entry(9, 90, kind.targetOldBytes);
        }
    }
    if (target === 'untracked') untracked[newRel] = UNTRACKED_BYTES;
    if (target === 'same') untracked[newRel] = newBytes;
    files[docRel] = newBytes;
    manifest[docRel] = entry(5, 8, newBytes);

    const base = { name: caseName(kind, form, `${src} source, ${targetText(target, form)}`, overwrite), form, overwrite, tracked: trackedSeed, untracked, served };

    if (src === 'modified') {
        return { ...base, outcome: 'c', stderr: [new RegExp(`${escape(oldRel)} holds unpublished edits for doc 5`), new RegExp(escape(docRel)), /push|move/i] };
    }
    if (target === 'untracked' && !overwrite) {
        return { ...base, outcome: 'c', stderr: [new RegExp(`${escape(newRel)} exists locally but is not tracked`), /doc 5/, /--overwrite/] };
    }
    return { ...base, outcome: 'a', after: { files, manifest } };
}

/** The rows that need more than the cross product: old-path reuse, an edited or deleted target, a directory target. */
function kindSpecialCases(kind: Kind): MatrixCase[] {
    const cases: MatrixCase[] = [];
    const newBytes = newBytesOf(kind);
    const { oldRel, newRel } = kind;
    const reusedRel = kind === CASE_KIND ? 'Page-2.md' : oldRel;
    const reuseText = kind === CASE_KIND ? 'another doc gets a suffix for the case-colliding old name' : 'old path written by another doc';

    for (const overwrite of [false, true]) {
        for (const src of ['unmodified', 'absent'] as const) {
            cases.push({
                name: caseName(kind, 'folder', `${src} source, free target, ${reuseText}`, overwrite),
                outcome: 'a', form: 'folder', overwrite,
                tracked: { [oldRel]: source(kind, src) },
                served: [kind.renamed(), kind.reuser()],
                after: {
                    files: { [newRel]: newBytes, [reusedRel]: servedBytes(kind.reuser()) },
                    manifest: { [newRel]: entry(5, 8, newBytes), [reusedRel]: entry(6, 60, servedBytes(kind.reuser())) },
                },
            });
            cases.push({
                name: caseName(kind, 'folder', `${src} source, target tracked by another doc whose file is modified, which this pull moves away`, overwrite),
                outcome: 'c', form: 'folder', overwrite,
                tracked: { [oldRel]: source(kind, src), [newRel]: targetTracked(kind, Buffer.from('nine EDITED')) },
                served: [kind.renamed(), kind.mover()],
                stderr: [/doc 9/, /doc 5/, new RegExp(escape(newRel))],
            });
            // The target is tracked by doc 9, which the server deleted (not in this pull).
            cases.push({
                name: caseName(kind, 'folder', `${src} source, target tracked by a doc deleted remotely, unmodified`, overwrite),
                outcome: 'a', form: 'folder', overwrite,
                tracked: { [oldRel]: source(kind, src), [newRel]: targetTracked(kind) },
                served: [kind.renamed()],
                after: { files: { [newRel]: newBytes }, manifest: { [newRel]: entry(5, 8, newBytes) } },
            });
            cases.push({
                name: caseName(kind, 'folder', `${src} source, target tracked by a doc deleted remotely, modified`, overwrite),
                outcome: overwrite ? 'a' : 'c', form: 'folder', overwrite,
                tracked: { [oldRel]: source(kind, src), [newRel]: targetTracked(kind, Buffer.from('nine EDITED')) },
                served: [kind.renamed()],
                ...(overwrite
                    // --overwrite discards local changes on every path this pull writes, as for an untracked target.
                    ? { after: { files: { [newRel]: newBytes }, manifest: { [newRel]: entry(5, 8, newBytes) } } }
                    : { stderr: [/unpushed local changes/, new RegExp(escape(newRel))] }),
            });
            // Its entry has no recorded hash (e.g. an earlier failed download), so
            // its local bytes cannot be verified: treated like an untracked file.
            cases.push({
                name: caseName(kind, 'folder', `${src} source, target tracked without a hash by a doc deleted remotely`, overwrite),
                outcome: overwrite ? 'a' : 'c', form: 'folder', overwrite,
                tracked: { [oldRel]: source(kind, src), [newRel]: { ...targetTracked(kind, UNTRACKED_BYTES), hashOf: undefined, hashless: true } },
                served: [kind.renamed()],
                ...(overwrite
                    ? { after: { files: { [newRel]: newBytes }, manifest: { [newRel]: entry(5, 8, newBytes) } } }
                    : { stderr: [new RegExp(`${escape(newRel)} holds local bytes with no recorded hash`), /doc 5/, /--overwrite/] }),
            });
        }
        cases.push({
            name: caseName(kind, 'folder', `modified source, ${reuseText}`, overwrite),
            outcome: 'c', form: 'folder', overwrite,
            tracked: { [oldRel]: source(kind, 'modified') },
            served: [kind.renamed(), kind.reuser()],
            stderr: kind === CASE_KIND
                ? [/doc 5/, new RegExp(escape(oldRel)), /push|move/i]
                : [/doc 5/, /doc 6/, new RegExp(escape(oldRel)), /push it first/],
        });
    }

    // A later rename's target is a directory: the refusal comes before the
    // earlier rename is written.
    for (const src of ['unmodified', 'absent'] as const) {
        cases.push({
            name: caseName(kind, 'folder', `earlier rename succeeds, ${src} source, this rename's target is a directory`, false),
            outcome: 'c', form: 'folder', overwrite: false,
            tracked: { 'early.md': EARLY_TRACKED, [oldRel]: source(kind, src) },
            untracked: { [newRel]: 'dir' },
            served: [EARLY_SERVED, kind.renamed()],
            stderr: [new RegExp(`${escape(newRel)}" exists and is not a regular file`)],
        });
    }
    return cases;
}

function kindCases(kind: Kind): MatrixCase[] {
    const cases: MatrixCase[] = [];
    for (const overwrite of [false, true]) {
        for (const form of ['folder', 'single'] as const) {
            for (const src of SOURCE_STATES) {
                for (const target of TARGET_STATES) {
                    cases.push(crossCase(kind, form, src, target, overwrite));
                }
            }
        }
    }
    return [...cases, ...kindSpecialCases(kind)];
}

/**
 * The source path is not a plain file: a directory, a symlink to a file in
 * the destination, or a dangling symlink. Never removed unless it is a
 * symlink whose file is unmodified (the link goes, its file stays).
 */
function oddSourceCases(): MatrixCase[] {
    const kind = VISUAL_KIND;
    const newBytes = newBytesOf(kind);
    const done = { [kind.newRel]: newBytes };
    const tracks = { [kind.newRel]: entry(5, 8, newBytes) };
    const refusal = [new RegExp(`${escape(kind.newRel)} exists locally but is not tracked`), /doc 5/];
    return [
        {
            name: caseName(kind, 'folder', 'source path is a directory, free target', false),
            outcome: 'a', form: 'folder', overwrite: false,
            tracked: { [kind.oldRel]: { ...tracked(kind, kind.oldBytes), state: 'dir' } },
            served: [kind.renamed()],
            after: { files: { [kind.oldRel]: 'dir', ...done }, manifest: tracks },
        },
        {
            name: caseName(kind, 'folder', 'source path is a directory, target holds an untracked file with different bytes', false),
            outcome: 'c', form: 'folder', overwrite: false,
            tracked: { [kind.oldRel]: { ...tracked(kind, kind.oldBytes), state: 'dir' } },
            untracked: { [kind.newRel]: UNTRACKED_BYTES },
            served: [kind.renamed()],
            stderr: refusal,
        },
        {
            name: caseName(kind, 'folder', 'source is a symlink to an unmodified file, free target', false),
            outcome: 'a', form: 'folder', overwrite: false,
            tracked: { [kind.oldRel]: { ...tracked(kind, kind.oldBytes), state: { symlinkTo: 'real.md' } } },
            untracked: { 'real.md': kind.oldBytes },
            served: [kind.renamed()],
            after: { files: { 'real.md': kind.oldBytes, ...done }, manifest: tracks },
        },
        {
            name: caseName(kind, 'folder', 'source is a symlink to an edited file, free target', false),
            outcome: 'c', form: 'folder', overwrite: false,
            tracked: { [kind.oldRel]: { ...tracked(kind, kind.oldBytes), state: { symlinkTo: 'real.md' } } },
            untracked: { 'real.md': kind.editedBytes },
            served: [kind.renamed()],
            stderr: [new RegExp(`${escape(kind.oldRel)} holds unpublished edits for doc 5`), /push|move/i],
        },
        {
            name: caseName(kind, 'folder', 'source is a dangling symlink, free target', false),
            outcome: 'a', form: 'folder', overwrite: false,
            tracked: { [kind.oldRel]: { ...tracked(kind, kind.oldBytes), state: { symlinkTo: 'gone.md' } } },
            served: [kind.renamed()],
            after: { files: { [kind.oldRel]: 'symlink:gone.md', ...done }, manifest: tracks },
        },
        {
            name: caseName(kind, 'folder', 'source is a dangling symlink, target holds an untracked file with different bytes', false),
            outcome: 'c', form: 'folder', overwrite: false,
            tracked: { [kind.oldRel]: { ...tracked(kind, kind.oldBytes), state: { symlinkTo: 'gone.md' } } },
            untracked: { [kind.newRel]: UNTRACKED_BYTES },
            served: [kind.renamed()],
            stderr: refusal,
        },
        // The target is a symlink: a write would go through it, to a file the
        // pull does not own (possibly outside the destination). Refused, even
        // with --overwrite, before any write.
        ...[false, true].map((overwrite): MatrixCase => ({
            name: caseName(kind, 'folder', 'unmodified source, target is a symlink to an untracked file', overwrite),
            outcome: 'c', form: 'folder', overwrite,
            tracked: { [kind.oldRel]: tracked(kind, kind.oldBytes) },
            untracked: { 'elsewhere.html': UNTRACKED_BYTES, [kind.newRel]: { symlinkTo: 'elsewhere.html' } },
            served: [kind.renamed()],
            stderr: [new RegExp(`${escape(kind.newRel)} is a symbolic link`), /doc 5/],
        })),
    ];
}

/**
 * A case-only rename on a case-insensitive filesystem: `Page.md` and
 * `page.md` are the same file. On Linux a hard link stands in for that one
 * file (both names share an inode).
 */
function sameFileCases(): MatrixCase[] {
    const kind = CASE_KIND;
    const newBytes = newBytesOf(kind);
    const cases: MatrixCase[] = [];
    for (const overwrite of [false, true]) {
        cases.push({
            name: caseName(kind, 'folder', 'unmodified source, target is the same file as the source', overwrite),
            outcome: 'a', form: 'folder', overwrite,
            tracked: { [kind.oldRel]: source(kind, 'unmodified') },
            untracked: { [kind.newRel]: { hardlinkTo: kind.oldRel } },
            served: [kind.renamed()],
            // Both names are the one file the pull wrote; it is never removed.
            after: { files: { [kind.oldRel]: newBytes, [kind.newRel]: newBytes }, manifest: { [kind.newRel]: entry(5, 8, newBytes) } },
        });
        cases.push({
            name: caseName(kind, 'folder', 'modified source, target is the same file as the source', overwrite),
            outcome: 'c', form: 'folder', overwrite,
            tracked: { [kind.oldRel]: source(kind, 'modified') },
            untracked: { [kind.newRel]: { hardlinkTo: kind.oldRel } },
            served: [kind.renamed()],
            stderr: [/Page\.md holds unpublished edits for doc 5/, /page\.md/, /push|move/i],
        });
    }
    return cases;
}

/** Preserved sources aliased by another doc's target (FR5-C1). */
function preservedSourceAliasCases(): MatrixCase[] {
    const cases: MatrixCase[] = [];
    for (const overwrite of [false, true]) {
        for (const alias of ['hardlink', 'symlink', 'directory'] as const) {
            for (const edited of [false, true]) {
                const kind = edited ? VISUAL_KIND : MEDIA_KIND;
                const oldRel = alias === 'directory' ? `alias/${kind.oldRel}` : kind.oldRel;
                const targetRel = alias === 'directory' ? kind.oldRel : `other${path.extname(kind.oldRel)}`;
                const other = kind.reuser();
                other.title = targetRel.replace(/\.md$/, '');
                cases.push({
                    name: caseName(kind, 'folder', `${edited ? 'edited source' : 'failed download source'} aliased by another doc's target via ${alias}`, overwrite),
                    outcome: 'c', form: 'folder', overwrite,
                    tracked: { [oldRel]: source(kind, edited ? 'modified' : 'unmodified') },
                    ...(alias === 'directory'
                        ? { directoryAliases: { alias: '.' } }
                        : { untracked: { [targetRel]: alias === 'hardlink' ? { hardlinkTo: oldRel } : { symlinkTo: oldRel } } }),
                    served: [edited ? kind.renamed() : kind.renamed('fail'), other],
                    stderr: [/doc 5/, /doc 6/, new RegExp(escape(oldRel)), new RegExp(escape(kind.newRel)), new RegExp(escape(targetRel))],
                });
            }
        }
        cases.push({
            name: caseName(MEDIA_KIND, 'folder', 'absent failed-download source path aliased by another target directory', overwrite),
            outcome: 'c', form: 'folder', overwrite,
            tracked: { 'alias/old.png': source(MEDIA_KIND, 'absent') },
            directoryAliases: { alias: '.' },
            served: [MEDIA_KIND.renamed('fail'), MEDIA_KIND.reuser()],
            stderr: [/doc 5/, /doc 6/, /alias\/old\.png/, /new\.png/, /pull again once the download succeeds/i],
        });
        cases.push({
            name: caseName(MEDIA_KIND, 'folder', 'dangling source alias would attach restored tracking to another doc bytes', overwrite),
            outcome: 'c', form: 'folder', overwrite,
            tracked: { 'old.png': { ...source(MEDIA_KIND, 'absent'), state: { symlinkTo: 'kept.png' } } },
            served: [MEDIA_KIND.renamed('fail'), { ...MEDIA_KIND.reuser(), title: 'kept.png' }],
            stderr: [/doc 5/, /doc 6/, /old\.png/, /kept\.png/, /new\.png/],
        });
        cases.push({
            name: caseName(MEDIA_KIND, 'folder', 'dangling target alias would overwrite another renamed doc replacement', overwrite),
            outcome: 'c', form: 'folder', overwrite,
            tracked: { 'old.png': source(MEDIA_KIND, 'unmodified') },
            untracked: { 'other.png': { symlinkTo: 'new.png' } },
            served: [MEDIA_KIND.renamed(), { ...MEDIA_KIND.reuser(), title: 'other.png' }],
            stderr: [/doc 5/, /doc 6/, /new\.png/, /other\.png/, /same file/],
        });
        // Single-doc pulls have only one planned target: it can alias its own
        // source, but cannot contain another doc's planned write target.
        cases.push({
            name: caseName(VISUAL_KIND, 'single', 'edited source aliased by its own target via hardlink', overwrite),
            outcome: 'c', form: 'single', overwrite,
            tracked: { [VISUAL_KIND.oldRel]: source(VISUAL_KIND, 'modified') },
            untracked: { [VISUAL_KIND.newRel]: { hardlinkTo: VISUAL_KIND.oldRel } },
            served: [VISUAL_KIND.renamed()],
            stderr: [/doc 5/, /page\.md/, /page\.html/, /push|move/i],
        });
        cases.push({
            name: caseName(MEDIA_KIND, 'single', 'failed download source aliased by its own unwritten target', overwrite),
            outcome: 'b', form: 'single', overwrite,
            tracked: { [MEDIA_KIND.oldRel]: source(MEDIA_KIND, 'unmodified') },
            untracked: { [MEDIA_KIND.newRel]: { hardlinkTo: MEDIA_KIND.oldRel } },
            served: [MEDIA_KIND.renamed('fail')],
            after: {
                files: { 'old.png': MEDIA_KIND.oldBytes, 'new.png': MEDIA_KIND.oldBytes },
                manifest: { 'old.png': entry(5, 7, MEDIA_KIND.oldBytes) },
            },
            stderr: [/doc 5 download failed; still tracked as old\.png/],
        });
        cases.push({
            name: caseName(VISUAL_KIND, 'folder', 'two renamed docs write targets that alias the same file', overwrite),
            outcome: 'c', form: 'folder', overwrite,
            tracked: {
                'page.md': source(VISUAL_KIND, 'unmodified'),
                'other.md': { id: 6, title: 'other', revision: 59, media: false, bytes: REUSER_BYTES.visual },
            },
            untracked: { 'page.html': { hardlinkTo: 'page.md' }, 'other.html': { hardlinkTo: 'page.md' } },
            served: [VISUAL_KIND.renamed(), { id: 6, title: 'other', revision: 60, docType: 'visual', body: Buffer.from('<h1>six</h1>') }],
            stderr: [/doc 5/, /doc 6/, /page\.html/, /other\.html/, /same file/],
        });
        cases.push({
            name: caseName(VISUAL_KIND, 'folder', 'two renamed docs write absent targets under aliased directories', overwrite),
            outcome: 'c', form: 'folder', overwrite,
            tracked: {
                'page.md': source(VISUAL_KIND, 'unmodified'),
                'other.md': { id: 6, title: 'other', revision: 59, media: false, bytes: REUSER_BYTES.visual },
            },
            directoryAliases: { b: 'a' },
            untracked: { a: 'dir' },
            served: [
                { ...VISUAL_KIND.renamed(), relative: 'a' },
                { id: 6, title: 'page', revision: 60, docType: 'visual', body: Buffer.from('<h1>six</h1>'), relative: 'b' },
            ],
            stderr: [/doc 5/, /doc 6/, /a\/page\.html/, /b\/page\.html/, /same file/],
        });
        // Both docs move away successfully. Their old names alias the other's
        // target, which is allowed: cleanup must preserve the files just written.
        cases.push({
            name: caseName(VISUAL_KIND, 'folder', 'two renamed docs alias each other targets via hardlinks', overwrite),
            outcome: overwrite ? 'a' : 'c', form: 'folder', overwrite,
            tracked: {
                'page.md': source(VISUAL_KIND, 'unmodified'),
                'other.md': { id: 6, title: 'other', revision: 59, media: false, bytes: REUSER_BYTES.visual },
            },
            untracked: { 'other.html': { hardlinkTo: 'page.md' }, 'page.html': { hardlinkTo: 'other.md' } },
            served: [VISUAL_KIND.renamed(), { id: 6, title: 'other', revision: 60, docType: 'visual', body: Buffer.from('<h1>six</h1>') }],
            after: {
                files: { 'page.md': Buffer.from('<h1>six</h1>'), 'other.html': Buffer.from('<h1>six</h1>'), 'other.md': newBytesOf(VISUAL_KIND), 'page.html': newBytesOf(VISUAL_KIND) },
                manifest: { 'page.html': entry(5, 8, newBytesOf(VISUAL_KIND)), 'other.html': entry(6, 60, Buffer.from('<h1>six</h1>')) },
            },
            // cli#167 M2: both old paths alias a file this pull wrote, so
            // cleanup keeps them with a warning naming the written path.
            ...(overwrite ? { stderr: [/! kept page\.md: it is the same file as other\.html \(a link\)/, /! kept other\.md: it is the same file as page\.html \(a link\)/] } : {}),
        });
    }
    return cases;
}

/** Case-insensitive allocation prevents aliases even before targets exist. */
function caseFoldAllocationCases(): MatrixCase[] {
    const cases: MatrixCase[] = [];
    const first: ServedDoc = { id: 5, title: 'Page', revision: 8, docType: null, body: Buffer.from('# five v2') };
    const second: ServedDoc = { id: 6, title: 'page', revision: 60, docType: null, body: Buffer.from('# six') };
    for (const overwrite of [false, true]) {
        for (const renamed of [false, true]) {
            cases.push({
                name: `folder pull, ${renamed ? 'two renamed' : 'two new'} docs with case-only title differences allocate distinct names, ${overwrite ? '--overwrite' : 'no --overwrite'}`,
                outcome: 'a', form: 'folder', overwrite,
                tracked: renamed ? {
                    'old.md': { ...source(CASE_KIND, 'unmodified'), title: 'old' },
                    'other.md': { id: 6, title: 'other', revision: 59, media: false, bytes: Buffer.from('# six v1') },
                } : {},
                served: [first, second],
                after: {
                    files: { 'Page.md': first.body!, 'page-2.md': second.body! },
                    manifest: { 'Page.md': entry(5, 8, first.body!), 'page-2.md': entry(6, 60, second.body!) },
                },
            });
        }
        cases.push({
            name: `single pull, another doc reserves a differently cased path, ${overwrite ? '--overwrite' : 'no --overwrite'}`,
            outcome: 'a', form: 'single', overwrite,
            tracked: {
                'old.md': { ...source(CASE_KIND, 'unmodified'), title: 'old' },
                'Page.md': { id: 9, title: 'Page', revision: 90, media: false, bytes: Buffer.from('# nine v1') },
            },
            served: [{ ...first, title: 'page' }],
            after: {
                files: { 'Page.md': Buffer.from('# nine v1'), 'page-2.md': first.body! },
                manifest: { 'Page.md': entry(9, 90, Buffer.from('# nine v1')), 'page-2.md': entry(5, 8, first.body!) },
            },
        });
        cases.push({
            name: `folder pull, legacy tracked case aliases refuse before either doc is written, ${overwrite ? '--overwrite' : 'no --overwrite'}`,
            outcome: 'c', form: 'folder', overwrite,
            tracked: {
                'Page.md': source(CASE_KIND, 'unmodified'),
                'page.md': { id: 6, title: 'page', revision: 59, media: false, bytes: CASE_KIND.oldBytes, state: { hardlinkTo: 'Page.md' } },
            },
            served: [first, second],
            stderr: [/doc 5/, /doc 6/, /Page\.md/, /page\.md/, /same file/],
        });
        cases.push({
            name: `folder pull, case-fold allocation preserves tracked exact paths when listing order changes, ${overwrite ? '--overwrite' : 'no --overwrite'}`,
            outcome: 'a', form: 'folder', overwrite,
            tracked: {
                'Page.md': source(CASE_KIND, 'unmodified'),
                'page-2.md': { id: 6, title: 'page', revision: 59, media: false, bytes: Buffer.from('# six v1') },
            },
            served: [second, first],
            after: {
                files: { 'Page.md': first.body!, 'page-2.md': second.body! },
                manifest: { 'Page.md': entry(5, 8, first.body!), 'page-2.md': entry(6, 60, second.body!) },
            },
        });
    }
    return cases;
}

/** The failed-download rows: doc 5's renamed media download answers 503. */
function failedMediaCases(): MatrixCase[] {
    const kind = MEDIA_KIND;
    const cases: MatrixCase[] = [];
    const keptOld = { 'old.png': entry(5, 7, kind.oldBytes) };
    const keptMessage = /doc 5 download failed; still tracked as old\.png/;

    for (const overwrite of [false, true]) {
        for (const form of ['folder', 'single'] as const) {
            for (const src of SOURCE_STATES) {
                for (const target of ['free', 'tracked', 'untracked'] as const) {
                    const trackedSeed: Record<string, TrackedSeed> = { 'old.png': source(kind, src) };
                    const untracked: Record<string, Buffer> = {};
                    const served: ServedDoc[] = [kind.renamed('fail')];
                    const files: Record<string, Entry> = {};
                    const manifest: Record<string, ManifestExpectation> = { ...keptOld };
                    if (src === 'unmodified') files['old.png'] = kind.oldBytes;
                    if (target === 'tracked') {
                        trackedSeed['new.png'] = targetTracked(kind);
                        if (form === 'folder') {
                            served.push(kind.mover());
                            files['moved.png'] = MOVER_NEW_BYTES.media;
                            manifest['moved.png'] = entry(9, 91, MOVER_NEW_BYTES.media);
                        } else {
                            files['new.png'] = kind.targetOldBytes;
                            manifest['new.png'] = entry(9, 90, kind.targetOldBytes);
                        }
                    }
                    if (target === 'untracked') {
                        untracked['new.png'] = UNTRACKED_BYTES;
                        files['new.png'] = UNTRACKED_BYTES;
                    }
                    const base = { name: caseName(kind, form, `download fails, ${src} source, ${targetText(target, form)}`, overwrite), form, overwrite, tracked: trackedSeed, untracked, served };
                    if (src === 'modified') {
                        cases.push({ ...base, outcome: 'c', stderr: [/old\.png holds unpublished edits for doc 5/, /download failed/, /push|move/i, /pull again once the download succeeds/i] });
                    } else {
                        cases.push({ ...base, outcome: 'b', after: { files, manifest }, stderr: [/failed to download media for doc 5/, keptMessage] });
                    }
                }
            }
        }

        for (const src of ['unmodified', 'absent'] as const) {
            cases.push({
                name: caseName(kind, 'folder', `download fails, ${src} source, old path written by another doc`, overwrite),
                outcome: 'c', form: 'folder', overwrite,
                tracked: { 'old.png': source(kind, src) },
                served: [kind.renamed('fail'), kind.reuser()],
                stderr: [/doc 5/, /doc 6/, /old\.png/, /new\.png/, /pull again once the download succeeds/i],
            });
            cases.push({
                name: caseName(kind, 'folder', `${src} source, the moved-away target doc's download fails while this rename takes its path`, overwrite),
                outcome: 'c', form: 'folder', overwrite,
                tracked: { 'old.png': source(kind, src), 'new.png': targetTracked(kind) },
                served: [kind.renamed(), kind.mover('fail')],
                stderr: [/doc 9/, /doc 5/, /new\.png/, /pull again once the download succeeds/i],
            });
            cases.push({
                name: caseName(kind, 'folder', `an earlier rename succeeds, a later renamed download fails, ${src} source`, overwrite),
                outcome: 'b', form: 'folder', overwrite,
                tracked: { 'early.md': EARLY_TRACKED, 'old.png': source(kind, src) },
                served: [EARLY_SERVED, kind.renamed('fail')],
                after: {
                    files: { 'early.html': EARLY_NEW, ...(src === 'unmodified' ? { 'old.png': kind.oldBytes } : {}) },
                    manifest: { 'early.html': entry(4, 41, EARLY_NEW), ...keptOld },
                },
            });
        }
        cases.push({
            name: caseName(kind, 'folder', 'download fails, old path claimed by another doc whose download also fails', overwrite),
            outcome: 'c', form: 'folder', overwrite,
            tracked: { 'old.png': source(kind, 'unmodified') },
            served: [kind.renamed('fail'), kind.reuser('fail')],
            stderr: [/doc 5/, /doc 6/, /pull again once the download succeeds/i],
        });
        cases.push({
            name: caseName(kind, 'folder', 'an earlier rename succeeds, a later renamed download fails and its old path is written by another doc', overwrite),
            outcome: 'c', form: 'folder', overwrite,
            tracked: { 'early.md': EARLY_TRACKED, 'old.png': source(kind, 'unmodified') },
            served: [EARLY_SERVED, kind.renamed('fail'), kind.reuser()],
            stderr: [/doc 5/, /doc 6/, /pull again once the download succeeds/i],
        });
    }
    return cases;
}

const MATRIX: MatrixCase[] = [...KINDS.flatMap(kindCases), ...oddSourceCases(), ...sameFileCases(), ...preservedSourceAliasCases(), ...caseFoldAllocationCases(), ...failedMediaCases()];

// ---------------------------------------------------------------------------
// Running and checking a case
// ---------------------------------------------------------------------------

function seed(dest: string, testCase: MatrixCase): { manifestText: string } {
    fs.mkdirSync(dest, { recursive: true });
    const docs: Record<string, object> = {};
    for (const [rel, target] of Object.entries(testCase.directoryAliases ?? {})) {
        fs.symlinkSync(target, path.join(dest, rel));
    }
    for (const [rel, file] of Object.entries(testCase.tracked)) {
        const state = file.state ?? 'file';
        const abs = path.join(dest, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (state === 'file') fs.writeFileSync(abs, file.bytes);
        else if (state === 'dir') fs.mkdirSync(abs);
        else if (state !== 'absent') {
            if ('symlinkTo' in state) fs.symlinkSync(state.symlinkTo, abs);
            else fs.linkSync(path.join(dest, state.hardlinkTo), abs);
        }
        docs[rel] = { id: file.id, title: file.title, current_revision_id: file.revision, media: file.media, body_sha256: file.hashless ? null : sha256Hex(file.hashOf ?? file.bytes) };
    }
    for (const [rel, content] of Object.entries(testCase.untracked ?? {})) {
        const abs = path.join(dest, rel);
        if (content === 'dir') fs.mkdirSync(abs);
        else if ('hardlinkTo' in content) fs.linkSync(path.join(dest, content.hardlinkTo), abs);
        else if ('symlinkTo' in content) fs.symlinkSync(content.symlinkTo, abs);
        else fs.writeFileSync(abs, content);
    }
    const manifestText = `${JSON.stringify({ folder_path: 'docs', docs }, null, 2)}\n`;
    fs.writeFileSync(path.join(dest, MANIFEST_FILE), manifestText);
    return { manifestText };
}

/** Every entry in the destination except the manifest: files as bytes, directories as 'dir', symlinks by target. */
function snapshot(dest: string): Record<string, Entry> {
    const out: Record<string, Entry> = {};
    for (const name of fs.readdirSync(dest).sort()) {
        if (name === MANIFEST_FILE) continue;
        const abs = path.join(dest, name);
        const stat = fs.lstatSync(abs);
        if (stat.isSymbolicLink()) out[name] = `symlink:${fs.readlinkSync(abs)}`;
        else if (stat.isDirectory()) {
            out[name] = 'dir';
            for (const [rel, content] of Object.entries(snapshot(abs))) out[`${name}/${rel}`] = content;
        } else out[name] = fs.readFileSync(abs);
    }
    return out;
}

function sortedEntries(entries: Record<string, Entry>): Record<string, Entry> {
    return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
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
    it('names every case once', () => {
        const names = MATRIX.map((c) => c.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it.each(MATRIX.map((c) => [`(${c.outcome}) ${c.name}`, c] as const))('%s', async (_label, testCase) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pull-matrix-'));
        const dest = path.join(root, 'out');
        try {
            const { manifestText } = seed(dest, testCase);
            const before = snapshot(dest);
            served = { form: testCase.form, docs: testCase.served };

            const result = await runPull(pullArgs(testCase, dest));

            if (testCase.outcome === 'c') {
                expect(snapshot(dest)).toEqual(before);
                expect(result.stdout).not.toContain('pulled');
                expect(result.stderr).not.toMatch(/kept .*untracked/);
                expect(fs.readFileSync(path.join(dest, MANIFEST_FILE), 'utf8')).toBe(manifestText);
                expect(result.code).toBe(1);
                expectStderr(result, testCase);
                return;
            }

            expect(result.code).toBe(0);
            const after = testCase.after!;
            expect(snapshot(dest)).toEqual(sortedEntries(after.files));

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
                const abs = path.join(dest, rel);
                if (!fs.existsSync(abs)) continue;
                expect(sha256Hex(fs.readFileSync(abs))).toBe(e.body_sha256);
            }
            expectStderr(result, testCase);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

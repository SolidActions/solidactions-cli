/**
 * Final review 4, C1 (PM ruling 14): every path-keyed dictionary in doc pull keeps any file name as its own key. A media doc
 * with a MIME outside the extension table is written under its bare title, so a title such as `__proto__` is a manifest key;
 * on a plain `{}` that key hits the inherited setter and the entry vanishes, and the other Object.prototype names read an
 * inherited value where there is no entry. The names below are swept through every route that records an entry.
 *
 * Module level (ported from Sol's final-review-4 scratch unit, `fr4-scratch/prototype-entry.test.cjs`): the real
 * `writeAll` places the file, the real `decideOutcomes`, `buildManifest` and `manifestProblem` settle it, against a real temp
 * directory. Nothing is substituted.
 *
 * Spawned sweep: every row runs the built CLI (`node dist/index.js`) against a real in-process HTTP server with a temp HOME
 * and real files, through the shared harness, which asserts every call's exit status, stdout and stderr. Each name is pulled
 * at the root (a bare-title media file, a markdown file) and one level down (a folder of that name holding both), through
 * the placed, kept, refused and unlisted-carried routes of a folder pull and of a single-doc pull, plus deletion propagation,
 * a rename onto an untracked file of that name, and that name as the media MIME itself. After every pull the final manifest
 * and the disk must agree (INV-A, INV-B, INV-C). A single-doc pull names a doc at the folder root (the harness's single form),
 * so its placed row has the root layout only.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildManifest, decideOutcomes, manifestProblem } from '../src/commands/doc-pull';
import type { DocOutcome, PlannedDoc } from '../src/commands/doc-pull';
import type { DocsManifest, ManifestEntry } from '../src/utils/docs-manifest';
import { sha256Hex } from '../src/utils/docs-manifest';
import { faultsFromEnv, writeAll } from '../src/utils/doc-pull-writes';
import { MANIFEST_FILE, cannotWriteLine, doc, failed, internalEntries, pulledOk, pulledStdout, relOf, sha256, singleDocWarning, useDocPullHarness } from './doc-pull-inv-harness';
import type { ServedDoc } from './doc-pull-inv-harness';

const h = useDocPullHarness();

/** Every own name of Object.prototype a title is likely to take, `__proto__` (a setter) first. */
const NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'prototype'];
const FOLDER = 'docs';

/** A dictionary the test builds by hand: no prototype, so a name is only ever an own key. */
function dictionary<T>(entries: Array<[string, T]>): Record<string, T> {
    const result = Object.create(null) as Record<string, T>;
    for (const [key, value] of entries) result[key] = value;
    return result;
}

describe('C1 module level: a placed, kept, refused or unlisted entry named like an Object.prototype member stays an own manifest key, and the gate refuses a placed file the manifest does not record', () => {
    let root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-pull-names-'));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    const bytes = Buffer.from('MEDIA BYTES');

    /** A media doc with an unknown MIME, planned at its bare title (the allocator's MIME fallback is ''). */
    function mediaDoc(id: number, rel: string, mediaBytes: Buffer | null): PlannedDoc {
        return {
            doc: { id, title: rel, relative: '', docType: null, docTypeKnown: true, body: '', current_revision_id: 2, properties: {} },
            relPath: rel,
            dirRel: '',
            fileName: rel,
            isMedia: true,
            mediaBytes,
            bodySha256: mediaBytes === null ? null : sha256Hex(mediaBytes),
        };
    }

    /** The previous manifest, as `readManifest` hands it over: parsed from its JSON text. */
    function previousTracking(rel: string): DocsManifest {
        const entry: ManifestEntry = { id: 1, title: rel, current_revision_id: 1, media: true, body_sha256: sha256Hex(bytes) };
        return JSON.parse(JSON.stringify({ folder_path: FOLDER, docs: dictionary([[rel, entry]]) })) as DocsManifest;
    }

    it.each(NAMES)('%s: placed by the real write loop, kept after a failed download, refused after a stop, and carried unlisted, it is an own key of the final manifest every time', (rel) => {
        const missing: string[] = [];

        // Placed: the real writer puts the bytes at the bare title.
        const { placed, stop } = writeAll(root, [{ relPath: rel, dirRel: '', data: bytes, authorized: { kind: 'absent' } }], faultsFromEnv({}));
        expect(stop).toBeNull();
        expect(placed.length).toBe(1);
        const placedOutcomes = decideOutcomes(root, [mediaDoc(1, rel, bytes)], new Set([rel]), false, null, FOLDER, [], new Set([1]), []);
        const placedManifest = buildManifest(FOLDER, null, placedOutcomes, false, []);
        if (!Object.hasOwn(placedManifest.docs, rel)) missing.push(`placed:${rel}`);
        const written = new Map([[rel, { hash: sha256Hex(bytes), identity: placed[0].identity }]]);
        expect(manifestProblem(root, placedManifest, placedOutcomes, written), 'the gate accepts the manifest that records the placed file').toBeNull();

        // Kept (cli#183): the download failed and the file is still the one the earlier entry names.
        const previous = previousTracking(rel);
        const keptOutcomes = decideOutcomes(root, [mediaDoc(1, rel, null)], new Set(), false, previous, FOLDER, [], new Set([1]), []);
        expect(keptOutcomes.map((outcome) => outcome.kind)).toEqual(['kept-previous']);
        const keptManifest = buildManifest(FOLDER, previous, keptOutcomes, false, []);
        if (!Object.hasOwn(keptManifest.docs, rel)) missing.push(`kept:${rel}`);

        // Refused: a stop before its write carries the earlier entry.
        const refusedOutcomes = decideOutcomes(root, [mediaDoc(1, rel, Buffer.from('NEW BYTES'))], new Set(), true, previous, FOLDER, [], new Set([1]), []);
        expect(refusedOutcomes.map((outcome) => outcome.kind)).toEqual(['refused']);
        const refusedManifest = buildManifest(FOLDER, previous, refusedOutcomes, true, []);
        if (!Object.hasOwn(refusedManifest.docs, rel)) missing.push(`refused:${rel}`);

        // Unlisted: a stopped or single-doc pull carries an earlier entry whose doc has no outcome.
        const unlistedManifest = buildManifest(FOLDER, previous, [], true, []);
        if (!Object.hasOwn(unlistedManifest.docs, rel)) missing.push(`unlisted:${rel}`);

        expect(missing, 'the manifest must preserve every placed and retained file key').toEqual([]);
        for (const manifest of [placedManifest, keptManifest, refusedManifest, unlistedManifest]) {
            expect(JSON.parse(JSON.stringify(manifest)).docs[rel]?.id, 'the serialised manifest records the entry as its own key').toBe(1);
        }
    });

    it.each([...NAMES, 'page.md'])('%s: a final manifest that does not record a file this run placed is refused by the gate', (rel) => {
        const { placed } = writeAll(root, [{ relPath: rel, dirRel: '', data: bytes, authorized: { kind: 'absent' } }], faultsFromEnv({}));
        const outcomes: DocOutcome[] = decideOutcomes(root, [mediaDoc(1, rel, bytes)], new Set([rel]), false, null, FOLDER, [], new Set([1]), []);
        const withoutPlaced: DocsManifest = { folder_path: FOLDER, docs: dictionary([['other.md', { id: 2, title: 'other', current_revision_id: 1, media: false, body_sha256: null }]]) };

        const problem = manifestProblem(root, withoutPlaced, outcomes, new Map([[rel, { hash: sha256Hex(bytes), identity: placed[0].identity }]]));

        expect(problem?.rel).toBe(rel);
        expect(problem?.reason).toBe('this pull wrote it but the manifest would not record it');
    });
});

const UNKNOWN_MIME = 'application/x-unknown';
type Layout = 'root' | 'nested';
const LAYOUTS: Layout[] = ['root', 'nested'];

/** The docs named `name` at one level: a media doc with an unknown MIME (a bare-title file) and a markdown doc; `nested` puts both in a folder of that name. */
function named(name: string, layout: Layout, version: number, mediaFails = false): ServedDoc[] {
    const relative = layout === 'nested' ? name : undefined;
    return [{ ...doc('media', 1, name, version, relative), mime: UNKNOWN_MIME, downloadFails: mediaFails }, doc('md', 2, name, version, relative)];
}
const x = (version: number): ServedDoc => doc('md', 9, 'x', version);

/** Every regular file under `dir`, the manifest aside, with its bytes, by relative path (a Map, so any name is a key). */
function filesOnDisk(dir: string): Map<string, string> {
    const files = new Map<string, string>();
    const walk = (abs: string, prefix: string): void => {
        for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
            const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
            if (entry.isDirectory()) walk(path.join(abs, entry.name), rel);
            else if (rel !== MANIFEST_FILE) files.set(rel, fs.readFileSync(path.join(abs, entry.name), 'latin1'));
        }
    };
    walk(dir, '');
    return files;
}

/**
 * The manifest and the disk agree: nothing outside the destination and no lock or temp file left (INV-A); the files on disk
 * are exactly `tracked` plus `untracked`, each holding the bytes the row expects (INV-B: what the pull did not write is as it
 * was); the manifest's own keys are exactly `tracked`, and each records the hash of the bytes at its path (INV-C).
 */
function expectManifestAndDiskAgree(tracked: Array<[string, string]>, untracked: Array<[string, string]> = []): void {
    expect(fs.readdirSync(h.outside), 'nothing is written outside the destination').toEqual([]);
    expect(internalEntries(h.out)).toEqual([]);
    const disk = filesOnDisk(h.out);
    expect([...disk.keys()].sort(), 'the files on disk').toEqual([...tracked, ...untracked].map(([rel]) => rel).sort());
    for (const [rel, bytes] of [...tracked, ...untracked]) expect(disk.get(rel), `the bytes at ${rel}`).toBe(bytes);
    const docs = (JSON.parse(fs.readFileSync(path.join(h.out, MANIFEST_FILE), 'utf8')) as DocsManifest).docs;
    expect(Object.keys(docs).sort(), 'the manifest\'s keys').toEqual(tracked.map(([rel]) => rel).sort());
    for (const [rel, bytes] of tracked) expect(Object.getOwnPropertyDescriptor(docs, rel)?.value?.body_sha256, `the hash recorded for ${rel}`).toBe(sha256(bytes));
}

const filesOf = (docs: ServedDoc[]): Array<[string, string]> => docs.filter((d) => !d.downloadFails).map((d) => [relOf(d), d.bytes]);

describe.each(NAMES)('C1 spawned sweep: docs named %s', { timeout: 60_000 }, (name) => {
    describe.each(LAYOUTS)('%s layout', (layout) => {
        it('folder pull, placed: every file is written and recorded under its own name', async () => {
            const docs = named(name, layout, 1);
            h.serve(docs);

            await h.pull('folder', 'docs', pulledOk(h.out, docs.map(relOf)));

            expectManifestAndDiskAgree(filesOf(docs));
        });

        it('folder pull, placed over the tracked files of the previous pull: each is still tracked, so none is refused as untracked', async () => {
            await h.seed(named(name, layout, 1));
            const docs = named(name, layout, 2);
            h.serve(docs);

            await h.pull('folder', 'docs', pulledOk(h.out, docs.map(relOf)));

            expectManifestAndDiskAgree(filesOf(docs));
        });

        it('folder pull, kept: a failed download keeps the earlier entry of the file still holding its bytes (cli#183)', async () => {
            const before = named(name, layout, 1);
            await h.seed(before);
            const [media, md] = named(name, layout, 2, true);
            h.serve([media, md]);

            await h.pull('folder', 'docs', pulledOk(h.out, [relOf(md)], `warn: failed to download media for doc 1 (${name}): HTTP 500\n`));

            expectManifestAndDiskAgree([[relOf(before[0]), before[0].bytes], [relOf(md), md.bytes]]);
        });

        it('folder pull, refused: a stop before the media write carries its earlier entry, and the markdown file placed before the stop is recorded', async () => {
            const before = named(name, layout, 1);
            await h.seed(before);
            const [media, md] = named(name, layout, 2);
            h.serve([md, media]);

            await h.pull('folder', 'docs', failed(cannotWriteLine(relOf(media), 'rename', 1, 2)), ['-y'], 'fail-rename:2');

            expectManifestAndDiskAgree([[relOf(before[0]), before[0].bytes], [relOf(md), md.bytes]]);
        });

        it('folder pull that stops, unlisted: the entries of docs the server no longer lists are carried', async () => {
            const before = [x(1), ...named(name, layout, 1)];
            await h.seed(before);
            h.serve([x(2)]);

            await h.pull('folder', 'docs', failed(cannotWriteLine('x.md', 'rename', 0, 1)), ['-y'], 'fail-rename:1');

            expectManifestAndDiskAgree(filesOf(before));
        });

        it('folder pull, deleted remotely: the unchanged files are removed and their entries dropped', async () => {
            const gone = named(name, layout, 1);
            await h.seed([x(1), ...gone]);
            h.serve([x(1)]);

            await h.pull('folder', 'docs', { code: 0, stdout: pulledStdout(h.out, ['x.md'], gone.map(relOf)), stderr: '' });

            expectManifestAndDiskAgree([['x.md', x(1).bytes]]);
        });

        it('single-doc pull, unlisted: the entries of the docs it does not name are carried', async () => {
            const before = [x(1), ...named(name, layout, 1)];
            await h.seed(before);
            h.serve([x(2), ...named(name, layout, 1)]);

            await h.pull('single', 'x', pulledOk(h.out, ['x.md'], singleDocWarning));

            expectManifestAndDiskAgree([['x.md', x(2).bytes], ...filesOf(before.slice(1))]);
        });
    });

    it('single-doc pull, placed: the bare-title media file is written and recorded under its own name (root layout: a single-doc pull names a doc at the folder root)', async () => {
        const [media] = named(name, 'root', 1);
        h.serve([media]);

        await h.pull('single', name, pulledOk(h.out, [name]));

        expectManifestAndDiskAgree([[name, media.bytes]]);
    });

    it('a rename onto an untracked file of that name is refused as untracked, and nothing changes', async () => {
        const old = { ...doc('media', 1, 'old', 1), mime: UNKNOWN_MIME };
        await h.seed([old]);
        fs.writeFileSync(path.join(h.out, name), 'LOCAL');
        h.serve([{ ...doc('media', 1, name, 2), mime: UNKNOWN_MIME }]);

        await h.pull('folder', 'docs', failed(`error: ${name} exists locally but is not tracked; this pull would overwrite it with doc 1 ("${name}", renamed from old).\nMove ${name} aside and pull again, or pass --overwrite to replace it.\n`));

        expectManifestAndDiskAgree([['old', old.bytes]], [[name, 'LOCAL']]);
    });

    it('the name as the media MIME itself: it is not in the extension table, so the file is the bare title', async () => {
        const media = { ...doc('media', 1, 'pic', 1), mime: name };
        h.serve([media]);

        await h.pull('folder', 'docs', pulledOk(h.out, ['pic']));

        expectManifestAndDiskAgree([['pic', media.bytes]]);
    });
});

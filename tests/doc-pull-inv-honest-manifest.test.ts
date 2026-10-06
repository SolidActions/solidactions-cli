/**
 * INV-C, the manifest never lies (spec §1.2, ruling 10). Every row runs the built CLI (`node dist/index.js`) against a
 * real in-process HTTP server with a temp HOME and real files, through the shared harness, which asserts every
 * call's exit status, stdout and stderr.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { FORMS, KINDS, MANIFEST_FILE, NFC_NAME, NFD_NAME, cannotWriteLine, caseInsensitiveFilesystem, changedLine, doc, escapeRegExp, failed, gateLine, internalEntries, manifestNotWrittenLine, manifestOf, normalisingFilesystem, pulledOk, pulledStdout, read, relOf, sha256, singleDocWarning, snapshot, updatedFiles, useDocPullHarness } from './doc-pull-inv-harness';
import type { CliResult, Expected, ServedDoc, Snapshot } from './doc-pull-inv-harness';

const h = useDocPullHarness();

/*
 * INV-C: the manifest never lies (spec §1.2, ruling 10; PM ruling 12). After a pull exits (0 or 1), every
 * manifest entry with a `body_sha256` matches the sha256 of the file at its path, unless that
 * path is the one this run's stderr names as refused (the changed-after-the-check or folder line),
 * or one the row deliberately changed outside the pull, or the target a failed manifest write left under the
 * old manifest (a documented state that the next pull adopts). A pull that stopped before the manifest is
 * the pure function of what it wrote: a refused doc keeps its earlier entry, a new doc has none. And no
 * lock or temp file is left behind.
 * Rows: {markdown, media} x {folder, single-doc} x {new path, unchanged tracked path, renamed
 * doc} x {success, fail-rename:1, fail-manifest-temp, fail-manifest-rename, changed after the check}, then the
 * mixed fixture and the platform rows. Pruned: none; every combination is possible (each pull has
 * exactly one doc, so rename 1 is always reached).
 */

type State = 'new' | 'unchanged' | 'renamed';
type Outcome = 'success' | 'fail-rename:1' | 'fail-manifest-temp' | 'fail-manifest-rename' | 'publication refusal';
const STATES: State[] = ['new', 'unchanged', 'renamed'];
const OUTCOMES: Outcome[] = ['success', 'fail-rename:1', 'fail-manifest-temp', 'fail-manifest-rename', 'publication refusal'];

const refusedIn = (stderr: string, rel: string): boolean =>
    stderr.includes(`error: ${rel} changed after doc pull checked it`) || stderr.includes(`error: ${rel} is a folder (doc pull writes a file there)`);

/** The invariant itself: see the header. `edited` lists paths the row changed outside the pull. */
function expectManifestHonest(result: CliResult, edited: string[] = []): void {
    expect(internalEntries(h.out)).toEqual([]);
    const manifestPath = path.join(h.out, MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) return;
    for (const [rel, entry] of Object.entries(manifestOf(h.out).docs)) {
        if (entry.body_sha256 == null || edited.includes(rel) || refusedIn(result.stderr, rel)) continue;
        expect(fs.existsSync(path.join(h.out, rel)), `${rel} is tracked with a hash but is not on disk`).toBe(true);
        expect(sha256(fs.readFileSync(path.join(h.out, rel))), `${rel} does not match its recorded hash`).toBe(entry.body_sha256);
    }
}

const emptySnapshot = (): Snapshot => ({ entries: {}, inodes: {} });
const snapshotOrEmpty = (dir: string): Snapshot => (fs.existsSync(dir) ? snapshot(dir) : emptySnapshot());

/** A snapshot without `rels` (the manifest file's inode always changes: it is rewritten by a rename). */
function without(snap: Snapshot, rels: string[]): Snapshot {
    const entries = { ...snap.entries };
    const inodes = { ...snap.inodes };
    for (const rel of rels) {
        delete entries[rel];
        delete inodes[rel];
    }
    return { entries, inodes };
}

/** What one row's pull must print (every stream, in full), by outcome: one doc, so a stop has written 0 of 1, a manifest failure 1 of 1. */
function expectedFor(form: string, state: State, outcome: Outcome, targetRel: string): Expected {
    switch (outcome) {
        case 'success':
            return pulledOk(h.out, [targetRel], form === 'single' && state !== 'new' ? singleDocWarning : '');
        case 'fail-rename:1':
            return failed(cannotWriteLine(targetRel, 'rename', 0, 1));
        case 'fail-manifest-temp':
            return failed(manifestNotWrittenLine('open manifest temp', 1, 1));
        case 'fail-manifest-rename':
            return failed(manifestNotWrittenLine('rename manifest', 1, 1));
        case 'publication refusal':
            return failed(changedLine(targetRel, 0, 1));
    }
}

const ROWS = KINDS.flatMap((kind) => FORMS.flatMap((form) => STATES.flatMap((state) => OUTCOMES.map((outcome) => ({ kind, form, state, outcome })))));

describe('INV-C the manifest never lies', { timeout: 60_000 }, () => {
    it.each(ROWS)('$kind | $form | $state | $outcome', async ({ kind, form, state, outcome }) => {
        const previous = state === 'renamed' ? doc(kind, 5, 'old', 1) : doc(kind, 5, 'item', 1);
        const next = state === 'renamed' ? doc(kind, 5, 'new', 2) : doc(kind, 5, 'item', 2);
        const targetRel = relOf(next);
        if (state !== 'new') await h.seed([previous]);
        const manifestBefore = fs.existsSync(path.join(h.out, MANIFEST_FILE)) ? read(h.out, MANIFEST_FILE) : null;
        const before = snapshotOrEmpty(h.out);
        h.serve([next]);
        const faultSpec = outcome === 'success' ? undefined : outcome === 'publication refusal' ? `create-before-commit:${targetRel}` : outcome;
        const manifestFailed = outcome === 'fail-manifest-temp' || outcome === 'fail-manifest-rename';

        const result = await h.pull(form, next.title, expectedFor(form, state, outcome, targetRel), ['-y'], faultSpec);

        // After a manifest failure the new bytes sit under the old manifest, which the next pull adopts.
        expectManifestHonest(result, manifestFailed ? [targetRel] : []);
        if (outcome === 'success') {
            expect(read(h.out, targetRel)).toBe(next.bytes);
            expect(manifestOf(h.out).docs[targetRel].body_sha256).toBe(sha256(next.bytes));
            if (state === 'renamed') {
                expect(fs.existsSync(path.join(h.out, relOf(previous)))).toBe(false);
                expect(manifestOf(h.out).docs[relOf(previous)]).toBeUndefined();
            }
            return;
        }
        // A pull that stopped, or could not write its manifest: the manifest is the earlier one (or, for a destination
        // with none, one that tracks nothing when a stop recorded it, and none at all when the manifest write failed).
        if (manifestFailed) {
            if (manifestBefore === null) expect(fs.existsSync(path.join(h.out, MANIFEST_FILE))).toBe(false);
            else expect(read(h.out, MANIFEST_FILE)).toBe(manifestBefore);
            expect(read(h.out, targetRel)).toBe(next.bytes);
            if (state === 'renamed') expect(read(h.out, relOf(previous))).toBe(previous.bytes);
        } else {
            if (manifestBefore === null) expect(manifestOf(h.out)).toEqual({ folder_path: 'docs', docs: {} });
            else expect(read(h.out, MANIFEST_FILE)).toBe(manifestBefore);
            const after = snapshotOrEmpty(h.out);
            // The target itself is the racing file after a changed-after-the-check refusal (RACE, a new inode); everything else is as before.
            const skipped = [MANIFEST_FILE, ...(outcome === 'publication refusal' ? [targetRel] : [])];
            expect(without(after, skipped)).toEqual(without(before, skipped));
            if (outcome === 'publication refusal') expect(read(h.out, targetRel)).toBe('RACE');
        }
    });
});

describe('INV-C as a runtime gate (PM ruling 12 rule 4)', { timeout: 60_000 }, () => {
    it.each(KINDS)('%s: a file this pull wrote that is changed before the manifest is recorded stops the pull before the manifest, which stays as it was', async (kind) => {
        const item = (version: number) => doc(kind, 5, 'item', version);
        const rel = relOf(item(1));
        await h.seed([item(1)]);
        const manifestBefore = read(h.out, MANIFEST_FILE);
        h.serve([item(2)]);

        await h.pull('folder', 'item', failed(gateLine(rel, 'its bytes are not the ones the manifest would record', 1, 1)), ['-y'], `change-after-writes:${rel}`);

        expect(read(h.out, rel)).toBe('CHANGED');
        expect(read(h.out, MANIFEST_FILE)).toBe(manifestBefore);
        expect(internalEntries(h.out)).toEqual([]);
    });

    it('a destination with no manifest gets none from a pull the gate stopped', async () => {
        h.serve([doc('md', 5, 'item', 1)]);

        await h.pull('folder', 'item', failed(gateLine('item.md', 'its bytes are not the ones the manifest would record', 1, 1)), ['-y'], 'change-after-writes:item.md');

        expect(fs.readdirSync(h.out)).toEqual(['item.md']);
    });
});

describe('INV-C mixed fixture: a failed download at a tracked path next to a written sibling', { timeout: 60_000 }, () => {
    const failing = (version: number): ServedDoc => ({ ...doc('media', 7, 'pic', version), downloadFails: version > 1 });
    const sibling = (version: number) => doc('md', 8, 'note', version);
    const downloadWarning = 'warn: failed to download media for doc 7 (pic): HTTP 500\n';

    it('success: the failed doc keeps its previous entry and file, the sibling is written', async () => {
        await h.seed([failing(1), sibling(1)]);
        const previousEntry = manifestOf(h.out).docs['pic.png'];
        h.serve([failing(2), sibling(2)]);

        const result = await h.pull('folder', 'pic', pulledOk(h.out, ['note.md'], downloadWarning));

        expect(manifestOf(h.out).docs['pic.png']).toEqual(previousEntry);
        expect(read(h.out, 'pic.png')).toBe(failing(1).bytes);
        expect(read(h.out, 'note.md')).toBe(sibling(2).bytes);
        expect(manifestOf(h.out).docs['note.md'].body_sha256).toBe(sha256(sibling(2).bytes));
        expectManifestHonest(result);
    });

    it('fail-rename:1: the sibling is not written, and the manifest still has the failed doc\'s entry and the sibling\'s earlier one', async () => {
        await h.seed([failing(1), sibling(1)]);
        const manifestBefore = read(h.out, MANIFEST_FILE);
        const previousEntry = manifestOf(h.out).docs['pic.png'];
        const before = snapshot(h.out);
        h.serve([failing(2), sibling(2)]);

        const result = await h.pull('folder', 'pic', failed(cannotWriteLine('note.md', 'rename', 0, 1)), ['-y'], 'fail-rename:1');

        expect(manifestOf(h.out).docs['pic.png']).toEqual(previousEntry);
        expect(read(h.out, 'note.md')).toBe(sibling(1).bytes);
        expect(read(h.out, MANIFEST_FILE)).toBe(manifestBefore);
        expect(without(snapshot(h.out), [MANIFEST_FILE])).toEqual(without(before, [MANIFEST_FILE]));
        expectManifestHonest(result);
    });
});

describe('INV-C: a kept entry whose file was edited is not kept (final review 1, F-M2)', { timeout: 60_000 }, () => {
    const pic = (version: number): ServedDoc => ({ ...doc('media', 7, 'pic', version), downloadFails: version > 1 });
    const note = (version: number) => doc('md', 8, 'note', version);

    it('--overwrite x a tracked media file edited locally x a failed download: the entry is dropped with the usual warning, never kept with a hash the file no longer has', async () => {
        await h.seed([pic(1), note(1)]);
        fs.writeFileSync(path.join(h.out, 'pic.png'), 'MY EDITED PIC');
        h.serve([pic(2), note(2)]);

        const result = await h.pull('folder', 'docs', pulledOk(h.out, ['note.md'], '! doc 7 ("pic") failed to download and pic.png holds a local file; not tracking it — pull again later.\nwarn: failed to download media for doc 7 (pic): HTTP 500\n! kept pic.png — deleted remotely but modified locally\n  (it is now untracked; use `solidactions doc upload` to re-create it)\n'), ['--overwrite']);

        expect(read(h.out, 'pic.png')).toBe('MY EDITED PIC');
        expect(manifestOf(h.out).docs['pic.png']).toBeUndefined();
        expectManifestHonest(result);
    });

    it('--overwrite x a tracked media file that still has its recorded bytes x a failed download: the entry is kept unchanged (cli#183)', async () => {
        await h.seed([pic(1), note(1)]);
        const previousEntry = manifestOf(h.out).docs['pic.png'];
        h.serve([pic(2), note(2)]);

        const result = await h.pull('folder', 'docs', pulledOk(h.out, ['note.md'], 'warn: failed to download media for doc 7 (pic): HTTP 500\n'), ['--overwrite']);

        expect(manifestOf(h.out).docs['pic.png']).toEqual(previousEntry);
        expectManifestHonest(result);
    });

    it('single-doc pull x --overwrite x a tracked media file edited locally x a failed download: the dropped entry is not brought back by the merge, and the other docs keep theirs (R-C3)', async () => {
        await h.seed([pic(1), note(1)]);
        const noteEntry = manifestOf(h.out).docs['note.md'];
        fs.writeFileSync(path.join(h.out, 'pic.png'), 'MY EDITED PIC');
        h.serve([pic(2), note(2)]);

        const result = await h.pull('single', 'pic', { code: 0, stdout: pulledStdout(h.out, []), stderr: `! doc 7 ("pic") failed to download and pic.png holds a local file; not tracking it — pull again later.\nwarn: failed to download media for doc 7 (pic): HTTP 500\n${singleDocWarning}` }, ['--overwrite']);

        expect(read(h.out, 'pic.png')).toBe('MY EDITED PIC');
        expect(manifestOf(h.out).docs['pic.png']).toBeUndefined();
        expect(manifestOf(h.out).docs['note.md']).toEqual(noteEntry);
        expectManifestHonest(result);
    });

    it('single-doc pull x a renamed media doc x a failed download: the old path keeps its file and its entry, and no entry appears at the new path', async () => {
        await h.seed([pic(1), note(1)]);
        const previousEntry = manifestOf(h.out).docs['pic.png'];
        h.serve([{ ...pic(2), title: 'pic2' }, note(2)]);

        const result = await h.pull('single', 'pic2', { code: 0, stdout: pulledStdout(h.out, []), stderr: `! kept pic.png — doc 7 download failed; still tracked as pic.png\nwarn: failed to download media for doc 7 (pic2): HTTP 500\n${singleDocWarning}` });

        expect(manifestOf(h.out).docs['pic.png']).toEqual(previousEntry);
        expect(manifestOf(h.out).docs['pic2.png']).toBeUndefined();
        expect(read(h.out, 'pic.png')).toBe(pic(1).bytes);
        expectManifestHonest(result);
    });
});

describe('INV-C platform rows', { timeout: 60_000 }, () => {
    it.skipIf(!caseInsensitiveFilesystem())('a case-only rename keeps every hash matching its file (needs a case-insensitive filesystem; CI unit tests run on Linux)', async () => {
        await h.seed([doc('md', 5, 'Page', 1)]);
        h.serve([doc('md', 5, 'page', 2)]);

        const result = await h.pull('folder', 'page', pulledOk(h.out, ['page.md']));

        expectManifestHonest(result);
        expect(Object.keys(manifestOf(h.out).docs)).toEqual(['page.md']);
    });

    it.skipIf(!normalisingFilesystem())('a doc seeded under the composed spelling of its name and then served under the decomposed one: one file, one entry, its hash matching the file (needs a normalising filesystem; CI unit tests run on Linux)', async () => {
        await h.seed([doc('md', 5, NFC_NAME, 1)]);
        h.serve([doc('md', 5, NFD_NAME, 2)]);
        // The summary names the file as the pull spelled it: either spelling, depending on the filesystem.
        const summary = new RegExp(`^pulled 1 doc → ${escapeRegExp(h.out)}\\n  (${NFC_NAME}|${NFD_NAME})\\.md\\n$`);

        const result = await h.pull('folder', NFD_NAME, { code: 0, stdout: summary, stderr: '' });

        expectManifestHonest(result);
        const entries = Object.entries(manifestOf(h.out).docs);
        expect(entries).toHaveLength(1);
        expect(entries[0][1].body_sha256).toBe(sha256('V2-' + NFD_NAME));
        expect(read(h.out, `${NFC_NAME}.md`)).toBe(`V2-${NFD_NAME}`);
        expect(read(h.out, `${NFD_NAME}.md`)).toBe(`V2-${NFD_NAME}`);
        expect(fs.readdirSync(h.out).filter((name) => name !== MANIFEST_FILE)).toHaveLength(1);
    });
});

/*
 * Final review 3, C1: a retained entry never replaces the tracking of bytes this pull placed. Rename chains (one-way
 * reuse, a swap, a 3-cycle) x the plan in both directions x a write failure at each position: whatever the pull
 * recorded, every hash in the manifest is the bytes on disk at that path. Pruned: none (every position is reachable).
 */
describe('INV-C rename chains: a write failure at any position leaves a manifest whose every hash is the file on disk (final review 3, C1)', { timeout: 60_000 }, () => {
    const CHAINS: Array<{ name: string; hops: Array<[string, string]> }> = [
        { name: 'one-way reuse (a to b, b to c)', hops: [['a', 'b'], ['b', 'c']] },
        { name: 'swap (a to b, b to a)', hops: [['a', 'b'], ['b', 'a']] },
        { name: '3-cycle (a to b, b to c, c to a)', hops: [['a', 'b'], ['b', 'c'], ['c', 'a']] },
    ];
    const ROWS = CHAINS.flatMap((chain) => [false, true].flatMap((reversed) => chain.hops.map((_hop, index) => ({ chain, reversed, failAt: index + 1 }))));

    it.each(ROWS)('$chain.name | plan reversed: $reversed | rename $failAt fails', async ({ chain, reversed, failAt }) => {
        const seeded = chain.hops.map(([from], index) => doc('md', index + 1, from, 1));
        const next = chain.hops.map(([, to], index) => doc('md', index + 1, to, 2));
        const plan = reversed ? [...next].reverse() : next;
        await h.seed(seeded);
        h.serve(plan);
        const failing = plan[failAt - 1];
        // The warning lines about tracking an entry gave up (none, or one per displaced entry) come first, then the error.
        const stderr = new RegExp(`^(! [^\\n]*\\n)*${escapeRegExp(`error: cannot write ${relOf(failing)}: EIO: i/o error, rename (test hook) — ${updatedFiles(failAt - 1, plan.length)} and are tracked; pull again.\n`)}$`);

        const result = await h.pull('folder', 'docs', failed(stderr), ['-y'], `fail-rename:${failAt}`);

        expectManifestHonest(result);
        const manifest = manifestOf(h.out);
        for (const placed of plan.slice(0, failAt - 1)) {
            expect(manifest.docs[relOf(placed)]?.body_sha256, `${relOf(placed)} was written by this pull`).toBe(sha256(placed.bytes));
        }
    });

    it('the swap with the second write failing, exactly: the first doc is tracked at the file this pull wrote for it (and still at its old twin), the second doc loses its entry at that name, and the warning says so before the error', async () => {
        await h.seed([doc('md', 1, 'a', 1), doc('md', 2, 'b', 1)]);
        h.serve([doc('md', 1, 'b', 2), doc('md', 2, 'a', 2)]);
        const warning = '! b.md now holds the file this pull wrote for doc 1 ("b"); doc 2 ("b") was tracked at b.md before and is no longer tracked there\n';

        const result = await h.pull('folder', 'docs', failed(warning + cannotWriteLine('a.md', 'rename', 1, 2)), ['-y'], 'fail-rename:2');

        expect(read(h.out, 'b.md')).toBe('V2-b');
        expect(read(h.out, 'a.md')).toBe('V1-a');
        expect(Object.fromEntries(Object.entries(manifestOf(h.out).docs).map(([rel, entry]) => [rel, [entry.id, entry.body_sha256]]))).toEqual({
            'a.md': [1, sha256('V1-a')],
            'b.md': [1, sha256('V2-b')],
        });
        expectManifestHonest(result);
    });
});

/*
 * Final review 3, I1: every tracking decision that applies to the manifest a stopped pull recorded is printed before the
 * error line. Rows: an edited media file whose download failed (dropped), a failed download over another doc's file
 * (kept: the doc is still listed; kept by the stop: it is gone from the server), and a renamed doc's failed download
 * (its old entry kept, with and without the old file). Every row also has a write that fails.
 */
describe('INV-C stopped pulls report the tracking decisions they recorded (final review 3, I1)', { timeout: 60_000 }, () => {
    const pic = (version: number, title = 'pic'): ServedDoc => ({ ...doc('media', 7, title, version), downloadFails: version > 1 });
    const note = (version: number) => doc('md', 8, 'note', version);
    const stopLine = cannotWriteLine('note.md', 'rename', 0, 1);

    it('--overwrite x a tracked media file edited locally x a failed download x a failed write: the dropped tracking is reported before the write error, and the manifest has neither the picture nor a changed note', async () => {
        await h.seed([pic(1), note(1)]);
        const noteEntry = manifestOf(h.out).docs['note.md'];
        fs.writeFileSync(path.join(h.out, 'pic.png'), 'MY EDITED PIC');
        h.serve([pic(2), note(2)]);

        const result = await h.pull('folder', 'docs', failed(`! doc 7 ("pic") failed to download and pic.png holds a local file; not tracking it — pull again later.\n${stopLine}`), ['--overwrite'], 'fail-rename:1');

        expect(read(h.out, 'pic.png')).toBe('MY EDITED PIC');
        expect(manifestOf(h.out).docs).toEqual({ 'note.md': noteEntry });
        expectManifestHonest(result);
    });

    it('a failed download over a file the manifest tracks for a doc still listed x a failed write: still tracking that doc is reported before the error', async () => {
        await h.seed([doc('media', 9, 'P', 1), note(1)]);
        const otherEntry = manifestOf(h.out).docs['P.png'];
        h.serve([{ ...doc('media', 7, 'P', 2), downloadFails: true }, { ...doc('media', 9, 'old', 2), bulkStatus: 'not_found' }, note(2)]);

        const result = await h.pull('folder', 'docs', failed(`! doc 7 ("P") failed to download and P.png holds doc 9's file ("P"); still tracking it as doc 9 — pull again later\n${stopLine}`), ['-y'], 'fail-rename:1');

        expect(manifestOf(h.out).docs['P.png']).toEqual(otherEntry);
        expect(read(h.out, 'P.png')).toBe('V1-P');
        expectManifestHonest(result);
    });

    it('a failed download over a file the manifest tracks for a doc gone from the server x a failed write: the pull that stopped did not drop that doc\'s entry, so no "no longer tracked" claim is printed and the entry stays for the next pull to propagate', async () => {
        await h.seed([doc('media', 9, 'P', 1), note(1)]);
        const otherEntry = manifestOf(h.out).docs['P.png'];
        h.serve([{ ...doc('media', 7, 'P', 2), downloadFails: true }, note(2)]);

        const result = await h.pull('folder', 'docs', failed(`! doc 7 ("P") failed to download and P.png holds a local file; not tracking it — pull again later.\n${stopLine}`), ['-y'], 'fail-rename:1');

        expect(manifestOf(h.out).docs['P.png']).toEqual(otherEntry);
        expectManifestHonest(result);
    });

    it('a renamed doc whose download failed x a failed write: the kept old file and entry are reported before the error', async () => {
        await h.seed([pic(1), note(1)]);
        const picEntry = manifestOf(h.out).docs['pic.png'];
        h.serve([pic(2, 'pic2'), note(2)]);

        const result = await h.pull('folder', 'docs', failed(`! kept pic.png — doc 7 download failed; still tracked as pic.png\n${stopLine}`), ['-y'], 'fail-rename:1');

        expect(manifestOf(h.out).docs['pic.png']).toEqual(picEntry);
        expect(manifestOf(h.out).docs['pic2.png']).toBeUndefined();
        expectManifestHonest(result);
    });

    it('a renamed doc whose download failed and whose old file is gone x a failed write: the kept entry for the missing file is reported before the error', async () => {
        await h.seed([pic(1), note(1)]);
        const picEntry = manifestOf(h.out).docs['pic.png'];
        fs.unlinkSync(path.join(h.out, 'pic.png'));
        h.serve([pic(2, 'pic2'), note(2)]);

        await h.pull('folder', 'docs', failed(`! doc 7 download failed; still tracked as pic.png, which is not present locally\n${stopLine}`), ['-y'], 'fail-rename:1');

        // The entry stays with its hash for a file that is gone (cli#183): the one state expectManifestHonest does not allow.
        expect(manifestOf(h.out).docs['pic.png']).toEqual(picEntry);
        expect(fs.existsSync(path.join(h.out, 'pic.png'))).toBe(false);
    });

    it('a stopped pull whose manifest could not be written prints no tracking decision: the manifest it would have described was not recorded', async () => {
        await h.seed([pic(1), note(1)]);
        fs.writeFileSync(path.join(h.out, 'pic.png'), 'MY EDITED PIC');
        const manifestBefore = read(h.out, MANIFEST_FILE);
        h.serve([pic(2), note(2)]);

        await h.pull('folder', 'docs', failed(`${manifestNotWrittenLine('rename manifest', 0, 1)}error: cannot write note.md: EIO: i/o error, rename (test hook)\n`), ['--overwrite'], 'fail-rename:1,fail-manifest-rename');

        expect(read(h.out, MANIFEST_FILE)).toBe(manifestBefore);
    });
});

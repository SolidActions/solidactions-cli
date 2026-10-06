/**
 * INV-C, the manifest never lies (spec §1.2, ruling 10). Every row runs the built CLI (`node dist/index.js`) against a
 * real in-process HTTP server with a temp HOME and real files, through the shared harness, which asserts every
 * call's exit status, stdout and stderr.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { FORMS, KINDS, MANIFEST_FILE, NFC_NAME, NFD_NAME, caseInsensitiveFilesystem, doc, escapeRegExp, failed, manifestOf, normalisingFilesystem, pulledOk, read, relOf, sha256, singleDocWarning, snapshot, stagingEntries, useDocPullHarness } from './doc-pull-inv-harness';
import type { CliResult, Expected, ServedDoc, Snapshot } from './doc-pull-inv-harness';

const h = useDocPullHarness();

/*
 * INV-C: the manifest never lies (spec §1.2, ruling 10). After a pull exits (0 or 1), every
 * manifest entry with a `body_sha256` matches the sha256 of the file at its path, unless that
 * path is the one this run's stderr names as refused (the publication-refusal or folder line),
 * or one the row deliberately edited outside the pull. An exit-1 row also leaves the manifest
 * bytes identical to before (or absent, when there was none), and nothing staged.
 * Rows: {markdown, media} x {folder, single-doc} x {new path, unchanged tracked path, renamed
 * doc} x {success, fail-rename:1, fail-manifest-temp, fail-manifest-rename, publication
 * refusal}, then the mixed fixture and the platform rows. Pruned: none; every combination is
 * possible (each pull has exactly one doc, so rename 1 is always reached).
 */

type State = 'new' | 'unchanged' | 'renamed';
type Outcome = 'success' | 'fail-rename:1' | 'fail-manifest-temp' | 'fail-manifest-rename' | 'publication refusal';
const STATES: State[] = ['new', 'unchanged', 'renamed'];
const OUTCOMES: Outcome[] = ['success', 'fail-rename:1', 'fail-manifest-temp', 'fail-manifest-rename', 'publication refusal'];

const refusedIn = (stderr: string, rel: string): boolean =>
    stderr.includes(`error: ${rel} changed after doc pull checked it`) || stderr.includes(`error: ${rel} is a folder now`);

/** The invariant itself: see the header. `edited` lists paths the row changed outside the pull. */
function expectManifestHonest(result: CliResult, manifestBefore: string | null, edited: string[] = []): void {
    const manifestPath = path.join(h.out, MANIFEST_FILE);
    if (result.code !== 0) {
        if (manifestBefore === null) expect(fs.existsSync(manifestPath)).toBe(false);
        else expect(read(h.out, MANIFEST_FILE)).toBe(manifestBefore);
        expect(stagingEntries(h.out)).toEqual([]);
    }
    if (!fs.existsSync(manifestPath)) return;
    for (const [rel, entry] of Object.entries(manifestOf(h.out).docs)) {
        if (entry.body_sha256 == null || edited.includes(rel) || refusedIn(result.stderr, rel)) continue;
        expect(fs.existsSync(path.join(h.out, rel)), `${rel} is tracked with a hash but is not on disk`).toBe(true);
        expect(sha256(fs.readFileSync(path.join(h.out, rel))), `${rel} does not match its recorded hash`).toBe(entry.body_sha256);
    }
}

const emptySnapshot = (): Snapshot => ({ entries: {}, inodes: {} });
const snapshotOrEmpty = (dir: string): Snapshot => (fs.existsSync(dir) ? snapshot(dir) : emptySnapshot());

/** The error line of an injected write failure that rolled back cleanly. */
const cannotWrite = (rel: string, what: string): string => `error: cannot write ${rel}: EIO: i/o error, ${what} (test hook) — nothing was changed.\n`;

/** What one row's pull must print (every stream, in full), by outcome. */
function expectedFor(form: string, state: State, outcome: Outcome, targetRel: string): Expected {
    switch (outcome) {
        case 'success':
            return pulledOk(h.out, [targetRel], form === 'single' && state !== 'new' ? singleDocWarning : '');
        case 'fail-rename:1':
            return failed(cannotWrite(targetRel, 'rename'));
        case 'fail-manifest-temp':
            return failed(cannotWrite(MANIFEST_FILE, 'open manifest.tmp'));
        case 'fail-manifest-rename':
            return failed(cannotWrite(MANIFEST_FILE, 'rename manifest'));
        case 'publication refusal':
            return failed(`error: ${targetRel} changed after doc pull checked it — nothing was changed. Pull again, or pass --overwrite to replace it.\n`);
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

        const result = await h.pull(form, next.title, expectedFor(form, state, outcome, targetRel), ['-y'], faultSpec);

        expectManifestHonest(result, manifestBefore);
        if (outcome === 'success') {
            expect(read(h.out, targetRel)).toBe(next.bytes);
            expect(manifestOf(h.out).docs[targetRel].body_sha256).toBe(sha256(next.bytes));
            if (state === 'renamed') {
                expect(fs.existsSync(path.join(h.out, relOf(previous)))).toBe(false);
                expect(manifestOf(h.out).docs[relOf(previous)]).toBeUndefined();
            }
        } else if (outcome === 'publication refusal') {
            expect(read(h.out, targetRel)).toBe('RACE');
            // The target itself is the racing file now (RACE, a new inode); everything else is as before.
            const after = snapshotOrEmpty(h.out);
            for (const snap of [before, after]) {
                delete snap.entries[targetRel];
                delete snap.inodes[targetRel];
            }
            expect(after).toEqual(before);
        } else {
            expect(snapshotOrEmpty(h.out)).toEqual(before);
        }
    });
});

describe('INV-C mixed fixture: a failed download at a tracked path next to a staged sibling', { timeout: 60_000 }, () => {
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
        expectManifestHonest(result, null);
    });

    it('fail-rename:1: the sibling is restored, the manifest and the failed doc\'s entry are as before', async () => {
        await h.seed([failing(1), sibling(1)]);
        const manifestBefore = read(h.out, MANIFEST_FILE);
        const previousEntry = manifestOf(h.out).docs['pic.png'];
        const before = snapshot(h.out);
        h.serve([failing(2), sibling(2)]);

        const result = await h.pull('folder', 'pic', failed(cannotWrite('note.md', 'rename')), ['-y'], 'fail-rename:1');

        expect(manifestOf(h.out).docs['pic.png']).toEqual(previousEntry);
        expect(read(h.out, 'note.md')).toBe(sibling(1).bytes);
        expect(snapshot(h.out)).toEqual(before);
        expectManifestHonest(result, manifestBefore);
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
        expectManifestHonest(result, null);
    });

    it('--overwrite x a tracked media file that still has its recorded bytes x a failed download: the entry is kept unchanged (cli#183)', async () => {
        await h.seed([pic(1), note(1)]);
        const previousEntry = manifestOf(h.out).docs['pic.png'];
        h.serve([pic(2), note(2)]);

        const result = await h.pull('folder', 'docs', pulledOk(h.out, ['note.md'], 'warn: failed to download media for doc 7 (pic): HTTP 500\n'), ['--overwrite']);

        expect(manifestOf(h.out).docs['pic.png']).toEqual(previousEntry);
        expectManifestHonest(result, null);
    });
});

describe('INV-C platform rows', { timeout: 60_000 }, () => {
    it.skipIf(!caseInsensitiveFilesystem())('a case-only rename keeps every hash matching its file (needs a case-insensitive filesystem; CI unit tests run on Linux)', async () => {
        await h.seed([doc('md', 5, 'Page', 1)]);
        h.serve([doc('md', 5, 'page', 2)]);

        const result = await h.pull('folder', 'page', pulledOk(h.out, ['page.md']));

        expectManifestHonest(result, null);
        expect(Object.keys(manifestOf(h.out).docs)).toEqual(['page.md']);
    });

    it.skipIf(!normalisingFilesystem())('a doc seeded under the composed spelling of its name and then served under the decomposed one: one file, one entry, its hash matching the file (needs a normalising filesystem; CI unit tests run on Linux)', async () => {
        await h.seed([doc('md', 5, NFC_NAME, 1)]);
        h.serve([doc('md', 5, NFD_NAME, 2)]);
        // The summary names the file as the pull spelled it: either spelling, depending on the filesystem.
        const summary = new RegExp(`^pulled 1 doc → ${escapeRegExp(h.out)}\\n  (${NFC_NAME}|${NFD_NAME})\\.md\\n$`);

        const result = await h.pull('folder', NFD_NAME, { code: 0, stdout: summary, stderr: '' });

        expectManifestHonest(result, null);
        const entries = Object.entries(manifestOf(h.out).docs);
        expect(entries).toHaveLength(1);
        expect(entries[0][1].body_sha256).toBe(sha256('V2-' + NFD_NAME));
        expect(read(h.out, `${NFC_NAME}.md`)).toBe(`V2-${NFD_NAME}`);
        expect(read(h.out, `${NFD_NAME}.md`)).toBe(`V2-${NFD_NAME}`);
        expect(fs.readdirSync(h.out).filter((name) => name !== MANIFEST_FILE)).toHaveLength(1);
    });
});

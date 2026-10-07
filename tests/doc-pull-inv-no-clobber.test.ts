/**
 * INV-B, no clobber (spec §1.2, ruling 9). Every row runs the built CLI (`node dist/index.js`) against a real
 * in-process HTTP server with a temp HOME and real files, through the shared harness, which asserts every
 * call's exit status, stdout and stderr.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { KINDS, MANIFEST_FILE, NFC_NAME, NFD_NAME, cannotWriteLine, caseInsensitiveFilesystem, changedLine, doc, failed, folderLine, internalEntries, manifestNotWrittenLine, manifestOf, normalisingFilesystem, pulledOk, pulledStdout, read, relOf, sha256, snapshot, useDocPullHarness } from './doc-pull-inv-harness';

const h = useDocPullHarness();

/*
 * INV-B: a pull never replaces bytes it does not own (spec §1.2, rulings 9 and the wave
 * cli-safety rules). Rows: {an untracked file at the target at preflight, a file created at the
 * target after the checks, a tracked file rewritten after the checks} x {without --overwrite:
 * refused, the bytes unchanged; with --overwrite: replaced} x {markdown, media}; one composed row
 * (a late file replaced under --overwrite, then a failed write stops the pull); the late-folder
 * rows (ruling 9); the rows for names the pull keeps for itself and for user entries that look
 * like the old staging folders (nothing the pull did not create is ever deleted); the alias rows;
 * and the platform rows. Pruned: none; the pull form is folder throughout, because the single-doc
 * form shares the same write loop and INV-C and INV-A sweep it.
 */

/** A pull that stopped at its only doc: it changed after the check, nothing was written before it. */
const racedLine = (rel: string): string => changedLine(rel, 0, 1);

describe.each(KINDS)('INV-B no clobber: %s', { timeout: 60_000 }, (kind) => {
    const item = (version: number) => doc(kind, 5, 'item', version);
    const rel = relOf(item(1));

    describe('an untracked file at the target at preflight', () => {
        it('without --overwrite: refused, the bytes unchanged, nothing else written', async () => {
            fs.mkdirSync(h.out);
            fs.writeFileSync(path.join(h.out, rel), 'LOCAL');
            const before = snapshot(h.out);
            h.serve([item(1)]);

            await h.pull('folder', 'item', failed(`1 file exists locally but is not tracked:\n  ${rel}\nMove them aside and pull again, or pass --overwrite to replace them.\n`));

            expect(snapshot(h.out)).toEqual(before);
        });

        it('with --overwrite: replaced', async () => {
            fs.mkdirSync(h.out);
            fs.writeFileSync(path.join(h.out, rel), 'LOCAL');
            h.serve([item(1)]);

            await h.pull('folder', 'item', pulledOk(h.out, [rel]), ['--overwrite']);

            expect(read(h.out, rel)).toBe(item(1).bytes);
            expect(internalEntries(h.out)).toEqual([]);
        });
    });

    describe('a file created at the target after the checks', () => {
        it('without --overwrite: refused, the late file keeps its bytes, and the manifest tracks nothing', async () => {
            h.serve([item(1)]);

            await h.pull('folder', 'item', failed(racedLine(rel)), ['-y'], `create-before-commit:${rel}`);

            expect(read(h.out, rel)).toBe('RACE');
            expect(fs.readdirSync(h.out).sort()).toEqual([MANIFEST_FILE, rel]);
            expect(manifestOf(h.out)).toEqual({ folder_path: 'docs', docs: {} });
        });

        it('with --overwrite: replaced by the served bytes', async () => {
            h.serve([item(1)]);

            await h.pull('folder', 'item', pulledOk(h.out, [rel]), ['--overwrite'], `create-before-commit:${rel}`);

            expect(read(h.out, rel)).toBe(item(1).bytes);
            expect(internalEntries(h.out)).toEqual([]);
        });
    });

    describe('a tracked file rewritten after the checks', () => {
        it('without --overwrite: refused, the rewrite keeps its bytes, and the manifest still tracks the doc as before', async () => {
            await h.seed([item(1)]);
            const manifestBefore = read(h.out, MANIFEST_FILE);
            h.serve([item(2)]);

            await h.pull('folder', 'item', failed(racedLine(rel)), ['-y'], `create-before-commit:${rel}`);

            expect(read(h.out, rel)).toBe('RACE');
            expect(read(h.out, MANIFEST_FILE)).toBe(manifestBefore);
            expect(internalEntries(h.out)).toEqual([]);
        });

        it('with --overwrite: replaced by the served bytes, and the manifest tracks them', async () => {
            await h.seed([item(1)]);
            h.serve([item(2)]);

            await h.pull('folder', 'item', pulledOk(h.out, [rel]), ['--overwrite'], `create-before-commit:${rel}`);

            expect(read(h.out, rel)).toBe(item(2).bytes);
            expect(manifestOf(h.out).docs[rel].body_sha256).toBe(sha256(item(2).bytes));
        });
    });

    describe('a folder created at the target after the checks (ruling 9)', () => {
        it.each([
            ['without --overwrite', ['-y']],
            ['with --overwrite', ['--overwrite']],
        ])('%s: refused, the folder and its file untouched, nothing else written', async (_name, flags) => {
            h.serve([item(1)]);

            await h.pull('folder', 'item', failed(folderLine(rel, 0, 1)), flags, `mkdir-before-commit:${rel}`);

            expect(read(h.out, rel, 'user.txt')).toBe('USER');
            expect(fs.readdirSync(h.out).sort()).toEqual([MANIFEST_FILE, rel]);
        });
    });
});

describe('INV-B: the authorized state is the one the checks saw (PM ruling 11)', { timeout: 60_000 }, () => {
    it('a file that appears right after the checks, at a target the checks saw absent, is refused and keeps its bytes', async () => {
        h.serve([doc('md', 5, 'item', 1)]);

        await h.pull('folder', 'item', failed(racedLine('item.md')), ['-y'], 'create-after-checks:item.md');

        expect(read(h.out, 'item.md')).toBe('RACE');
        expect(fs.readdirSync(h.out).sort()).toEqual([MANIFEST_FILE, 'item.md']);
    });

    it('a tracked file rewritten right after the checks, which saw its recorded bytes, is refused and keeps the rewrite', async () => {
        await h.seed([doc('md', 5, 'item', 1)]);
        const manifestBefore = read(h.out, MANIFEST_FILE);
        h.serve([doc('md', 5, 'item', 2)]);

        await h.pull('folder', 'item', failed(racedLine('item.md')), ['-y'], 'create-after-checks:item.md');

        expect(read(h.out, 'item.md')).toBe('RACE');
        expect(read(h.out, MANIFEST_FILE)).toBe(manifestBefore);
        expect(internalEntries(h.out)).toEqual([]);
    });

    it('under --overwrite the same file is replaced: any state was authorized', async () => {
        h.serve([doc('md', 5, 'item', 1)]);

        await h.pull('folder', 'item', pulledOk(h.out, ['item.md']), ['--overwrite'], 'create-after-checks:item.md');

        expect(read(h.out, 'item.md')).toBe('V1-item');
    });
});

describe('INV-B: names doc pull keeps for itself are never a doc path (final review 1, C1; PM ruling 12 rule 2)', { timeout: 60_000 }, () => {
    const mediaTitled = (title: string) => ({ ...doc('media', 5, title, 1) });

    it('a media doc titled like the manifest is written under a different name, and the manifest stays honest', async () => {
        const served = mediaTitled(MANIFEST_FILE);
        h.serve([served]);

        await h.pull('folder', 'docs', pulledOk(h.out, [`_${MANIFEST_FILE}`]));

        expect(read(h.out, `_${MANIFEST_FILE}`)).toBe(served.bytes);
        expect(manifestOf(h.out).docs[`_${MANIFEST_FILE}`].body_sha256).toBe(sha256(served.bytes));
        expect(Object.keys(manifestOf(h.out).docs)).toEqual([`_${MANIFEST_FILE}`]);
    });

    it('a media doc titled like the manifest in another spelling of its case is also kept apart', async () => {
        const upper = MANIFEST_FILE.toUpperCase();
        h.serve([mediaTitled(upper)]);

        await h.pull('folder', 'docs', pulledOk(h.out, [`_${upper}`]));

        expect(Object.keys(manifestOf(h.out).docs)).toEqual([`_${upper}`]);
    });

    it.each([`${MANIFEST_FILE}.lock`, `${MANIFEST_FILE}.LOCK`, '.sa-write-1-abc.tmp'])('a remote folder named %s is written under a different folder name, never into a name the pull keeps', async (folder) => {
        h.serve([{ ...doc('md', 5, 'a', 1), relative: folder }]);

        await h.pull('folder', 'docs', pulledOk(h.out, [`_${folder}/a.md`]));

        expect(read(h.out, `_${folder}`, 'a.md')).toBe('V1-a');
        expect(Object.keys(manifestOf(h.out).docs)).toEqual([`_${folder}/a.md`]);
        expect(internalEntries(h.out)).toEqual([]);
    });

    it('a doc titled like a temp file is written under a different name, and a second pull is stable', async () => {
        const served = doc('md', 5, '.sa-write-12345', 1);
        h.serve([served]);

        await h.pull('folder', 'docs', pulledOk(h.out, ['_.sa-write-12345.md']));
        await h.pull('folder', 'docs', pulledOk(h.out, ['_.sa-write-12345.md']));

        expect(read(h.out, '_.sa-write-12345.md')).toBe(served.bytes);
    });

    it('a remote folder named like an old staging folder is an ordinary folder: its docs and the edits made to them survive the next pull', async () => {
        const name = '.solidactions-pull-900123';
        h.serve([{ ...doc('md', 5, 'a', 1), relative: name }]);
        await h.pull('folder', 'docs', pulledOk(h.out, [`${name}/a.md`]));
        const kept = path.join(h.out, name, 'a.md');
        fs.writeFileSync(kept, 'MY UNPUSHED EDIT');
        h.serve([{ ...doc('md', 5, 'a', 2), relative: name }]);

        await h.pull('folder', 'docs', failed(`1 file has unpushed local changes:\n  ${name}/a.md\npush your changes first, or pass --overwrite to discard them.\n`));

        expect(fs.readFileSync(kept, 'utf8')).toBe('MY UNPUSHED EDIT');
    });

    it('a user folder named like an old staging folder, holding the user\'s own docs, is never scanned, classified or deleted by a pull (R-C1)', async () => {
        const name = '.solidactions-pull-900124';
        fs.mkdirSync(path.join(h.out, name, 'backup'), { recursive: true });
        fs.writeFileSync(path.join(h.out, name, 'a.md'), 'MY EDITED DOC');
        fs.writeFileSync(path.join(h.out, name, 'backup', 'b.md'), 'MY OTHER DOC');
        const before = snapshot(h.out);
        h.serve([doc('md', 5, 'a', 1)]);

        await h.pull('folder', 'docs', pulledOk(h.out, ['a.md']));

        const after = snapshot(h.out);
        for (const [rel, state] of Object.entries(before.entries)) expect(after.entries[rel], rel).toBe(state);
        for (const [rel, inode] of Object.entries(before.inodes)) expect(after.inodes[rel], rel).toBe(inode);
        expect(read(h.out, 'a.md')).toBe('V1-a');
    });

    it('a user file named like an old staging folder is left alone too, through a pull that stops on an error', async () => {
        fs.mkdirSync(h.out);
        fs.writeFileSync(path.join(h.out, '.solidactions-pull-7'), 'MY FILE');
        h.serve([doc('md', 5, 'a', 1)]);

        await h.pull('folder', 'docs', failed(cannotWriteLine('a.md', 'rename', 0, 1)), ['-y'], 'fail-rename:1');

        expect(read(h.out, '.solidactions-pull-7')).toBe('MY FILE');
    });
});

describe('INV-B: names that differ only by normalisation or case are distinct files on every filesystem (final review 1, C4)', { timeout: 60_000 }, () => {
    const first = (version: number) => doc('md', 1, NFC_NAME, version);
    const second = (version: number) => doc('md', 2, NFD_NAME, version);
    const files = [`${NFC_NAME}.md`, `${NFD_NAME}-2.md`];

    it('two docs whose titles are the composed and the decomposed spelling get two files, and the manifest records each one\'s own bytes', async () => {
        h.serve([first(1), second(1)]);

        await h.pull('folder', 'docs', pulledOk(h.out, files));

        expect(read(h.out, files[0])).toBe(first(1).bytes);
        expect(read(h.out, files[1])).toBe(second(1).bytes);
        expect(manifestOf(h.out).docs[files[0]].body_sha256).toBe(sha256(first(1).bytes));
        expect(manifestOf(h.out).docs[files[1]].body_sha256).toBe(sha256(second(1).bytes));
    });

    it('under --overwrite over two existing files both are replaced, each with its own bytes', async () => {
        fs.mkdirSync(h.out);
        fs.writeFileSync(path.join(h.out, files[0]), 'LOCAL ONE');
        fs.writeFileSync(path.join(h.out, files[1]), 'LOCAL TWO');
        h.serve([first(1), second(1)]);

        await h.pull('folder', 'docs', pulledOk(h.out, files), ['--overwrite']);

        expect(read(h.out, files[0])).toBe(first(1).bytes);
        expect(read(h.out, files[1])).toBe(second(1).bytes);
        expect(manifestOf(h.out).docs[files[1]].body_sha256).toBe(sha256(second(1).bytes));
    });

    it('under --overwrite a manifest failure after both files were written leaves each with its own bytes, and no manifest', async () => {
        fs.mkdirSync(h.out);
        fs.writeFileSync(path.join(h.out, files[0]), 'LOCAL ONE');
        fs.writeFileSync(path.join(h.out, files[1]), 'LOCAL TWO');
        h.serve([first(1), second(1)]);

        await h.pull('folder', 'docs', failed(manifestNotWrittenLine('rename manifest', 2, 2)), ['--overwrite'], 'fail-manifest-rename');

        expect(read(h.out, files[0])).toBe(first(1).bytes);
        expect(read(h.out, files[1])).toBe(second(1).bytes);
        expect(fs.existsSync(path.join(h.out, MANIFEST_FILE))).toBe(false);
        expect(internalEntries(h.out)).toEqual([]);
    });

    it('two folders whose names are the composed and the decomposed spelling get two folders', async () => {
        h.serve([{ ...doc('md', 1, 'a', 1), relative: NFC_NAME }, { ...doc('md', 2, 'b', 1), relative: NFD_NAME }]);

        await h.pull('folder', 'docs', pulledOk(h.out, [`${NFC_NAME}/a.md`, `${NFD_NAME}-2/b.md`]));

        expect(read(h.out, `${NFC_NAME}/a.md`)).toBe('V1-a');
        expect(read(h.out, `${NFD_NAME}-2/b.md`)).toBe('V1-b');
    });

    it('under --overwrite two aliased folders with existing files: both written with their own bytes, and a manifest failure leaves them that way', async () => {
        fs.mkdirSync(path.join(h.out, NFC_NAME), { recursive: true });
        fs.mkdirSync(path.join(h.out, `${NFD_NAME}-2`));
        fs.writeFileSync(path.join(h.out, NFC_NAME, 'a.md'), 'LOCAL A');
        fs.writeFileSync(path.join(h.out, `${NFD_NAME}-2`, 'a.md'), 'LOCAL B');
        h.serve([{ ...doc('md', 1, 'a', 1), relative: NFC_NAME }, { ...doc('md', 2, 'a', 1), relative: NFD_NAME }]);

        await h.pull('folder', 'docs', failed(manifestNotWrittenLine('rename manifest', 2, 2)), ['--overwrite'], 'fail-manifest-rename');

        expect(read(h.out, NFC_NAME, 'a.md')).toBe('V1-a');
        expect(read(h.out, `${NFD_NAME}-2`, 'a.md')).toBe('V1-a');
        expect(fs.existsSync(path.join(h.out, MANIFEST_FILE))).toBe(false);
    });

    it('two folders differing only by case are two folders, and the doc names inside keep their own', async () => {
        h.serve([{ ...doc('md', 1, 'a', 1), relative: 'Dir' }, { ...doc('md', 2, 'b', 1), relative: 'dir' }]);

        await h.pull('folder', 'docs', pulledOk(h.out, ['Dir/a.md', 'dir-2/b.md']));
    });

    it('a previous manifest that tracks two docs at paths that are one entry on some filesystem is refused before anything is written', async () => {
        fs.mkdirSync(h.out);
        fs.writeFileSync(path.join(h.out, 'Page.md'), 'V1-Page');
        fs.writeFileSync(path.join(h.out, 'page.md'), 'V1-page');
        fs.writeFileSync(path.join(h.out, MANIFEST_FILE), JSON.stringify({
            folder_path: 'docs',
            docs: {
                'Page.md': { id: 1, title: 'Page', current_revision_id: 11, media: false, body_sha256: sha256('V1-Page') },
                'page.md': { id: 2, title: 'page', current_revision_id: 12, media: false, body_sha256: sha256('V1-page') },
            },
        }));
        const before = snapshot(h.out);
        h.serve([doc('md', 1, 'Page', 2), doc('md', 2, 'page', 2)]);

        await h.pull('folder', 'docs', failed('error: Page.md (doc 1) and page.md (doc 2) would be the same file on a case-insensitive or Unicode-normalising filesystem; this pull would write different docs through those names.\nNothing was written. Rename one of the docs on the server and pull again.\n'));

        expect(snapshot(h.out)).toEqual(before);
    });

    /** R-C4: entries a single-doc pull keeps for other docs are checked against every key of the final manifest (the INV-C gate, rule 4). */
    it.each([
        ['case', 'Page', 'page'],
        ['normalisation', NFC_NAME, NFD_NAME],
    ])('a single-doc pull whose kept entries for other docs alias each other (%s) writes its own file and refuses to record a manifest with the alias', async (_kind, one, two) => {
        fs.mkdirSync(h.out);
        const retained = JSON.stringify({
            folder_path: 'docs',
            docs: {
                [`${one}.md`]: { id: 1, title: one, current_revision_id: 11, media: false, body_sha256: sha256('V1-one') },
                [`${two}.md`]: { id: 2, title: two, current_revision_id: 12, media: false, body_sha256: sha256('V1-two') },
            },
        });
        fs.writeFileSync(path.join(h.out, MANIFEST_FILE), retained);
        h.serve([doc('md', 3, 'other', 1)]);

        await h.pull('single', 'other', failed(`error: doc pull stopped before recording a manifest that would not match the files (${two}.md: the same file as ${one}.md on a case-insensitive or Unicode-normalising filesystem) — 1 of 1 files were updated; the manifest was not changed.\n`));

        expect(read(h.out, 'other.md')).toBe('V1-other');
        expect(read(h.out, MANIFEST_FILE)).toBe(retained);
        expect(internalEntries(h.out)).toEqual([]);
    });

    it('a stopped folder pull keeps the earlier entries of docs it did not list, so a doc deleted remotely stays tracked for the next pull to propagate', async () => {
        await h.seed([doc('md', 1, 'a', 1), doc('md', 2, 'gone', 1)]);
        const goneEntry = manifestOf(h.out).docs['gone.md'];
        h.serve([doc('md', 1, 'a', 2)]);

        await h.pull('folder', 'docs', failed(cannotWriteLine('a.md', 'rename', 0, 1)), ['-y'], 'fail-rename:1');

        expect(manifestOf(h.out).docs['gone.md']).toEqual(goneEntry);
        expect(manifestOf(h.out).docs['a.md'].body_sha256).toBe(sha256('V1-a'));
        await h.pull('folder', 'docs', { code: 0, stdout: pulledStdout(h.out, ['a.md'], ['gone.md']), stderr: '' }, ['-y']);
        expect(fs.existsSync(path.join(h.out, 'gone.md'))).toBe(false);
        expect(read(h.out, 'a.md')).toBe('V2-a');
    });
});

describe('INV-B: a file that already holds the bytes the pull would write is never a conflict (PM ruling 12 rule 5)', { timeout: 60_000 }, () => {
    it.each(KINDS)('%s: a tracked file holding the served bytes under an older recorded hash is adopted without --overwrite, and the manifest then records the new hash', async (kind) => {
        const item = (version: number) => doc(kind, 5, 'item', version);
        const rel = relOf(item(1));
        await h.seed([item(1)]);
        fs.writeFileSync(path.join(h.out, rel), item(2).bytes);
        h.serve([item(2)]);

        await h.pull('folder', 'item', pulledOk(h.out, [rel]), ['-y']);

        expect(read(h.out, rel)).toBe(item(2).bytes);
        expect(manifestOf(h.out).docs[rel].body_sha256).toBe(sha256(item(2).bytes));
    });

    it.each(KINDS)('%s: a tracked file holding other bytes than the served ones is still an unpushed local change', async (kind) => {
        const item = (version: number) => doc(kind, 5, 'item', version);
        const rel = relOf(item(1));
        await h.seed([item(1)]);
        fs.writeFileSync(path.join(h.out, rel), 'MY OWN EDIT');
        h.serve([item(2)]);

        await h.pull('folder', 'item', failed(`1 file has unpushed local changes:\n  ${rel}\npush your changes first, or pass --overwrite to discard them.\n`), ['-y']);

        expect(read(h.out, rel)).toBe('MY OWN EDIT');
    });
});

describe('INV-B composed: a late file replaced under --overwrite stays replaced when a later write fails', { timeout: 60_000 }, () => {
    it('the replaced file holds the served bytes and is tracked, the second doc is not written, and the line counts one of two', async () => {
        h.serve([doc('md', 5, 'item', 1), doc('md', 6, 'zz', 1)]);

        await h.pull('folder', 'item', failed(cannotWriteLine('zz.md', 'rename', 1, 2)), ['--overwrite'], 'create-before-commit:item.md,fail-rename:2');

        expect(read(h.out, 'item.md')).toBe('V1-item');
        expect(fs.existsSync(path.join(h.out, 'zz.md'))).toBe(false);
        expect(Object.keys(manifestOf(h.out).docs)).toEqual(['item.md']);
        expect(manifestOf(h.out).docs['item.md'].body_sha256).toBe(sha256('V1-item'));
        expect(internalEntries(h.out)).toEqual([]);
    });
});

describe('INV-B platform rows', { timeout: 60_000 }, () => {
    it.skipIf(!caseInsensitiveFilesystem())('a case-only rename on one file under two names adopts it and never loses it (needs a case-insensitive filesystem; CI unit tests run on Linux)', async () => {
        await h.seed([doc('md', 5, 'Page', 1)]);
        h.serve([doc('md', 5, 'page', 2)]);

        await h.pull('folder', 'page', pulledOk(h.out, ['page.md']));

        expect(Object.keys(manifestOf(h.out).docs)).toEqual(['page.md']);
        expect(read(h.out, 'page.md')).toBe('V2-page');
        expect(fs.readdirSync(h.out).filter((name) => name !== MANIFEST_FILE)).toHaveLength(1);
    });

    it.skipIf(!normalisingFilesystem())('an untracked file under the decomposed spelling of a target name is refused, not replaced (needs a normalising filesystem; CI unit tests run on Linux)', async () => {
        fs.mkdirSync(h.out);
        fs.writeFileSync(path.join(h.out, `${NFD_NAME}.md`), 'LOCAL');
        h.serve([doc('md', 5, NFC_NAME, 1)]);

        // The listing prints the name as the directory read returns it: either spelling, depending on the filesystem.
        const untracked = new RegExp(`^1 file exists locally but is not tracked:\\n  (${NFC_NAME}|${NFD_NAME})\\.md\\nMove them aside and pull again, or pass --overwrite to replace them\\.\\n$`);

        await h.pull('folder', NFC_NAME, failed(untracked));

        expect(read(h.out, `${NFD_NAME}.md`)).toBe('LOCAL');
    });
});

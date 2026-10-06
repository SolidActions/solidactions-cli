/**
 * INV-A, never outside the destination (cli#168, cli#188, cli#182; spec §1.2). Every row runs the
 * built CLI (`node dist/index.js`) against a real in-process HTTP server with a temp HOME and real files,
 * through the shared harness, which asserts every call's exit status, stdout and stderr.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { FORMS, KINDS, cannotWriteLine, changedLine, doc, failed, internalEntries, manifestNotWrittenLine, pulledOk, read, relOf, singleDocWarning, snapshot, useDocPullHarness } from './doc-pull-inv-harness';
import type { Snapshot } from './doc-pull-inv-harness';

const h = useDocPullHarness();

/*
 * INV-A: a pull never reads or writes outside the destination, and never through a link
 * (cli#168, cli#188, cli#182; spec §1.2). Every row ends the same way: every file outside the
 * destination keeps its bytes and its inode. Rows are {markdown, media} x {folder, single-doc}
 * x the link cases (a)-(d), then a folder swapped for a link right before the writes, then the
 * platform row. The pull has no reverse path (no restore, no removal of anything it wrote), so
 * there is nothing else to go through a link. Pruned: none. Case (d)'s injected failure is
 * `fail-rename:2` for the folder form (a second doc follows the hard-linked one); the single-doc
 * pull has one doc, so it uses `fail-manifest-rename`, the failure that also comes after the
 * doc's rename.
 */

function expectOutsideUnchanged(before: Snapshot): void {
    const after = snapshot(h.outside);
    expect(after.entries).toEqual(before.entries);
    expect(after.inodes).toEqual(before.inodes);
}


describe.each(KINDS.flatMap((kind) => FORMS.map((form) => [kind, form] as const)))('INV-A never outside the destination: %s | %s', { timeout: 60_000 }, (kind, form) => {
    const item = (version: number) => doc(kind, 5, 'item', version);
    const rel = relOf(item(1));
    /** A single-doc pull into a destination that already tracks the folder says so on stderr. */
    const warnsWhenTracked = form === 'single' ? singleDocWarning : '';

    it('(a) a tracked file hard-linked to an outside file: the pull replaces the file, the outside name keeps its bytes and inode', async () => {
        await h.seed([item(1)]);
        fs.linkSync(path.join(h.out, rel), path.join(h.outside, 'hard-link'));
        const before = snapshot(h.outside);
        h.serve([item(2)]);

        await h.pull(form, 'item', pulledOk(h.out, [rel], warnsWhenTracked));

        expect(read(h.out, rel)).toBe(item(2).bytes);
        expect(read(h.outside, 'hard-link')).toBe(item(1).bytes);
        expectOutsideUnchanged(before);
    });

    it('(b) a symlink to an outside file at the target name before the pull: refused, the outside file untouched, the link left', async () => {
        fs.mkdirSync(h.out);
        fs.writeFileSync(path.join(h.outside, 'target.txt'), 'OUTSIDE');
        fs.symlinkSync(path.join(h.outside, 'target.txt'), path.join(h.out, rel));
        const before = snapshot(h.outside);
        h.serve([item(1)]);

        await h.pull(form, 'item', failed(`error: ${rel} is a symbolic link; this pull would write doc 5 ("item") through it.\nReplace it with a regular file or folder and pull again.\n`));

        expect(fs.lstatSync(path.join(h.out, rel)).isSymbolicLink()).toBe(true);
        expectOutsideUnchanged(before);
    });

    it('(c) a symlink planted at the target name after the checks, without --overwrite: refused, the link and the outside file untouched', async () => {
        fs.writeFileSync(path.join(h.outside, 'target.txt'), 'OUTSIDE');
        const before = snapshot(h.outside);
        h.serve([item(1)]);

        await h.pull(form, 'item', failed(changedLine(rel, 0, 1)), ['-y'], `link-before-commit:${rel}>${path.join(h.outside, 'target.txt')}`);

        expect(fs.lstatSync(path.join(h.out, rel)).isSymbolicLink()).toBe(true);
        expectOutsideUnchanged(before);
    });

    it('(c) a symlink planted at the target name after the checks, with --overwrite: the link is replaced by a regular file, the outside file untouched', async () => {
        fs.writeFileSync(path.join(h.outside, 'target.txt'), 'OUTSIDE');
        const before = snapshot(h.outside);
        h.serve([item(1)]);

        await h.pull(form, 'item', pulledOk(h.out, [rel]), ['--overwrite'], `link-before-commit:${rel}>${path.join(h.outside, 'target.txt')}`);

        expect(fs.lstatSync(path.join(h.out, rel)).isFile()).toBe(true);
        expect(read(h.out, rel)).toBe(item(1).bytes);
        expectOutsideUnchanged(before);
    });

    it('(d) a hard-linked tracked file replaced, then an injected failure after its rename: the replacement stays (a new inode), the outside name keeps its bytes and inode', async () => {
        const sibling = (version: number) => doc(kind, 6, 'zz', version);
        await h.seed(form === 'folder' ? [item(1), sibling(1)] : [item(1)]);
        fs.linkSync(path.join(h.out, rel), path.join(h.outside, 'hard-link'));
        const before = snapshot(h.outside);
        const inode = fs.statSync(path.join(h.out, rel)).ino;
        h.serve(form === 'folder' ? [item(2), sibling(2)] : [item(2)]);
        const injected = form === 'folder'
            ? cannotWriteLine(relOf(sibling(2)), 'rename', 1, 2)
            : manifestNotWrittenLine('rename manifest', 1, 1);

        await h.pull(form, 'item', failed(injected), ['-y'], form === 'folder' ? 'fail-rename:2' : 'fail-manifest-rename');

        expect(read(h.out, rel)).toBe(item(2).bytes);
        expect(fs.statSync(path.join(h.out, rel)).ino).not.toBe(inode);
        expect(read(h.outside, 'hard-link')).toBe(item(1).bytes);
        expect(fs.statSync(path.join(h.outside, 'hard-link')).ino).toBe(inode);
        expectOutsideUnchanged(before);
        expect(internalEntries(h.out)).toEqual([]);
    });
});

describe('INV-A: a folder of the destination swapped for a link right before the writes', { timeout: 60_000 }, () => {
    it('stops at the doc under that folder with the link refusal, and nothing outside changes', async () => {
        fs.writeFileSync(path.join(h.outside, 'b.md'), 'OUTSIDE');
        const before = snapshot(h.outside);
        h.serve([doc('md', 5, 'b', 1, 'sub')]);

        await h.pull('folder', 'b', failed('error: sub/b.md is a symbolic link (or sits under one: sub); this pull would write doc 5 ("b") through it.\nReplace it with a regular file or folder and pull again.\n'), ['-y'], `link-before-commit:sub>${h.outside}`);

        expectOutsideUnchanged(before);
        expect(internalEntries(h.out)).toEqual([]);
    });

    it('a created folder that is a link by the time the next doc is written is never written into either', async () => {
        const first = doc('md', 5, 'a', 1, 'x');
        h.serve([first, doc('md', 6, 'c', 1, 'y')]);
        fs.writeFileSync(path.join(h.outside, 'keep.txt'), 'KEEP');
        const before = snapshot(h.outside);

        await h.pull('folder', 'docs', failed('error: y/c.md is a symbolic link (or sits under one: y); this pull would write doc 6 ("c") through it.\nReplace it with a regular file or folder and pull again.\n'), ['-y'], `link-before-commit:y>${h.outside}`);

        expectOutsideUnchanged(before);
        expect(read(h.out, 'x', 'a.md')).toBe(first.bytes);
    });
});

describe('INV-A platform rows', { timeout: 60_000 }, () => {
    it.skipIf(fs.constants.O_NOFOLLOW !== undefined)('a link planted at the target after the checks is replaced, never written through (needs a platform without O_NOFOLLOW; CI unit tests run on Linux)', async () => {
        fs.writeFileSync(path.join(h.outside, 'target.txt'), 'OUTSIDE');
        const before = snapshot(h.outside);
        h.serve([doc('md', 5, 'item', 1)]);

        await h.pull('folder', 'item', pulledOk(h.out, ['item.md']), ['--overwrite'], `link-before-commit:item.md>${path.join(h.outside, 'target.txt')}`);

        expect(fs.lstatSync(path.join(h.out, 'item.md')).isFile()).toBe(true);
        expectOutsideUnchanged(before);
    });
});

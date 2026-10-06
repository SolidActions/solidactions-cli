/**
 * INV-A, never outside the destination (cli#168, cli#188, cli#182; spec §1.2). Every row runs the
 * built CLI (`node dist/index.js`) against a real in-process HTTP server with a temp HOME and real files,
 * through the shared harness, which asserts every call's exit status, stdout and stderr.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { FORMS, KINDS, deadPid, doc, escapeRegExp, failed, pulledOk, read, relOf, singleDocWarning, snapshot, stagingEntries, useDocPullHarness } from './doc-pull-inv-harness';
import type { Snapshot } from './doc-pull-inv-harness';

const h = useDocPullHarness();

/*
 * INV-A: a pull never reads or writes outside the destination, and never through a link
 * (cli#168, cli#188, cli#182; spec §1.2). Every row ends the same way: every file outside the
 * destination keeps its bytes and its inode. Rows are {markdown, media} x {folder, single-doc}
 * x the link cases (a)-(d), then ruling 8's six reverse paths, then the platform row.
 * Pruned: none. Case (d)'s injected failure is `fail-rename:2` for the folder form (a second
 * doc follows the hard-linked one); the single-doc pull has one doc, so it uses
 * `fail-manifest-rename`, the failure that also comes after the doc's rename.
 */

function expectOutsideUnchanged(before: Snapshot): void {
    const after = snapshot(h.outside);
    expect(after.entries).toEqual(before.entries);
    expect(after.inodes).toEqual(before.inodes);
}

const racedLine = (rel: string): string => `error: ${rel} changed after doc pull checked it — nothing was changed. Pull again, or pass --overwrite to replace it.\n`;
const cannotWrite = (rel: string, what: string): RegExp => new RegExp(`^error: cannot write ${escapeRegExp(rel)}: EIO: i/o error, ${escapeRegExp(what)} \\(test hook\\) — nothing was changed\\.\n$`);
/** A saved copy that could not be put back; the line names where it is kept (final review 1, I3). */
const couldNotRestore = (rel: string): RegExp => new RegExp(`^error: cannot write \\.solidactions-docs\\.json: EIO: i/o error, rename manifest \\(test hook\\) — could not restore ${escapeRegExp(rel)} \\(.*\\); its previous copy is in \\.solidactions-pull-\\d+/backup/${escapeRegExp(rel)}\\.\n$`);

/** A new file this pull created that could not be removed: no previous copy exists, and the line must not claim one. */
const couldNotRemove = (rel: string): RegExp => new RegExp(`^error: cannot write \\.solidactions-docs\\.json: EIO: i/o error, rename manifest \\(test hook\\) — could not remove ${escapeRegExp(rel)} \\(.*\\); this pull created it, so it has no previous copy\\.\n$`);

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

    it('(c) a symlink planted at the target name after staging, without --overwrite: refused, the link and the outside file untouched', async () => {
        fs.writeFileSync(path.join(h.outside, 'target.txt'), 'OUTSIDE');
        const before = snapshot(h.outside);
        h.serve([item(1)]);

        await h.pull(form, 'item', failed(racedLine(rel)), ['-y'], `link-before-commit:${rel}>${path.join(h.outside, 'target.txt')}`);

        expect(fs.lstatSync(path.join(h.out, rel)).isSymbolicLink()).toBe(true);
        expectOutsideUnchanged(before);
    });

    it('(c) a symlink planted at the target name after staging, with --overwrite: the link is replaced by a regular file, the outside file untouched', async () => {
        fs.writeFileSync(path.join(h.outside, 'target.txt'), 'OUTSIDE');
        const before = snapshot(h.outside);
        h.serve([item(1)]);

        await h.pull(form, 'item', pulledOk(h.out, [rel]), ['--overwrite'], `link-before-commit:${rel}>${path.join(h.outside, 'target.txt')}`);

        expect(fs.lstatSync(path.join(h.out, rel)).isFile()).toBe(true);
        expect(read(h.out, rel)).toBe(item(1).bytes);
        expectOutsideUnchanged(before);
    });

    it('(d) a hard-linked tracked file replaced, then an injected failure after its rename: rolled back to the original inode, the outside name untouched', async () => {
        const sibling = (version: number) => doc(kind, 6, 'zz', version);
        await h.seed(form === 'folder' ? [item(1), sibling(1)] : [item(1)]);
        fs.linkSync(path.join(h.out, rel), path.join(h.outside, 'hard-link'));
        const before = snapshot(h.outside);
        const inode = fs.statSync(path.join(h.out, rel)).ino;
        h.serve(form === 'folder' ? [item(2), sibling(2)] : [item(2)]);
        const injected = form === 'folder'
            ? cannotWrite(relOf(sibling(2)), 'rename')
            : cannotWrite('.solidactions-docs.json', 'rename manifest');

        await h.pull(form, 'item', failed(injected), ['-y'], form === 'folder' ? 'fail-rename:2' : 'fail-manifest-rename');

        expect(read(h.out, rel)).toBe(item(1).bytes);
        expect(fs.statSync(path.join(h.out, rel)).ino).toBe(inode);
        expect(read(h.outside, 'hard-link')).toBe(item(1).bytes);
        expectOutsideUnchanged(before);
        expect(stagingEntries(h.out)).toEqual([]);
    });
});

describe('INV-A ruling 8: a reverse step never goes through a link planted on its path', { timeout: 60_000 }, () => {
    function sentinels(...names: string[]): Snapshot {
        for (const name of names) fs.writeFileSync(path.join(h.outside, name), 'OUTSIDE');
        return snapshot(h.outside);
    }

    it('restoring a backup whose target folder was swapped for a link: the rollback is reported incomplete, the saved copy kept, nothing outside changes', async () => {
        await h.seed([doc('md', 5, 'b', 1, 'sub')]);
        const before = sentinels('b.md');
        h.serve([doc('md', 5, 'b', 2, 'sub')]);

        await h.pull('folder', 'b', failed(couldNotRestore('sub/b.md')), ['-y'], `fail-manifest-rename,swap-before-rollback:sub>${h.outside}`);

        expectOutsideUnchanged(before);
        const [staging] = stagingEntries(h.out);
        expect(stagingEntries(h.out)).toHaveLength(1);
        expect(read(h.out, staging, 'backup', 'sub', 'b.md')).toBe(doc('md', 5, 'b', 1, 'sub').bytes);
    });

    it('removing this pull\'s new file under a folder swapped for a link: the rollback is reported incomplete, nothing outside changes', async () => {
        await h.seed([doc('md', 5, 'b', 1, 'sub')]);
        const before = sentinels('b.md', 'n.md');
        h.serve([doc('md', 5, 'b', 2, 'sub'), doc('md', 6, 'n', 1, 'sub')]);

        await h.pull('folder', 'b', failed(couldNotRemove('sub/n.md')), ['-y'], `fail-manifest-rename,swap-before-rollback:sub>${h.outside}`);

        expectOutsideUnchanged(before);
        const [staging] = stagingEntries(h.out);
        expect(fs.existsSync(path.join(h.out, staging, 'backup', 'sub', 'n.md'))).toBe(false);
    });

    it('removing a folder this pull created, swapped for a link: the rollback is reported incomplete, nothing outside changes', async () => {
        const before = sentinels('keep.txt');
        h.serve([doc('md', 5, 'c', 1, 'x')]);

        await h.pull('folder', 'c', failed(couldNotRemove('x/c.md')), ['-y'], `fail-manifest-rename,swap-before-rollback:x>${h.outside}`);

        expectOutsideUnchanged(before);
        const [staging] = stagingEntries(h.out);
        expect(fs.existsSync(path.join(h.out, staging, 'backup'))).toBe(false);
    });

    it('leftover cleanup whose backup root is a link: refused, nothing outside changes', async () => {
        const staging = path.join(h.out, `.solidactions-pull-${deadPid()}`);
        fs.mkdirSync(staging, { recursive: true });
        const before = sentinels('a.md');
        fs.symlinkSync(h.outside, path.join(staging, 'backup'));
        h.serve([doc('md', 5, 'a', 1)]);

        await h.pull('folder', 'a', failed(`error: ${path.join(staging, 'backup')} is not a folder doc pull created; remove it and pull again.\n`));

        expectOutsideUnchanged(before);
    });

    it('leftover cleanup with a backup subfolder that is a link: refused as a differing copy, nothing outside changes', async () => {
        const staging = path.join(h.out, `.solidactions-pull-${deadPid()}`);
        fs.mkdirSync(path.join(staging, 'backup'), { recursive: true });
        const before = sentinels('a.md');
        fs.symlinkSync(h.outside, path.join(staging, 'backup', 'sub'));
        fs.mkdirSync(path.join(h.out, 'sub'));
        fs.writeFileSync(path.join(h.out, 'sub', 'real.md'), 'REAL');
        h.serve([doc('md', 5, 'a', 1)]);

        await h.pull('folder', 'a', failed(`error: an interrupted doc pull left saved copies in ${staging}; 1 file(s) differ from their saved copies (first: sub), so neither was changed. Keep the versions you want, delete that folder, and pull again.\n`));

        expectOutsideUnchanged(before);
        expect(read(h.out, 'sub', 'real.md')).toBe('REAL');
    });

    it('leftover cleanup whose target folder is a link: refused, nothing outside changes, the saved copy kept', async () => {
        const staging = path.join(h.out, `.solidactions-pull-${deadPid()}`);
        fs.mkdirSync(path.join(staging, 'backup', 'sub'), { recursive: true });
        fs.writeFileSync(path.join(staging, 'backup', 'sub', 'b.md'), 'B1');
        const before = sentinels('keep.txt');
        fs.symlinkSync(h.outside, path.join(h.out, 'sub'));
        h.serve([doc('md', 5, 'a', 1)]);

        await h.pull('folder', 'a', failed("error: cannot restore an interrupted pull's saved copies: sub is a symbolic link or not a directory.\n"));

        expectOutsideUnchanged(before);
        expect(read(staging, 'backup', 'sub', 'b.md')).toBe('B1');
    });
});

describe('INV-A platform rows', { timeout: 60_000 }, () => {
    it.skipIf(fs.constants.O_NOFOLLOW !== undefined)('a link planted at the target after staging is replaced, never written through (needs a platform without O_NOFOLLOW; CI unit tests run on Linux)', async () => {
        fs.writeFileSync(path.join(h.outside, 'target.txt'), 'OUTSIDE');
        const before = snapshot(h.outside);
        h.serve([doc('md', 5, 'item', 1)]);

        await h.pull('folder', 'item', pulledOk(h.out, ['item.md']), ['--overwrite'], `link-before-commit:item.md>${path.join(h.outside, 'target.txt')}`);

        expect(fs.lstatSync(path.join(h.out, 'item.md')).isFile()).toBe(true);
        expectOutsideUnchanged(before);
    });
});

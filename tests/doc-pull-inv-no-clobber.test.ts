/**
 * INV-B, no clobber (spec §1.2, ruling 9). Every row runs the built CLI (`node dist/index.js`) against a real
 * in-process HTTP server with a temp HOME and real files, through the shared harness, which asserts every
 * call's exit status, stdout and stderr.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { KINDS, MANIFEST_FILE, NFC_NAME, NFD_NAME, caseInsensitiveFilesystem, doc, expectResult, failed, manifestOf, normalisingFilesystem, pulledOk, read, relOf, sha256, snapshot, stagingEntries, useDocPullHarness } from './doc-pull-inv-harness';

const h = useDocPullHarness();

/*
 * INV-B: a pull never replaces bytes it does not own (spec §1.2, rulings 9 and the wave
 * cli-safety rules). Rows: {an untracked file at the target at preflight, a file created at the
 * target after staging, a tracked file rewritten after staging} x {without --overwrite: refused,
 * the bytes unchanged; with --overwrite: replaced} x {markdown, media}; one composed row (a late
 * file replaced under --overwrite, then a failed rename restores it); the late-folder rows
 * (ruling 9); and the platform rows. Pruned: none; the pull form is folder throughout, because
 * the single-doc form shares the same commit and INV-C and INV-A sweep it.
 */

const racedLine = (rel: string): string => `error: ${rel} changed after doc pull checked it — nothing was changed. Pull again, or pass --overwrite to replace it.\n`;

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
            expect(stagingEntries(h.out)).toEqual([]);
        });
    });

    describe('a file created at the target after staging', () => {
        it('without --overwrite: refused, the late file keeps its bytes, no manifest is written', async () => {
            h.serve([item(1)]);

            await h.pull('folder', 'item', failed(racedLine(rel)), ['-y'], `create-before-commit:${rel}`);

            expect(read(h.out, rel)).toBe('RACE');
            expect(fs.readdirSync(h.out)).toEqual([rel]);
        });

        it('with --overwrite: replaced by the served bytes', async () => {
            h.serve([item(1)]);

            await h.pull('folder', 'item', pulledOk(h.out, [rel]), ['--overwrite'], `create-before-commit:${rel}`);

            expect(read(h.out, rel)).toBe(item(1).bytes);
            expect(stagingEntries(h.out)).toEqual([]);
        });
    });

    describe('a tracked file rewritten after staging', () => {
        it('without --overwrite: refused, the rewrite keeps its bytes, the old manifest stays', async () => {
            await h.seed([item(1)]);
            const manifestBefore = read(h.out, MANIFEST_FILE);
            h.serve([item(2)]);

            await h.pull('folder', 'item', failed(racedLine(rel)), ['-y'], `create-before-commit:${rel}`);

            expect(read(h.out, rel)).toBe('RACE');
            expect(read(h.out, MANIFEST_FILE)).toBe(manifestBefore);
            expect(stagingEntries(h.out)).toEqual([]);
        });

        it('with --overwrite: replaced by the served bytes, and the manifest tracks them', async () => {
            await h.seed([item(1)]);
            h.serve([item(2)]);

            await h.pull('folder', 'item', pulledOk(h.out, [rel]), ['--overwrite'], `create-before-commit:${rel}`);

            expect(read(h.out, rel)).toBe(item(2).bytes);
            expect(manifestOf(h.out).docs[rel].body_sha256).toBe(sha256(item(2).bytes));
        });
    });

    describe('a folder created at the target after staging (ruling 9)', () => {
        it.each([
            ['without --overwrite', ['-y']],
            ['with --overwrite', ['--overwrite']],
        ])('%s: refused, the folder and its file untouched, nothing else written', async (_name, flags) => {
            h.serve([item(1)]);

            await h.pull('folder', 'item', failed(`error: ${rel} is a folder now (doc pull writes a file there) — nothing was changed. Move it aside and pull again.\n`), flags, `mkdir-before-commit:${rel}`);

            expect(read(h.out, rel, 'user.txt')).toBe('USER');
            expect(fs.readdirSync(h.out)).toEqual([rel]);
        });
    });
});

describe('INV-B: the authorized state is the one the checks saw (PM ruling 11)', { timeout: 60_000 }, () => {
    it('a file that appears right after the checks, at a target the checks saw absent, is refused and keeps its bytes', async () => {
        h.serve([doc('md', 5, 'item', 1)]);

        await h.pull('folder', 'item', failed(racedLine('item.md')), ['-y'], 'create-after-checks:item.md');

        expect(read(h.out, 'item.md')).toBe('RACE');
        expect(fs.readdirSync(h.out)).toEqual(['item.md']);
    });

    it('a tracked file rewritten right after the checks, which saw its recorded bytes, is refused and keeps the rewrite', async () => {
        await h.seed([doc('md', 5, 'item', 1)]);
        const manifestBefore = read(h.out, MANIFEST_FILE);
        h.serve([doc('md', 5, 'item', 2)]);

        await h.pull('folder', 'item', failed(racedLine('item.md')), ['-y'], 'create-after-checks:item.md');

        expect(read(h.out, 'item.md')).toBe('RACE');
        expect(read(h.out, MANIFEST_FILE)).toBe(manifestBefore);
        expect(stagingEntries(h.out)).toEqual([]);
    });

    it('under --overwrite the same file is replaced: any state was authorized', async () => {
        h.serve([doc('md', 5, 'item', 1)]);

        await h.pull('folder', 'item', pulledOk(h.out, ['item.md']), ['--overwrite'], 'create-after-checks:item.md');

        expect(read(h.out, 'item.md')).toBe('V1-item');
    });
});

describe('INV-B: names doc pull keeps for itself are never a doc path (final review 1, C1)', { timeout: 60_000 }, () => {
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

    it('a doc in a remote folder named after this very pull is written under a different folder name, not into the staging folder', async () => {
        h.serve([{ ...doc('md', 5, 'a', 1), relative: '.solidactions-pull-{pid}' }]);

        const run = h.start('folder', 'docs');
        const rel = `_.solidactions-pull-${run.pid}/a.md`;

        expectResult(await run.result, pulledOk(h.out, [rel]));
        expect(read(h.out, rel)).toBe('V1-a');
        expect(Object.keys(manifestOf(h.out).docs)).toEqual([rel]);
    });

    it('a doc titled like a staging folder is written under a different name, and a second pull is stable', async () => {
        const served = doc('md', 5, '.solidactions-pull-12345', 1);
        h.serve([served]);

        await h.pull('folder', 'docs', pulledOk(h.out, ['_.solidactions-pull-12345.md']));
        await h.pull('folder', 'docs', pulledOk(h.out, ['_.solidactions-pull-12345.md']));

        expect(read(h.out, '_.solidactions-pull-12345.md')).toBe(served.bytes);
    });

    it('a remote folder named like a dead pull keeps its documents and the edits made to them across the next pull', async () => {
        const dead = '.solidactions-pull-900123';
        h.serve([{ ...doc('md', 5, 'a', 1), relative: dead }]);
        await h.pull('folder', 'docs', pulledOk(h.out, [`_${dead}/a.md`]));
        const kept = path.join(h.out, `_${dead}`, 'a.md');
        fs.writeFileSync(kept, 'MY UNPUSHED EDIT');
        h.serve([{ ...doc('md', 5, 'a', 2), relative: dead }]);

        await h.pull('folder', 'docs', failed(`1 file has unpushed local changes:\n  _${dead}/a.md\npush your changes first, or pass --overwrite to discard them.\n`));

        expect(fs.readFileSync(kept, 'utf8')).toBe('MY UNPUSHED EDIT');
    });

    it('an existing folder with a staging name and other contents is refused and never deleted, even at a dead pid', async () => {
        const name = '.solidactions-pull-900124';
        fs.mkdirSync(path.join(h.out, name), { recursive: true });
        fs.writeFileSync(path.join(h.out, name, 'a.md'), 'MY EDITED DOC');
        const before = snapshot(h.out);
        h.serve([doc('md', 5, 'a', 1)]);

        await h.pull('folder', 'docs', failed(`error: ${path.join(h.out, name)} is not a folder doc pull created; remove it and pull again.\n`));

        expect(snapshot(h.out)).toEqual(before);
    });

    it('a root file with a staging name is refused and left alone', async () => {
        fs.mkdirSync(h.out);
        fs.writeFileSync(path.join(h.out, '.solidactions-pull-7'), 'MY FILE');
        const before = snapshot(h.out);
        h.serve([doc('md', 5, 'a', 1)]);

        await h.pull('folder', 'docs', failed(`error: ${path.join(h.out, '.solidactions-pull-7')} is not a folder doc pull created; remove it and pull again.\n`));

        expect(snapshot(h.out)).toEqual(before);
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

    it('under --overwrite a later failure restores every original, and no manifest is written', async () => {
        fs.mkdirSync(h.out);
        fs.writeFileSync(path.join(h.out, files[0]), 'LOCAL ONE');
        fs.writeFileSync(path.join(h.out, files[1]), 'LOCAL TWO');
        h.serve([first(1), second(1)]);
        const before = snapshot(h.out);

        await h.pull('folder', 'docs', failed(`error: cannot write ${MANIFEST_FILE}: EIO: i/o error, rename manifest (test hook) — nothing was changed.\n`), ['--overwrite'], 'fail-manifest-rename');

        expect(snapshot(h.out)).toEqual(before);
    });

    it('two folders whose names are the composed and the decomposed spelling get two folders', async () => {
        h.serve([{ ...doc('md', 1, 'a', 1), relative: NFC_NAME }, { ...doc('md', 2, 'b', 1), relative: NFD_NAME }]);

        await h.pull('folder', 'docs', pulledOk(h.out, [`${NFC_NAME}/a.md`, `${NFD_NAME}-2/b.md`]));

        expect(read(h.out, `${NFC_NAME}/a.md`)).toBe('V1-a');
        expect(read(h.out, `${NFD_NAME}-2/b.md`)).toBe('V1-b');
    });

    it('under --overwrite two aliased folders with existing files: both written, and a later failure restores both originals', async () => {
        fs.mkdirSync(path.join(h.out, NFC_NAME), { recursive: true });
        fs.mkdirSync(path.join(h.out, `${NFD_NAME}-2`));
        fs.writeFileSync(path.join(h.out, NFC_NAME, 'a.md'), 'LOCAL A');
        fs.writeFileSync(path.join(h.out, `${NFD_NAME}-2`, 'a.md'), 'LOCAL B');
        h.serve([{ ...doc('md', 1, 'a', 1), relative: NFC_NAME }, { ...doc('md', 2, 'a', 1), relative: NFD_NAME }]);
        const before = snapshot(h.out);

        await h.pull('folder', 'docs', failed(`error: cannot write ${MANIFEST_FILE}: EIO: i/o error, rename manifest (test hook) — nothing was changed.\n`), ['--overwrite'], 'fail-manifest-rename');

        expect(snapshot(h.out)).toEqual(before);
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
});

describe('INV-B composed: a late file replaced under --overwrite is restored when a later rename fails', { timeout: 60_000 }, () => {
    it('the late file keeps its bytes, the second doc is not written, nothing is left staged', async () => {
        h.serve([doc('md', 5, 'item', 1), doc('md', 6, 'zz', 1)]);

        await h.pull('folder', 'item', failed('error: cannot write zz.md: EIO: i/o error, rename (test hook) — nothing was changed.\n'), ['--overwrite'], 'create-before-commit:item.md,fail-rename:2');

        expect(read(h.out, 'item.md')).toBe('RACE');
        expect(fs.existsSync(path.join(h.out, 'zz.md'))).toBe(false);
        expect(fs.existsSync(path.join(h.out, MANIFEST_FILE))).toBe(false);
        expect(stagingEntries(h.out)).toEqual([]);
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

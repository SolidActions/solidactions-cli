/**
 * INV-B, no clobber (spec §1.2, ruling 9). Every row runs the built CLI (`node dist/index.js`) against a real
 * in-process HTTP server with a temp HOME and real files, through the shared harness, which asserts every
 * call's exit status, stdout and stderr.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { KINDS, MANIFEST_FILE, NFC_NAME, NFD_NAME, caseInsensitiveFilesystem, doc, failed, manifestOf, normalisingFilesystem, pulledOk, read, relOf, sha256, snapshot, stagingEntries, useDocPullHarness } from './doc-pull-inv-harness';

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

/**
 * Rule 5 at every refusal site (spec §1.1 rule 5, final review 3 C3): a file whose bytes already equal what the pull would
 * write for that doc is never a conflict, so the pull after an interrupted one (a failed or killed manifest write, a
 * killed rename chain) heals; a real edit is still refused at the same site. Every row runs the built CLI against a real
 * in-process HTTP server with real files, through the shared harness, which asserts every call's exit status, stdout and
 * stderr.
 *
 * Refusal sites (src/commands/doc-pull.ts), each with an "already the pulled bytes" row and a "real edit" row:
 *   1. a tracked file whose bytes differ from its recorded hash (the unpushed-local-changes check);
 *   2. an untracked file at a target (the untracked-file check);
 *   3. an untracked or hash-less file at a rename's target (the rename-target check);
 *   4. a rename's source whose bytes differ from its recorded hash (the rename-source block);
 *   5. a rename's source that another doc's write lands on (the cross-doc modified-source refusal);
 *   6. a target that changed between the checks and the rename (the publication refusal, "changed after doc pull checked it").
 * A seventh site, a rename's edited source whose download failed, writes nothing, so no bytes can equal what it would write:
 * its row is refused whatever the file holds.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { LOCK_FILE, MANIFEST_FILE, NFC_NAME, NFD_NAME, caseInsensitiveFilesystem, changedLine, doc, failed, killed, manifestNotWrittenLine, manifestOf, normalisingFilesystem, pulledOk, pulledStdout, read, sha256, useDocPullHarness } from './doc-pull-inv-harness';
import type { Expected, ServedDoc } from './doc-pull-inv-harness';

const h = useDocPullHarness();

const isWindows = process.platform === 'win32';

/** `it`, or `it.skip` when the row's platform property is missing (the reason is in each title, spec §1.7). */
const itWhen = (runs: boolean) => it.skipIf(!runs);

const unpushed = (rel: string): string => `1 file has unpushed local changes:\n  ${rel}\npush your changes first, or pass --overwrite to discard them.\n`;
const untracked = (rel: string): string => `1 file exists locally but is not tracked:\n  ${rel}\nMove them aside and pull again, or pass --overwrite to replace them.\n`;

describe('rule 5 at every refusal site: bytes already equal to what the pull writes are not a conflict, a real edit still is', { timeout: 60_000 }, () => {
    it('site 1, a tracked file: its bytes already the pulled ones heal; an edit is refused', async () => {
        await h.seed([doc('md', 5, 'item', 1)]);
        h.serve([doc('md', 5, 'item', 2)]);
        fs.writeFileSync(path.join(h.out, 'item.md'), 'MY EDIT');
        await h.pull('folder', 'docs', failed(unpushed('item.md')));
        expect(read(h.out, 'item.md')).toBe('MY EDIT');
        fs.writeFileSync(path.join(h.out, 'item.md'), 'V2-item');

        await h.pull('folder', 'docs', pulledOk(h.out, ['item.md']));

        expect(manifestOf(h.out).docs['item.md'].body_sha256).toBe(sha256('V2-item'));
    });

    it('site 2, an untracked file: its bytes already the pulled ones are adopted; an edit is refused', async () => {
        fs.mkdirSync(h.out);
        fs.writeFileSync(path.join(h.out, 'item.md'), 'MINE');
        h.serve([doc('md', 5, 'item', 1)]);
        await h.pull('folder', 'docs', failed(untracked('item.md')));
        fs.writeFileSync(path.join(h.out, 'item.md'), 'V1-item');

        await h.pull('folder', 'docs', pulledOk(h.out, ['item.md']));

        expect(manifestOf(h.out).docs['item.md'].body_sha256).toBe(sha256('V1-item'));
    });

    it('site 3, a rename\'s target holding an untracked file: its bytes already the pulled ones are adopted; an edit is refused', async () => {
        await h.seed([doc('md', 1, 'a', 1)]);
        h.serve([doc('md', 1, 'b', 2)]);
        fs.writeFileSync(path.join(h.out, 'b.md'), 'MINE');
        await h.pull('folder', 'docs', failed('error: b.md exists locally but is not tracked; this pull would overwrite it with doc 1 ("b", renamed from a.md).\nMove b.md aside and pull again, or pass --overwrite to replace it.\n'));
        fs.writeFileSync(path.join(h.out, 'b.md'), 'V2-b');

        await h.pull('folder', 'docs', pulledOk(h.out, ['b.md']));

        expect(Object.keys(manifestOf(h.out).docs)).toEqual(['b.md']);
        expect(fs.existsSync(path.join(h.out, 'a.md'))).toBe(false);
    });

    it('site 4, a rename\'s source: its bytes already the ones this pull writes for that doc heal (the old name goes); an edit is refused', async () => {
        await h.seed([doc('md', 1, 'a', 1)]);
        h.serve([doc('md', 1, 'b', 2)]);
        fs.writeFileSync(path.join(h.out, 'a.md'), 'MY EDIT');
        await h.pull('folder', 'docs', failed('error: a.md holds unpublished edits for doc 1 ("b"), which is now written as b.md.\nNothing was written. Push a.md first (or move it aside) and pull again.\n'));
        expect(read(h.out, 'a.md')).toBe('MY EDIT');
        fs.writeFileSync(path.join(h.out, 'a.md'), 'V2-b');

        await h.pull('folder', 'docs', pulledOk(h.out, ['b.md']));

        expect(read(h.out, 'b.md')).toBe('V2-b');
        expect(fs.existsSync(path.join(h.out, 'a.md'))).toBe(false);
        expect(Object.keys(manifestOf(h.out).docs)).toEqual(['b.md']);
    });

    it('site 5, a rename\'s source another doc\'s write lands on (a swap killed after its first rename): the retry heals; the same state with a real edit at the source is refused', async () => {
        await h.seed([doc('md', 1, 'a', 1), doc('md', 2, 'b', 1)]);
        h.serve([doc('md', 1, 'b', 2), doc('md', 2, 'a', 2)]);
        await h.pull('folder', 'docs', killed(), ['-y'], 'kill-after-renames:1');
        fs.rmSync(path.join(h.out, LOCK_FILE));
        expect(read(h.out, 'b.md')).toBe('V2-b');
        expect(read(h.out, 'a.md')).toBe('V1-a');
        fs.writeFileSync(path.join(h.out, 'b.md'), 'MY EDIT');
        await h.pull('folder', 'docs', failed('error: b.md holds unpublished edits for doc 2 ("b", now written as a.md), but this pull would write doc 1 ("b") to b.md, the same file.\nMove or rename the edited b.md (or push it first) and pull again.\n'));
        fs.writeFileSync(path.join(h.out, 'b.md'), 'V2-b');

        await h.pull('folder', 'docs', { code: 0, stdout: pulledStdout(h.out, ['b.md', 'a.md']), stderr: /^(! kept [^\n]*\n)*$/ });

        expect(read(h.out, 'b.md')).toBe('V2-b');
        expect(read(h.out, 'a.md')).toBe('V2-a');
        expect(Object.fromEntries(Object.entries(manifestOf(h.out).docs).map(([rel, entry]) => [rel, entry.body_sha256]))).toEqual({ 'b.md': sha256('V2-b'), 'a.md': sha256('V2-a') });
    });

    it('site 6, a target that changed between the checks and the rename: the pulled bytes themselves are not a change; other bytes are', async () => {
        const racing = (bytes: string): ServedDoc => ({ ...doc('md', 5, 'item', 1), bytes });
        h.serve([racing('RACE')]);
        await h.pull('folder', 'docs', pulledOk(h.out, ['item.md']), ['-y'], 'create-after-checks:item.md');
        expect(read(h.out, 'item.md')).toBe('RACE');
        expect(manifestOf(h.out).docs['item.md'].body_sha256).toBe(sha256('RACE'));
        fs.rmSync(h.out, { recursive: true });
        h.serve([racing('NOT THE RACE')]);

        await h.pull('folder', 'docs', failed(changedLine('item.md', 0, 1)), ['-y'], 'create-after-checks:item.md');

        expect(read(h.out, 'item.md')).toBe('RACE');
    });

    it('a rename\'s edited source whose download failed is refused whatever it holds: nothing is written, so no bytes can equal what would be written', async () => {
        const pic = (version: number): ServedDoc => ({ ...doc('media', 7, version === 1 ? 'pic' : 'pic2', version), downloadFails: version > 1 });
        await h.seed([pic(1)]);
        fs.writeFileSync(path.join(h.out, 'pic.png'), 'V2-pic2');
        h.serve([pic(2)]);

        await h.pull('folder', 'docs', failed('error: pic.png holds unpublished edits for doc 7, which is now pic2.png, but its download failed.\nNothing was written. Push pic.png first (or move it aside), then pull again once the download succeeds.\n'));

        expect(read(h.out, 'pic.png')).toBe('V2-pic2');
    });
});

/**
 * The interrupted-rename retry (final review 3, C3): a rename whose placement succeeded but whose manifest write failed, or
 * that was killed after placement, leaves the old manifest naming the old path while both names resolve to the placed file.
 * The next pull must heal it. A filesystem that aliases case or Unicode normalisation makes both names one file by itself;
 * Linux makes the same state with a hard link or a symbolic link at the old name (a legacy old source that follows a link
 * to the placed target), which every row below also covers.
 */
describe('the retry of an interrupted rename heals when the old name aliases the placed file', { timeout: 60_000 }, () => {
    type Interruption = 'manifest write fails' | 'killed after the rename';
    const INTERRUPTIONS: Interruption[] = ['manifest write fails', 'killed after the rename'];

    async function interrupt(how: Interruption): Promise<void> {
        const expected: Expected = how === 'killed after the rename'
            ? killed()
            : failed(manifestNotWrittenLine('rename manifest', 1, 1));
        await h.pull('folder', 'docs', expected, ['-y'], how === 'killed after the rename' ? 'kill-after-renames:1' : 'fail-manifest-rename');
        if (how === 'killed after the rename') fs.rmSync(path.join(h.out, LOCK_FILE));
    }

    /** The old name `from` becomes another name for the placed file `to` (the state a case or normalisation alias is in). */
    const ALIASES: Array<{ name: string; skip: boolean; make: (from: string, to: string) => void }> = [
        { name: 'a hard link', skip: isWindows, make: (from, to) => { fs.rmSync(path.join(h.out, from)); fs.linkSync(path.join(h.out, to), path.join(h.out, from)); } },
        { name: 'a symbolic link', skip: isWindows, make: (from, to) => { fs.rmSync(path.join(h.out, from)); fs.symlinkSync(to, path.join(h.out, from)); } },
    ];

    for (const alias of ALIASES) {
        itWhen(!alias.skip).each(INTERRUPTIONS)(`${alias.name} at the old name | %s: the retry records the placed file under the new name`, async (how) => {
            await h.seed([doc('md', 1, 'Page', 1)]);
            h.serve([doc('md', 1, 'page', 2)]);
            await interrupt(how);
            alias.make('Page.md', 'page.md');
            expect(read(h.out, 'Page.md')).toBe('V2-page');

            await h.pull('folder', 'docs', pulledOk(h.out, ['page.md']));

            expect(read(h.out, 'page.md')).toBe('V2-page');
            expect(Object.fromEntries(Object.entries(manifestOf(h.out).docs).map(([rel, entry]) => [rel, entry.body_sha256]))).toEqual({ 'page.md': sha256('V2-page') });
        });
    }

    it.each(INTERRUPTIONS)('the same name, no alias | %s: the retry adopts the placed file', async (how) => {
        await h.seed([doc('md', 5, 'item', 1)]);
        h.serve([doc('md', 5, 'item', 2)]);
        await interrupt(how);

        await h.pull('folder', 'docs', pulledOk(h.out, ['item.md']));

        expect(manifestOf(h.out).docs['item.md'].body_sha256).toBe(sha256('V2-item'));
    });

    itWhen(caseInsensitiveFilesystem()).each(INTERRUPTIONS)('a case-only rename | %s: the retry records the placed file (needs a case-insensitive filesystem; CI unit tests run on Linux)', async (how) => {
        await h.seed([doc('md', 1, 'Page', 1)]);
        h.serve([doc('md', 1, 'page', 2)]);
        await interrupt(how);

        await h.pull('folder', 'docs', pulledOk(h.out, ['page.md']));

        expect(Object.values(manifestOf(h.out).docs).map((entry) => entry.body_sha256)).toEqual([sha256('V2-page')]);
        expect(fs.readdirSync(h.out).filter((name) => name !== MANIFEST_FILE)).toHaveLength(1);
    });

    itWhen(normalisingFilesystem()).each(INTERRUPTIONS)('a rename between the composed and the decomposed spelling | %s: the retry records the placed file (needs a normalising filesystem; CI unit tests run on Linux)', async (how) => {
        await h.seed([doc('md', 1, NFC_NAME, 1)]);
        h.serve([doc('md', 1, NFD_NAME, 2)]);
        await interrupt(how);

        await h.pull('folder', 'docs', { code: 0, stdout: new RegExp(`^pulled 1 doc → .*\\n  (${NFC_NAME}|${NFD_NAME})\\.md\\n$`), stderr: '' });

        expect(Object.values(manifestOf(h.out).docs).map((entry) => entry.body_sha256)).toEqual([sha256(`V2-${NFD_NAME}`)]);
        expect(fs.readdirSync(h.out).filter((name) => name !== MANIFEST_FILE)).toHaveLength(1);
    });
});

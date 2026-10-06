/**
 * Final review 5, C1 (cli#168, Peter's ruling in issuecomment-6025529901): outcome classification never collapses a
 * filesystem inspection error or a non-regular entry into "absent". Every outcome caller that inspects a path returns
 * `absent` only on ENOENT; anything else is a refusal with its reason, so the INV-C gate refuses the manifest instead of
 * dropping tracking. The callers: a failed download at its tracked path (cli#183), a renamed doc whose download failed
 * (cli#157 keep), a placed renamed doc's old twin after a stop, and a failed download at a path another doc tracked
 * (cli#190, the different-owner fallback). A placed rename after a complete pull is checked too (the family sweep).
 *
 * Module rows run the real `writeAll`, `decideOutcomes`, `buildManifest` and `manifestProblem` against real temp folders,
 * with the failure made real (chmod, folders, files, looping links) BEFORE the outcome is decided. Spawned rows run the
 * built CLI through the shared harness, with the failure made by the test-only `break-after-writes` hook, which runs
 * after the writes and before the outcomes. Nothing is substituted.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildManifest, decideOutcomes, manifestProblem } from '../src/commands/doc-pull';
import type { PlannedDoc, RenameMove } from '../src/commands/doc-pull';
import type { DocsManifest, ManifestEntry } from '../src/utils/docs-manifest';
import { docsFrom, sha256Hex } from '../src/utils/docs-manifest';
import { faultsFromEnv, writeAll } from '../src/utils/doc-pull-writes';
import { doc, failed, gateLine, manifestOf, MANIFEST_FILE, pulledOk, read, useDocPullHarness } from './doc-pull-inv-harness';
import type { ServedDoc } from './doc-pull-inv-harness';

const FOLDER = 'docs';
const isRoot = process.getuid?.() === 0; // root reads and lists mode-000 entries, so nothing is denied to it
const isWindows = process.platform === 'win32';
const OLD = 'sub/pic.png';

type Caller = 'unchanged failed download' | 'renamed failed download' | 'stopped placed rename twin' | 'different-owner fallback' | 'placed rename, complete pull';
const SOL_CALLERS: Caller[] = ['unchanged failed download', 'renamed failed download', 'stopped placed rename twin'];
const CALLERS: Caller[] = [...SOL_CALLERS, 'different-owner fallback'];

interface Break {
    /** The error the raw syscall at `sub/pic.png` gives once the break is made. */
    error: 'EACCES' | 'EISDIR' | 'ENOTDIR' | 'ELOOP' | 'EIO-like (read EACCES)' | 'ENOENT';
    /** The test-only hook's `<how>:<rel>`, for the spawned rows. */
    hook: string;
    /** The gate's reason, or null for ENOENT (confirmed absence keeps its sanctioned outcome). */
    reason: string | null;
    /** The skip reason for the title, when the break needs something this platform or user may lack. */
    needs?: string;
    skip: boolean;
}

const BREAKS: Break[] = [
    { error: 'EACCES', hook: 'chmod0:sub', reason: 'cannot check it (EACCES: permission denied)', needs: 'needs a non-root user; Windows has no modes', skip: isRoot || isWindows },
    { error: 'EISDIR', hook: `folder:${OLD}`, reason: 'is a folder, not a file', skip: false },
    { error: 'ENOTDIR', hook: 'file:sub', reason: 'cannot check it (ENOTDIR: not a directory)', skip: false },
    { error: 'ELOOP', hook: 'loop:sub', reason: 'cannot check it (ELOOP: too many symbolic links encountered)', needs: 'needs symbolic links, not run on Windows', skip: isWindows },
    { error: 'EIO-like (read EACCES)', hook: `chmod0:${OLD}`, reason: 'cannot read it (EACCES: permission denied)', needs: 'needs a non-root user; Windows has no modes', skip: isRoot || isWindows },
    { error: 'ENOENT', hook: `remove:${OLD}`, reason: null, skip: false },
];

const titled = (name: string, b: Break): string => (b.needs === undefined ? name : `${name} (${b.error}; ${b.needs})`);

/** Make the break real at `dest`, the way the spawned hook does. */
function applyBreak(dest: string, hook: string): void {
    const [how, rel] = hook.split(/:(.*)/s);
    const abs = path.join(dest, ...rel.split('/'));
    if (how === 'chmod0') {
        fs.chmodSync(abs, 0o000);
        return;
    }
    fs.rmSync(abs, { recursive: true, force: true });
    if (how === 'folder') fs.mkdirSync(abs);
    else if (how === 'file') fs.writeFileSync(abs, 'BLOCKER');
    else if (how === 'loop') fs.symlinkSync(path.basename(abs), abs);
}

/** Undo a mode-000 break so the temp folder can be removed. */
function restoreModes(dest: string): void {
    for (const [rel, mode] of [['sub', 0o700], [OLD, 0o600]] as const) {
        try {
            fs.chmodSync(path.join(dest, ...rel.split('/')), mode);
        } catch {
            // not there in this row
        }
    }
}

/** What the real filesystem now says at `sub/pic.png`: the row's own condition, so a row cannot pass on the wrong state. */
function observed(dest: string): string {
    const abs = path.join(dest, ...OLD.split('/'));
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(abs);
    } catch (error) {
        return (error as NodeJS.ErrnoException).code ?? 'ERROR';
    }
    if (stat.isDirectory()) return 'EISDIR';
    try {
        fs.readFileSync(abs);
        return 'readable';
    } catch (error) {
        return `EIO-like (read ${(error as NodeJS.ErrnoException).code})`;
    }
}

const entryFor = (id: number, title: string, bytes: string): ManifestEntry => ({ id, title, current_revision_id: id + 100, media: true, body_sha256: sha256Hex(bytes) });

function mediaDoc(id: number, title: string, relPath: string, bytes: string | null): PlannedDoc {
    const dirRel = path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath);
    return {
        doc: { id, title, relative: dirRel, docType: null, docTypeKnown: true, body: '', current_revision_id: id + 200, properties: {} },
        relPath,
        dirRel,
        fileName: path.posix.basename(relPath),
        isMedia: true,
        mediaBytes: bytes === null ? null : Buffer.from(bytes),
        bodySha256: bytes === null ? null : sha256Hex(bytes),
    };
}

const move = (id: number, title: string, newRel: string, replacementWritten: boolean): RenameMove => ({
    oldRel: OLD, newRel, id, title, sourcePresent: true, sourceIdentity: null, sourceHash: sha256Hex('OLD'), modified: false, replacementWritten, targetIsSource: false,
});

/**
 * One caller's pull, settled: the previous pull tracked `sub/pic.png` (bytes `OLD`), this pull writes what the caller
 * writes, then the break is made, then the outcomes are decided, the manifest is built and the gate runs.
 */
function settleCaller(dest: string, caller: Caller, breakHook: string | null, sourceError?: string): { kinds: string[]; keys: string[]; warnings: string[]; problem: { rel: string; reason: string } | null } {
    fs.mkdirSync(path.join(dest, 'sub'));
    fs.writeFileSync(path.join(dest, ...OLD.split('/')), 'OLD');
    const owner = caller === 'different-owner fallback' ? entryFor(9, 'old', 'OLD') : entryFor(1, 'pic', 'OLD');
    const previous: DocsManifest = { folder_path: FOLDER, docs: docsFrom([[OLD, owner]]) };
    let planned: PlannedDoc[];
    let moves: RenameMove[] = [];
    let stopped = false;
    switch (caller) {
        case 'unchanged failed download':
            planned = [mediaDoc(1, 'pic', OLD, null)];
            break;
        case 'renamed failed download':
            planned = [mediaDoc(1, 'new', 'new.png', null)];
            moves = [move(1, 'new', 'new.png', false)];
            break;
        case 'stopped placed rename twin':
        case 'placed rename, complete pull':
            planned = [mediaDoc(1, 'new', 'new.png', 'NEW')];
            moves = [move(1, 'new', 'new.png', true)];
            stopped = caller === 'stopped placed rename twin';
            break;
        case 'different-owner fallback':
            planned = [mediaDoc(7, 'pic', OLD, null)];
            break;
    }
    if (sourceError !== undefined) moves = moves.map((m) => ({ ...m, sourceError }));
    const writes = planned.filter((p) => p.mediaBytes !== null).map((p) => ({ relPath: p.relPath, dirRel: p.dirRel, data: p.mediaBytes as Buffer, authorized: { kind: 'absent' as const } }));
    const { placed, stop } = writeAll(dest, writes, faultsFromEnv({}));
    expect(stop).toBeNull();
    if (breakHook !== null) applyBreak(dest, breakHook);
    const warnings: string[] = [];
    const outcomes = decideOutcomes(dest, planned, new Set(placed.map((w) => w.relPath)), stopped, previous, FOLDER, moves, new Set([1, 7, 9]), warnings);
    const manifest = buildManifest(FOLDER, previous, outcomes, stopped, warnings);
    const problem = manifestProblem(dest, manifest, outcomes, new Map(placed.map((w) => [w.relPath, { hash: sha256Hex(w.data), identity: w.identity }])));
    return { kinds: outcomes.map((o) => o.kind), keys: Object.keys(manifest.docs), warnings, problem };
}

describe('module: an inspection error or a non-regular entry is never "absent" (decideOutcomes -> buildManifest -> manifestProblem)', () => {
    let dest: string;

    beforeEach(() => {
        dest = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-pull-inspect-'));
    });

    afterEach(() => {
        restoreModes(dest);
        fs.rmSync(dest, { recursive: true, force: true });
    });

    // Sol's final-review-5 unit, ported as it was: its three callers x {EACCES, ENOTDIR, ELOOP, directory}, each must refuse.
    it.skipIf(isRoot || isWindows)("Sol's unit: no inspection failure or folder is classified as missing and removed before the gate (needs a non-root user and symbolic links; not run as root or on Windows)", () => {
        const accepted: string[] = [];
        for (const caller of SOL_CALLERS) {
            for (const b of BREAKS.filter((candidate) => ['EACCES', 'ENOTDIR', 'ELOOP', 'EISDIR'].includes(candidate.error))) {
                const rowDest = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-pull-inspect-sol-'));
                try {
                    const settled = settleCaller(rowDest, caller, b.hook);
                    expect(observed(rowDest)).toBe(b.error);
                    if (settled.problem === null) accepted.push(`${caller}:${b.error}`);
                } finally {
                    restoreModes(rowDest);
                    fs.rmSync(rowDest, { recursive: true, force: true });
                }
            }
        }
        expect(accepted, 'inspection errors/nonregular entries must refuse, not publish an untracking manifest').toEqual([]);
    });

    for (const caller of CALLERS) {
        for (const b of BREAKS.filter((candidate) => candidate.reason !== null)) {
            it.skipIf(b.skip)(titled(`${caller} x ${b.error}: the gate refuses with the path and the error; no tracking is dropped and no tracking line is queued`, b), () => {
                const settled = settleCaller(dest, caller, b.hook);

                expect(observed(dest)).toBe(b.error);
                expect(settled.problem).toEqual({ rel: OLD, reason: b.reason });
                expect(settled.kinds).not.toContain('dropped');
                expect(settled.warnings).toEqual([]);
            });
        }
    }

    // The placed rename of a complete pull retires its old entry by design (cli#157); an old name it cannot even check
    // could hold edits nobody verified, so it refuses too. A folder or a link there stays cli#157's "nothing to remove".
    for (const b of BREAKS.filter((candidate) => ['EACCES', 'ENOTDIR', 'ELOOP'].includes(candidate.error))) {
        it.skipIf(b.skip)(titled(`placed rename, complete pull x ${b.error}: an old name that cannot be checked refuses`, b), () => {
            const settled = settleCaller(dest, 'placed rename, complete pull', b.hook);

            expect(observed(dest)).toBe(b.error);
            expect(settled.problem).toEqual({ rel: OLD, reason: b.reason });
        });
    }

    it('placed rename, complete pull x EISDIR: a folder at the old name is still nothing to keep or remove (cli#157)', () => {
        const settled = settleCaller(dest, 'placed rename, complete pull', `folder:${OLD}`);

        expect(settled.kinds).toEqual(['placed']);
        expect(settled.keys).toEqual(['new.png']);
        expect(settled.problem).toBeNull();
    });

    // The rename planner's own check of the old name (the family sweep): an error there other than ENOENT is a source
    // nobody could check for edits, so the outcome refuses even when the name can be checked by the time it is decided.
    for (const caller of ['renamed failed download', 'stopped placed rename twin', 'placed rename, complete pull'] as Caller[]) {
        it(`${caller}: an old name that could not be checked when the rename was planned refuses, though it can be checked now`, () => {
            const settled = settleCaller(dest, caller, null, 'cannot check it (EACCES: permission denied)');

            expect(observed(dest)).toBe('readable');
            expect(settled.problem).toEqual({ rel: OLD, reason: 'cannot check it (EACCES: permission denied)' });
            expect(settled.kinds).not.toContain('dropped');
            expect(settled.warnings).toEqual([]);
        });
    }

    // Confirmed absence (ENOENT) keeps its sanctioned outcome (manager ruling on cli#168, issuecomment-6013479498 (b)).
    const ABSENT: Record<Caller, { kinds: string[]; keys: string[]; warnings: string[] }> = {
        'unchanged failed download': { kinds: ['dropped'], keys: [], warnings: [`! doc 1 ("pic") failed to download and ${OLD} is not present locally; not tracking it — pull again later.`] },
        'renamed failed download': { kinds: ['dropped'], keys: [], warnings: [`! doc 1 ("new") failed to download and ${OLD} is not present locally; not tracking it — pull again later.`] },
        'stopped placed rename twin': { kinds: ['placed'], keys: ['new.png'], warnings: [] },
        // The previous owner's entry is never replaced by the failed doc's id with no hash (manager ruling, cli#190 warning).
        'different-owner fallback': { kinds: ['dropped'], keys: [], warnings: [`! doc 7 ("pic") failed to download and ${OLD} is not present locally; not tracking it — pull again later. Doc 9 ("old") was tracked at ${OLD} before and is no longer tracked there.`] },
        'placed rename, complete pull': { kinds: ['placed'], keys: ['new.png'], warnings: [] },
    };
    for (const caller of [...CALLERS, 'placed rename, complete pull'] as Caller[]) {
        it(`${caller} x ENOENT: confirmed absence keeps its sanctioned outcome and the gate passes`, () => {
            const settled = settleCaller(dest, caller, `remove:${OLD}`);

            expect(observed(dest)).toBe('ENOENT');
            expect({ kinds: settled.kinds, keys: settled.keys, warnings: settled.warnings }).toEqual(ABSENT[caller]);
            expect(settled.problem).toBeNull();
        });
    }
});

describe('spawned: an inspection error or a non-regular entry stops the pull before the manifest, which stays as it was', { timeout: 60_000 }, () => {
    const h = useDocPullHarness();

    afterEach(() => restoreModes(h.out));

    const note = (version: number): ServedDoc => doc('md', 2, 'note', version);
    const media = (id: number, title: string, version: number, relative?: string): ServedDoc => doc('media', id, title, version, relative);

    interface SpawnedCaller {
        /** The previous pull: always tracks `sub/pic.png` and `note.md`. */
        seed: ServedDoc[];
        /** This pull. */
        serve: ServedDoc[];
        /** Other faults this caller needs (a stop). */
        faults: string[];
        /** The gate line's counts: files written of files planned. */
        written: [number, number];
        /** What follows the gate line (a stop's own line, without its "tracked" tail). */
        after: string;
        /** The files this pull placed, with their bytes. */
        placed: Record<string, string>;
    }

    const SPAWNED: Record<Exclude<Caller, 'placed rename, complete pull'>, SpawnedCaller> = {
        'unchanged failed download': {
            seed: [note(1), media(1, 'pic', 1, 'sub')],
            serve: [{ ...media(1, 'pic', 2, 'sub'), downloadFails: true }, note(2)],
            faults: [], written: [1, 1], after: '', placed: { 'note.md': 'V2-note' },
        },
        'renamed failed download': {
            seed: [note(1), media(1, 'pic', 1, 'sub')],
            serve: [{ ...media(1, 'new', 2), downloadFails: true }, note(2)],
            faults: [], written: [1, 1], after: '', placed: { 'note.md': 'V2-note' },
        },
        'stopped placed rename twin': {
            seed: [note(1), media(1, 'pic', 1, 'sub')],
            serve: [media(1, 'new', 2), note(2)],
            faults: ['fail-rename:2'], written: [1, 2], after: 'error: cannot write note.md: EIO: i/o error, rename (test hook)\n', placed: { 'new.png': 'V2-new' },
        },
        'different-owner fallback': {
            seed: [note(1), media(9, 'pic', 1, 'sub')],
            serve: [{ ...media(7, 'pic', 2, 'sub'), downloadFails: true }, { ...media(9, 'old', 1, 'sub'), bulkStatus: 'not_found' }, note(2)],
            faults: [], written: [1, 1], after: '', placed: { 'note.md': 'V2-note' },
        },
    };

    for (const [caller, row] of Object.entries(SPAWNED)) {
        for (const b of BREAKS.filter((candidate) => candidate.reason !== null)) {
            it.skipIf(b.skip)(titled(`${caller} x ${b.error}: exit 1 on the gate's line naming ${OLD} and the error; the manifest is unchanged and the placed files stay`, b), async () => {
                await h.seed(row.seed);
                const before = read(h.out, MANIFEST_FILE);
                h.serve(row.serve);

                await h.pull('folder', 'docs', failed(gateLine(OLD, b.reason as string, ...row.written) + row.after), ['-y'], [...row.faults, `break-after-writes:${b.hook}`].join(','));

                restoreModes(h.out);
                expect(read(h.out, MANIFEST_FILE)).toBe(before);
                for (const [rel, bytes] of Object.entries(row.placed)) expect(read(h.out, rel)).toBe(bytes);
            });
        }
    }

    it.skipIf(isRoot || isWindows)('placed rename, complete pull: a renamed doc whose old folder cannot be listed when the pull starts is written, and the gate refuses the manifest (EACCES; needs a non-root user; Windows has no modes)', async () => {
        await h.seed([note(1), media(1, 'pic', 1, 'sub')]);
        const before = read(h.out, MANIFEST_FILE);
        h.serve([media(1, 'new', 2), note(2)]);
        fs.chmodSync(path.join(h.out, 'sub'), 0o000);

        await h.pull('folder', 'docs', failed(gateLine(OLD, 'cannot check it (EACCES: permission denied)', 2, 2)));

        restoreModes(h.out);
        expect(read(h.out, MANIFEST_FILE)).toBe(before);
        expect(read(h.out, OLD)).toBe('V1-pic');
        expect(read(h.out, 'new.png')).toBe('V2-new');
    });

    it('different-owner fallback x ENOENT: the failed doc is not tracked over the other doc\'s entry; the cli#190 line says that doc is no longer tracked there', async () => {
        const row = SPAWNED['different-owner fallback'];
        await h.seed(row.seed);
        h.serve(row.serve);

        await h.pull('folder', 'docs', pulledOk(h.out, ['note.md'], `! doc 7 ("pic") failed to download and ${OLD} is not present locally; not tracking it — pull again later. Doc 9 ("pic") was tracked at ${OLD} before and is no longer tracked there.\nwarn: skipping doc 9 (old): bulk_read returned status "not_found"\nwarn: failed to download media for doc 7 (pic): HTTP 500\n`), ['-y'], `break-after-writes:remove:${OLD}`);

        expect(manifestOf(h.out).docs[OLD]).toBeUndefined();
        expect(Object.keys(manifestOf(h.out).docs)).toEqual(['note.md']);
    });
});

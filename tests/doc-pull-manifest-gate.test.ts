/**
 * Final review 3, C1 and C2 (spec §1.1 rules 3 and 4, §1.3 step 4): the manifest a pull records is built so that bytes this
 * pull placed always win over an earlier entry, and the INV-C gate checks every final entry, never a pass on a read it could
 * not make. Direct tests of the module functions against real temp directories: the real `writeAll` places files, and the
 * real `decideOutcomes`, `buildManifest` and `manifestProblem` settle them. Nothing is substituted.
 *
 * The scenarios come from Sol's final-review-3 scratch unit (one swap with a write failure; a placed target that becomes a
 * directory), widened to the families the shop's rule asks for: one-way reuse, swaps and cycles x a write failure at each
 * position x every plan order (C1); every read-error kind x placed and kept entries (C2).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildManifest, decideOutcomes, manifestProblem } from '../src/commands/doc-pull';
import type { DocOutcome, PlannedDoc, RenameMove } from '../src/commands/doc-pull';
import type { DocsManifest, ManifestEntry } from '../src/utils/docs-manifest';
import { sha256Hex } from '../src/utils/docs-manifest';
import { faultsFromEnv, writeAll } from '../src/utils/doc-pull-writes';
import type { Authorized, PlannedWrite } from '../src/utils/doc-pull-writes';

const FOLDER = 'docs';
const isRoot = process.getuid?.() === 0; // root reads mode-000 files, so nothing is unreadable to it
const isWindows = process.platform === 'win32';

let root: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-pull-gate-'));
});

afterEach(() => {
    for (const rel of ['locked.md']) {
        try {
            fs.chmodSync(path.join(root, rel), 0o600);
        } catch {
            // not created by this row
        }
    }
    fs.rmSync(root, { recursive: true, force: true });
});

const entryFor = (id: number, title: string, bytes: string, media = false): ManifestEntry => ({ id, title, current_revision_id: id + 100, media, body_sha256: sha256Hex(bytes) });

function plannedDoc(id: number, title: string, bytes: string, relPath = `${title}.md`): PlannedDoc {
    return {
        doc: { id, title, relative: '', docType: null, docTypeKnown: true, body: bytes, current_revision_id: id + 200, properties: {} },
        relPath,
        dirRel: path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath),
        fileName: path.posix.basename(relPath),
        isMedia: false,
        mediaBytes: null,
        bodySha256: sha256Hex(bytes),
    };
}

/** A media doc whose signed-URL download failed: planned at `relPath`, nothing to write. */
function failedDownloadDoc(id: number, title: string, relPath: string): PlannedDoc {
    return { ...plannedDoc(id, title, '', relPath), isMedia: true, mediaBytes: null, bodySha256: null };
}

const abs = (rel: string): string => path.join(root, ...rel.split('/'));

/** What the preflight would have authorised for a target: the file's bytes when it is there, absent when it is not. */
function authorizedFor(rel: string): Authorized {
    return fs.existsSync(abs(rel)) ? { kind: 'sha256', sha256: sha256Hex(fs.readFileSync(abs(rel))) } : { kind: 'absent' };
}

/** The rename the pull would have recognised for `p`: the previous manifest tracks its doc under another path. */
function renameFor(previous: DocsManifest, p: PlannedDoc): RenameMove | null {
    const old = Object.keys(previous.docs).find((rel) => previous.docs[rel].id === p.doc.id);
    if (old === undefined || old === p.relPath) return null;
    const stat = fs.existsSync(abs(old)) ? fs.statSync(abs(old)) : null;
    return {
        oldRel: old,
        newRel: p.relPath,
        id: p.doc.id,
        title: p.doc.title,
        sourcePresent: stat !== null,
        sourceIdentity: stat === null ? null : `${stat.dev}:${stat.ino}`,
        sourceHash: stat === null ? null : sha256Hex(fs.readFileSync(abs(old))),
        modified: false,
        replacementWritten: true,
        targetIsSource: false,
    } as RenameMove;
}

const hooks = (spec?: string): NodeJS.ProcessEnv => (spec === undefined ? {} : { SOLIDACTIONS_TEST_HOOKS: '1', SOLIDACTIONS_DOC_PULL_TEST_FAULT: spec });

type Placed = ReturnType<typeof writeAll>['placed'];

/** The outcomes, final manifest and gate answer for a pull that wrote `placed` (and stopped, or not). */
function settle(previous: DocsManifest | null, planned: PlannedDoc[], placed: Placed, stopped: boolean, moves: RenameMove[]): { outcomes: DocOutcome[]; manifest: DocsManifest; warnings: string[]; problem: { rel: string; reason: string } | null } {
    const warnings: string[] = [];
    const outcomes = decideOutcomes(root, planned, new Set(placed.map((write) => write.relPath)), stopped, previous, FOLDER, moves, new Set(planned.map((p) => p.doc.id)), warnings);
    const manifest = buildManifest(FOLDER, previous, outcomes, stopped, warnings);
    const problem = manifestProblem(root, manifest, outcomes, new Map(placed.map((write) => [write.relPath, { hash: sha256Hex(write.data), identity: write.identity }])));
    return { outcomes, manifest, warnings, problem };
}

/** Every hash the manifest records is the hash of the bytes now on disk at that path. */
function expectManifestMatchesDisk(manifest: DocsManifest): void {
    for (const [rel, entry] of Object.entries(manifest.docs)) {
        if (entry.body_sha256 == null) continue;
        expect(fs.existsSync(abs(rel)), `${rel} is tracked with a hash but is not on disk`).toBe(true);
        expect(sha256Hex(fs.readFileSync(abs(rel))), `${rel} is tracked with a hash its bytes do not have`).toBe(entry.body_sha256);
    }
}

interface Hop {
    id: number;
    /** The doc's path before this pull (its old title); null for a doc the destination does not have yet. */
    from: string | null;
    /** The doc's title now. */
    to: string;
}

function permutations<T>(items: T[]): T[][] {
    if (items.length <= 1) return [items];
    return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

const NFC = 'café';
const NFD = 'café';

const SHAPES: Array<{ name: string; hops: Hop[] }> = [
    { name: 'one-way reuse (a to b, b to c)', hops: [{ id: 1, from: 'a', to: 'b' }, { id: 2, from: 'b', to: 'c' }] },
    { name: 'one-way reuse of three (a to b, b to c, c to d)', hops: [{ id: 1, from: 'a', to: 'b' }, { id: 2, from: 'b', to: 'c' }, { id: 3, from: 'c', to: 'd' }] },
    { name: 'swap (a to b, b to a)', hops: [{ id: 1, from: 'a', to: 'b' }, { id: 2, from: 'b', to: 'a' }] },
    { name: 'swap beside a new doc', hops: [{ id: 1, from: 'a', to: 'b' }, { id: 2, from: 'b', to: 'a' }, { id: 9, from: null, to: 'z' }] },
    { name: '3-cycle (a to b, b to c, c to a)', hops: [{ id: 1, from: 'a', to: 'b' }, { id: 2, from: 'b', to: 'c' }, { id: 3, from: 'c', to: 'a' }] },
    { name: 'a rename onto the case-variant of another doc\'s old path (a to page, Page to c)', hops: [{ id: 1, from: 'a', to: 'page' }, { id: 2, from: 'Page', to: 'c' }] },
    { name: 'a rename onto the decomposed spelling of another doc\'s old path', hops: [{ id: 1, from: 'a', to: NFD }, { id: 2, from: NFC, to: 'c' }] },
];

interface ChainRun {
    previous: DocsManifest;
    planned: PlannedDoc[];
    placed: Placed;
    stopped: boolean;
    moves: RenameMove[];
}

/** Seed `hops`' old files, then run the real write loop over them in `order`, failing the rename at `failAt` (1-based) or not at all. */
function runChain(hops: Hop[], order: number[], failAt: number | null): ChainRun {
    const previous: DocsManifest = { folder_path: FOLDER, docs: {} };
    for (const hop of hops) {
        if (hop.from === null) continue;
        fs.writeFileSync(abs(`${hop.from}.md`), `OLD-${hop.id}`);
        previous.docs[`${hop.from}.md`] = entryFor(hop.id, hop.from, `OLD-${hop.id}`);
    }
    const planned = order.map((index) => plannedDoc(hops[index].id, hops[index].to, `NEW-${hops[index].id}`));
    const moves = planned.map((p) => renameFor(previous, p)).filter((move): move is RenameMove => move !== null);
    const writes: PlannedWrite[] = planned.map((p) => ({ relPath: p.relPath, dirRel: p.dirRel, data: p.doc.body, authorized: authorizedFor(p.relPath) }));
    const { placed, stop } = writeAll(root, writes, faultsFromEnv(hooks(failAt === null ? undefined : `fail-rename:${failAt}`)));
    expect(placed.length, 'files placed before the injected failure').toBe(failAt === null ? writes.length : failAt - 1);
    return { previous, planned, placed, stopped: stop !== null, moves };
}

describe('C1: placed bytes win over every retained entry, so the manifest never claims another doc\'s hash for a file this pull wrote', () => {
    for (const shape of SHAPES) {
        const orders = permutations(shape.hops.map((_hop, index) => index));
        const positions: Array<number | null> = [null, ...shape.hops.map((_hop, index) => index + 1)];
        const rows = orders.flatMap((order) => positions.map((failAt) => ({ order, failAt })));
        it.each(rows)(`${shape.name} | plan order $order | write failure at $failAt: the gate accepts the manifest and every hash in it is the bytes on disk`, ({ order, failAt }) => {
            const run = runChain(shape.hops, order, failAt);

            const settled = settle(run.previous, run.planned, run.placed, run.stopped, run.moves);

            expect(settled.problem).toBeNull();
            expectManifestMatchesDisk(settled.manifest);
            for (const write of run.placed) {
                expect(settled.manifest.docs[write.relPath]?.body_sha256, `${write.relPath} was placed by this run`).toBe(sha256Hex(write.data));
            }
        });
    }

    it('the swap Sol reproduced (a to b, b to a, the second write fails): b.md is tracked as the file this pull wrote for doc 1, doc 2 loses its entry there with a warning, and doc 1 keeps its old twin', () => {
        const run = runChain([{ id: 1, from: 'a', to: 'b' }, { id: 2, from: 'b', to: 'a' }], [0, 1], 2);

        const settled = settle(run.previous, run.planned, run.placed, run.stopped, run.moves);

        expect(fs.readFileSync(abs('b.md'), 'utf8')).toBe('NEW-1');
        expect(settled.manifest.docs['b.md']).toEqual({ ...entryFor(1, 'b', 'NEW-1'), current_revision_id: 201 });
        expect(settled.manifest.docs['a.md']).toEqual(entryFor(1, 'a', 'OLD-1'));
        expect(Object.values(settled.manifest.docs).filter((e) => e.id === 2)).toEqual([]);
        expect(settled.warnings).toEqual(['! b.md now holds the file this pull wrote for doc 1 ("b"); doc 2 ("b") was tracked at b.md before and is no longer tracked there']);
        expect(settled.problem).toBeNull();
    });

    it('a later write failure after a swap where both docs were placed: the second doc\'s placed file wins over the first doc\'s old twin, and the old twin\'s doc keeps its new file', () => {
        const run = runChain([{ id: 1, from: 'a', to: 'b' }, { id: 2, from: 'b', to: 'a' }, { id: 9, from: null, to: 'z' }], [0, 1, 2], 3);

        const settled = settle(run.previous, run.planned, run.placed, run.stopped, run.moves);

        expect(Object.keys(settled.manifest.docs).sort()).toEqual(['a.md', 'b.md']);
        expect(settled.manifest.docs['b.md'].id).toBe(1);
        expect(settled.manifest.docs['a.md'].id).toBe(2);
        expectManifestMatchesDisk(settled.manifest);
        expect(settled.warnings.length).toBe(2);
    });
});

describe('C2: the gate checks every final entry and never passes a read it could not make', () => {
    /** One placed file, written by the real write loop, then a manifest that records it. */
    function placedOne(rel: string, bytes: string): { previous: null; planned: PlannedDoc[]; placed: Placed } {
        const planned = [plannedDoc(3, path.posix.basename(rel, '.md'), bytes, rel)];
        const { placed } = writeAll(root, planned.map((p) => ({ relPath: p.relPath, dirRel: p.dirRel, data: p.doc.body, authorized: { kind: 'absent' } as Authorized })), faultsFromEnv({}));
        expect(placed.length).toBe(1);
        return { previous: null, planned, placed };
    }

    const PLACED_BREAKS: Array<{ name: string; rel: string; skip?: boolean; apply: () => void; reason: RegExp }> = [
        {
            name: 'the file became a directory (EISDIR on a read)',
            rel: 'item.md',
            apply: () => {
                fs.unlinkSync(abs('item.md'));
                fs.mkdirSync(abs('item.md'));
            },
            reason: /not a regular file/,
        },
        {
            name: 'the folder on its way became a file (ENOTDIR)',
            rel: 'sub/item.md',
            apply: () => {
                fs.rmSync(abs('sub'), { recursive: true });
                fs.writeFileSync(abs('sub'), 'now a file');
            },
            reason: /cannot be checked \(ENOTDIR\)/,
        },
        {
            name: 'the folder on its way became a looping link (ELOOP; needs symbolic links, not run on Windows)',
            rel: 'sub/item.md',
            skip: isWindows,
            apply: () => {
                fs.rmSync(abs('sub'), { recursive: true });
                fs.symlinkSync('sub', abs('sub'));
            },
            reason: /cannot be checked \(ELOOP\)/,
        },
        {
            name: 'the file became a link to a file holding the same bytes (needs symbolic links, not run on Windows)',
            rel: 'item.md',
            skip: isWindows,
            apply: () => {
                fs.renameSync(abs('item.md'), abs('real.md'));
                fs.symlinkSync('real.md', abs('item.md'));
            },
            reason: /not a regular file/,
        },
        {
            name: 'the file was replaced by another file with the same bytes (not the one this run renamed in)',
            rel: 'item.md',
            apply: () => {
                // A second name keeps the placed inode alive, so the replacement cannot be handed the same inode number.
                fs.linkSync(abs('item.md'), abs('placed-inode.md'));
                fs.unlinkSync(abs('item.md'));
                fs.writeFileSync(abs('item.md'), 'PLACED');
            },
            reason: /its bytes are not the ones the manifest would record/,
        },
        {
            name: 'the file was changed in place',
            rel: 'item.md',
            apply: () => fs.writeFileSync(abs('item.md'), 'CHANGED'),
            reason: /its bytes are not the ones the manifest would record/,
        },
        {
            name: 'the file is gone',
            rel: 'item.md',
            apply: () => fs.unlinkSync(abs('item.md')),
            reason: /the file this pull wrote is not there/,
        },
    ];

    // Every row is registered; one the platform cannot run is a visible skip whose title says why (spec §1.7).
    for (const { name, rel, skip, apply, reason } of PLACED_BREAKS) {
        it.skipIf(skip === true)(`a placed file where ${name}: the gate refuses`, () => {
            const { previous, planned, placed } = placedOne(rel, 'PLACED');
            apply();

            const settled = settle(previous, planned, placed, false, []);

            expect(settled.problem).not.toBeNull();
            expect(settled.problem?.rel).toBe(rel);
            expect(settled.problem?.reason).toMatch(reason);
        });
    }

    it.skipIf(isRoot || isWindows)('a placed file that is write-only (the mode its replaced file had) is accepted: this run renamed it in and wrote its hash (needs a non-root user; Windows has no modes)', () => {
        fs.writeFileSync(abs('locked.md'), 'OLD');
        fs.chmodSync(abs('locked.md'), 0o200);
        const planned = [plannedDoc(3, 'locked', 'PLACED')];
        const { placed } = writeAll(root, planned.map((p) => ({ relPath: p.relPath, dirRel: p.dirRel, data: p.doc.body, authorized: { kind: 'any' } as Authorized })), faultsFromEnv({}));
        expect(placed.length).toBe(1);

        const settled = settle(null, planned, placed, false, []);

        expect(settled.problem).toBeNull();
    });

    /** A failed download at a tracked path: the outcome keeps the earlier entry (cli#183) while the file is the one the entry names. */
    function keptEntry(rel: string, bytes: string): { previous: DocsManifest; planned: PlannedDoc[] } {
        const dirRel = path.posix.dirname(rel);
        if (dirRel !== '.') fs.mkdirSync(abs(dirRel), { recursive: true });
        fs.writeFileSync(abs(rel), bytes);
        const previous: DocsManifest = { folder_path: FOLDER, docs: { [rel]: entryFor(5, 'pic', bytes, true) } };
        return { previous, planned: [failedDownloadDoc(5, 'pic', rel)] };
    }

    const KEPT_BREAKS: Array<{ name: string; rel: string; skip?: boolean; apply: () => void; accepted?: boolean; reason?: RegExp }> = [
        {
            name: 'a directory is at its path (EISDIR on a read)',
            rel: 'pic.png',
            apply: () => {
                fs.unlinkSync(abs('pic.png'));
                fs.mkdirSync(abs('pic.png'));
            },
            reason: /not a regular file/,
        },
        {
            name: 'the folder on its way is a file (ENOTDIR)',
            rel: 'sub/pic.png',
            apply: () => {
                fs.rmSync(abs('sub'), { recursive: true });
                fs.writeFileSync(abs('sub'), 'now a file');
            },
            reason: /cannot be checked \(ENOTDIR\)/,
        },
        {
            name: 'the folder on its way is a looping link (ELOOP; needs symbolic links, not run on Windows)',
            rel: 'sub/pic.png',
            skip: isWindows,
            apply: () => {
                fs.rmSync(abs('sub'), { recursive: true });
                fs.symlinkSync('sub', abs('sub'));
            },
            reason: /cannot be checked \(ELOOP\)/,
        },
        {
            name: 'the file cannot be read (EACCES; needs a non-root user; Windows has no modes)',
            rel: 'pic.png',
            skip: isWindows || isRoot,
            apply: () => fs.chmodSync(abs('pic.png'), 0o000),
            reason: /cannot be read back \(EACCES\)/,
        },
        {
            name: 'a link to a file holding the entry\'s bytes is at its path (needs symbolic links, not run on Windows)',
            rel: 'pic.png',
            skip: isWindows,
            apply: () => {
                fs.renameSync(abs('pic.png'), abs('real.png'));
                fs.symlinkSync('real.png', abs('pic.png'));
            },
            reason: /not a regular file/,
        },
        {
            name: 'the file holds other bytes than the entry',
            rel: 'pic.png',
            apply: () => fs.writeFileSync(abs('pic.png'), 'EDITED'),
            reason: /its bytes are not the ones the manifest would record/,
        },
        {
            name: 'the file went missing after the outcome was decided (manager ruling on cli#168, I1(b): a kept entry with a hash needs its file)',
            rel: 'pic.png',
            apply: () => fs.unlinkSync(abs('pic.png')),
            reason: /the file it tracks is not there/,
        },
        {
            name: 'the file is still the one the entry names',
            rel: 'pic.png',
            apply: () => undefined,
            accepted: true,
        },
    ];

    for (const { name, rel, skip, apply, accepted, reason } of KEPT_BREAKS) {
        it.skipIf(skip === true)(`a kept entry where ${name}`, () => {
            const { previous, planned } = keptEntry(rel, 'PIC-BYTES');
            const outcomes = decideOutcomes(root, planned, new Set(), false, previous, FOLDER, [], new Set([5]), []);
            expect(outcomes.map((outcome) => outcome.kind)).toEqual(['kept-previous']);
            apply();

            const manifest = buildManifest(FOLDER, previous, outcomes, false, []);
            const problem = manifestProblem(root, manifest, outcomes, new Map());

            if (accepted === true) {
                expect(problem).toBeNull();
            } else {
                expect(problem?.rel).toBe(rel);
                expect(problem?.reason).toMatch(reason as RegExp);
            }
        });
    }

    it('a failed download at a tracked path whose file is missing is dropped with the "not tracking it" warning, so the gate meets no kept entry for a missing file (manager ruling on cli#168, I1(b))', () => {
        const { previous, planned } = keptEntry('pic.png', 'PIC-BYTES');
        fs.unlinkSync(abs('pic.png'));
        const warnings: string[] = [];

        const outcomes = decideOutcomes(root, planned, new Set(), false, previous, FOLDER, [], new Set([5]), warnings);
        const manifest = buildManifest(FOLDER, previous, outcomes, false, warnings);

        expect(outcomes.map((outcome) => outcome.kind)).toEqual(['dropped']);
        expect(warnings).toEqual(['! doc 5 ("pic") failed to download and pic.png is not present locally; not tracking it — pull again later.']);
        expect(Object.keys(manifest.docs)).toEqual([]);
        expect(manifestProblem(root, manifest, outcomes, new Map())).toBeNull();
    });

    it('a renamed doc whose download failed and whose old file is missing is dropped the same way, and its old entry is not kept (I1(b))', () => {
        const previous: DocsManifest = { folder_path: FOLDER, docs: { 'old.png': entryFor(5, 'old', 'OLD-BYTES', true) } };
        const planned = [failedDownloadDoc(5, 'new', 'new.png')];
        const move: RenameMove = { oldRel: 'old.png', newRel: 'new.png', id: 5, title: 'new', sourcePresent: false, sourceIdentity: null, sourceHash: null, modified: false, replacementWritten: false, targetIsSource: false };
        const warnings: string[] = [];

        const outcomes = decideOutcomes(root, planned, new Set(), false, previous, FOLDER, [move], new Set([5]), warnings);
        const manifest = buildManifest(FOLDER, previous, outcomes, false, warnings);

        expect(outcomes.map((outcome) => outcome.kind)).toEqual(['dropped']);
        expect(warnings).toEqual(['! doc 5 ("new") failed to download and old.png is not present locally; not tracking it — pull again later.']);
        expect(Object.keys(manifest.docs)).toEqual([]);
        expect(manifestProblem(root, manifest, outcomes, new Map())).toBeNull();
    });

    it('a refused doc\'s carried entry and an unlisted doc\'s entry are not read: a folder or an edited file at their path is the refusal\'s own state, not this run\'s claim', () => {
        fs.writeFileSync(abs('refused.md'), 'EDITED LOCALLY');
        fs.mkdirSync(abs('unlisted.md'));
        const previous: DocsManifest = { folder_path: FOLDER, docs: { 'refused.md': entryFor(1, 'refused', 'RECORDED'), 'unlisted.md': entryFor(2, 'unlisted', 'RECORDED') } };
        const planned = [plannedDoc(1, 'refused', 'NEW')];

        const settled = settle(previous, planned, [], true, []);

        expect(settled.outcomes.map((outcome) => outcome.kind)).toEqual(['refused']);
        expect(Object.keys(settled.manifest.docs).sort()).toEqual(['refused.md', 'unlisted.md']);
        expect(settled.problem).toBeNull();
    });
});

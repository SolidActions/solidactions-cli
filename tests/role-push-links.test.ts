/**
 * Pure tests for the role-push link baseline (planLinkBaseline, readRoleSidecar,
 * normalizeCrewPath). No I/O beyond real temp files, no mocks or stubs.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { planLinkBaseline, readRoleSidecar, type RoleSidecarInfo } from '../src/commands/role-push';
import { normalizeCrewPath } from '../src/utils/crew';

const sidecar = (over: Partial<RoleSidecarInfo> = {}): RoleSidecarInfo => ({
    name: 'triage',
    inCrew: 'acme',
    docId: null,
    links: { always_load_skills: ['shared/a'], available_skills: ['shared/x'] },
    ...over,
});
const params = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    always_load_skills: ['shared/a'],
    available_skills: ['shared/x'],
    metadata: { k: 'v' },
    ...over,
});
const plan = (p: Record<string, unknown>, sc: RoleSidecarInfo | null, target: { crew: string | null; docId?: number | null }, replace = false, name = 'triage') =>
    planLinkBaseline(p, sc, name, target, replace);

describe('normalizeCrewPath', () => {
    it('trims segments, drops empty ones and maps blank to null', () => {
        expect(normalizeCrewPath('acme')).toBe('acme');
        expect(normalizeCrewPath('acme/')).toBe('acme');
        expect(normalizeCrewPath(' acme ')).toBe('acme');
        expect(normalizeCrewPath('/acme//ops /')).toBe('acme/ops');
        expect(normalizeCrewPath('  ')).toBeNull();
        expect(normalizeCrewPath('')).toBeNull();
        expect(normalizeCrewPath(undefined)).toBeNull();
        expect(normalizeCrewPath(null)).toBeNull();
    });
});

describe('planLinkBaseline', () => {
    it('omits unchanged lists and reports them as kept', () => {
        const r = plan(params(), sidecar(), { crew: 'acme' });
        expect(r.refused).toBeNull();
        expect(r.kept).toEqual(['always_load_skills', 'available_skills']);
        expect(r.params).toEqual({ metadata: { k: 'v' } });
    });

    it('treats absent frontmatter lists as unchanged when the baseline is empty, and does not report them as kept', () => {
        const sc = sidecar({ links: { always_load_skills: [], available_skills: [] } });
        const r = plan({ metadata: { k: 'v' } }, sc, { crew: 'acme' });
        expect(r.refused).toBeNull();
        expect(r.kept).toEqual([]);
        expect(r.params).toEqual({ metadata: { k: 'v' } });
    });

    it('refuses a changed list without the flag, and a reorder counts as a change', () => {
        for (const list of [['shared/a', 'shared/c'], [], ['shared/b']]) {
            const r = plan(params({ always_load_skills: list }), sidecar(), { crew: 'acme' });
            expect(r.refused).toMatch(/^always_load_skills differs from what was pulled/);
            expect(r.refused).toMatch(/--replace-links/);
        }
        const two = sidecar({ links: { always_load_skills: ['shared/a', 'shared/b'], available_skills: [] } });
        expect(plan({ always_load_skills: ['shared/b', 'shared/a'] }, two, { crew: 'acme' }).refused).toMatch(/always_load_skills differs/);
        expect(plan(params({ available_skills: [] }), sidecar(), { crew: 'acme' }).refused).toMatch(/^available_skills differs/);
    });

    it('sends a changed list with --replace-links and still omits the unchanged one', () => {
        const r = plan(params({ always_load_skills: ['shared/a', 'shared/c'] }), sidecar(), { crew: 'acme' }, true);
        expect(r.refused).toBeNull();
        expect(r.params).toEqual({ always_load_skills: ['shared/a', 'shared/c'], metadata: { k: 'v' } });
        expect(r.kept).toEqual(['available_skills']);
    });

    it('a list removed from the frontmatter is a change: refused, and with --replace-links it clears the list', () => {
        const p = params();
        delete p.always_load_skills;
        expect(plan(p, sidecar(), { crew: 'acme' }).refused).toMatch(/always_load_skills differs/);
        expect(plan(p, sidecar(), { crew: 'acme' }, true).params.always_load_skills).toEqual([]);
    });

    it('a blank frontmatter value (always_load_skills: -> null) counts as changed, even against an empty baseline', () => {
        expect(plan(params({ always_load_skills: null }), sidecar(), { crew: 'acme' }).refused).toMatch(/always_load_skills differs/);
        const empty = sidecar({ links: { always_load_skills: [], available_skills: [] } });
        expect(plan({ always_load_skills: null }, empty, { crew: 'acme' }).refused).toMatch(/always_load_skills differs/);
        // With the flag the blank value clears the list rather than sending null.
        expect(plan({ always_load_skills: null }, empty, { crew: 'acme' }, true).params.always_load_skills).toEqual([]);
    });

    it('applies no baseline for a role that is not the pulled one, sending the params as written', () => {
        const changed = params({ always_load_skills: ['shared/z'] });
        for (const r of [
            plan(changed, null, { crew: 'acme' }),                                   // no sidecar
            plan(changed, sidecar(), { crew: 'acme' }, false, 'other-name'),          // different role name
            plan(changed, sidecar(), { crew: 'other' }),                              // crew mismatch
            plan(changed, sidecar(), { crew: null }),                                 // sidecar has a crew, target has none
            plan(changed, sidecar({ docId: 7 }), { crew: 'acme', docId: 8 }),         // doc id mismatch beats a crew match
        ]) {
            expect(r.refused).toBeNull();
            expect(r.kept).toEqual([]);
            expect(r.params).toEqual(changed);
        }
    });

    it('matches the crew across spellings', () => {
        for (const [pulled, target] of [['acme', 'acme/'], ['acme', ' acme '], ['acme/', 'acme'], ['acme/ops', '/acme//ops/']] as const) {
            const sc = sidecar({ inCrew: normalizeCrewPath(pulled) });
            const r = plan(params({ always_load_skills: ['shared/z'] }), sc, { crew: target });
            expect(r.refused, `${pulled} vs ${target}`).toMatch(/always_load_skills differs/); // baseline applied
        }
        // raw (un-normalised) sidecar value hand-built: the target side is normalised too
        expect(plan(params(), sidecar({ inCrew: 'acme' }), { crew: 'acme/' }).kept).toEqual(['always_load_skills', 'available_skills']);
    });

    it('applies the baseline for any crew when the sidecar recorded none', () => {
        const r = plan(params(), sidecar({ inCrew: null }), { crew: 'whatever' });
        expect(r.kept).toEqual(['always_load_skills', 'available_skills']);
        expect(r.params).toEqual({ metadata: { k: 'v' } });
    });

    it('matches on doc id when both sides have one, whatever the crew spelling', () => {
        const r = plan(params(), sidecar({ docId: 7 }), { crew: 'renamed-crew', docId: 7 });
        expect(r.kept).toEqual(['always_load_skills', 'available_skills']);
        // one side without a doc id falls back to the crew
        expect(plan(params(), sidecar({ docId: 7 }), { crew: 'renamed-crew' }).kept).toEqual([]);
        expect(plan(params(), sidecar({ docId: null }), { crew: 'acme/', docId: 7 }).kept).toEqual(['always_load_skills', 'available_skills']);
    });

    it('does not mutate its input', () => {
        const p = params();
        plan(p, sidecar(), { crew: 'acme' });
        expect(p).toEqual(params());
    });
});

describe('readRoleSidecar (real files)', () => {
    const tmpDirs: string[] = [];
    afterEach(() => {
        for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
        tmpDirs.length = 0;
    });
    const withSidecar = (content: string | null) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-role-sidecar-'));
        tmpDirs.push(dir);
        if (content !== null) fs.writeFileSync(path.join(dir, '.solidactions-role.json'), content);
        return dir;
    };

    it('reads name, normalised crew, doc id and links', () => {
        const dir = withSidecar(JSON.stringify({ name: 'triage', in_crew: ' acme/ ', doc_id: '12', links: { always_load_skills: ['shared/a'], available_skills: ['shared/x'] } }));
        expect(readRoleSidecar(dir)).toEqual({ name: 'triage', inCrew: 'acme', docId: 12, links: { always_load_skills: ['shared/a'], available_skills: ['shared/x'] } });
    });

    it('a sidecar without links has an empty baseline, and null in_crew / doc_id read as null', () => {
        const dir = withSidecar(JSON.stringify({ name: 'triage', in_crew: null, doc_id: null }));
        const sc = readRoleSidecar(dir)!;
        expect(sc).toEqual({ name: 'triage', inCrew: null, docId: null, links: { always_load_skills: [], available_skills: [] } });
        // safe direction: a present list is refused, an absent one omitted
        expect(plan(params(), sc, { crew: 'acme' }).refused).toMatch(/differs from what was pulled/);
        expect(plan({ metadata: {} }, sc, { crew: 'acme' }).refused).toBeNull();
    });

    it('a missing, malformed or nameless sidecar reads as null (hand-authored folder)', () => {
        expect(readRoleSidecar(withSidecar(null))).toBeNull();
        expect(readRoleSidecar(withSidecar('{not json'))).toBeNull();
        expect(readRoleSidecar(withSidecar(JSON.stringify({ in_crew: 'acme' })))).toBeNull();
    });
});

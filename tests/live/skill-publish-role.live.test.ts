import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { liveConfig, LIVE } from './live-env';
import { callCrewsTool } from '../../src/utils/mcp';
import { publishSkillByName } from '../../src/utils/skill-snapshot';

describe.skipIf(!LIVE)('skill publish --role (live)', () => {
    const config = liveConfig()!;
    const stamp = Date.now();
    const crew = `cli-pub-crew-${stamp}`;
    const role = `cli-pub-role-${stamp}`;
    const skill = 'live-skill';

    beforeAll(async () => {
        const c = await callCrewsTool(config, 'crews_manage', { action: 'create', name: crew, description: 'cli live test crew', body: '# Crew\nlive' });
        expect(c.ok, JSON.stringify(c.data)).toBe(true);
        // Versioned role (no version_mode: 'live') so a snapshot is meaningful.
        const r = await callCrewsTool(config, 'roles', { action: 'create', name: role, description: 'cli live role', body: '# Role\nlive', in_crew: crew });
        expect(r.ok, JSON.stringify(r.data)).toBe(true);
        const s = await callCrewsTool(config, 'roles', { action: 'create_skill', role, name: skill, description: 'd', body: '# Skill\nbody', in_crew: crew });
        expect(s.ok, JSON.stringify(s.data)).toBe(true);
    });

    afterAll(async () => {
        const cleanups: Array<[string, Record<string, unknown>]> = [
            ['crews_delete', { action: 'delete_role', name: role, in_crew: crew }],
            ['crews_delete', { action: 'delete_crew', name: crew }],
        ];
        for (const [tool, args] of cleanups) {
            try { await callCrewsTool(config, tool, args); } catch { /* best-effort */ }
        }
    });

    it('publishes an edited role-scoped skill', async () => {
        const e = await callCrewsTool(config, 'roles', { action: 'edit_skill', role, name: skill, body: '# Skill\nedited body', in_crew: crew });
        expect(e.ok, JSON.stringify(e.data)).toBe(true);

        const outcome = await publishSkillByName(config, skill, { role, inCrew: crew });
        expect(outcome.status, JSON.stringify(outcome)).toBe('published');
        expect((outcome as any).snapshotId).toEqual(expect.any(Number));

        const r = await callCrewsTool(config, 'roles', { action: 'read_skill', role, name: skill, in_crew: crew });
        expect(r.ok, JSON.stringify(r.data)).toBe(true);
        expect(r.data.body).toContain('edited body');
        expect(r.data.published).toBe(true);
        expect(r.data.has_unpublished_revisions).toBe(false);
    });

    it('reports a clear error for a missing role-scoped skill', async () => {
        const outcome = await publishSkillByName(config, 'no-such-skill', { role, inCrew: crew });
        expect(outcome.status).toBe('error');
    });
});

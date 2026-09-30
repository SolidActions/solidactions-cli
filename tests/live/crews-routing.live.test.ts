import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { liveConfig, LIVE } from './live-env';
import { callCrewsTool } from '../../src/utils/mcp';
import { createCleanup } from './cleanup';

describe.skipIf(!LIVE)('crews routing (live)', () => {
    const config = liveConfig()!;
    const stamp = Date.now();
    const crew = `cli-live-crew-${stamp}`;
    const role = `cli-live-role-${stamp}`;
    const sharedSkill = `cli-live-shared-${stamp}`;
    const cleanup = createCleanup(config);

    beforeAll(async () => {
        cleanup.crew(crew);
        cleanup.role(role, crew);
        cleanup.sharedSkill(sharedSkill);
        const c = await callCrewsTool(config, 'crews_manage', { action: 'create', name: crew, description: 'cli live test crew', body: '# Crew\nlive' });
        expect(c.ok, JSON.stringify(c.data)).toBe(true);
        const r = await callCrewsTool(config, 'roles', { action: 'create', name: role, description: 'cli live role', body: '# Role\nlive', in_crew: crew, version_mode: 'live' });
        expect(r.ok, JSON.stringify(r.data)).toBe(true);
        const s = await callCrewsTool(config, 'roles', { action: 'create_skill', role, name: 'live-skill', description: 'd', body: '# Skill\nbody', in_crew: crew });
        expect(s.ok, JSON.stringify(s.data)).toBe(true);
    });

    afterAll(async () => {
        await cleanup.run();
    });

    it('lists roles', async () => {
        const r = await callCrewsTool(config, 'roles', { action: 'list' });
        expect(r.ok, JSON.stringify(r.data)).toBe(true);
        expect(r.data.roles.some((x: any) => x.name === role || x.identifier === role)).toBe(true);
    });

    it('reads a role', async () => {
        const r = await callCrewsTool(config, 'roles', { action: 'read', name: role, in_crew: crew });
        expect(r.ok, JSON.stringify(r.data)).toBe(true);
    });

    it('reads a role-scoped skill', async () => {
        const r = await callCrewsTool(config, 'roles', { action: 'read_skill', role, name: 'live-skill', in_crew: crew });
        expect(r.ok, JSON.stringify(r.data)).toBe(true);
        expect(r.data.body).toContain('body');
    });

    it('edits a role-scoped skill', async () => {
        const e = await callCrewsTool(config, 'roles', { action: 'edit_skill', role, name: 'live-skill', body: '# Skill\nedited body', in_crew: crew });
        expect(e.ok, JSON.stringify(e.data)).toBe(true);
        const r = await callCrewsTool(config, 'roles', { action: 'read_skill', role, name: 'live-skill', in_crew: crew });
        expect(r.data.body).toContain('edited body');
    });

    it('lists shared skills without error', async () => {
        const r = await callCrewsTool(config, 'skills', { action: 'list' });
        expect(r.ok, JSON.stringify(r.data)).toBe(true);
        expect(Array.isArray(r.data.skills)).toBe(true);
    });

    it('creates, edits, reads and deletes a shared skill', async () => {
        const c = await callCrewsTool(config, 'skills', { action: 'create', name: sharedSkill, description: 'd', body: '# S\none' });
        expect(c.ok, JSON.stringify(c.data)).toBe(true);
        const e = await callCrewsTool(config, 'skills', { action: 'edit', identifier: sharedSkill, body: '# S\ntwo' });
        expect(e.ok, JSON.stringify(e.data)).toBe(true);
        const r = await callCrewsTool(config, 'skills', { action: 'read', identifier: sharedSkill });
        expect(r.data.body).toContain('two');
        const d = await callCrewsTool(config, 'skills', { action: 'delete', identifier: sharedSkill });
        expect(d.ok, JSON.stringify(d.data)).toBe(true);
    });
});

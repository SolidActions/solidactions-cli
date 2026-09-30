import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { liveConfig, LIVE } from './live-env';
import { callCrewsTool } from '../../src/utils/mcp';
import { skillPullWithConfig, fetchSkillFiles, SKILL_SIDECAR } from '../../src/commands/skill-pull';

class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

/** Run skillPullWithConfig with process.exit/stderr/stdout captured. */
async function runPull(fn: () => Promise<void>): Promise<{ exit: number | undefined; stderr: string }> {
    const origExit = process.exit.bind(process);
    const origErr = process.stderr.write.bind(process.stderr);
    const origLog = console.log;
    let stderr = '';
    (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };
    (process.stderr as any).write = (chunk: string) => { stderr += String(chunk); return true; };
    console.log = () => { /* swallow */ };
    try {
        await fn();
        return { exit: undefined, stderr };
    } catch (e) {
        if (e instanceof ProcessExitError) return { exit: e.code, stderr };
        throw e;
    } finally {
        (process as any).exit = origExit;
        (process.stderr as any).write = origErr;
        console.log = origLog;
    }
}

describe.skipIf(!LIVE)('skill pull --role (live)', () => {
    const config = liveConfig()!;
    const stamp = Date.now();
    const crew = `cli-pull-crew-${stamp}`;
    const role = `cli-pull-role-${stamp}`;
    const roleSkill = `pull-role-skill-${stamp}`;
    const sharedSkill = `pull-shared-skill-${stamp}`;
    const tmpDirs: string[] = [];

    const mkTmp = () => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pull-live-'));
        tmpDirs.push(d);
        return d;
    };

    beforeAll(async () => {
        const c = await callCrewsTool(config, 'crews_manage', { action: 'create', name: crew, description: 'cli live test crew', body: '# Crew\nlive' });
        expect(c.ok, JSON.stringify(c.data)).toBe(true);
        const r = await callCrewsTool(config, 'roles', { action: 'create', name: role, description: 'cli live role', body: '# Role\nlive', in_crew: crew, version_mode: 'live' });
        expect(r.ok, JSON.stringify(r.data)).toBe(true);
        const s = await callCrewsTool(config, 'roles', {
            action: 'create_skill', role, name: roleSkill, description: 'role skill', body: '# Role Skill\nrole body marker',
            in_crew: crew, references: { 'references/notes.md': 'role notes content' },
        });
        expect(s.ok, JSON.stringify(s.data)).toBe(true);
        const sh = await callCrewsTool(config, 'skills', {
            action: 'create', name: sharedSkill, description: 'shared skill', body: '# Shared Skill\nshared body marker',
            references: { 'references/shared.md': 'shared notes content' },
        });
        expect(sh.ok, JSON.stringify(sh.data)).toBe(true);
    });

    afterAll(async () => {
        const cleanups: Array<[string, Record<string, unknown>]> = [
            ['crews_delete', { action: 'delete_skill', identifier: sharedSkill }],
            ['crews_delete', { action: 'delete_role', name: role, in_crew: crew }],
            ['crews_delete', { action: 'delete_crew', name: crew }],
        ];
        for (const [tool, args] of cleanups) {
            try { await callCrewsTool(config, tool, args); } catch { /* best-effort */ }
        }
        for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    });

    it('pulls a role-scoped skill with --role/--in-crew, replacing the dest as a unit', async () => {
        const base = mkTmp();
        const dest = path.join(base, 'out');
        fs.mkdirSync(dest);
        fs.writeFileSync(path.join(dest, 'stale.md'), 'stale');
        fs.writeFileSync(path.join(dest, SKILL_SIDECAR), '{}'); // marks dest as a previously pulled skill

        const res = await runPull(() => skillPullWithConfig(roleSkill, dest, { role, inCrew: crew }, config));
        expect(res.exit, res.stderr).toBe(0);

        expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toContain('role body marker');
        expect(fs.readFileSync(path.join(dest, 'references/notes.md'), 'utf8')).toBe('role notes content');
        expect(fs.existsSync(path.join(dest, 'stale.md'))).toBe(false);
        const sidecar = JSON.parse(fs.readFileSync(path.join(dest, SKILL_SIDECAR), 'utf8'));
        expect(sidecar.role).toBe(role);
        expect(sidecar.in_crew).toBe(crew);
        expect(fs.readdirSync(base)).toEqual(['out']);
    });

    it('fetchSkillFiles returns the file map without writing anything', async () => {
        const files = await fetchSkillFiles(config, roleSkill, { role, inCrew: crew });
        expect(Object.keys(files).sort()).toEqual([SKILL_SIDECAR, 'SKILL.md', 'references/notes.md'].sort());
        expect(String(files['SKILL.md'])).toContain('role body marker');
    });

    it('pulls a shared skill', async () => {
        const dest = path.join(mkTmp(), 'shared');
        const res = await runPull(() => skillPullWithConfig(sharedSkill, dest, {}, config));
        expect(res.exit, res.stderr).toBe(0);
        expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toContain('shared body marker');
        expect(fs.readFileSync(path.join(dest, 'references/shared.md'), 'utf8')).toBe('shared notes content');
        expect(JSON.parse(fs.readFileSync(path.join(dest, SKILL_SIDECAR), 'utf8')).role).toBeNull();
    });

    it('refuses to replace a non-empty folder that is not a pulled skill', async () => {
        const dest = mkTmp();
        fs.writeFileSync(path.join(dest, 'important.txt'), 'keep');
        const res = await runPull(() => skillPullWithConfig(roleSkill, dest, { role, inCrew: crew }, config));
        expect(res.exit).toBe(1);
        expect(res.stderr).toContain('not a pulled skill');
        expect(fs.readdirSync(dest)).toEqual(['important.txt']);
    });

    it('pulling a role-scoped skill without --role hints at --role and creates nothing', async () => {
        const dest = path.join(mkTmp(), 'never-created');
        const res = await runPull(() => skillPullWithConfig(roleSkill, dest, {}, config));
        expect(res.exit).toBe(1);
        expect(res.stderr).toMatch(/role-scoped|--role/);
        expect(res.stderr).toContain('not in the shared library');
        expect(fs.existsSync(dest)).toBe(false);
    });
});

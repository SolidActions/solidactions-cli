import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { liveConfig, LIVE } from './live-env';
import { callCrewsTool } from '../../src/utils/mcp';

const CLI = path.resolve(__dirname, '../../dist/index.js');

describe.skipIf(!LIVE)('role push / skill push --in-crew (live, real CLI)', () => {
    const config = liveConfig()!;
    const stamp = Date.now();
    const crew = `cli-push-crew-${stamp}`;
    const role = `cli-push-role-${stamp}`;
    const versionedRole = `cli-push-versioned-${stamp}`;
    const orphanRole = `cli-push-orphan-${stamp}`;
    const roleSkill = `push-role-skill-${stamp}`;
    const tmpDirs: string[] = [];

    const mkTmp = () => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-push-live-'));
        tmpDirs.push(d);
        return d;
    };

    /** Run the built CLI against the live stack; env-only config, throwaway HOME so no config files are written. */
    const runCli = (args: string[]) => {
        const home = mkTmp();
        const res = spawnSync('node', [CLI, ...args], {
            encoding: 'utf8',
            env: {
                PATH: process.env.PATH,
                HOME: home,
                SOLIDACTIONS_HOST: config.host,
                SOLIDACTIONS_API_KEY: config.apiKey,
                SOLIDACTIONS_WORKSPACE_ID: config.workspaceId,
            },
        });
        return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
    };

    // Roles are pushed with version_mode: live so a plain `read` returns the latest body
    // (a versioned role with no published snapshot answers read with no_snapshot).
    const writeFolder = (name: string, body: string, description = 'cli live role', versionMode: string | null = 'live') => {
        const dir = path.join(mkTmp(), name);
        fs.mkdirSync(dir);
        const vm = versionMode ? `version_mode: ${versionMode}\n` : '';
        fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${vm}---\n${body}\n`);
        return dir;
    };

    beforeAll(async () => {
        expect(fs.existsSync(CLI), 'run `npm run build` first').toBe(true);
        const c = await callCrewsTool(config, 'crews_manage', { action: 'create', name: crew, description: 'cli live test crew', body: '# Crew\nlive' });
        expect(c.ok, JSON.stringify(c.data)).toBe(true);
    });

    afterAll(async () => {
        const cleanups: Array<[string, Record<string, unknown>]> = [
            ['crews_delete', { action: 'delete_role', name: role, in_crew: crew }],
            ['crews_delete', { action: 'delete_role', name: versionedRole, in_crew: crew }],
            ['crews_delete', { action: 'delete_role', name: orphanRole }],
            ['crews_delete', { action: 'delete_crew', name: crew }],
        ];
        for (const [tool, args] of cleanups) {
            try {
                const r = await callCrewsTool(config, tool, args);
                if (!r.ok && r.data?.code !== 'role_not_found') {
                    console.warn(`cleanup ${tool} ${JSON.stringify(args)} returned ok:false: ${JSON.stringify(r.data)}`);
                }
            } catch (e: any) {
                console.warn(`cleanup ${tool} threw: ${e.message}`);
            }
        }
        for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    });

    it('role push without --in-crew for a new role exits 1 with a --in-crew hint and creates nothing', async () => {
        const res = runCli(['role', 'push', writeFolder(orphanRole, '# Orphan\nno crew')]);
        expect(res.status, res.stdout + res.stderr).toBe(1);
        expect(res.stderr).toMatch(/--in-crew/);
        expect(res.stderr).not.toMatch(/\n\s+at /); // no stack trace
        const read = await callCrewsTool(config, 'roles', { action: 'read', name: orphanRole });
        expect(read.ok, JSON.stringify(read.data)).toBe(false);
    });

    it('role push --in-crew creates the role in that crew', async () => {
        const res = runCli(['role', 'push', writeFolder(role, '# Role\nfirst body marker'), '--in-crew', crew]);
        expect(res.status, res.stdout + res.stderr).toBe(0);
        expect(res.stdout).toMatch(/created role/);
        const read = await callCrewsTool(config, 'roles', { action: 'read', name: role, in_crew: crew });
        expect(read.ok, JSON.stringify(read.data)).toBe(true);
        expect(JSON.stringify(read.data)).toContain('first body marker');
    });

    it('re-pushing the role with --in-crew updates it (edit sends in_crew)', async () => {
        const res = runCli(['role', 'push', writeFolder(role, '# Role\nsecond body marker'), '--in-crew', crew]);
        expect(res.status, res.stdout + res.stderr).toBe(0);
        expect(res.stdout).toMatch(/updated role/);
        const read = await callCrewsTool(config, 'roles', { action: 'read', name: role, in_crew: crew });
        expect(JSON.stringify(read.data)).toContain('second body marker');
    });

    it('role push --dry-run --in-crew reports update for an existing role, and create for a new one', () => {
        const existing = runCli(['role', 'push', writeFolder(role, '# Role\nx'), '--in-crew', crew, '--dry-run']);
        expect(existing.status, existing.stdout + existing.stderr).toBe(0);
        expect(existing.stdout).toMatch(/would update/);

        const fresh = runCli(['role', 'push', writeFolder(`${role}-new`, '# Role\nx'), '--in-crew', crew, '--dry-run']);
        expect(fresh.status, fresh.stdout + fresh.stderr).toBe(0);
        expect(fresh.stdout).toMatch(/would create/);
    });

    it('role push --dry-run recognises an existing versioned role that has no published snapshot', () => {
        const create = runCli(['role', 'push', writeFolder(versionedRole, '# V\nbody', 'versioned role', null), '--in-crew', crew]);
        expect(create.status, create.stdout + create.stderr).toBe(0);
        const dry = runCli(['role', 'push', writeFolder(versionedRole, '# V\nbody2', 'versioned role', null), '--in-crew', crew, '--dry-run']);
        expect(dry.status, dry.stdout + dry.stderr).toBe(0);
        expect(dry.stdout).toMatch(/would update/);
    });

    it('skill push --role --in-crew creates a role skill that read_skill finds', async () => {
        const res = runCli(['skill', 'push', writeFolder(roleSkill, '# Skill\nrole skill marker', 'role skill'), '--role', role, '--in-crew', crew]);
        expect(res.status, res.stdout + res.stderr).toBe(0);
        const read = await callCrewsTool(config, 'roles', { action: 'read_skill', role, name: roleSkill, in_crew: crew });
        expect(read.ok, JSON.stringify(read.data)).toBe(true);
        expect(read.data.body).toContain('role skill marker');
    });

    it('skill push --role --in-crew re-push updates the role skill', async () => {
        const res = runCli(['skill', 'push', writeFolder(roleSkill, '# Skill\nedited skill marker', 'role skill'), '--role', role, '--in-crew', crew]);
        expect(res.status, res.stdout + res.stderr).toBe(0);
        const read = await callCrewsTool(config, 'roles', { action: 'read_skill', role, name: roleSkill, in_crew: crew });
        expect(read.data.body).toContain('edited skill marker');
    });

    it('skill push --in-crew without --role is rejected', () => {
        const res = runCli(['skill', 'push', writeFolder('whatever-skill', '# S\nx', 'd'), '--in-crew', crew]);
        expect(res.status).toBe(1);
        expect(res.stderr).toMatch(/--in-crew requires --role/);
    });
});

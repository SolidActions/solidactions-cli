import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { liveConfig, LIVE } from './live-env';
import { callCrewsTool } from '../../src/utils/mcp';
import { createCleanup } from './cleanup';

const CLI = path.resolve(__dirname, '../../dist/index.js');

describe.skipIf(!LIVE)('role push / skill push --in-crew (live, real CLI)', () => {
    const config = liveConfig()!;
    const stamp = Date.now();
    const crew = `cli-push-crew-${stamp}`;
    const role = `cli-push-role-${stamp}`;
    const versionedRole = `cli-push-versioned-${stamp}`;
    const orphanRole = `cli-push-orphan-${stamp}`;
    const uniqueRole = `cli-push-unique-${stamp}`;
    const neverPublishedRole = `cli-push-unpub-${stamp}`;
    const dupRole = `cli-push-dup-${stamp}`;
    const roleSkill = `push-role-skill-${stamp}`;
    const tmpDirs: string[] = [];
    const cleanup = createCleanup(config);

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
    const docIdOf = (data: any): number => {
        const raw = data?.doc_id ?? data?.role_doc_id ?? data?.id;
        const n = typeof raw === 'string' ? parseInt(raw, 10) : raw;
        expect(Number.isInteger(n), `no doc id in ${JSON.stringify(data)}`).toBe(true);
        return n;
    };

    const writeFolder = (name: string, body: string, description = 'cli live role', versionMode: string | null = 'live') => {
        const dir = path.join(mkTmp(), name);
        fs.mkdirSync(dir);
        const vm = versionMode ? `version_mode: ${versionMode}\n` : '';
        fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${vm}---\n${body}\n`);
        return dir;
    };

    beforeAll(async () => {
        expect(fs.existsSync(CLI), 'run `npm run build` first').toBe(true);
        cleanup.crew(crew);
        cleanup.role(role, crew);
        cleanup.role(versionedRole, crew);
        cleanup.role(orphanRole);
        cleanup.role(uniqueRole, crew);
        cleanup.role(neverPublishedRole, crew);
        cleanup.role(dupRole, crew);
        cleanup.role(dupRole, 'smoke-crew');
        const c = await callCrewsTool(config, 'crews_manage', { action: 'create', name: crew, description: 'cli live test crew', body: '# Crew\nlive' });
        expect(c.ok, JSON.stringify(c.data)).toBe(true);
    });

    afterAll(async () => {
        await cleanup.run();
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

    const snapshot = async (docId: number) => {
        const r = await callCrewsTool(config, 'crews_history_manage', { action: 'take_doc_snapshot', doc_id: docId });
        expect(r.ok, JSON.stringify(r.data)).toBe(true);
    };
    const docIdFromPush = (stdout: string): number => {
        const id = parseInt(/\(doc (\d+)\)/.exec(stdout)?.[1] ?? '', 10);
        expect(Number.isInteger(id), stdout).toBe(true);
        return id;
    };

    it('role push without --in-crew updates a uniquely named existing role (versioned, published), dry-run agrees', async () => {
        const create = runCli(['role', 'push', writeFolder(uniqueRole, '# U\nfirst unique body', 'unique role', null), '--in-crew', crew]);
        expect(create.status, create.stdout + create.stderr).toBe(0);
        await snapshot(docIdFromPush(create.stdout));

        const dir = writeFolder(uniqueRole, '# U\nsecond unique body', 'unique role', null);
        const dry = runCli(['role', 'push', dir, '--dry-run']);
        expect(dry.status, dry.stdout + dry.stderr).toBe(0);
        expect(dry.stdout).toMatch(/would update/);
        const beforePush = await callCrewsTool(config, 'roles', { action: 'read', name: uniqueRole, in_crew: crew });
        expect(JSON.stringify(beforePush.data)).toContain('first unique body'); // dry-run changed nothing

        const push = runCli(['role', 'push', dir]);
        expect(push.status, push.stdout + push.stderr).toBe(0);
        expect(push.stdout).toMatch(/updated role/);

        const read0 = await callCrewsTool(config, 'roles', { action: 'read', name: uniqueRole, in_crew: crew });
        await snapshot(docIdOf(read0.data));
        const read = await callCrewsTool(config, 'roles', { action: 'read', name: uniqueRole, in_crew: crew });
        expect(read.ok, JSON.stringify(read.data)).toBe(true);
        expect(read.data.body).toContain('second unique body');
    });

    it('role push without --in-crew updates a versioned role that was never published (no_snapshot)', async () => {
        const create = runCli(['role', 'push', writeFolder(neverPublishedRole, '# N\nfirst', 'never published', null), '--in-crew', crew]);
        expect(create.status, create.stdout + create.stderr).toBe(0);
        const docId = docIdFromPush(create.stdout);
        const dir = writeFolder(neverPublishedRole, '# N\nedited never-published body', 'never published', null);
        const dry = runCli(['role', 'push', dir, '--dry-run']);
        expect(dry.status, dry.stdout + dry.stderr).toBe(0);
        expect(dry.stdout).toMatch(/would update/);
        const push = runCli(['role', 'push', dir]);
        expect(push.status, push.stdout + push.stderr).toBe(0);
        expect(push.stdout).toMatch(/updated role/);
        await snapshot(docId);
        const read = await callCrewsTool(config, 'roles', { action: 'read', name: neverPublishedRole, in_crew: crew });
        expect(read.ok, JSON.stringify(read.data)).toBe(true);
        expect(read.data.body).toContain('edited never-published body');
    });

    it('role push without --in-crew for a name that exists in two crews exits 1 with an ambiguity hint, dry-run too', async () => {
        for (const c of [crew, 'smoke-crew']) {
            const r = await callCrewsTool(config, 'roles', { action: 'create', name: dupRole, description: 'dup role', body: `# Dup\nin ${c}`, in_crew: c, version_mode: 'live' });
            expect(r.ok, JSON.stringify(r.data)).toBe(true);
        }
        const dir = writeFolder(dupRole, '# Dup\npushed body');
        for (const extra of [[], ['--dry-run']]) {
            const res = runCli(['role', 'push', dir, ...extra]);
            expect(res.status, res.stdout + res.stderr).toBe(1);
            expect(res.stderr).toMatch(/multiple crews/);
            expect(res.stderr).toMatch(/--in-crew/);
            expect(res.stderr).not.toMatch(/\n\s+at /);
        }
        // Nothing was touched, and --in-crew disambiguates.
        const untouched = await callCrewsTool(config, 'roles', { action: 'read', name: dupRole, in_crew: 'smoke-crew' });
        expect(untouched.data.body).toContain('in smoke-crew');
        const ok = runCli(['role', 'push', dir, '--in-crew', 'smoke-crew']);
        expect(ok.status, ok.stdout + ok.stderr).toBe(0);
        expect(ok.stdout).toMatch(/updated role/);
        const after = await callCrewsTool(config, 'roles', { action: 'read', name: dupRole, in_crew: 'smoke-crew' });
        expect(after.data.body).toContain('pushed body');
        const other = await callCrewsTool(config, 'roles', { action: 'read', name: dupRole, in_crew: crew });
        expect(other.data.body).toContain(`in ${crew}`);
    });

    it('role push --dry-run without --in-crew for a brand-new role exits 1 with the --in-crew hint (like the real push)', () => {
        const res = runCli(['role', 'push', writeFolder(`${orphanRole}-dry`, '# Orphan\nno crew'), '--dry-run']);
        expect(res.status, res.stdout + res.stderr).toBe(1);
        expect(res.stderr).toMatch(/--in-crew/);
        expect(res.stdout).not.toMatch(/would/);
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

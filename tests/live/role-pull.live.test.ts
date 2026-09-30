import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import yaml from 'js-yaml';
import { liveConfig, LIVE } from './live-env';
import { callCrewsTool } from '../../src/utils/mcp';
import { createCleanup } from './cleanup';

const CLI = path.resolve(__dirname, '../../dist/index.js');

describe.skipIf(!LIVE)('role pull (live, real CLI)', () => {
    const config = liveConfig()!;
    const stamp = Date.now();
    const crew = `cli-rpull-crew-${stamp}`;
    const role = `cli-rpull-role-${stamp}`;
    const unpublishedRole = `cli-rpull-unpub-${stamp}`;
    const parentRole = `cli-rpull-parent-${stamp}`;
    const childRole = `cli-rpull-child-${stamp}`;
    const roleSkill = `rpull-skill-${stamp}`;
    const tmpDirs: string[] = [];
    const cleanup = createCleanup(config);

    const mkTmp = () => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-rpull-live-'));
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

    const docIdOf = (data: any): number => {
        const raw = data?.doc_id ?? data?.role_doc_id ?? data?.skill_doc_id ?? data?.id;
        const n = typeof raw === 'string' ? parseInt(raw, 10) : raw;
        expect(Number.isInteger(n), `no doc id in ${JSON.stringify(data)}`).toBe(true);
        return n;
    };

    const snapshot = async (docId: number) => {
        const r = await callCrewsTool(config, 'crews_history_manage', { action: 'take_doc_snapshot', doc_id: docId });
        expect(r.ok, JSON.stringify(r.data)).toBe(true);
    };

    beforeAll(async () => {
        expect(fs.existsSync(CLI), 'run `npm run build` first').toBe(true);
        cleanup.crew(crew);
        cleanup.role(role, crew);
        cleanup.role(unpublishedRole, crew);
        cleanup.role(childRole, crew);
        cleanup.role(parentRole, crew);
        const c = await callCrewsTool(config, 'crews_manage', { action: 'create', name: crew, description: 'cli live test crew', body: '# Crew\nlive' });
        expect(c.ok, JSON.stringify(c.data)).toBe(true);

        // A versioned role (the default version_mode) with one role skill, both published.
        const r = await callCrewsTool(config, 'roles', { action: 'create', name: role, description: 'cli live pull role', body: '# Role\nline one', in_crew: crew, metadata: { owner: 'live-test' }, always_load_docs: [], catalog_advertised: false });
        expect(r.ok, JSON.stringify(r.data)).toBe(true);
        const s = await callCrewsTool(config, 'roles', {
            action: 'create_skill', role, name: roleSkill, description: 'role skill for pull', body: '# Role Skill\nskill line one',
            in_crew: crew, references: { 'references/notes.md': 'skill notes content' },
        });
        expect(s.ok, JSON.stringify(s.data)).toBe(true);
        await snapshot(docIdOf(r.data));
        await snapshot(docIdOf(s.data));

        // A versioned role that was never published.
        const u = await callCrewsTool(config, 'roles', { action: 'create', name: unpublishedRole, description: 'never published', body: '# Unpub\nx', in_crew: crew });
        expect(u.ok, JSON.stringify(u.data)).toBe(true);

        // A parent role and a child that inherits from it, both published.
        const p = await callCrewsTool(config, 'roles', { action: 'create', name: parentRole, description: 'parent role', body: '# Parent\np', in_crew: crew, always_load_docs: [] });
        expect(p.ok, JSON.stringify(p.data)).toBe(true);
        await snapshot(docIdOf(p.data));
        const ch = await callCrewsTool(config, 'roles', { action: 'create', name: childRole, description: 'child role', body: '# Child\nc', in_crew: crew, inherits_from: parentRole });
        expect(ch.ok, JSON.stringify(ch.data)).toBe(true);
        await snapshot(docIdOf(ch.data));
    });

    afterAll(async () => {
        await cleanup.run();
        for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    });

    it('pulls a role with its skills, and role push of the pulled folder is accepted', async () => {
        const dest = path.join(mkTmp(), 'out');
        const pull = runCli(['role', 'pull', role, dest, '--in-crew', crew]);
        expect(pull.status, pull.stdout + pull.stderr).toBe(0);

        const md = fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8');
        expect(md).toContain('line one');
        expect(md).toContain(`name: ${role}`);
        expect(md).not.toMatch(/^in_crew:/m);
        expect(md).not.toMatch(/^type:/m);
        // The role's own skill is auto-discovered by the server (a bare name in its available_skills index), not a link.
        expect(md).not.toMatch(/^available_skills:/m);
        expect(md).not.toMatch(/^always_load_skills:/m);
        expect(fs.existsSync(path.join(dest, 'skills', roleSkill, 'SKILL.md'))).toBe(true);
        expect(fs.readFileSync(path.join(dest, 'skills', roleSkill, 'references/notes.md'), 'utf8')).toBe('skill notes content');
        const sidecar = JSON.parse(fs.readFileSync(path.join(dest, '.solidactions-role.json'), 'utf8'));
        expect(sidecar.name).toBe(role);
        expect(sidecar.in_crew).toBe(crew);

        const before = await callCrewsTool(config, 'roles', { action: 'read', name: role, in_crew: crew });
        expect(before.ok, JSON.stringify(before.data)).toBe(true);
        console.log(`role property keys from live server: ${Object.keys(before.data.properties).join(', ')}`);
        expect(md).toContain('owner: live-test');

        const push = runCli(['role', 'push', dest, '--in-crew', crew]);
        expect(push.status, push.stdout + push.stderr).toBe(0);
        console.log(`round-trip push output: ${push.stdout.trim()}`);

        // The published (snapshot) body is unchanged, and so is the folder after a second pull over it.
        const read = await callCrewsTool(config, 'roles', { action: 'read', name: role, in_crew: crew });
        expect(read.ok, JSON.stringify(read.data)).toBe(true);
        expect(read.data.body).toContain('line one');
        expect(read.data.properties).toEqual(before.data.properties);
        console.log(`head revision before/after push: ${before.data.head_revision_id} / ${read.data.head_revision_id}`);
        // The server records a new head revision for every edit (it does not dedupe), so the honest
        // no-op check is on content: publish the pushed head and it must equal what was published before.
        await snapshot(docIdOf(before.data));
        const afterPublish = await callCrewsTool(config, 'roles', { action: 'read', name: role, in_crew: crew });
        expect(afterPublish.ok, JSON.stringify(afterPublish.data)).toBe(true);
        expect(afterPublish.data.body).toBe(before.data.body);
        expect(afterPublish.data.properties).toEqual(before.data.properties);

        const again = runCli(['role', 'pull', role, dest, '--in-crew', crew]);
        expect(again.status, again.stdout + again.stderr).toBe(0);
        expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toBe(md);
    });

    it('pulls always_load_skills and available_skills as identifiers, and role push of the folder recreates the links', async () => {
        const skillA = `rpull-shared-a-${stamp}`;
        const skillB = `rpull-shared-b-${stamp}`;
        const linkRole = `cli-rpull-links-${stamp}`;
        const cloneRole = `cli-rpull-clone-${stamp}`;
        cleanup.sharedSkill(skillA);
        cleanup.sharedSkill(skillB);
        cleanup.role(linkRole, crew);
        cleanup.role(cloneRole, crew);

        for (const [n, marker] of [[skillA, 'preloaded marker'], [skillB, 'menu marker']]) {
            const s = await callCrewsTool(config, 'skills', { action: 'create', name: n, description: `shared ${n}`, body: `# ${n}\n${marker}` });
            expect(s.ok, JSON.stringify(s.data)).toBe(true);
            await snapshot(docIdOf(s.data));
        }
        const r = await callCrewsTool(config, 'roles', {
            action: 'create', name: linkRole, description: 'role with skill links', body: '# Links\nbody', in_crew: crew,
            always_load_skills: [`shared/${skillA}`], available_skills: [`shared/${skillB}`],
        });
        expect(r.ok, JSON.stringify(r.data)).toBe(true);
        await snapshot(docIdOf(r.data));

        const src = await callCrewsTool(config, 'roles', { action: 'read', name: linkRole, in_crew: crew });
        expect(src.ok, JSON.stringify(src.data)).toBe(true);
        console.log(`live read shapes: always_load_skills[0] keys=${Object.keys(src.data.always_load_skills[0] ?? {}).join(',')}; available_skills[0] keys=${Object.keys(src.data.available_skills[0] ?? {}).join(',')}; redacted_keys=${JSON.stringify(src.data.redacted_keys)}`);

        const dest = path.join(mkTmp(), 'out');
        const pull = runCli(['role', 'pull', linkRole, dest, '--in-crew', crew, '--no-skills']);
        expect(pull.status, pull.stdout + pull.stderr).toBe(0);
        const mdPath = path.join(dest, 'SKILL.md');
        const md = fs.readFileSync(mdPath, 'utf8');
        const fm = yaml.load(md.split('---\n')[1]) as Record<string, unknown>;
        expect(fm.always_load_skills).toEqual([`shared/${skillA}`]);
        expect(fm.available_skills).toEqual([`shared/${skillB}`]);

        // The folder recreates the role, links included, under a new name.
        fs.writeFileSync(mdPath, md.replace(`name: ${linkRole}`, `name: ${cloneRole}`));
        const push = runCli(['role', 'push', dest, '--in-crew', crew]);
        expect(push.status, push.stdout + push.stderr).toBe(0);
        expect(push.stdout).toMatch(/created role/);
        const cloneDoc = parseInt(/\(doc (\d+)\)/.exec(push.stdout)?.[1] ?? '', 10);
        expect(Number.isInteger(cloneDoc), push.stdout).toBe(true);
        await snapshot(cloneDoc);

        const clone = await callCrewsTool(config, 'roles', { action: 'read', name: cloneRole, in_crew: crew });
        expect(clone.ok, JSON.stringify(clone.data)).toBe(true);
        expect(clone.data.always_load_skills.map((b: any) => b.identifier)).toEqual([`shared/${skillA}`]);
        expect(clone.data.available_skills.map((e: any) => e.identifier)).toEqual([`shared/${skillB}`]);
    });

    it('skill push of a pulled role folder is refused and uploads nothing', () => {
        const dest = path.join(mkTmp(), 'out');
        const pull = runCli(['role', 'pull', role, dest, '--in-crew', crew]);
        expect(pull.status, pull.stdout + pull.stderr).toBe(0);
        const push = runCli(['skill', 'push', dest]);
        expect(push.status, push.stdout + push.stderr).toBe(1);
        expect(push.stderr).toContain('is a pulled role folder; use `solidactions role push`');
        expect(push.stdout).toBe('');
    });

    it('role push notes which frontmatter keys were folded into metadata, once, on stderr', () => {
        const dest = path.join(mkTmp(), 'out');
        const pull = runCli(['role', 'pull', role, dest, '--in-crew', crew, '--no-skills']);
        expect(pull.status, pull.stdout + pull.stderr).toBe(0);
        const mdPath = path.join(dest, 'SKILL.md');
        fs.writeFileSync(mdPath, fs.readFileSync(mdPath, 'utf8').replace(/^---\n/, '---\ntypo_key: oops\nanother_key: 2\n'));
        const push = runCli(['role', 'push', dest, '--in-crew', crew]);
        expect(push.status, push.stdout + push.stderr).toBe(0);
        const notes = push.stderr.split('\n').filter((l) => l.startsWith('note: frontmatter keys'));
        expect(notes).toEqual(['note: frontmatter keys not in the schema were stored under metadata: typo_key, another_key']);
    });

    it('--no-skills pulls the role only', () => {
        const dest = path.join(mkTmp(), 'out');
        const pull = runCli(['role', 'pull', role, dest, '--in-crew', crew, '--no-skills']);
        expect(pull.status, pull.stdout + pull.stderr).toBe(0);
        expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'skills'))).toBe(false);
    });

    it('a role that was never published reports no_snapshot, exits 1 and creates no dir', () => {
        const dest = path.join(mkTmp(), 'out');
        const pull = runCli(['role', 'pull', unpublishedRole, dest, '--in-crew', crew]);
        expect(pull.status, pull.stdout + pull.stderr).toBe(1);
        expect(pull.stderr).toMatch(/no_snapshot|not published/);
        expect(pull.stderr).not.toMatch(/\n\s+at /);
        expect(fs.existsSync(dest)).toBe(false);
    });

    it('an unknown role reports a not-found message mentioning --in-crew, and creates no dir', () => {
        const dest = path.join(mkTmp(), 'out');
        const pull = runCli(['role', 'pull', `no-such-role-${stamp}`, dest, '--in-crew', crew]);
        expect(pull.status, pull.stdout + pull.stderr).toBe(1);
        expect(pull.stderr).toMatch(/not found/i);
        expect(pull.stderr).toMatch(/--in-crew/);
        expect(fs.existsSync(dest)).toBe(false);
    });

    it('refuses to pull into a non-empty dir that is not a pulled role', () => {
        const dest = mkTmp();
        fs.writeFileSync(path.join(dest, 'precious.txt'), 'keep me');
        const pull = runCli(['role', 'pull', role, dest, '--in-crew', crew]);
        expect(pull.status, pull.stdout + pull.stderr).toBe(1);
        expect(pull.stderr).toMatch(/refusing to replace/);
        expect(fs.readFileSync(path.join(dest, 'precious.txt'), 'utf8')).toBe('keep me');
        expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(false);
    });

    it('warns on stderr, and still exits 0, when the pulled role inherits from a parent', () => {
        const dest = path.join(mkTmp(), 'out');
        const pull = runCli(['role', 'pull', childRole, dest, '--in-crew', crew, '--no-skills']);
        expect(pull.status, pull.stdout + pull.stderr).toBe(0);
        expect(pull.stderr).toContain(`warn: role ${childRole} inherits from ${parentRole}`);
        expect(pull.stderr).toMatch(/role push will store them/);
        expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toContain(`inherits_from: ${parentRole}`);
    });

    it('does not warn for a role without a parent', () => {
        const dest = path.join(mkTmp(), 'out');
        const pull = runCli(['role', 'pull', role, dest, '--in-crew', crew, '--no-skills']);
        expect(pull.status, pull.stdout + pull.stderr).toBe(0);
        expect(pull.stderr).not.toMatch(/inherits from/);
    });
});

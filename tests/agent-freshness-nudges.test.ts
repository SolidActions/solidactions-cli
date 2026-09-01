import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
    NUDGE_SUPPRESSION_ENV,
    UPDATE_CACHE_FILE,
    collectAgentFreshness,
    emitAgentFreshnessNudges,
    isCoworkSandbox,
    isNewerVersion,
} from '../src/utils/agent-freshness';
import { BUNDLED_SKILLS_VERSION } from '../src/utils/skills';

function tempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeProject(root: string): void {
    fs.writeFileSync(path.join(root, 'solidactions.yaml'), 'workflows: []\n');
}

function writeUpdateCache(home: string, latestVersion: string, checkedAt = new Date()): void {
    const dir = path.join(home, '.solidactions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, UPDATE_CACHE_FILE), JSON.stringify({
        checkedAt: checkedAt.toISOString(),
        latestVersion,
    }));
}

describe('agent freshness nudge decisions', () => {
    it('compares release and prerelease semvers without treating invalid cache data as newer', () => {
        expect(isNewerVersion('3.15.0', '3.7.0')).toBe(true);
        expect(isNewerVersion('3.15.0', '3.15.0')).toBe(false);
        expect(isNewerVersion('3.14.9', '3.15.0')).toBe(false);
        expect(isNewerVersion('3.15.0', '3.15.0-rc.1')).toBe(true);
        expect(isNewerVersion('not-a-version', '3.15.0')).toBe(false);
    });

    it('uses explicit Cowork markers and does not classify an ordinary sandbox alone as Cowork', () => {
        expect(isCoworkSandbox({ CLAUDE_CODE_IS_COWORK: '1' })).toBe(true);
        expect(isCoworkSandbox({ CLAUDE_CODE_ENTRYPOINT: 'local-agent', SANDBOX_RUNTIME: '1' })).toBe(true);
        expect(isCoworkSandbox({ SANDBOX_RUNTIME: '1' })).toBe(false);
    });

    it('reports an outdated CLI from a fresh daily cache without requesting a refresh', () => {
        const home = tempDir('sa-nudge-home-');
        writeUpdateCache(home, '9.8.7');

        const result = collectAgentFreshness({ cwd: home, homeDir: home, env: {}, currentVersion: '1.2.3' });

        expect(result.lines).toEqual([
            'AGENT NOTE: CLI 1.2.3 outdated (9.8.7 available); newer versions add verbs not visible in this --help. Run: npm i -g @solidactions/cli',
        ]);
        expect(result.shouldRefreshUpdateCache).toBe(false);
    });

    it('points a project with no skills at ai init', () => {
        const root = tempDir('sa-nudge-missing-');
        makeProject(root);
        writeUpdateCache(root, '1.0.0');

        const result = collectAgentFreshness({ cwd: root, homeDir: root, env: {}, currentVersion: '1.0.0' });

        expect(result.lines).toEqual([
            'AGENT NOTE: Install SolidActions skills for this project. Run: solidactions ai init',
        ]);
    });

    it('reports an absent/mismatched stamp as stale and accepts the bundled stamp', () => {
        const root = tempDir('sa-nudge-stale-');
        const skills = path.join(root, '.agents', 'skills');
        makeProject(root);
        fs.mkdirSync(skills, { recursive: true });
        fs.writeFileSync(path.join(skills, 'solidactions-getting-started.md'), '# skill\n');
        writeUpdateCache(root, '1.0.0');

        let result = collectAgentFreshness({ cwd: root, homeDir: root, env: {}, currentVersion: '1.0.0' });
        expect(result.lines).toEqual([
            `AGENT NOTE: Refresh stale SolidActions skills at ${skills}. Run: solidactions ai init --update`,
        ]);

        fs.writeFileSync(path.join(skills, '.solidactions-version'), `${BUNDLED_SKILLS_VERSION}\n`);
        result = collectAgentFreshness({ cwd: root, homeDir: root, env: {}, currentVersion: '1.0.0' });
        expect(result.lines).toEqual([]);
    });

    it('prints the Cowork instruction on every run, using an installed path when present', () => {
        const root = tempDir('sa-nudge-cowork-');
        const skills = path.join(root, '.claude', 'skills');
        makeProject(root);
        fs.mkdirSync(skills, { recursive: true });
        fs.writeFileSync(path.join(skills, 'solidactions-getting-started.md'), '# skill\n');
        fs.writeFileSync(path.join(skills, '.solidactions-version'), `${BUNDLED_SKILLS_VERSION}\n`);
        writeUpdateCache(root, '1.0.0');

        const result = collectAgentFreshness({
            cwd: root,
            homeDir: root,
            env: { CLAUDE_CODE_IS_COWORK: '1' },
            currentVersion: '1.0.0',
        });

        expect(result.lines).toHaveLength(1);
        expect(result.lines[0]).toBe(
            `AGENT NOTE: skills at ${skills} are not auto-loaded in this environment — read ${skills}/solidactions-*.md (or ${skills}/*/SKILL.md) before proceeding`,
        );
        expect(result.lines[0]).not.toMatch(/[\r\n]/);
    });

    it('the one suppression variable disables output, cache writes, and update launch', () => {
        const home = tempDir('sa-nudge-suppressed-');
        const launch = vi.fn();
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        emitAgentFreshnessNudges({
            cwd: home,
            homeDir: home,
            env: { [NUDGE_SUPPRESSION_ENV]: '1', CLAUDE_CODE_IS_COWORK: '1' },
            currentVersion: '1.0.0',
            launchUpdateCheck: launch,
        });

        expect(stderr).not.toHaveBeenCalled();
        expect(launch).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(home, '.solidactions', UPDATE_CACHE_FILE))).toBe(false);
        stderr.mockRestore();
    });

    it('claims an expired cache before one background refresh and reuses it on the next invocation', () => {
        const home = tempDir('sa-nudge-refresh-');
        const launch = vi.fn();
        const now = new Date('2026-08-31T12:00:00.000Z');

        emitAgentFreshnessNudges({ cwd: home, homeDir: home, env: {}, currentVersion: '1.0.0', now, launchUpdateCheck: launch });
        emitAgentFreshnessNudges({ cwd: home, homeDir: home, env: {}, currentVersion: '1.0.0', now, launchUpdateCheck: launch });

        expect(launch).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fs.readFileSync(path.join(home, '.solidactions', UPDATE_CACHE_FILE), 'utf8'))).toEqual({
            checkedAt: now.toISOString(),
        });
    });
});

describe('built CLI nudge I/O contract', () => {
    it('keeps command stdout exact while sending every notice to stderr', () => {
        const root = tempDir('sa-nudge-built-');
        const home = path.join(root, 'home');
        fs.mkdirSync(home);
        makeProject(root);
        writeUpdateCache(home, '9.8.7');

        const run = spawnSync(process.execPath, [path.resolve(__dirname, '../dist/index.js'), '--version'], {
            cwd: root,
            env: { ...process.env, HOME: home, CLAUDE_CODE_IS_COWORK: '1', NO_COLOR: '1' },
            encoding: 'utf8',
        });

        expect(run.status).toBe(0);
        expect(run.stdout).toBe('1.33.0\n');
        expect(run.stderr).toContain('AGENT NOTE: CLI 1.33.0 outdated (9.8.7 available)');
        expect(run.stderr).toContain('AGENT NOTE: Install SolidActions skills for this project.');
        expect(run.stderr).toContain('AGENT NOTE: skills at');
        for (const line of run.stderr.trimEnd().split('\n')) expect(line).toMatch(/^AGENT NOTE: /);
    });
});

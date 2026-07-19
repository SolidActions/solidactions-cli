/**
 * Issue #30: `solidactions dev --env <env>` silently fell back to the GLOBAL
 * `~/.solidactions/config.json` (usually production) when run outside the
 * project's `.solidactions` tree — the user saw only "Loaded 0 vars" and a bare
 * 404, with no hint that the wrong tenant had been targeted.
 *
 * runDev now refuses loudly (before any config resolution or network work)
 * unless a project-local config is reachable from the cwd, naming the config
 * that WOULD have been used and how to fix it.
 *
 * Test-double policy: no mock/spy/stub libraries. Real temp directories, real
 * config files on disk, real process.cwd() changes. The happy-path run that
 * needs an API client uses the same real SaApiClient injection seam as
 * dev.test.ts / dev-env-404-hint.test.ts.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertProjectLocalConfig, runDev, type PlatformVar, type SaApiClient } from '../src/commands/dev';
import { makeTmpEnv, writeLocal } from './helpers';

const ECHO_FIXTURE = path.resolve(__dirname, '../fixtures/echo.ts');

const originalCwd = process.cwd();
afterEach(() => process.chdir(originalCwd));

/** A directory tree guaranteed to have no `.solidactions` in any parent. */
function makeOrphanDir(): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-orphan-'));
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function fakeApi(): SaApiClient {
    return {
        projectSlug: 'test-project',
        async fetchVarsAndConnections(_env: string): Promise<PlatformVar[]> {
            return [];
        },
    };
}

describe('assertProjectLocalConfig — refusal', () => {
    it('throws when neither the cwd nor the entry has a project-local config', () => {
        const env = makeTmpEnv();
        const orphan = makeOrphanDir();
        try {
            process.chdir(orphan.dir);
            expect(() => assertProjectLocalConfig(path.join(orphan.dir, 'wf.ts'), 'production'))
                .toThrow(/no project-local \.solidactions\/config\.json found/);
        } finally { orphan.cleanup(); env.cleanup(); }
    });

    it('names the global config that WOULD have been used, and the two fixes', () => {
        const env = makeTmpEnv();
        const orphan = makeOrphanDir();
        try {
            process.chdir(orphan.dir);
            let msg = '';
            try { assertProjectLocalConfig(path.join(orphan.dir, 'wf.ts'), 'production'); }
            catch (e: any) { msg = e.message; }

            expect(msg).toContain(path.join(env.home, '.solidactions', 'config.json'));
            expect(msg).toContain('usually points at production');
            expect(msg).toContain('cd into the project directory');
            expect(msg).toContain('solidactions init');
        } finally { orphan.cleanup(); env.cleanup(); }
    });

    it('refuses — and points at the workflow\'s own config — when only the ENTRY has one', () => {
        const env = makeTmpEnv();
        const orphan = makeOrphanDir();
        try {
            const projectConfig = writeLocal(env.cwd, { host: 'https://proj.example', apiKey: 'sk_proj' });
            process.chdir(orphan.dir); // cwd outside the project tree — the #30 scenario
            let msg = '';
            try { assertProjectLocalConfig(path.join(env.cwd, 'wf.ts'), 'production'); }
            catch (e: any) { msg = e.message; }

            expect(msg).toContain('Refusing to run --env production');
            expect(msg).toContain(projectConfig);
        } finally { orphan.cleanup(); env.cleanup(); }
    });

    it('refuses when the entry belongs to a DIFFERENT project than the cwd', () => {
        const env = makeTmpEnv();
        const other = makeOrphanDir();
        try {
            const cwdConfig = writeLocal(env.cwd, { host: 'https://a.example', apiKey: 'sk_a' });
            const entryConfig = writeLocal(other.dir, { host: 'https://b.example', apiKey: 'sk_b' });
            process.chdir(env.cwd);

            let msg = '';
            try { assertProjectLocalConfig(path.join(other.dir, 'wf.ts'), 'staging'); }
            catch (e: any) { msg = e.message; }

            expect(msg).toContain('config mismatch');
            expect(msg).toContain(entryConfig);
            expect(msg).toContain(cwdConfig);
        } finally { other.cleanup(); env.cleanup(); }
    });
});

describe('assertProjectLocalConfig — legitimate flows are preserved', () => {
    it('passes when the cwd has a project-local config and the entry is in that tree', () => {
        const env = makeTmpEnv();
        try {
            writeLocal(env.cwd, { host: 'https://proj.example', apiKey: 'sk_proj' });
            process.chdir(env.cwd);
            expect(() => assertProjectLocalConfig(path.join(env.cwd, 'src', 'wf.ts'), 'production')).not.toThrow();
        } finally { env.cleanup(); }
    });

    it('passes with an explicit SOLIDACTIONS_HOST override even with no local config', () => {
        const env = makeTmpEnv();
        const orphan = makeOrphanDir();
        try {
            process.env.SOLIDACTIONS_HOST = 'https://explicit.example';
            process.chdir(orphan.dir);
            expect(() => assertProjectLocalConfig(path.join(orphan.dir, 'wf.ts'), 'production')).not.toThrow();
        } finally { orphan.cleanup(); env.cleanup(); }
    });

    it('passes with an explicit SOLIDACTIONS_API_KEY override even with no local config', () => {
        const env = makeTmpEnv();
        const orphan = makeOrphanDir();
        try {
            process.env.SOLIDACTIONS_API_KEY = 'sk_explicit';
            process.chdir(orphan.dir);
            expect(() => assertProjectLocalConfig(path.join(orphan.dir, 'wf.ts'), 'production')).not.toThrow();
        } finally { orphan.cleanup(); env.cleanup(); }
    });
});

describe('runDev — guard wiring', () => {
    it('rejects an --env run from outside any project tree, before touching config', async () => {
        const env = makeTmpEnv();
        const orphan = makeOrphanDir();
        try {
            process.chdir(orphan.dir);
            await expect(runDev({ entry: ECHO_FIXTURE, input: '{"n":1}', env: 'production' }))
                .rejects.toThrow(/no project-local \.solidactions\/config\.json found/);
        } finally { orphan.cleanup(); env.cleanup(); }
    }, 20_000);

    // These two run from the repo root (the SDK mock-server shim resolves its
    // toolchain relative to the cwd), which has no project-local config of its
    // own — so the guard WOULD fire if it were reached.
    it('an injected api client (tests / embedders) bypasses the guard and the run completes', async () => {
        const out = await runDev({ entry: ECHO_FIXTURE, input: '{"n":1}', env: 'production', api: fakeApi() });
        expect(out.result.status).toBe('completed');
    }, 20_000);

    it('a bare run (no --env) does no platform fetch and is never blocked by the guard', async () => {
        const out = await runDev({ entry: ECHO_FIXTURE, input: '{"n":1}' });
        expect(out.result.status).toBe('completed');
        expect(out.stdout).toContain('running locally');
    }, 20_000);
});

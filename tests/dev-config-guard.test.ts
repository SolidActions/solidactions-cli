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
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assertProjectLocalConfig, buildSaApiClient, resolveDevProjectDir, runDev } from '../src/commands/dev';
import { makeTmpEnv, writeLocal } from './helpers';

const ECHO_FIXTURE = path.resolve(__dirname, '../fixtures/echo.ts');

const originalCwd = process.cwd();
afterEach(() => process.chdir(originalCwd));

/** A directory tree guaranteed to have no `.solidactions` in any parent. */
function makeOrphanDir(): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-orphan-'));
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Real in-process HTTP server standing in for the SA API (repo convention —
// same shape as env-set-global-guard.test.ts). The client under test is the
// REAL buildSaApiClient(), so the request path, headers and response decoding
// are all exercised; only the server on the other end is local.
let server: http.Server;
let port: number;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url?.includes('/variable-mappings')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify([]));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: `unhandled ${req.method} ${req.url}` }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => {
        port = (server.address() as any).port;
        resolve();
    }));
});

afterAll(() => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))));

function realApi() {
    return buildSaApiClient(
        { host: `http://127.0.0.1:${port}`, apiKey: 'sk_test' } as any,
        'test-project',
    );
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
            // `solidactions init` does NOT write .solidactions/config.json —
            // `login --local` is the documented command (README "login flags").
            expect(msg).toContain('solidactions login --local');
            expect(msg).not.toContain('solidactions init');
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

    // Review round 1 (MEDIUM): this branch is reachable only for entries run
    // IN-PROCESS (.js/.mjs). A .ts entry is re-exec'd with the child cwd already
    // at the entry's own project root, so entryLocal === cwdLocal by
    // construction there and the mismatch cannot fire — correctly so: the child
    // is anchored to the right project. Entry named .mjs to reflect that.
    it('refuses when the entry belongs to a DIFFERENT project than the cwd (in-process entries)', () => {
        const env = makeTmpEnv();
        const other = makeOrphanDir();
        try {
            const cwdConfig = writeLocal(env.cwd, { host: 'https://a.example', apiKey: 'sk_a' });
            const entryConfig = writeLocal(other.dir, { host: 'https://b.example', apiKey: 'sk_b' });
            process.chdir(env.cwd);

            let msg = '';
            try { assertProjectLocalConfig(path.join(other.dir, 'wf.mjs'), 'staging'); }
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

    it('passes with BOTH env overrides set and no local config — nothing can fall to global', () => {
        const env = makeTmpEnv();
        const orphan = makeOrphanDir();
        try {
            process.env.SOLIDACTIONS_HOST = 'https://explicit.example';
            process.env.SOLIDACTIONS_API_KEY = 'sk_explicit';
            process.chdir(orphan.dir);
            expect(() => assertProjectLocalConfig(path.join(orphan.dir, 'wf.ts'), 'production')).not.toThrow();
        } finally { orphan.cleanup(); env.cleanup(); }
    });

    it('a partial env override does NOT suppress the guard when a local config exists', () => {
        const env = makeTmpEnv();
        try {
            process.env.SOLIDACTIONS_API_KEY = 'sk_explicit';
            writeLocal(env.cwd, { host: 'https://proj.example', apiKey: 'sk_proj' });
            process.chdir(env.cwd);
            // The local config supplies `host`; nothing falls to global.
            expect(() => assertProjectLocalConfig(path.join(env.cwd, 'wf.ts'), 'production')).not.toThrow();
        } finally { env.cleanup(); }
    });
});

/**
 * Review round 1 (HIGH): the bypass was OR-based, so setting EITHER var skipped
 * the guard entirely — but resolveConfig() picks host and apiKey independently,
 * so the unset field still fell through to the global (production) config. The
 * reviewer drove a real request to the global host (401) from an orphan dir
 * with only SOLIDACTIONS_API_KEY set. The bypass now requires BOTH vars.
 */
describe('assertProjectLocalConfig — partial env override still refuses', () => {
    it('refuses with only SOLIDACTIONS_API_KEY set, naming host as the field falling to global', () => {
        const env = makeTmpEnv();
        const orphan = makeOrphanDir();
        try {
            process.env.SOLIDACTIONS_API_KEY = 'sk_explicit';
            process.chdir(orphan.dir);

            let msg = '';
            try { assertProjectLocalConfig(path.join(orphan.dir, 'wf.ts'), 'production'); }
            catch (e: any) { msg = e.message; }

            expect(msg).toContain('SOLIDACTIONS_API_KEY is set');
            expect(msg).toContain('`host` would still come from the global config');
            expect(msg).toContain('Set SOLIDACTIONS_HOST too');
            expect(msg).toContain(path.join(env.home, '.solidactions', 'config.json'));
        } finally { orphan.cleanup(); env.cleanup(); }
    });

    it('refuses with only SOLIDACTIONS_HOST set, naming apiKey as the field falling to global', () => {
        const env = makeTmpEnv();
        const orphan = makeOrphanDir();
        try {
            process.env.SOLIDACTIONS_HOST = 'https://explicit.example';
            process.chdir(orphan.dir);

            let msg = '';
            try { assertProjectLocalConfig(path.join(orphan.dir, 'wf.ts'), 'production'); }
            catch (e: any) { msg = e.message; }

            expect(msg).toContain('SOLIDACTIONS_HOST is set');
            expect(msg).toContain('`apiKey` would still come from the global config');
            expect(msg).toContain('Set SOLIDACTIONS_API_KEY too');
        } finally { orphan.cleanup(); env.cleanup(); }
    });

    it('the full-refusal path (no env vars at all) carries no partial-override line', () => {
        const env = makeTmpEnv();
        const orphan = makeOrphanDir();
        try {
            process.chdir(orphan.dir);
            let msg = '';
            try { assertProjectLocalConfig(path.join(orphan.dir, 'wf.ts'), 'production'); }
            catch (e: any) { msg = e.message; }

            expect(msg).toContain('Refusing to run --env production');
            expect(msg).not.toContain('resolve independently');
        } finally { orphan.cleanup(); env.cleanup(); }
    });

    it('runDev rejects an --env run with only SOLIDACTIONS_API_KEY set', async () => {
        const env = makeTmpEnv();
        const orphan = makeOrphanDir();
        try {
            process.env.SOLIDACTIONS_API_KEY = 'sk_explicit';
            process.chdir(orphan.dir);
            await expect(runDev({ entry: ECHO_FIXTURE, input: '{"n":1}', env: 'production' }))
                .rejects.toThrow(/host` would still come from the global config/);
        } finally { orphan.cleanup(); env.cleanup(); }
    }, 20_000);
});

/**
 * Review round 2 (FALSE-NEGATIVE): a local config that EXISTS but is malformed
 * passed the guard (the path is there) while readConfigFile() returned null, so
 * resolution fell through to the global production config — #30 surviving.
 */
describe('assertProjectLocalConfig — malformed local config', () => {
    it('refuses a present-but-unparseable local config, naming path and parse error', () => {
        const env = makeTmpEnv();
        try {
            const dir = path.join(env.cwd, '.solidactions');
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, 'config.json');
            fs.writeFileSync(file, '{ "host": "https://proj.example", oops');
            process.chdir(env.cwd);

            let msg = '';
            try { assertProjectLocalConfig(path.join(env.cwd, 'wf.mjs'), 'production'); }
            catch (e: any) { msg = e.message; }

            expect(msg).toContain(`local config at ${file} is malformed`);
            expect(msg).toContain('would fall through to the global');
            expect(msg).toContain('solidactions login --local');
        } finally { env.cleanup(); }
    });

    it('an empty local config file is refused too (JSON.parse fails on "")', () => {
        const env = makeTmpEnv();
        try {
            const dir = path.join(env.cwd, '.solidactions');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'config.json'), '');
            process.chdir(env.cwd);
            expect(() => assertProjectLocalConfig(path.join(env.cwd, 'wf.mjs'), 'production'))
                .toThrow(/is malformed/);
        } finally { env.cleanup(); }
    });

    it('a well-formed local config is not affected', () => {
        const env = makeTmpEnv();
        try {
            writeLocal(env.cwd, { host: 'https://proj.example', apiKey: 'sk_proj' });
            process.chdir(env.cwd);
            expect(() => assertProjectLocalConfig(path.join(env.cwd, 'wf.mjs'), 'production')).not.toThrow();
        } finally { env.cleanup(); }
    });
});

/**
 * Review round 2 (FALSE-POSITIVE): the re-exec cwd used the nearest package.json
 * parent, so in a monorepo (`/repo/package.json` + `/repo/apps/a/.solidactions/`)
 * an entry under `apps/a` re-exec'd with cwd `/repo` — no local config reachable
 * there, so the guard refused a legitimate run. The child cwd is now anchored to
 * the entry's own local config.
 */
describe('resolveDevProjectDir — monorepo anchoring', () => {
    it('prefers the directory owning the entry\'s local config over the nearest package.json', () => {
        const env = makeTmpEnv();
        try {
            const repo = env.cwd;
            const app = path.join(repo, 'apps', 'a');
            fs.mkdirSync(path.join(app, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"repo"}');
            writeLocal(app, { host: 'https://a.example', apiKey: 'sk_a' });

            expect(resolveDevProjectDir(path.join(app, 'src', 'wf.ts'))).toBe(app);
        } finally { env.cleanup(); }
    });

    it('falls back to the nearest package.json parent when no local config exists', () => {
        const env = makeTmpEnv();
        try {
            const repo = env.cwd;
            const nested = path.join(repo, 'apps', 'b', 'src');
            fs.mkdirSync(nested, { recursive: true });
            fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"repo"}');

            expect(resolveDevProjectDir(path.join(nested, 'wf.ts'))).toBe(repo);
        } finally { env.cleanup(); }
    });

    it('the guard passes from the anchored cwd in that monorepo layout', () => {
        const env = makeTmpEnv();
        try {
            const repo = env.cwd;
            const app = path.join(repo, 'apps', 'a');
            fs.mkdirSync(path.join(app, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"repo"}');
            writeLocal(app, { host: 'https://a.example', apiKey: 'sk_a' });

            const entry = path.join(app, 'src', 'wf.ts');
            process.chdir(resolveDevProjectDir(entry)); // what the re-exec child does
            expect(() => assertProjectLocalConfig(entry, 'production')).not.toThrow();
        } finally { env.cleanup(); }
    });
});

/**
 * Review round 2 (mechanical): compare config identity by realpath so a project
 * reached through a symlinked alias is not reported as a different project.
 */
describe('assertProjectLocalConfig — symlinked project alias', () => {
    it('does not report a mismatch when entry and cwd reach the same config via a symlink', () => {
        const env = makeTmpEnv();
        try {
            const real = path.join(env.cwd, 'real-project');
            fs.mkdirSync(path.join(real, 'src'), { recursive: true });
            writeLocal(real, { host: 'https://proj.example', apiKey: 'sk_proj' });

            const alias = path.join(env.cwd, 'alias-project');
            fs.symlinkSync(real, alias, 'dir');

            process.chdir(real);
            // Entry reached through the alias — same file, different path string.
            expect(() => assertProjectLocalConfig(path.join(alias, 'src', 'wf.mjs'), 'production')).not.toThrow();
        } finally { env.cleanup(); }
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
        const out = await runDev({ entry: ECHO_FIXTURE, input: '{"n":1}', env: 'production', api: realApi() });
        expect(out.result.status).toBe('completed');
    }, 20_000);

    it('a bare run (no --env) does no platform fetch and is never blocked by the guard', async () => {
        const out = await runDev({ entry: ECHO_FIXTURE, input: '{"n":1}' });
        expect(out.result.status).toBe('completed');
        expect(out.stdout).toContain('running locally');
    }, 20_000);
});

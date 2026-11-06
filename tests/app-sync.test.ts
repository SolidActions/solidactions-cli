/**
 * The `app:` block on deploy (app#2522, Task C1).
 *
 * Test-double policy: the app is answered by a real in-process HTTP server
 * (node:http on port 0), the seam the chief ruled for this task (mail
 * 6d71efaa, entered in the app's docs/decisions.md seams ledger); the real
 * path is the app plan's "Real deploy" verify row. The deploy rows spawn the
 * built binary (dist/index.js), so `npm run build` comes before them.
 * No mock/spy/stub libraries.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildAppSyncPayload, emptyColourWarnings, formatAppSync, syncApp } from '../src/utils/app-sync';
import type { AppSyncResult } from '../src/utils/app-sync';
import type { SolidActionsConfig } from '../src/utils/env';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

function parse(source: string): SolidActionsConfig {
    return yaml.load(source) as SolidActionsConfig;
}

describe('buildAppSyncPayload', () => {
    it('sends the app: block exactly as the yaml declares it', () => {
        const config = parse('pages: []\napp:\n  sidebar: hidden\n  theme:\n    light:\n      accent: "#1f3a2e"\n');

        expect(buildAppSyncPayload(config)).toEqual({ app: { sidebar: 'hidden', theme: { light: { accent: '#1f3a2e' } } } });
    });

    it('sends null when the yaml has no app: block', () => {
        expect(buildAppSyncPayload(parse('pages: []\n'))).toEqual({ app: null });
        expect(buildAppSyncPayload({})).toEqual({ app: null });
    });

    it('sends null for an empty app: key, which the yaml parses to null', () => {
        const config = parse('pages: []\napp:\n');

        expect(config.app).toBeNull();
        expect(buildAppSyncPayload(config)).toEqual({ app: null });
    });
});

describe('emptyColourWarnings', () => {
    it('warns once for an unquoted hex colour, which yaml reads as a comment', () => {
        const config = parse('app:\n  theme:\n    light:\n      accent: #e0a458\n      mark: "#e0a458"\n');

        // Positive control: the quoted sibling arrived as a string, the unquoted one as null.
        expect(config.app?.theme?.light).toEqual({ accent: null, mark: '#e0a458' });
        expect(emptyColourWarnings(config.app)).toEqual(['app.theme.light.accent is empty: quote hex colours in yaml ("#e0a458")']);
    });

    it('names the mode and the key for every empty colour in both palettes', () => {
        const config = parse('app:\n  theme:\n    light:\n      sidebar_bg: #111111\n    dark:\n      sidebar_fg: #eeeeee\n      mark: #ff00ff\n');

        expect(emptyColourWarnings(config.app)).toEqual([
            'app.theme.light.sidebar_bg is empty: quote hex colours in yaml ("#e0a458")',
            'app.theme.dark.sidebar_fg is empty: quote hex colours in yaml ("#e0a458")',
            'app.theme.dark.mark is empty: quote hex colours in yaml ("#e0a458")',
        ]);
    });

    it('stays quiet for a fully quoted block', () => {
        const config = parse('app:\n  sidebar: shown\n  theme:\n    light:\n      sidebar_bg: "#ffffff"\n      sidebar_fg: "#111111"\n      accent: "#1f3a2e"\n      mark: "#e0a458"\n');

        expect(config.app?.theme?.light?.accent).toBe('#1f3a2e');
        expect(emptyColourWarnings(config.app)).toEqual([]);
    });

    it('stays quiet when a whole palette or the theme is null, or the block is absent', () => {
        expect(emptyColourWarnings(parse('app:\n  theme:\n    light:\n').app)).toEqual([]);
        expect(emptyColourWarnings(parse('app:\n  theme:\n').app)).toEqual([]);
        expect(emptyColourWarnings(parse('app:\n  sidebar: hidden\n').app)).toEqual([]);
        expect(emptyColourWarnings(undefined)).toEqual([]);
        expect(emptyColourWarnings(null)).toEqual([]);
        expect(emptyColourWarnings('text')).toEqual([]);
    });

    it('stays quiet for a palette key that is simply not present', () => {
        expect(emptyColourWarnings(parse('app:\n  theme:\n    dark:\n      accent: "#112233"\n').app)).toEqual([]);
    });
});

describe('formatAppSync', () => {
    const ok = (body: unknown): AppSyncResult => ({ httpStatus: 200, transportError: false, body });
    const status = (httpStatus: number, body: unknown = null): AppSyncResult => ({ httpStatus, transportError: false, body });
    const palette = { sidebar_bg: '#ffffff' };

    it.each([
        ['set with both palettes', ok({ outcome: 'set', owner: 'code', app: { sidebar: 'hidden', theme: { light: palette, dark: palette } } }), true, ['✓ App settings applied (sidebar: hidden, theme: light+dark)'], false],
        ['set with the light palette only', ok({ outcome: 'set', owner: 'code', app: { sidebar: 'shown', theme: { light: palette, dark: null } } }), true, ['✓ App settings applied (sidebar: shown, theme: light)'], false],
        ['set with the dark palette only', ok({ outcome: 'set', owner: 'code', app: { sidebar: 'shown', theme: { light: null, dark: palette } } }), true, ['✓ App settings applied (sidebar: shown, theme: dark)'], false],
        ['set with no theme', ok({ outcome: 'set', owner: 'code', app: { sidebar: 'hidden', theme: null } }), true, ['✓ App settings applied (sidebar: hidden, theme: none)'], false],
        ['unchanged after an app: block was sent', ok({ outcome: 'unchanged', owner: 'code', app: {} }), true, ['✓ App settings unchanged'], false],
        ['unchanged with no app: block (most deploys)', ok({ outcome: 'unchanged', owner: null, app: null }), false, [], false],
        ['cleared', ok({ outcome: 'cleared', owner: null, app: null }), false, ['✓ App settings cleared (the app: block was removed)'], false],
        ['kept_editor', ok({ outcome: 'kept_editor', owner: 'editor', app: { sidebar: 'hidden' } }), false, [], false],
        ['404 with no app: block (an older server)', status(404), false, [], false],
        ['404 with an app: block', status(404), true, ['This server does not support app: yet; upgrade the platform'], true],
        ['422 with one error', status(422, { code: 'validation_failed', message: 'The app: block in solidactions.yaml is invalid.', errors: { 'app.theme.light.accent': ['Must be a colour like #1f3a2e.'] } }), true, ['App settings refused:', '  app.theme.light.accent: Must be a colour like #1f3a2e.'], true],
        ['422 with several fields and messages', status(422, { errors: { 'app.sidebar': ['Must be shown or hidden.'], 'app.theme.dark.mark': ['Must be a colour like #1f3a2e.', 'Too dark.'] } }), true, ['App settings refused:', '  app.sidebar: Must be shown or hidden.', '  app.theme.dark.mark: Must be a colour like #1f3a2e.', '  app.theme.dark.mark: Too dark.'], true],
        ['401', status(401, { message: 'Unauthenticated.' }), true, ['App settings sync FAILED: not signed in'], true],
        ['403 with the server message', status(403, { code: 'forbidden', message: 'Forbidden.' }), false, ['App settings sync FAILED: Forbidden.'], true],
        ['500 with no body', status(500), false, ['App settings sync FAILED: HTTP 500'], true],
        ['500 with an empty message', status(500, { message: '' }), true, ['App settings sync FAILED: HTTP 500'], true],
        ['transport error', { httpStatus: null, transportError: true, body: null } as AppSyncResult, true, ['App settings sync FAILED: could not reach the server'], true],
    ] as const)('prints the line for %s', (_name, result, sentApp, lines, failed) => {
        expect(formatAppSync(result as AppSyncResult, sentApp)).toEqual({ lines, failed });
    });
});

describe('syncApp', () => {
    let server: http.Server;
    let port: number;
    let seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string } | null = null;
    let answerStatus = 200;
    let answerBody: object = {};

    beforeAll(async () => {
        server = http.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', (chunk: Buffer) => chunks.push(chunk));
            request.on('end', () => {
                seen = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') };
                response.writeHead(answerStatus, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(answerBody));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        }));
    });

    afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));

    beforeEach(() => {
        seen = null;
        answerStatus = 200;
        answerBody = {};
    });

    it('PUTs the app block to the project app/sync route with the API headers and returns the answer', async () => {
        answerBody = { outcome: 'set', owner: 'code', app: { sidebar: 'hidden', theme: null } };

        const result = await syncApp({ host: `http://127.0.0.1:${port}`, apiKey: 'key-1', workspaceId: 'ws-1' }, 'foo-dev', { app: { sidebar: 'hidden' } });

        expect(seen).not.toBeNull();
        expect(seen?.method).toBe('PUT');
        expect(seen?.url).toBe('/api/v1/projects/foo-dev/app/sync');
        expect(JSON.parse(seen?.body ?? 'null')).toEqual({ app: { sidebar: 'hidden' } });
        expect(seen?.body).toBe('{"app":{"sidebar":"hidden"}}');
        expect(seen?.headers.authorization).toBe('Bearer key-1');
        expect(seen?.headers.accept).toBe('application/json');
        expect(seen?.headers['content-type']).toContain('application/json');
        expect(seen?.headers['x-workspace-id']).toBe('ws-1');
        expect(result).toEqual({ httpStatus: 200, transportError: false, body: answerBody });
    });

    it('sends {"app":null} when the deploy has no app block, and escapes the slug in the path', async () => {
        await syncApp({ host: `http://127.0.0.1:${port}`, apiKey: 'key-1' }, 'a b', { app: null });

        expect(seen?.url).toBe('/api/v1/projects/a%20b/app/sync');
        expect(seen?.body).toBe('{"app":null}');
    });

    it('returns the status and body of a refusal instead of throwing', async () => {
        answerStatus = 422;
        answerBody = { code: 'validation_failed', message: 'The app: block in solidactions.yaml is invalid.', errors: { 'app.sidebar': ['Must be shown or hidden.'] } };

        const result = await syncApp({ host: `http://127.0.0.1:${port}`, apiKey: 'key-1' }, 'foo', { app: { sidebar: 'nope' } });

        expect(seen?.method).toBe('PUT');
        expect(result).toEqual({ httpStatus: 422, transportError: false, body: answerBody });
    });

    it('reports a transport error when nothing is listening', async () => {
        const closed = http.createServer();
        await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
        const closedPort = (closed.address() as { port: number }).port;
        await new Promise<void>((resolve, reject) => closed.close((error) => (error ? reject(error) : resolve())));

        const result = await syncApp({ host: `http://127.0.0.1:${closedPort}`, apiKey: 'key-1' }, 'foo', { app: null });

        expect(result).toEqual({ httpStatus: null, transportError: true, body: null });
    });
});

describe('solidactions project deploy sends the app: block', () => {
    interface Seen { method: string; url: string; body: string; headers: http.IncomingHttpHeaders; }

    const PROJECT = 'app-proj';
    let server: http.Server;
    let port: number;
    let requests: Seen[] = [];
    let appStatus = 200;
    let appBody: object = {};
    let home: string;
    let sourceDir: string;

    beforeAll(async () => {
        server = http.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', (chunk: Buffer) => chunks.push(chunk));
            request.on('end', () => {
                const url = request.url ?? '';
                requests.push({ method: request.method ?? '', url, body: Buffer.concat(chunks).toString('utf8'), headers: request.headers });
                if (request.method === 'PUT' && url.endsWith('/app/sync')) {
                    response.writeHead(appStatus, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify(appBody));
                    return;
                }
                if (request.method === 'GET' && /^\/api\/v1\/projects\/[^/?]+$/.test(url)) {
                    response.writeHead(200, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify({ slug: PROJECT, status: 'deployed' }));
                    return;
                }
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({}));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        }));
    });

    afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));

    beforeEach(() => {
        requests = [];
        appStatus = 200;
        appBody = {};
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-app-sync-home-'));
        sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-app-sync-src-'));
        fs.mkdirSync(path.join(sourceDir, 'pages'));
        fs.writeFileSync(path.join(sourceDir, 'pages', 'home.html'), '<h1>Home</h1>\n');
    });

    afterEach(() => {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(sourceDir, { recursive: true, force: true });
    });

    function writeYaml(appBlock: string): void {
        fs.writeFileSync(path.join(sourceDir, 'solidactions.yaml'), `pages:\n  - id: home\n    name: Home\n    file: pages/home.html\n${appBlock}`);
    }

    function deployProject(): Promise<{ code: number; stdout: string; stderr: string }> {
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1', SOLIDACTIONS_HOST: `http://127.0.0.1:${port}`, SOLIDACTIONS_API_KEY: 'key-1', SOLIDACTIONS_WORKSPACE_ID: 'ws-1' };
        delete env.FORCE_COLOR;
        return new Promise((resolve) => {
            execFile(process.execPath, [CLI_BINARY, 'project', 'deploy', PROJECT, sourceDir, '-e', 'production', '--no-git-metadata'], { env, encoding: 'utf8', timeout: 60000 }, (error, stdout, stderr) => {
                const code = error === null ? 0 : (typeof error.code === 'number' ? error.code : -1);
                resolve({ code, stdout, stderr });
            });
        });
    }

    const appSyncRequests = (): Seen[] => requests.filter(r => r.method === 'PUT' && r.url.endsWith('/app/sync'));
    const indexOf = (suffix: string): number => requests.findIndex(r => r.method === 'PUT' && r.url.endsWith(suffix));

    it('sends the yaml block, prints the applied line and exits 0', { timeout: 90000 }, async () => {
        appBody = { outcome: 'set', owner: 'code', app: { sidebar: 'hidden', theme: { light: { accent: '#1f3a2e' }, dark: null } } };
        writeYaml('app:\n  sidebar: hidden\n  theme:\n    light:\n      accent: "#1f3a2e"\n');

        const run = await deployProject();

        // Positive control: the deploy ran to its pages sync.
        expect(indexOf('/pages/sync')).toBeGreaterThanOrEqual(0);
        expect(appSyncRequests()).toHaveLength(1);
        const sent = appSyncRequests()[0];
        expect(sent.url).toBe(`/api/v1/projects/${PROJECT}/app/sync`);
        expect(JSON.parse(sent.body)).toEqual({ app: { sidebar: 'hidden', theme: { light: { accent: '#1f3a2e' } } } });
        expect(sent.headers.authorization).toBe('Bearer key-1');
        expect(sent.headers['x-workspace-id']).toBe('ws-1');
        // After the yaml declarations, before the pages sync.
        const declarations = requests.findIndex(r => r.method === 'POST' && r.url.endsWith('/variable-mappings/sync-yaml'));
        expect(declarations).toBeGreaterThanOrEqual(0);
        expect(indexOf('/app/sync')).toBeGreaterThan(declarations);
        expect(indexOf('/app/sync')).toBeLessThan(indexOf('/pages/sync'));
        expect(run.stdout).toContain('✓ App settings applied (sidebar: hidden, theme: light)');
        expect(run.code).toBe(0);
    });

    it('warns about an unquoted colour on stdout and still sends the block', { timeout: 90000 }, async () => {
        appBody = { outcome: 'set', owner: 'code', app: { sidebar: 'shown', theme: { light: { mark: '#112233' }, dark: null } } };
        writeYaml('app:\n  theme:\n    light:\n      accent: #e0a458\n      mark: "#112233"\n');

        const run = await deployProject();

        expect(appSyncRequests()).toHaveLength(1);
        expect(JSON.parse(appSyncRequests()[0].body)).toEqual({ app: { theme: { light: { accent: null, mark: '#112233' } } } });
        expect(run.stdout).toContain('app.theme.light.accent is empty: quote hex colours in yaml ("#e0a458")');
        expect(run.code).toBe(0);
    });

    it('prints the server\'s refusal on stderr and exits 1', { timeout: 90000 }, async () => {
        appStatus = 422;
        appBody = { code: 'validation_failed', message: 'The app: block in solidactions.yaml is invalid.', errors: { 'app.theme.light.accent': ['Must be a colour like #1f3a2e.'] } };
        writeYaml('app:\n  theme:\n    light:\n      accent: "red"\n');

        const run = await deployProject();

        // Positive control: the deploy still reached the pages sync after the refusal.
        expect(indexOf('/pages/sync')).toBeGreaterThanOrEqual(0);
        expect(appSyncRequests()).toHaveLength(1);
        expect(run.stderr).toContain('App settings refused:');
        expect(run.stderr).toContain('  app.theme.light.accent: Must be a colour like #1f3a2e.');
        expect(run.code).toBe(1);
    });

    it('names the host on a 401 from the app route and exits 1', { timeout: 90000 }, async () => {
        appStatus = 401;
        appBody = { message: 'Unauthenticated.' };
        writeYaml('app:\n  sidebar: hidden\n');

        const run = await deployProject();

        expect(appSyncRequests()).toHaveLength(1);
        expect(run.stderr).toContain('Authentication failed against');
        expect(run.stderr).toContain('App settings sync FAILED: not signed in');
        expect(run.code).toBe(1);
    });

    it('sends {"app":null} with no yaml block, prints nothing about app settings when unchanged, and exits 0', { timeout: 90000 }, async () => {
        appBody = { outcome: 'unchanged', owner: null, app: null };
        writeYaml('');

        const run = await deployProject();

        expect(indexOf('/pages/sync')).toBeGreaterThanOrEqual(0);
        expect(appSyncRequests()).toHaveLength(1);
        expect(JSON.parse(appSyncRequests()[0].body)).toEqual({ app: null });
        expect(run.stdout).not.toContain('App settings');
        expect(run.stderr).not.toContain('App settings');
        expect(run.code).toBe(0);
    });

    it('treats a 404 from an older server as nothing to say when the yaml has no app: block', { timeout: 90000 }, async () => {
        appStatus = 404;
        appBody = { message: 'Not found.' };
        writeYaml('');

        const run = await deployProject();

        expect(indexOf('/pages/sync')).toBeGreaterThanOrEqual(0);
        expect(appSyncRequests()).toHaveLength(1);
        expect(run.stdout + run.stderr).not.toContain('App settings');
        expect(run.stdout + run.stderr).not.toContain('does not support app:');
        expect(run.code).toBe(0);
    });

    it('fails the deploy with the upgrade line when an older server meets an app: block', { timeout: 90000 }, async () => {
        appStatus = 404;
        appBody = { message: 'Not found.' };
        writeYaml('app:\n  sidebar: hidden\n');

        const run = await deployProject();

        expect(appSyncRequests()).toHaveLength(1);
        expect(run.stderr).toContain('This server does not support app: yet; upgrade the platform');
        expect(run.code).toBe(1);
    });
});

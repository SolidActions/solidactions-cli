/**
 * Local app server seam: same as tests/deploy-archive-every.test.ts, accepted in app docs/decisions.md 2026-11-08 (mail fa9f7607); nine sibling tests/deploy-*.test.ts use it.
 *
 * deploy end-to-end for code pages (cli#236): a real `http.createServer` fake, real temp project
 * directories, the real pinned esbuild through the built `dist/commands/deploy.js`. No mocks.
 * CI (`check.yml`) runs this file.
 */
import * as http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validatesAgainstAppMain } from './helpers/pages-sync-main-rules';

const project = 'code-pages-project';
let server: http.Server;
let port: number;
let requests: { method: string; url: string; body: Buffer; contentType: string }[] = [];
let sourceDir = '';
let projectMissing = false;
let notFoundServed = 0;

const BOARD_TSX = `import React from 'react';
import { formatTitle } from '../lib/format';
import { mark } from 'fake-chart';

export default function Board(): React.ReactElement {
    return <div>{formatTitle('board')}{mark}</div>;
}
`;
const FORMAT_TS = `export function formatTitle(title: string): string {
    return \`TITLE:\${title}\`;
}
`;
const ABOUT_HTML = '<h1>About</h1>\n';

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const url = req.url ?? '';
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            requests.push({ method: req.method ?? '', url, body: Buffer.concat(chunks), contentType: req.headers['content-type'] ?? '' });
            res.setHeader('Content-Type', 'application/json');
            if (req.method === 'GET' && url === `/api/v1/projects/${project}`) {
                if (projectMissing) {
                    res.statusCode = 404;
                    notFoundServed += 1;
                    res.end(JSON.stringify({ message: 'not found' }));
                } else {
                    res.end(JSON.stringify({ slug: project, status: 'deployed' }));
                }
            } else if (req.method === 'POST' && url === '/api/v1/projects') {
                res.end(JSON.stringify({ slug: project }));
            } else if (req.method === 'POST' && url.endsWith('/deploy')) {
                res.end(JSON.stringify({ stored: true, source_hash: 'a'.repeat(32), deployment_id: 'dep-1' }));
            } else if (req.method === 'PUT' && url.endsWith('/functions/sync')) {
                res.end(JSON.stringify({ functions: [], retired: [], retire_errors: [] }));
            } else if (req.method === 'PUT' && url.endsWith('/pages/sync')) {
                const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                res.end(JSON.stringify({
                    pages: (payload.pages ?? []).map((page: any, index: number) => ({
                        slug: page.slug, id: index + 1, status: 'live', error: null, url: null,
                    })),
                    trashed: [],
                    trash_errors: [],
                    stamp: 'written',
                }));
            } else {
                res.end(JSON.stringify({}));
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port;
        resolve();
    }));
});

afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

function writeFile(root: string, rel: string, text: string): void {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
}

/** Brief fixture; variant selects the row's breakage. Removed in `finally` in `run`. */
function fixture(variant: 'full' | 'broken' | 'oversize' | 'html-only'): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-code-pages-')));
    const board = variant === 'oversize'
        ? `import React from 'react';\n\nexport default function Board(): React.ReactElement {\n    return (\n        <div>\n${'<span>x</span>\n'.repeat(65000)}        </div>\n    );\n}\n`
        : BOARD_TSX;
    const format = variant === 'broken'
        ? `import { Fragment } from 'react/jsx-runtime';\n\nexport function formatTitle(title: string): string {\n    return \`TITLE:\${title}:\${typeof Fragment}\`;\n}\n`
        : FORMAT_TS;
    writeFile(root, 'pages/board.tsx', board);
    writeFile(root, 'lib/format.ts', format);
    writeFile(root, 'node_modules/fake-chart/package.json', '{"name":"fake-chart","version":"1.0.0","main":"index.js"}');
    writeFile(root, 'node_modules/fake-chart/index.js', `import './style.css';\nexport const mark = 'FAKE_CHART_MARK';\n`);
    writeFile(root, 'node_modules/fake-chart/style.css', '.fake{color:red}\n');
    writeFile(root, 'pages/about.html', ABOUT_HTML);
    const pages = variant === 'html-only'
        ? '  - id: about\n    name: About\n    file: pages/about.html\n'
        : '  - id: board\n    name: Board\n    file: pages/board.tsx\n    home: true\n    sources:\n      - key: sales\n        kind: sql\n        database: main\n        sql: select 1\n  - id: about\n    name: About\n    file: pages/about.html\n';
    writeFile(root, 'solidactions.yaml', `pages:\n${pages}`);
    writeFile(root, 'package.json', JSON.stringify({ name: 'fixture', dependencies: { '@solidactions/sdk': '^0.7.3' } }));
    // Setup proof: the entry files the rows assert on really exist.
    expect(fs.existsSync(path.join(root, 'pages/board.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'pages/about.html'))).toBe(true);
    return root;
}

async function run(
    variant: 'full' | 'broken' | 'oversize' | 'html-only',
    options: { configOnly?: boolean; missing?: boolean } = {},
) {
    sourceDir = fixture(variant);
    requests = [];
    projectMissing = options.missing ?? false;
    notFoundServed = 0;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-code-pages-home-'));
    const modulePath = path.resolve('dist/commands/deploy.js');
    const script = `const command = require(process.argv[1]); command.deploy('code-pages-project', process.argv[2], { env: 'production', gitMetadata: false, configOnly: process.argv[3] === '1' });`;
    try {
        const child = spawn(process.execPath, ['-e', script, modulePath, sourceDir, options.configOnly ? '1' : '0'], {
            env: { ...process.env, HOME: home, SOLIDACTIONS_HOST: `http://127.0.0.1:${port}`, SOLIDACTIONS_API_KEY: 'test-key', SOLIDACTIONS_WORKSPACE_ID: 'workspace-1', FORCE_COLOR: '0' },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
        const exit = await new Promise<number | null>((resolve, reject) => {
            child.on('error', reject);
            child.on('close', resolve);
        });
        return { stdout, stderr, exit, requests: [...requests], notFoundServed };
    } finally {
        fs.rmSync(sourceDir, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
    }
}

function pagesSyncBody(request: { body: Buffer }): any {
    return JSON.parse(request.body.toString('utf8'));
}

describe('deploy code pages end to end', () => {
    // Brief row 1.
    it('deploys a tsx page and an html page with bundle fields that validate against the app rules', async () => {
        const result = await run('full');
        expect(result.exit).toBe(0);
        expect(result.stderr).toBe('');
        const puts = result.requests.filter((r) => r.method === 'PUT' && r.url.endsWith('/pages/sync'));
        expect(puts).toHaveLength(1);
        const body = pagesSyncBody(puts[0]);
        expect(body.pages).toHaveLength(2);
        expect(body.pages.map((page: any) => page.slug).sort()).toEqual(['about', 'board']);
        const board = body.pages.find((page: any) => page.slug === 'board');
        const about = body.pages.find((page: any) => page.slug === 'about');
        expect(board).toMatchObject({ language: 'tsx', kind: 'dashboard', body: BOARD_TSX });
        expect(board.compiled.startsWith('globalThis.__saPlatform.define(')).toBe(true);
        expect(board.compiled_css).toContain('.fake');
        expect(board.compiler_version).toBe('0.28.2');
        expect(Object.keys(board.source_files).sort()).toEqual(['lib/format.ts', 'pages/board.tsx']);
        expect(board.sources).toEqual([{ key: 'sales', kind: 'sql', database: 'main', sql: 'select 1' }]);
        expect(about.language).toBe('html');
        for (const key of ['compiled', 'compiled_css', 'compiler_version', 'source_files']) {
            expect(key in about).toBe(false);
        }
        // Old-server guard (R1): today's app main still accepts this body.
        expect(validatesAgainstAppMain(body)).toEqual([]);
    }, 60_000);

    // Brief row 2 (regression pin: passes on the base too).
    it('syncs pages after the archive POST', async () => {
        const result = await run('full');
        expect(result.exit).toBe(0);
        const posts = result.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/deploy'));
        expect(posts).toHaveLength(1);
        const syncIndex = result.requests.findIndex((r) => r.method === 'PUT' && r.url.endsWith('/pages/sync'));
        expect(syncIndex).toBeGreaterThan(result.requests.indexOf(posts[0]));
    }, 60_000);

    // Brief row 3.
    it('refuses a page that fails to bundle and uploads nothing', async () => {
        const result = await run('broken');
        expect(result.exit).toBe(1);
        expect(result.stderr).toContain('Page bundling failed; nothing was uploaded:');
        expect(result.stderr).toContain('page board (pages/board.tsx):');
        expect(result.stderr).toContain('react/jsx-runtime');
        expect(result.requests.filter((r) => r.method === 'PUT' || r.method === 'POST')).toHaveLength(0);
    }, 60_000);

    // Brief row 3b (ruling after the Task 2 review).
    it('fails bundling before project creation on first deploy', async () => {
        const result = await run('broken', { missing: true });
        expect(result.exit).toBe(1);
        expect(result.stderr).toContain('Page bundling failed; nothing was uploaded:');
        expect(result.stderr).toContain('page board (pages/board.tsx):');
        expect(result.stderr).toContain('react/jsx-runtime');
        // The 404 project lookup ran exactly as the CLI sends it (typed and
        // canonical slugs are identical here, so one GET), through the 404
        // branch; the bundling failure then exits before any creation POST.
        const gets = result.requests.filter((r) => r.method === 'GET');
        expect(gets).toHaveLength(1);
        expect([gets[0].method, gets[0].url]).toEqual(['GET', `/api/v1/projects/${project}`]);
        expect(result.notFoundServed).toBeGreaterThan(0);
        expect(result.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
        expect(result.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    }, 60_000);

    // Brief row 3c (ruling after the Task 2 review).
    it('skips bundling for --config-only and syncs the config', async () => {
        const result = await run('broken', { configOnly: true });
        expect(result.exit).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('✓ Config synced for code-pages-project');
        expect(result.stdout + result.stderr).not.toContain('Page bundling failed');
        expect(result.requests.filter((r) => r.method === 'PUT' && r.url.endsWith('/pages/sync'))).toHaveLength(0);
        // Positive control: the config sync itself ran.
        expect(result.requests.filter((r) => r.method === 'POST' && r.url.endsWith('variable-mappings/sync-yaml'))).toHaveLength(1);
    }, 60_000);

    // Brief row 4.
    it('refuses a page over the 2 MiB limit and uploads nothing', async () => {
        const result = await run('oversize');
        expect(result.exit).toBe(1);
        expect(result.stderr).toContain('page board');
        expect(result.stderr).toContain('over the 2 MiB (2097152 bytes) limit');
        expect(result.requests.filter((r) => r.method === 'PUT' || r.method === 'POST')).toHaveLength(0);
    }, 120_000);

    // Brief row 5 (regression pin: passes on the base too).
    it('deploys an html-only project with no bundle fields', async () => {
        const result = await run('html-only');
        expect(result.exit).toBe(0);
        expect(result.stderr).toBe('');
        const puts = result.requests.filter((r) => r.method === 'PUT' && r.url.endsWith('/pages/sync'));
        expect(puts).toHaveLength(1);
        const body = pagesSyncBody(puts[0]);
        expect(body.pages).toHaveLength(1);
        expect(body.pages[0].slug).toBe('about');
        expect(body.pages[0].path).toBe('pages/about.html');
        for (const page of body.pages) {
            expect(page.language).toBe('html');
            for (const key of ['compiled', 'compiled_css', 'compiler_version', 'source_files']) {
                expect(key in page).toBe(false);
            }
        }
        expect(validatesAgainstAppMain(body)).toEqual([]);
    }, 60_000);
});

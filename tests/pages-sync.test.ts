import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildPagesSyncPayload, bundleCodePages, formatPagesSummary, formatPagesSyncFailure, listCodePages, pagesSyncOutcome, readPageBodies, terminalExitCode } from '../src/utils/pages-sync';
import type { PageFile, PagesSyncOutcome, PagesSyncResultRow } from '../src/utils/pages-sync';
import { validatesAgainstAppMain } from './helpers/pages-sync-main-rules';

const pages: PageFile[] = [
    { slug: 'home', name: 'Home', path: 'pages/home.html', kind: 'visual', language: 'html', home: true },
    { slug: 'board', name: 'Board', path: 'pages/board.tsx', kind: 'dashboard', language: 'tsx', home: false, sources: [{ key: 'sales' }] },
];
const live: PagesSyncResultRow = { slug: 'home', id: 1, status: 'live', error: null, url: '/home' };
const failed: PagesSyncResultRow = { slug: 'board', id: null, status: 'error', error: { code: 'unknown_binding', message: 'Missing binding' }, url: null };

describe('pages sync', () => {
    it('lists code pages in YAML order and skips editor pointers', () => {
        expect(listCodePages({ pages: [
            { id: 'home', name: 'Home', file: 'pages/home.html', home: true },
            { id: 7, name: 'Editor', owner: 'editor' },
            { id: 'board', name: 'Board', file: 'pages/board.tsx', sources: [{ key: 'sales' }] },
        ] })).toEqual(pages);
    });
    it('lists no pages when the section is absent', () => {
        expect(listCodePages({})).toEqual([]);
    });
    it('reads exact page bodies from real files', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pages-'));
        try {
            fs.mkdirSync(path.join(root, 'pages'));
            fs.writeFileSync(path.join(root, pages[0].path), '<h1>Home</h1>\n');
            fs.writeFileSync(path.join(root, pages[1].path), 'export default 42;\n');
            expect(readPageBodies(root, pages)).toEqual(new Map([['home', '<h1>Home</h1>\n'], ['board', 'export default 42;\n']]));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
    it('builds the payload with null deployment and passthrough provenance and page fields', () => {
        const ref = { branch: 'main', short_sha: 'abc', commit_sha: 'abcdef', dirty: false };
        expect(buildPagesSyncPayload(pages, new Map([['home', 'html'], ['board', 'tsx']]), null, ref)).toEqual({
            deployment_id: null, code_ref: ref, pages: [{ ...pages[0], body: 'html' }, { ...pages[1], body: 'tsx' }],
        });
    });
    it('marks .html pages html and .tsx pages tsx', () => {
        expect(listCodePages({ pages: [
            { id: 'a', name: 'A', file: 'pages/a.html' },
            { id: 'b', name: 'B', file: 'pages/b.tsx' },
        ] }).map(page => page.language)).toEqual(['html', 'tsx']);
    });
    it('adds bundle fields to bundled pages only, keeping the data sources', () => {
        const ref = { branch: 'main', short_sha: 'abc', commit_sha: 'abcdef', dirty: false };
        const bodies = new Map([['home', 'html'], ['board', 'tsx']]);
        const bundles = new Map([['board', { compiled: 'C', compiledCss: 'S', sources: { 'pages/board.tsx': 'T' }, compilerVersion: '0.28.2' }]]);

        const payload = buildPagesSyncPayload(pages, bodies, null, ref, bundles);

        expect(payload.pages[1]).toEqual({ ...pages[1], body: 'tsx', source_files: { 'pages/board.tsx': 'T' }, compiled: 'C', compiled_css: 'S', compiler_version: '0.28.2' });
        expect(payload.pages[1].sources).toEqual([{ key: 'sales' }]);
        for (const key of ['source_files', 'compiled', 'compiled_css', 'compiler_version'] as const) {
            expect(key in payload.pages[0]).toBe(false);
        }
    });
    it('bundles only tsx pages and names the failing slug, file and line', async () => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pages-bundle-')));
        try {
            fs.mkdirSync(path.join(root, 'pages'), { recursive: true });
            fs.writeFileSync(path.join(root, 'pages/board.tsx'), `import React from 'react';\nexport default function Board(): React.ReactElement {\n    const = 5;\n    return <div />;\n}\n`);
            fs.writeFileSync(path.join(root, 'pages/home.html'), '<h1>Home</h1>\n');
            const tsxPage: PageFile = { slug: 'board', name: 'Board', path: 'pages/board.tsx', kind: 'dashboard', language: 'tsx', home: false };
            const htmlPage: PageFile = { slug: 'home', name: 'Home', path: 'pages/home.html', kind: 'visual', language: 'html', home: true };

            const { bundles, errors } = await bundleCodePages(root, [tsxPage, htmlPage]);

            expect(errors.length).toBe(1);
            expect(errors[0].startsWith('page board (pages/board.tsx): pages/board.tsx:3:')).toBe(true);
            expect(bundles.size).toBe(0);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
    it('tries every tsx page and keeps only the valid bundles', async () => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pages-bundle-')));
        try {
            fs.mkdirSync(path.join(root, 'pages'), { recursive: true });
            fs.writeFileSync(path.join(root, 'pages/bad-syntax.tsx'), `import React from 'react';\nexport default function Bad(): React.ReactElement {\n    const = 5;\n    return <div />;\n}\n`);
            fs.writeFileSync(path.join(root, 'pages/bad-runtime.tsx'), `import 'react/jsx-runtime';\nimport React from 'react';\n\nexport default function Bad(): React.ReactElement {\n    return <div />;\n}\n`);
            fs.writeFileSync(path.join(root, 'pages/ok.tsx'), `import React from 'react';\n\nexport default function Ok(): React.ReactElement {\n    return <div>VALID_PAGE_MARK</div>;\n}\n`);
            const page = (slug: string, file: string): PageFile => ({ slug, name: slug, path: `pages/${file}`, kind: 'dashboard', language: 'tsx', home: false });

            const { bundles, errors } = await bundleCodePages(root, [page('bad-syntax', 'bad-syntax.tsx'), page('bad-runtime', 'bad-runtime.tsx'), page('ok', 'ok.tsx')]);

            expect(errors.length).toBe(2);
            expect(errors[0].startsWith('page bad-syntax (pages/bad-syntax.tsx):')).toBe(true);
            expect(errors[1].startsWith('page bad-runtime (pages/bad-runtime.tsx):')).toBe(true);
            expect(errors[1]).toContain('react/jsx-runtime');
            expect([...bundles.keys()]).toEqual(['ok']);
            expect(bundles.get('ok')!.compiled).toContain('VALID_PAGE_MARK');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
    it('still validates against the pinned app rules with bundles, and the helper catches a file map under sources', () => {
        // The pinned rules require sources.*.kind (R1), so this row's
        // fixture carries kind 'sql': the shared fixture's kind-less entry
        // predates the guard and would not validate against main either.
        const guarded: PageFile[] = [
            { slug: 'home', name: 'Home', path: 'pages/home.html', kind: 'visual', language: 'html', home: true },
            { slug: 'board', name: 'Board', path: 'pages/board.tsx', kind: 'dashboard', language: 'tsx', home: false, sources: [{ key: 'sales', kind: 'sql' }] },
        ];
        const ref = { branch: 'main', short_sha: 'abc', commit_sha: 'abcdef', dirty: false };
        const bodies = new Map([['home', 'html'], ['board', 'tsx']]);
        const bundles = new Map([['board', { compiled: 'C', compiledCss: 'S', sources: { 'pages/board.tsx': 'T' }, compilerVersion: '0.28.2' }]]);

        expect(validatesAgainstAppMain(buildPagesSyncPayload(guarded, bodies, null, ref))).toEqual([]);
        expect(validatesAgainstAppMain(buildPagesSyncPayload(guarded, bodies, null, ref, bundles))).toEqual([]);

        const withBundles = buildPagesSyncPayload(guarded, bodies, null, ref, bundles);
        const badPages = withBundles.pages.map(page => page.slug === 'board' ? { ...page, sources: { 'a.ts': 'x' } } : page);
        expect(validatesAgainstAppMain({ ...withBundles, pages: badPages }).length).toBeGreaterThan(0);
    });
    it('formats live, page error, trash and trash error lines in order', () => {
        expect(formatPagesSummary([live, { ...live, slug: 'no-url', url: null }, failed], [{ slug: 'old', id: 3 }], [{ slug: 'stuck', error: { code: 'denied', message: 'No access' } }])).toEqual([
            'page home: live /home', 'page no-url: live', 'page board: error unknown_binding: Missing binding',
            'page old: moved to trash (id 3)', 'page stuck: could not move to trash: denied: No access',
        ]);
    });
    it.each([
        [404, false, [], [], 0, 'skipped-old-server'],
        [404, false, [], [], 1, 'failed'],
        [500, false, [], [], 0, 'failed'],
        [409, false, [], [], 1, 'failed'],
        [503, false, [], [], 1, 'failed'],
        [null, true, [], [], 1, 'failed'],
        [200, false, [failed], [], 1, 'failed'],
        [200, false, [live], [{ slug: 'old' }], 1, 'failed'],
        [200, false, [live], [], 1, 'ok'],
    ] as const)('classifies status %s transport %s rows %j trash %j count %s as %s', (httpStatus, transportError, rows, trashErrors, sentPageCount, expected) => {
        expect(pagesSyncOutcome({ httpStatus, transportError, rows: [...rows], trashErrors: [...trashErrors], sentPageCount })).toBe(expected);
    });
    it.each([
        [200, false, null, 1, null],
        [404, false, null, 0, null],
        [404, false, null, 1, 'This server does not support pages: yet; upgrade the platform'],
        [null, true, null, 1, 'pages sync failed: could not reach the server'],
        [500, false, null, 1, 'pages sync failed (HTTP 500)'],
        [422, false, { code: 'invalid', message: 'Bad request' }, 1, 'pages sync failed (422 invalid): Bad request'],
        [409, false, { code: 'deploy_conflict', message: 'Another change to this project collided with the deploy twice. Nothing was changed; deploy again.' }, 1, 'pages sync failed (409 deploy_conflict): Another change to this project collided with the deploy twice. Nothing was changed; deploy again.'],
        [503, false, { code: 'deploy_timeout', message: 'The deploy took too long and was rolled back. Nothing was changed; deploy again.' }, 1, 'pages sync failed (503 deploy_timeout): The deploy took too long and was rolled back. Nothing was changed; deploy again.'],
    ] as const)('formats request failure status %s transport %s body %j count %s', (httpStatus, transportError, body, sentPageCount, expected) => {
        expect(formatPagesSyncFailure({ httpStatus, transportError, body, sentPageCount })).toBe(expected);
    });
    it.each([
        ['superseded', [live], 'pages sync superseded: a newer deploy of this project took over'],
        ['superseded', [], 'pages sync superseded: a newer deploy of this project took over'],
        ['failed', [live], 'pages sync failed: pages finished but completion could not be recorded; cleanup may be incomplete: deploy again'],
        ['failed', [], 'pages sync failed: pages finished but completion could not be recorded; cleanup may be incomplete: deploy again'],
    ] as const)('reports stamp %s with committed pages %j and exits 1', (stamp, rows, warning) => {
        const body = { pages: [...rows], trashed: [], trash_errors: [], stamp };
        const input = { httpStatus: 200, transportError: false, sentPageCount: rows.length };

        expect(formatPagesSummary(body.pages, body.trashed, body.trash_errors)).toEqual(rows.map(row => `page ${row.slug}: live ${row.url}`));
        expect(formatPagesSyncFailure({ ...input, body })).toBe(warning);
        const outcome = pagesSyncOutcome({ ...input, rows: body.pages, trashErrors: body.trash_errors, stamp: body.stamp });
        expect(terminalExitCode({ buildFailed: false, yamlSyncFailed: false, outcome })).toBe(1);
    });
    it.each(['written', undefined] as const)('keeps successful deploys successful with stamp %s', (stamp) => {
        const body = { pages: [live], trashed: [], trash_errors: [], stamp };
        const input = { httpStatus: 200, transportError: false, sentPageCount: 1 };

        expect(formatPagesSyncFailure({ ...input, body })).toBeNull();
        const outcome = pagesSyncOutcome({ ...input, rows: body.pages, trashErrors: body.trash_errors, stamp });
        expect(terminalExitCode({ buildFailed: false, yamlSyncFailed: false, outcome })).toBe(0);
    });
    it.each([false, true].flatMap(buildFailed => [false, true].flatMap(yamlSyncFailed => (['ok', 'failed', 'skipped-old-server'] as PagesSyncOutcome[]).map(outcome => [buildFailed, yamlSyncFailed, outcome] as const))))(
        'returns the terminal code for build %s YAML %s outcome %s', (buildFailed, yamlSyncFailed, outcome) => {
            expect(terminalExitCode({ buildFailed, yamlSyncFailed, outcome })).toBe(buildFailed || yamlSyncFailed || outcome === 'failed' ? 1 : 0);
        },
    );
});

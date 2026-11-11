import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildPagesSyncPayload, bundleCodePages, formatPagesSummary, formatPagesSyncFailure, listCodePages, pagesSyncOutcome, readPageBodies, terminalExitCode } from '../src/utils/pages-sync';
import type { PageFile, PagesSyncOutcome, PagesSyncPayload, PagesSyncResultRow } from '../src/utils/pages-sync';
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
        const bodies = new Map([['home', 'html'], ['board', 'stale-tsx']]);
        const bundles = new Map([['board', { compiled: 'C', compiledCss: 'S', sources: { 'pages/board.tsx': 'T' }, compilerVersion: '0.28.2', entrySource: 'ENTRY_SRC' }]]);

        const payload = buildPagesSyncPayload(pages, bodies, null, ref, bundles);

        expect(payload.pages[1]).toEqual({ ...pages[1], body: 'ENTRY_SRC', source_files: { 'pages/board.tsx': 'T' }, compiled: 'C', compiled_css: 'S', compiler_version: '0.28.2' });
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
        const guarded: PageFile[] = [
            { slug: 'home', name: 'Home', path: 'pages/home.html', kind: 'visual', language: 'html', home: true },
            { slug: 'board', name: 'Board', path: 'pages/board.tsx', kind: 'dashboard', language: 'tsx', home: false, sources: [{ key: 'sales', kind: 'sql', database: 'main', sql: 'select 1' }] },
        ];
        const ref = { branch: 'main', short_sha: 'abc', commit_sha: 'abcdef', dirty: false };
        const bodies = new Map([['home', 'html'], ['board', 'tsx']]);
        const bundles = new Map([['board', { compiled: 'C', compiledCss: 'S', sources: { 'pages/board.tsx': 'T' }, compilerVersion: '0.28.2', entrySource: 'T' }]]);

        expect(validatesAgainstAppMain(buildPagesSyncPayload(guarded, bodies, null, ref))).toEqual([]);
        expect(validatesAgainstAppMain(buildPagesSyncPayload(guarded, bodies, null, ref, bundles))).toEqual([]);

        const withBundles = buildPagesSyncPayload(guarded, bodies, null, ref, bundles);
        const badPages = withBundles.pages.map(page => page.slug === 'board' ? { ...page, sources: { 'a.ts': 'x' } } : page);
        expect(validatesAgainstAppMain({ ...withBundles, pages: badPages }).length).toBeGreaterThan(0);
    });
    it('rejects duplicate slugs under the pinned app rules', () => {
        const ref = { branch: 'main', short_sha: 'abc', commit_sha: 'abcdef', dirty: false };
        const dup: PageFile[] = [
            { slug: 'home', name: 'Home', path: 'pages/home.html', kind: 'visual', language: 'html', home: true },
            { slug: 'home', name: 'Other', path: 'pages/other.html', kind: 'visual', language: 'html', home: false },
        ];
        const payload = buildPagesSyncPayload(dup, new Map([['home', 'a']]), null, ref);
        expect(payload.pages).toHaveLength(2);
        expect(validatesAgainstAppMain(payload).length).toBeGreaterThan(0);
    });
    it('rejects two home pages under the pinned app rules', () => {
        const ref = { branch: 'main', short_sha: 'abc', commit_sha: 'abcdef', dirty: false };
        const twoHomes: PageFile[] = [
            { slug: 'home', name: 'Home', path: 'pages/home.html', kind: 'visual', language: 'html', home: true },
            { slug: 'board', name: 'Board', path: 'pages/board.html', kind: 'dashboard', language: 'html', home: true },
        ];
        const payload = buildPagesSyncPayload(twoHomes, new Map([['home', 'a'], ['board', 'b']]), null, ref);
        expect(validatesAgainstAppMain(payload).length).toBeGreaterThan(0);
    });
    it('rejects an empty name and an empty path under the pinned app rules', () => {
        const ref = { branch: 'main', short_sha: 'abc', commit_sha: 'abcdef', dirty: false };
        const base: PageFile[] = [
            { slug: 'home', name: 'Home', path: 'pages/home.html', kind: 'visual', language: 'html', home: true },
        ];
        const emptyName = buildPagesSyncPayload(base, new Map([['home', 'a']]), null, ref);
        emptyName.pages[0].name = '';
        expect(validatesAgainstAppMain(emptyName).length).toBeGreaterThan(0);
        const emptyPath = buildPagesSyncPayload(base, new Map([['home', 'a']]), null, ref);
        emptyPath.pages[0].path = '';
        expect(validatesAgainstAppMain(emptyPath).length).toBeGreaterThan(0);
    });
    it('rejects sql sources with neither or both of database and connection', () => {
        const ref = { branch: 'main', short_sha: 'abc', commit_sha: 'abcdef', dirty: false };
        const base: PageFile[] = [
            { slug: 'board', name: 'Board', path: 'pages/board.html', kind: 'dashboard', language: 'html', home: true, sources: [{ key: 'sales', kind: 'sql' }] },
        ];
        const neither = buildPagesSyncPayload(base, new Map([['board', 'b']]), null, ref);
        expect(validatesAgainstAppMain(neither).length).toBeGreaterThan(0);
        const both = buildPagesSyncPayload(base, new Map([['board', 'b']]), null, ref);
        both.pages[0].sources = [{ key: 'sales', kind: 'sql', database: 'main', connection: 'other' }];
        expect(validatesAgainstAppMain(both).length).toBeGreaterThan(0);
    });
    it('rejects a pegs source carrying a database under the pinned app rules', () => {
        const ref = { branch: 'main', short_sha: 'abc', commit_sha: 'abcdef', dirty: false };
        const base: PageFile[] = [
            { slug: 'board', name: 'Board', path: 'pages/board.html', kind: 'dashboard', language: 'html', home: true, sources: [{ key: 'k', kind: 'pegs', database: 'main' }] },
        ];
        expect(validatesAgainstAppMain(buildPagesSyncPayload(base, new Map([['board', 'b']]), null, ref)).length).toBeGreaterThan(0);
    });
    it('rejects a body over 1048576 bytes under the pinned app rules', () => {
        const ref = { branch: 'main', short_sha: 'abc', commit_sha: 'abcdef', dirty: false };
        const base: PageFile[] = [
            { slug: 'home', name: 'Home', path: 'pages/home.html', kind: 'visual', language: 'html', home: true },
        ];
        expect(validatesAgainstAppMain(buildPagesSyncPayload(base, new Map([['home', 'x'.repeat(1048577)]]), null, ref)).length).toBeGreaterThan(0);
    });
    it('rejects an empty or whitespace-only body under the pinned app rules', () => {
        const ref = { branch: 'main', short_sha: 'abc', commit_sha: 'abcdef', dirty: false };
        const base: PageFile[] = [
            { slug: 'home', name: 'Home', path: 'pages/home.html', kind: 'visual', language: 'html', home: true },
        ];
        const empty = buildPagesSyncPayload(base, new Map([['home', '']]), null, ref);
        expect(empty.pages[0].body).toBe('');
        expect(validatesAgainstAppMain(empty).length).toBeGreaterThan(0);
        const blank = buildPagesSyncPayload(base, new Map([['home', '   ']]), null, ref);
        expect(blank.pages[0].body).toBe('   ');
        expect(validatesAgainstAppMain(blank).length).toBeGreaterThan(0);
    });
    it('accepts a map of valid pages under the pinned app rules', () => {
        const ref = { branch: 'main', short_sha: 'abc', commit_sha: 'abcdef', dirty: false };
        const base: PageFile[] = [
            { slug: 'home', name: 'Home', path: 'pages/home.html', kind: 'visual', language: 'html', home: true },
            { slug: 'board', name: 'Board', path: 'pages/board.html', kind: 'dashboard', language: 'html', home: false },
        ];
        const payload = buildPagesSyncPayload(base, new Map([['home', 'a'], ['board', 'b']]), null, ref);
        expect(payload.pages).toHaveLength(2);
        const mapped = { ...payload, pages: { a: payload.pages[0], b: payload.pages[1] } };
        expect(validatesAgainstAppMain(mapped)).toEqual([]);
    });
    it('rejects kind tsx and more than 50 sources under the pinned app rules', () => {
        const ref = { branch: 'main', short_sha: 'abc', commit_sha: 'abcdef', dirty: false };
        const base: PageFile[] = [
            { slug: 'home', name: 'Home', path: 'pages/home.html', kind: 'visual', language: 'html', home: true },
        ];
        const badKind = buildPagesSyncPayload(base, new Map([['home', 'a']]), null, ref);
        (badKind.pages[0] as unknown as Record<string, unknown>).kind = 'tsx';
        expect(validatesAgainstAppMain(badKind).length).toBeGreaterThan(0);
        const many = buildPagesSyncPayload(base, new Map([['home', 'a']]), null, ref);
        many.pages[0].sources = Array.from({ length: 51 }, (_, n) => ({ key: `k${n}`, kind: 'sql', database: 'main' }));
        expect(validatesAgainstAppMain(many).length).toBeGreaterThan(0);
    });
    it('rejects a non-UUID deployment_id under the pinned app rules', () => {
        const ref = { branch: 'main', short_sha: 'abc', commit_sha: 'abcdef', dirty: false };
        const base: PageFile[] = [
            { slug: 'home', name: 'Home', path: 'pages/home.html', kind: 'visual', language: 'html', home: true },
        ];
        const payload = buildPagesSyncPayload(base, new Map([['home', 'a']]), 'dep-1', ref);
        expect(payload.deployment_id).toBe('dep-1');
        expect(validatesAgainstAppMain(payload).length).toBeGreaterThan(0);
        const good = buildPagesSyncPayload(base, new Map([['home', 'a']]), '123e4567-e89b-12d3-a456-426614174000', ref);
        expect(validatesAgainstAppMain(good)).toEqual([]);
    });
    it('rejects wrong code_ref field types under the pinned app rules', () => {
        const base: PageFile[] = [
            { slug: 'home', name: 'Home', path: 'pages/home.html', kind: 'visual', language: 'html', home: true },
        ];
        const badBranch = buildPagesSyncPayload(base, new Map([['home', 'a']]), null, { branch: 5, short_sha: null, commit_sha: null, dirty: null } as unknown as PagesSyncPayload['code_ref']);
        expect(validatesAgainstAppMain(badBranch).length).toBeGreaterThan(0);
        const badDirty = buildPagesSyncPayload(base, new Map([['home', 'a']]), null, { branch: null, short_sha: null, commit_sha: null, dirty: 'maybe' } as unknown as PagesSyncPayload['code_ref']);
        expect(validatesAgainstAppMain(badDirty).length).toBeGreaterThan(0);
    });
    it('rejects source value types and limits under the pinned app rules', () => {
        const ref = { branch: 'main', short_sha: 'abc', commit_sha: 'abcdef', dirty: false };
        const base: PageFile[] = [
            { slug: 'board', name: 'Board', path: 'pages/board.html', kind: 'dashboard', language: 'html', home: true, sources: [{ key: 'sales', kind: 'sql', database: 'main', sql: 'select 1' }] },
        ];
        const longSql = buildPagesSyncPayload(base, new Map([['board', 'b']]), null, ref);
        longSql.pages[0].sources = [{ key: 'sales', kind: 'sql', database: 'main', sql: 'x'.repeat(65536) }];
        expect(validatesAgainstAppMain(longSql).length).toBeGreaterThan(0);
        const negativeTtl = buildPagesSyncPayload(base, new Map([['board', 'b']]), null, ref);
        negativeTtl.pages[0].sources = [{ key: 'sales', kind: 'sql', database: 'main', cache_ttl_seconds: -1 }];
        expect(validatesAgainstAppMain(negativeTtl).length).toBeGreaterThan(0);
        const limitZero = buildPagesSyncPayload(base, new Map([['board', 'b']]), null, ref);
        limitZero.pages[0].sources = [{ key: 'sales', kind: 'sql', database: 'main', limit: 0 }];
        expect(validatesAgainstAppMain(limitZero).length).toBeGreaterThan(0);
        const limitHigh = buildPagesSyncPayload(base, new Map([['board', 'b']]), null, ref);
        limitHigh.pages[0].sources = [{ key: 'sales', kind: 'sql', database: 'main', limit: 501 }];
        expect(validatesAgainstAppMain(limitHigh).length).toBeGreaterThan(0);
        const badBoard = buildPagesSyncPayload(base, new Map([['board', 'b']]), null, ref);
        badBoard.pages[0].sources = [{ key: 'sales', kind: 'sql', database: 'main', pegboard_id: 'not-a-uuid' }];
        expect(validatesAgainstAppMain(badBoard).length).toBeGreaterThan(0);
        const longAction = buildPagesSyncPayload(base, new Map([['board', 'b']]), null, ref);
        longAction.pages[0].sources = [{ key: 'sales', kind: 'sql', database: 'main', action: 'x'.repeat(129) }];
        expect(validatesAgainstAppMain(longAction).length).toBeGreaterThan(0);
    });
    it('rejects home yes but accepts 1 and 1 as a home under the pinned app rules', () => {
        const ref = { branch: 'main', short_sha: 'abc', commit_sha: 'abcdef', dirty: false };
        const yesHome: PageFile[] = [
            { slug: 'home', name: 'Home', path: 'pages/home.html', kind: 'visual', language: 'html', home: 'yes' as unknown as boolean },
        ];
        expect(validatesAgainstAppMain(buildPagesSyncPayload(yesHome, new Map([['home', 'a']]), null, ref)).length).toBeGreaterThan(0);
        const oneHome: PageFile[] = [
            { slug: 'home', name: 'Home', path: 'pages/home.html', kind: 'visual', language: 'html', home: 1 as unknown as boolean },
        ];
        expect(validatesAgainstAppMain(buildPagesSyncPayload(oneHome, new Map([['home', 'a']]), null, ref))).toEqual([]);
        const stringOneHome: PageFile[] = [
            { slug: 'home', name: 'Home', path: 'pages/home.html', kind: 'visual', language: 'html', home: '1' as unknown as boolean },
        ];
        expect(validatesAgainstAppMain(buildPagesSyncPayload(stringOneHome, new Map([['home', 'a']]), null, ref))).toEqual([]);
        const twoHomes: PageFile[] = [
            { slug: 'home', name: 'Home', path: 'pages/home.html', kind: 'visual', language: 'html', home: true },
            { slug: 'board', name: 'Board', path: 'pages/board.html', kind: 'dashboard', language: 'html', home: '1' as unknown as boolean },
        ];
        expect(validatesAgainstAppMain(buildPagesSyncPayload(twoHomes, new Map([['home', 'a'], ['board', 'b']]), null, ref)).length).toBeGreaterThan(0);
    });
    it('accepts associative params and a numeric-string cache ttl under the pinned app rules', () => {
        const ref = { branch: 'main', short_sha: 'abc', commit_sha: 'abcdef', dirty: false };
        const base: PageFile[] = [
            { slug: 'board', name: 'Board', path: 'pages/board.html', kind: 'dashboard', language: 'html', home: true, sources: [{ key: 'sales', kind: 'sql', database: 'main', params: { region: 'eu' }, cache_ttl_seconds: '5' as unknown as number }] },
        ];
        expect(validatesAgainstAppMain(buildPagesSyncPayload(base, new Map([['board', 'b']]), null, ref))).toEqual([]);
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

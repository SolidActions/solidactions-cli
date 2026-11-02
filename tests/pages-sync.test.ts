import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildPagesSyncPayload, formatPagesSummary, formatPagesSyncFailure, listCodePages, pagesSyncOutcome, readPageBodies, terminalExitCode } from '../src/utils/pages-sync';
import type { PageFile, PagesSyncOutcome, PagesSyncResultRow } from '../src/utils/pages-sync';

const pages: PageFile[] = [
    { slug: 'home', name: 'Home', path: 'pages/home.html', kind: 'visual', home: true },
    { slug: 'board', name: 'Board', path: 'pages/board.tsx', kind: 'dashboard', home: false, sources: [{ key: 'sales' }] },
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
    it.each([false, true].flatMap(buildFailed => [false, true].flatMap(yamlSyncFailed => (['ok', 'failed', 'skipped-old-server'] as PagesSyncOutcome[]).map(outcome => [buildFailed, yamlSyncFailed, outcome] as const))))(
        'returns the terminal code for build %s YAML %s outcome %s', (buildFailed, yamlSyncFailed, outcome) => {
            expect(terminalExitCode({ buildFailed, yamlSyncFailed, outcome })).toBe(buildFailed || yamlSyncFailed || outcome === 'failed' ? 1 : 0);
        },
    );
});

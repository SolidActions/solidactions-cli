import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildFunctionsSyncPayload, formatFunctionsSummary, formatFunctionsSyncFailure, functionsSyncOutcome, joinSyncOutcomes, listCodeFunctions, readFunctionSources, FUNCTIONS_SYNC_TIMEOUT_MS } from '../src/utils/functions-sync';
import { terminalExitCode } from '../src/utils/pages-sync';
import { validateItems } from '../src/utils/validate-items';
import type { CodeFunction, FunctionsSyncOutcome, FunctionSyncResultRow } from '../src/utils/functions-sync';

const functions: CodeFunction[] = [
    { id: 'hello', name: 'Hello', file: 'functions/hello.ts', description: 'Says hi', webhook: true },
    { id: 'enrich', name: 'Enrich', file: 'functions/enrich.ts', timeout: 20, confirm: true, input_schema: { type: 'object' } },
];
const live: FunctionSyncResultRow = { id: 'hello', status: 'live', error: null, webhook_url: 'https://example.com/api/webhook/token123' };
const unchanged: FunctionSyncResultRow = { id: 'hello', status: 'unchanged', error: null, webhook_url: 'https://example.com/api/webhook/token123' };
const failed: FunctionSyncResultRow = { id: 'enrich', status: 'error', error: { code: 'compile_failed', message: 'Line 3: unexpected token' }, webhook_url: null };

describe('functions sync', () => {
    it('lists code functions in YAML order and skips editor pointers', () => {
        expect(listCodeFunctions({ functions: [
            { id: 'hello', name: 'Hello', file: 'functions/hello.ts', description: 'Says hi', webhook: true },
            { id: 7, name: 'Editor', owner: 'editor' },
            { id: 'enrich', name: 'Enrich', file: 'functions/enrich.ts', timeout: 20, confirm: true, input_schema: { type: 'object' } },
        ] })).toEqual(functions);
    });
    it('lists no functions when the section is absent', () => {
        expect(listCodeFunctions({})).toEqual([]);
    });
    it('reads exact function sources from real files', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-functions-'));
        try {
            fs.mkdirSync(path.join(root, 'functions'));
            fs.writeFileSync(path.join(root, functions[0].file), 'export default { fetch() { return new Response("hi"); } }\n');
            fs.writeFileSync(path.join(root, functions[1].file), 'export default { fetch() { return new Response("rich"); } }\n');
            expect(readFunctionSources(root, functions)).toEqual(new Map([['hello', 'export default { fetch() { return new Response("hi"); } }\n'], ['enrich', 'export default { fetch() { return new Response("rich"); } }\n']]));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
    it('builds the payload with passthrough code_ref and function fields plus sources', () => {
        const ref = { branch: 'main', short_sha: 'abc', commit_sha: 'abcdef', dirty: false };
        expect(buildFunctionsSyncPayload(functions, new Map([['hello', 'src-hi'], ['enrich', 'src-rich']]), ref)).toEqual({
            code_ref: ref,
            functions: [{ ...functions[0], source: 'src-hi' }, { ...functions[1], source: 'src-rich' }],
        });
    });
    it('formats live, unchanged, function error, retired and retire error lines in order', () => {
        expect(formatFunctionsSummary(
            [live, { ...live, id: 'bare', webhook_url: null }, unchanged, failed],
            [{ id: 'old' }],
            [{ id: 'stuck', error: { code: 'deploy_failed', message: 'Cloudflare refused' } }],
        )).toEqual([
            'function hello: live https://example.com/api/webhook/token123',
            'function bare: live',
            'function hello: unchanged https://example.com/api/webhook/token123',
            'function enrich: error compile_failed: Line 3: unexpected token',
            'function old: retired',
            'function stuck: could not retire: deploy_failed: Cloudflare refused',
        ]);
    });
    it.each([
        [404, false, null, [], [], 0, 'skipped-old-server'],
        [404, false, null, [], [], 1, 'failed'],
        [500, false, null, [], [], 1, 'failed'],
        [409, false, null, [], [], 1, 'failed'],
        [503, false, null, [], [], 1, 'failed'],
        [503, false, null, [], [], 0, 'failed'],
        [503, false, { code: 'functions_disabled', message: 'Fast functions are off on this stack.' }, [], [], 0, 'skipped-old-server'],
        [503, false, { code: 'functions_disabled', message: 'Fast functions are off on this stack.' }, [], [], 1, 'failed'],
        [503, false, { code: 'something_else', message: 'Try again later.' }, [], [], 0, 'failed'],
        [null, true, null, [], [], 1, 'failed'],
        [200, false, null, [failed], [], 1, 'failed'],
        [200, false, null, [live], [{ id: 'stuck' }], 1, 'failed'],
        [200, false, null, [live], [], 1, 'ok'],
        [200, false, null, [unchanged], [], 1, 'ok'],
    ] as const)('classifies status %s transport %s body %j rows %j retire errors %j count %s as %s', (httpStatus, transportError, body, rows, retireErrors, sentFunctionCount, expected) => {
        expect(functionsSyncOutcome({ httpStatus, transportError, body, rows: [...rows], retireErrors: [...retireErrors], sentFunctionCount })).toBe(expected);
    });
    it.each([
        [200, false, null, 1, null],
        [404, false, null, 0, null],
        [404, false, null, 1, 'This server does not support functions yet; upgrade the platform'],
        [503, false, { code: 'functions_disabled', message: 'Fast functions are off on this stack.' }, 0, null],
        [null, true, null, 1, 'functions sync failed: could not reach the server'],
        [500, false, null, 1, 'functions sync failed (HTTP 500)'],
        [422, false, { code: 'invalid', message: 'Bad request' }, 1, 'functions sync failed (422 invalid): Bad request'],
        [409, false, { code: 'deploy_conflict', message: "Another deploy of this project's functions is running. Try again when it finishes." }, 1, "functions sync failed (409 deploy_conflict): Another deploy of this project's functions is running. Try again when it finishes."],
        [503, false, { code: 'functions_disabled', message: 'Fast functions are off on this stack.' }, 1, 'functions sync failed (503 functions_disabled): Fast functions are off on this stack.'],
    ] as const)('formats request failure status %s transport %s body %j count %s', (httpStatus, transportError, body, sentFunctionCount, expected) => {
        expect(formatFunctionsSyncFailure({ httpStatus, transportError, body, sentFunctionCount })).toBe(expected);
    });
    it.each([
        ['failed', 'failed', 'failed'],
        ['failed', 'ok', 'failed'],
        ['failed', 'skipped-old-server', 'failed'],
        ['ok', 'failed', 'failed'],
        ['ok', 'ok', 'ok'],
        ['ok', 'skipped-old-server', 'ok'],
        ['skipped-old-server', 'failed', 'failed'],
        ['skipped-old-server', 'ok', 'ok'],
        ['skipped-old-server', 'skipped-old-server', 'skipped-old-server'],
    ] as const)('joins functions outcome %s with pages outcome %s as %s', (functionsOutcome, pagesOutcome, expected) => {
        expect(joinSyncOutcomes(functionsOutcome, pagesOutcome)).toBe(expected);
    });
    it('fails the deploy exit code on any per-function error', () => {
        const functionsOutcome = functionsSyncOutcome({ httpStatus: 200, transportError: false, body: null, rows: [live, failed], retireErrors: [], sentFunctionCount: 2 });
        expect(functionsOutcome).toBe('failed');
        const outcome = joinSyncOutcomes(functionsOutcome, 'ok');
        expect(outcome).toBe('failed');
        expect(terminalExitCode({ buildFailed: false, yamlSyncFailed: false, outcome })).toBe(1);
    });
    it('refuses a source over 256 KB client-side through validateItems', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-functions-'));
        try {
            fs.mkdirSync(path.join(root, 'functions'));
            fs.writeFileSync(path.join(root, 'functions/big.ts'), 'x'.repeat(257 * 1024));
            const errors = validateItems({ functions: [{ id: 'big', name: 'Big', file: 'functions/big.ts' }] }, root);
            expect(errors.some(error => error.field === 'file' && error.message.includes('256 KB'))).toBe(true);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
    it('sets the HTTP client timeout for this call to 210 s (P7)', () => {
        expect(FUNCTIONS_SYNC_TIMEOUT_MS).toBe(210_000);
    });
    it('never prints a dispatch hostname or a script name (I10)', () => {
        const lines = formatFunctionsSummary([live, unchanged, failed], [{ id: 'old' }], [{ id: 'stuck', error: { code: 'deploy_failed', message: 'Cloudflare refused' } }]);
        const failures = [
            formatFunctionsSyncFailure({ httpStatus: 404, transportError: false, body: null, sentFunctionCount: 1 }),
            formatFunctionsSyncFailure({ httpStatus: 409, transportError: false, body: { code: 'deploy_conflict', message: "Another deploy of this project's functions is running. Try again when it finishes." }, sentFunctionCount: 1 }),
            formatFunctionsSyncFailure({ httpStatus: 503, transportError: false, body: { code: 'functions_disabled', message: 'Fast functions are off on this stack.' }, sentFunctionCount: 1 }),
        ].filter((line): line is string => line !== null);
        // Needles built by concatenation so a repo-wide sweep for tenant-visible
        // hostnames and script prefixes never matches this guard itself.
        const needles = ['workers' + '.dev', 'fn' + '-'];
        for (const line of [...lines, ...failures]) {
            for (const needle of needles) {
                expect(line).not.toContain(needle);
            }
        }
    });
    it.each([false, true].flatMap(buildFailed => [false, true].flatMap(yamlSyncFailed => (['ok', 'failed', 'skipped-old-server'] as FunctionsSyncOutcome[]).map(outcome => [buildFailed, yamlSyncFailed, outcome] as const))))(
        'returns the terminal code for build %s YAML %s outcome %s', (buildFailed, yamlSyncFailed, outcome) => {
            expect(terminalExitCode({ buildFailed, yamlSyncFailed, outcome })).toBe(buildFailed || yamlSyncFailed || outcome === 'failed' ? 1 : 0);
        },
    );
});

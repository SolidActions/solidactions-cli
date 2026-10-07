/**
 * cli#209 (Peter's ruling, issuecomment-6037546650, and the manager rulings of the targeted round): a doc the server
 * still lists whose `bulk_read` row is not a success (status `error`, `not_found`, an unknown status, no status at all)
 * or is left out of the results is the outcome `refused(fetch-failed)`. Its previous manifest entry is carried unchanged,
 * its local file is not touched (no other doc of the pull is given its name), it is never a deletion-propagation
 * candidate, and the pull exits 1 with one line naming every such doc, after the manifest is written. The rest of the
 * pull proceeds: the other docs are written and tracked, and docs really gone from the listing are still propagated.
 *
 * Every row runs the built CLI (`node dist/index.js`) against a real in-process HTTP server, with a temp HOME and real
 * files. Nothing is substituted.
 */
import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { cannotWriteLine, doc, failed, KINDS, manifestNotWrittenLine, manifestOf, MANIFEST_FILE, pulledStdout, read, relOf, useDocPullHarness } from './doc-pull-inv-harness';
import type { Kind, ServedDoc } from './doc-pull-inv-harness';
import { makeTmpEnv, writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

/** The one line a pull prints for the docs it could not fetch, then exits 1 (manager ruling on cli#209). */
const fetchFailedLine = (docs: Array<[number, string]>): string =>
    `error: could not fetch ${docs.length} doc(s) from the server: ${docs.map(([id, title]) => `${id} ("${title}")`).join(', ')} — their local files and tracking were left as they were; pull again.\n`;

/**
 * Final review 6's reproduction (fr6-scratch/bulk-read-loss.test.cjs), ported: the same four cases, the same server
 * answers, the same hand-written previous manifest and file, the same aggregate assertion. The original transpiled the
 * review head into scratch; this runs the built CLI of the working tree.
 */
describe('final review 6, C1: the reviewer\'s unit, ported', () => {
    function invoke(cwd: string, home: string, out: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SOLIDACTIONS_NO_AGENT_NUDGES: '1' };
        for (const key of ['SOLIDACTIONS_HOST', 'SOLIDACTIONS_API_KEY', 'SOLIDACTIONS_WORKSPACE_ID', 'DEBUG', 'NODE_DEBUG', 'FORCE_COLOR', 'SOLIDACTIONS_TEST_HOOKS', 'SOLIDACTIONS_DOC_PULL_TEST_FAULT']) delete env[key];
        return new Promise((resolve, reject) => {
            const child = childProcess.spawn(process.execPath, [CLI_BINARY, 'doc', 'pull', 'docs', out, '-y'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk) => { stdout += chunk; });
            child.stderr.on('data', (chunk) => { stderr += chunk; });
            child.on('error', reject);
            child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
        });
    }

    it('a listed doc with a failed or omitted bulk-read row retains its local file and previous ownership', { timeout: 20000 }, async () => {
        const observed: Record<string, unknown> = {};
        const expected: Record<string, unknown> = {};
        for (const kind of ['markdown', 'media']) {
            for (const mode of ['error', 'missing']) {
                const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-pull-bulk-'));
                const home = path.join(root, 'home');
                const out = path.join(root, 'out');
                fs.mkdirSync(path.join(home, '.solidactions'), { recursive: true });
                fs.mkdirSync(out);
                const rel = kind === 'markdown' ? 'report.md' : 'report.png';
                const bytes = 'previous successful pull';
                fs.writeFileSync(path.join(out, rel), bytes);
                const entry = { id: 7, title: 'report', current_revision_id: 1, media: kind === 'media', body_sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
                fs.writeFileSync(path.join(out, MANIFEST_FILE), JSON.stringify({ folder_path: 'docs', docs: { [rel]: entry } }));
                const server = http.createServer((req, res) => {
                    let body = '';
                    req.on('data', (chunk) => { body += chunk; });
                    req.on('end', () => {
                        const args = JSON.parse(body).params.arguments;
                        const data = args.action === 'list' ? { folders: [], docs: [{ id: 7, title: 'report', doc_type: null }] } : { results: mode === 'error' ? [{ id: 7, status: 'error', error: 'read failed' }] : [] };
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: false, content: [{ type: 'text', text: JSON.stringify(data) }] } }));
                    });
                });
                await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
                fs.writeFileSync(path.join(home, '.solidactions', 'config.json'), JSON.stringify({ host: `http://127.0.0.1:${(server.address() as { port: number }).port}`, apiKey: 'test-key', workspaceId: 'test-workspace' }));
                try {
                    const result = await invoke(root, home, out);
                    const manifest = JSON.parse(fs.readFileSync(path.join(out, MANIFEST_FILE), 'utf8'));
                    observed[`${kind}/${mode}`] = {
                        code: result.code,
                        signal: result.signal,
                        stdout: result.stdout,
                        stderr: result.stderr,
                        bytes: fs.existsSync(path.join(out, rel)) ? fs.readFileSync(path.join(out, rel), 'utf8') : null,
                        entry: manifest.docs[rel] ?? null,
                    };
                    expected[`${kind}/${mode}`] = { code: 1, signal: null, stdout: pulledStdout(out, []), stderr: fetchFailedLine([[7, 'report']]), bytes, entry };
                } finally {
                    await new Promise((resolve) => server.close(resolve));
                    fs.rmSync(root, { recursive: true, force: true });
                }
            }
        }
        expect(observed, 'A bulk-read failure is not evidence that a listed doc was deleted remotely').toEqual(expected);
    });
});

/** Each way a listed doc's bulk-read row can fail: the doc's `ServedDoc` fields that make the server answer that way. */
const FAILURES: Array<{ name: string; fields: Partial<ServedDoc> }> = [
    { name: 'status error', fields: { bulkStatus: 'error' } },
    { name: 'status not_found', fields: { bulkStatus: 'not_found' } },
    { name: 'an unknown status', fields: { bulkStatus: 'archived' } },
    { name: 'no status', fields: { bulkRow: 'no-status' } },
    { name: 'the row left out', fields: { bulkRow: 'omitted' } },
];

describe('cli#209: a listed doc whose content could not be fetched keeps its file and its tracking', () => {
    const h = useDocPullHarness();
    const report = (kind: Kind, version: number): ServedDoc => doc(kind, 7, 'report', version);
    const note = (version: number): ServedDoc => doc('md', 2, 'note', version);

    for (const kind of KINDS) {
        for (const f of FAILURES) {
            it(`folder pull x ${kind} x ${f.name}: exit 1 on the one line; the tracked file's bytes and its manifest entry are unchanged`, async () => {
                await h.seed([report(kind, 1)]);
                const rel = relOf(report(kind, 1));
                const entryBefore = manifestOf(h.out).docs[rel];
                h.serve([{ ...report(kind, 2), ...f.fields }]);

                await h.pull('folder', 'docs', { code: 1, stdout: pulledStdout(h.out, []), stderr: fetchFailedLine([[7, 'report']]) });

                expect(read(h.out, rel)).toBe('V1-report');
                expect(manifestOf(h.out).docs[rel]).toEqual(entryBefore);
                expect(Object.keys(manifestOf(h.out).docs)).toEqual([rel]);
            });
        }

        // The single-doc pull reads its one doc with read_doc, not bulk_read: a read that fails refuses before anything is written.
        for (const f of [FAILURES[0], FAILURES[4]]) {
            const answer = f.fields.bulkRow === 'omitted' ? 'error: doc_not_found: no such doc\n' : 'error: read_failed: read failed\n';
            it(`single-doc pull x ${kind} x ${f.name}: exit 1 on the read's error; the tracked file and the whole manifest are unchanged`, async () => {
                await h.seed([report(kind, 1)]);
                const rel = relOf(report(kind, 1));
                const manifestBefore = read(h.out, MANIFEST_FILE);
                h.serve([{ ...report(kind, 2), ...f.fields }]);

                await h.pull('single', 'report', failed(`error: folder_path_not_found: no such folder\n${answer}`));

                expect(read(h.out, rel)).toBe('V1-report');
                expect(read(h.out, MANIFEST_FILE)).toBe(manifestBefore);
            });
        }

        it(`folder pull x ${kind}: a locally edited file whose doc could not be fetched keeps its edits and its tracking`, async () => {
            await h.seed([report(kind, 1)]);
            const rel = relOf(report(kind, 1));
            const entryBefore = manifestOf(h.out).docs[rel];
            fs.writeFileSync(path.join(h.out, rel), 'my edit');
            h.serve([{ ...report(kind, 2), bulkStatus: 'error' }]);

            await h.pull('folder', 'docs', { code: 1, stdout: pulledStdout(h.out, []), stderr: fetchFailedLine([[7, 'report']]) });

            expect(read(h.out, rel)).toBe('my edit');
            expect(manifestOf(h.out).docs[rel]).toEqual(entryBefore);
        });

        it(`control, folder pull x ${kind}: a doc really gone from the listing is still removed when unmodified, exit 0`, async () => {
            await h.seed([report(kind, 1), note(1)]);
            const rel = relOf(report(kind, 1));
            h.serve([note(1)]);

            await h.pull('folder', 'docs', { code: 0, stdout: pulledStdout(h.out, ['note.md'], [rel]), stderr: '' });

            expect(fs.existsSync(path.join(h.out, rel))).toBe(false);
            expect(Object.keys(manifestOf(h.out).docs)).toEqual(['note.md']);
        });

        it(`folder pull x ${kind}: one fetch failure next to a normal update: the update is written and tracked, the failed doc is left as it was, exit 1`, async () => {
            await h.seed([note(1), report(kind, 1)]);
            const rel = relOf(report(kind, 1));
            const entryBefore = manifestOf(h.out).docs[rel];
            h.serve([note(2), { ...report(kind, 2), bulkRow: 'omitted' }]);

            await h.pull('folder', 'docs', { code: 1, stdout: pulledStdout(h.out, ['note.md']), stderr: fetchFailedLine([[7, 'report']]) });

            expect(read(h.out, 'note.md')).toBe('V2-note');
            expect(manifestOf(h.out).docs['note.md']).toMatchObject({ id: 2, current_revision_id: 22, body_sha256: crypto.createHash('sha256').update('V2-note').digest('hex') });
            expect(read(h.out, rel)).toBe('V1-report');
            expect(manifestOf(h.out).docs[rel]).toEqual(entryBefore);
        });

        it(`folder pull x ${kind}: another doc now titled like the failed one is given another name; the failed doc's file and entry are untouched`, async () => {
            await h.seed([report(kind, 1)]);
            const rel = relOf(report(kind, 1));
            const entryBefore = manifestOf(h.out).docs[rel];
            h.serve([{ ...report(kind, 2), bulkStatus: 'error' }, doc(kind, 8, 'report', 1)]);
            const other = kind === 'md' ? 'report-2.md' : 'report-2.png';

            await h.pull('folder', 'docs', { code: 1, stdout: pulledStdout(h.out, [other]), stderr: fetchFailedLine([[7, 'report']]) });

            expect(read(h.out, rel)).toBe('V1-report');
            expect(read(h.out, other)).toBe('V1-report');
            expect(manifestOf(h.out).docs[rel]).toEqual(entryBefore);
            expect(manifestOf(h.out).docs[other]).toMatchObject({ id: 8 });
        });
    }

    it('a first pull into a new folder: a found row is written and tracked; an error row and a row left out are named on the one line and get no file or entry (was the in-process row-status guard test)', async () => {
        h.serve([doc('md', 1, 'good', 1), { ...doc('md', 2, 'broken', 1), bulkStatus: 'error' }, { ...doc('md', 3, 'ghost', 1), bulkRow: 'omitted' }]);

        await h.pull('folder', 'docs', { code: 1, stdout: pulledStdout(h.out, ['good.md']), stderr: fetchFailedLine([[2, 'broken'], [3, 'ghost']]) });

        expect(read(h.out, 'good.md')).toBe('V1-good');
        expect(fs.existsSync(path.join(h.out, 'broken.md'))).toBe(false);
        expect(fs.existsSync(path.join(h.out, 'ghost.md'))).toBe(false);
        expect(Object.keys(manifestOf(h.out).docs)).toEqual(['good.md']);
    });

    it('a pull that stops at a write still names the failed doc, before the stop line; the failed doc keeps its file and entry', async () => {
        await h.seed([note(1), report('md', 1)]);
        const entryBefore = manifestOf(h.out).docs['report.md'];
        h.serve([note(2), { ...report('md', 2), bulkStatus: 'error' }]);

        await h.pull('folder', 'docs', failed(fetchFailedLine([[7, 'report']]) + cannotWriteLine('note.md', 'rename', 0, 1)), ['-y'], 'fail-rename:1');

        expect(read(h.out, 'note.md')).toBe('V1-note');
        expect(read(h.out, 'report.md')).toBe('V1-report');
        expect(manifestOf(h.out).docs['report.md']).toEqual(entryBefore);
    });

    it('a pull whose manifest cannot be written still names the failed doc, after the manifest line; the manifest is unchanged', async () => {
        await h.seed([note(1), report('md', 1)]);
        const manifestBefore = read(h.out, MANIFEST_FILE);
        h.serve([note(2), { ...report('md', 2), bulkStatus: 'error' }]);

        await h.pull('folder', 'docs', failed(manifestNotWrittenLine('open manifest temp', 1, 1) + fetchFailedLine([[7, 'report']])), ['-y'], 'fail-manifest-temp');

        expect(read(h.out, 'report.md')).toBe('V1-report');
        expect(read(h.out, MANIFEST_FILE)).toBe(manifestBefore);
    });

    it('a listed doc never pulled before whose fetch fails is simply not tracked, and no file is written for it', async () => {
        await h.seed([note(1)]);
        h.serve([note(1), { ...doc('md', 9, 'fresh', 1), bulkStatus: 'error' }]);

        await h.pull('folder', 'docs', { code: 1, stdout: pulledStdout(h.out, ['note.md']), stderr: fetchFailedLine([[9, 'fresh']]) });

        expect(fs.existsSync(path.join(h.out, 'fresh.md'))).toBe(false);
        expect(Object.keys(manifestOf(h.out).docs)).toEqual(['note.md']);
    });

    it('several failed docs are named on the one line, in listing order, and each keeps its file and entry', async () => {
        await h.seed([note(1), report('md', 1), doc('media', 8, 'pic', 1)]);
        const before = manifestOf(h.out).docs;
        h.serve([note(1), { ...report('md', 2), bulkStatus: 'not_found' }, { ...doc('media', 8, 'pic', 2), bulkRow: 'omitted' }]);

        await h.pull('folder', 'docs', { code: 1, stdout: pulledStdout(h.out, ['note.md']), stderr: fetchFailedLine([[7, 'report'], [8, 'pic']]) });

        expect(read(h.out, 'report.md')).toBe('V1-report');
        expect(read(h.out, 'pic.png')).toBe('V1-pic');
        expect(manifestOf(h.out).docs).toEqual(before);
    });

    it('--json: the JSON summary on stdout, the one line on stderr, exit 1; the failed doc keeps its file and entry', async () => {
        await h.seed([report('md', 1)]);
        const entryBefore = manifestOf(h.out).docs['report.md'];
        h.serve([{ ...report('md', 2), bulkStatus: 'error' }]);

        const result = await h.pull('folder', 'docs', { code: 1, stdout: /^\{.*\}\n$/s, stderr: fetchFailedLine([[7, 'report']]) }, ['-y', '--json']);

        const summary = JSON.parse(result.stdout);
        expect({ files: summary.files, removed: summary.removed, kept_modified: summary.kept_modified }).toEqual({ files: [], removed: [], kept_modified: [] });
        expect(summary.manifest.docs['report.md']).toEqual(entryBefore);
        expect(read(h.out, 'report.md')).toBe('V1-report');
    });

    it('deletion propagation never takes a path whose doc this pull listed: an edited media file over a failed download is not "deleted remotely"', async () => {
        await h.seed([doc('media', 7, 'pic', 1)]);
        fs.writeFileSync(path.join(h.out, 'pic.png'), 'my edit');
        h.serve([{ ...doc('media', 7, 'pic', 2), downloadFails: true }]);

        await h.pull('folder', 'docs', {
            code: 0,
            stdout: pulledStdout(h.out, []),
            stderr: '! doc 7 ("pic") failed to download and pic.png holds a local file; not tracking it — pull again later.\nwarn: failed to download media for doc 7 (pic): HTTP 500\n',
        }, ['--overwrite']);

        expect(read(h.out, 'pic.png')).toBe('my edit');
    });
});

/**
 * The round 6 addendum (manager ruling on cli#209): a `found` bulk_read row, or a single-doc `read_doc` answer, with no
 * `body` key or a `null` body is fetch-failed too. Only a string body (`""` included) is content. Each row starts from a
 * previously tracked file and its manifest entry, written by hand, and a real server that answers this round's shape.
 */
describe('cli#209 addendum: a found answer without a body is a failed fetch, never an empty doc', () => {
    type BodyShape = 'no body key' | 'a null body' | 'an empty string body';
    const BYTES = 'V1-report';

    async function pullWithBody(form: 'folder' | 'single', kind: Kind, shape: BodyShape): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; out: string; rel: string; entry: Record<string, unknown>; cleanup: () => void }> {
        const env = makeTmpEnv();
        const out = path.join(env.cwd, 'out');
        fs.mkdirSync(out);
        const rel = kind === 'md' ? 'report.md' : 'report.png';
        fs.writeFileSync(path.join(out, rel), BYTES);
        const entry = { id: 7, title: 'report', current_revision_id: 71, media: kind === 'media', body_sha256: crypto.createHash('sha256').update(BYTES).digest('hex') };
        fs.writeFileSync(path.join(out, MANIFEST_FILE), JSON.stringify({ folder_path: 'docs', docs: { [rel]: entry } }));
        const bodyField = shape === 'no body key' ? {} : { body: shape === 'a null body' ? null : '' };
        const properties = kind === 'media' ? { blob_sha: 'sha-7', mime: 'image/png', size: 2 } : {};
        const mcp = (data: object, isError = false): string => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError, content: [{ type: 'text', text: JSON.stringify(data) }] } });
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (chunk) => { raw += chunk; });
            req.on('end', () => {
                const url = req.url ?? '';
                if (url === '/api/v1/docs/7/media') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/blob/7`, mime: 'image/png', size: 2 }));
                    return;
                }
                if (url === '/blob/7') {
                    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
                    res.end('V2');
                    return;
                }
                const args = JSON.parse(raw).params.arguments;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                if (args.action === 'list') {
                    res.end(form === 'single' ? mcp({ code: 'folder_path_not_found', message: 'no such folder' }, true) : mcp({ folders: [], docs: [{ id: 7, title: 'report', doc_type: null }] }));
                } else if (args.action === 'bulk_read') {
                    res.end(mcp({ results: [{ index: 0, status: 'found', id: 7, title: 'report', folder_path: 'docs', current_revision_id: 72, properties, ...bodyField }] }));
                } else {
                    res.end(mcp({ id: 7, title: 'report', folder_path: 'docs', current_revision_id: 72, properties, doc_type: null, ...bodyField }));
                }
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        writeGlobal(env.home, { host: `http://127.0.0.1:${(server.address() as { port: number }).port}`, apiKey: 'test-key', workspaceId: 'test-workspace' });
        const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: env.home, SOLIDACTIONS_NO_AGENT_NUDGES: '1' };
        for (const key of ['SOLIDACTIONS_HOST', 'SOLIDACTIONS_API_KEY', 'SOLIDACTIONS_WORKSPACE_ID', 'DEBUG', 'NODE_DEBUG', 'FORCE_COLOR', 'SOLIDACTIONS_TEST_HOOKS', 'SOLIDACTIONS_DOC_PULL_TEST_FAULT']) delete childEnv[key];
        try {
            const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
                const child = childProcess.spawn(process.execPath, [CLI_BINARY, 'doc', 'pull', form === 'single' ? 'docs/report' : 'docs', out, '-y'], { cwd: env.cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
                let stdout = '';
                let stderr = '';
                child.stdout.on('data', (chunk) => { stdout += chunk; });
                child.stderr.on('data', (chunk) => { stderr += chunk; });
                child.on('error', reject);
                child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
            });
            return { ...result, out, rel, entry, cleanup: env.cleanup };
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    }

    const SINGLE_DOC_WARNING = "deletions not propagated: single-doc pull cannot speak for a folder's contents\n";

    for (const form of ['folder', 'single'] as const) {
        for (const kind of KINDS) {
            for (const shape of ['no body key', 'a null body'] as BodyShape[]) {
                it(`${form === 'folder' ? 'folder pull' : 'single-doc pull'} x ${kind} x a found answer with ${shape}: exit 1 on the one line; the tracked file's bytes and its manifest entry are unchanged`, async () => {
                    const run = await pullWithBody(form, kind, shape);
                    try {
                        expect({
                            code: run.code,
                            signal: run.signal,
                            stdout: run.stdout,
                            stderr: run.stderr,
                            bytes: fs.readFileSync(path.join(run.out, run.rel), 'utf8'),
                            entry: manifestOf(run.out).docs[run.rel],
                        }).toEqual({
                            code: 1,
                            signal: null,
                            stdout: `pulled 0 docs → ${run.out}\n`,
                            stderr: `${form === 'single' ? SINGLE_DOC_WARNING : ''}${fetchFailedLine([[7, 'report']])}`,
                            bytes: BYTES,
                            entry: run.entry,
                        });
                    } finally {
                        run.cleanup();
                    }
                });
            }
        }

        it(`control, ${form === 'folder' ? 'folder pull' : 'single-doc pull'} x md x a found answer with an empty string body: an empty doc is content, written and tracked, exit 0`, async () => {
            const run = await pullWithBody(form, 'md', 'an empty string body');
            try {
                expect({ code: run.code, signal: run.signal }).toEqual({ code: 0, signal: null });
                expect(run.stdout).toBe(`pulled 1 doc → ${run.out}\n  report.md\n`);
                expect(run.stderr).toBe(form === 'single' ? SINGLE_DOC_WARNING : '');
                expect(fs.readFileSync(path.join(run.out, 'report.md'), 'utf8')).toBe('');
                expect(manifestOf(run.out).docs['report.md']).toMatchObject({ id: 7, current_revision_id: 72, body_sha256: crypto.createHash('sha256').update('').digest('hex') });
            } finally {
                run.cleanup();
            }
        });
    }
});

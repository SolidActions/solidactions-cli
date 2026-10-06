/**
 * The shared harness of the three doc-pull invariant sweeps (`doc-pull-inv-outside`, `-no-clobber`,
 * `-honest-manifest`). Every row runs the built CLI (`node dist/index.js`) against a real in-process HTTP
 * server with a temp HOME and real files. A plain module, not a test file (`tests/helpers.ts` is the precedent).
 *
 * Every spawned call goes through `pull`/`seed`, which take the call's expected exit status, stdout and stderr
 * as a required argument and assert them before returning: no call can skip the stream checks.
 */
import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');
export const MANIFEST_FILE = '.solidactions-docs.json';
export const LOCK_FILE = `${MANIFEST_FILE}.lock`;
const SINGLE_DOC_WARNING = "deletions not propagated: single-doc pull cannot speak for a folder's contents\n";

export const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

export type Kind = 'md' | 'media';
export type Form = 'folder' | 'single';
export const KINDS: Kind[] = ['md', 'media'];
export const FORMS: Form[] = ['folder', 'single'];

export interface ServedDoc {
    id: number;
    title: string;
    revision: number;
    kind: Kind;
    /** The markdown body, or the media bytes. */
    bytes: string;
    /** Folder below `docs/`, e.g. `sub`; the root when absent. */
    relative?: string;
    /** The signed-URL download answers 500. */
    downloadFails?: boolean;
    /** The `bulk_read` status for this doc (default `found`): a doc that is listed but not fetched. */
    bulkStatus?: string;
}

export const extOf = (kind: Kind): string => (kind === 'md' ? '.md' : '.png');
export const relOf = (d: ServedDoc): string => `${d.relative ? `${d.relative}/` : ''}${d.title}${extOf(d.kind)}`;

/** A doc at version `version`: its bytes are `V<version>-<title>`, so every version is distinct. */
export function doc(kind: Kind, id: number, title: string, version: number, relative?: string): ServedDoc {
    return { id, title, revision: version * 10 + id, kind, bytes: `V${version}-${title}`, ...(relative === undefined ? {} : { relative }) };
}

function mcpResult(data: object, isError = false): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError, content: [{ type: 'text', text: JSON.stringify(data) }] } });
}

const mediaProps = (d: ServedDoc): Record<string, unknown> => (d.kind === 'media' ? { blob_sha: `sha-${d.id}`, mime: 'image/png', size: 4 } : {});
const bodyOf = (d: ServedDoc): string => (d.kind === 'md' ? d.bytes : '');

export interface CliResult {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
}

/** A stream expectation: a string is the exact stream, a RegExp must match it. */
export type StreamExpectation = string | RegExp;

/** What one spawned call must have done: its exit status and both streams, in full. */
export interface Expected {
    code: number | null;
    /** The signal a killed run (a test hook's SIGKILL) ends with; the code is then null. */
    signal?: NodeJS.Signals;
    stdout: StreamExpectation;
    stderr: StreamExpectation;
}

function expectStream(name: string, actual: string, expected: StreamExpectation): void {
    if (typeof expected === 'string') expect(actual, name).toBe(expected);
    else expect(actual, name).toMatch(expected);
}

/** Escape a literal for use inside a RegExp. */
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** A pull that succeeded: its stdout summary, exactly (`removed` lists files deleted remotely). */
export function pulledStdout(destination: string, rels: string[], removed: string[] = []): string {
    return `pulled ${rels.length} doc${rels.length === 1 ? '' : 's'} → ${destination}\n${rels.map((rel) => `  ${rel}\n`).join('')}${removed.map((rel) => `- removed (deleted remotely): ${rel}\n`).join('')}`;
}

/** A successful pull's expectation: its summary on stdout; stderr empty unless the row says a warning is due. */
export function pulledOk(destination: string, rels: string[], stderr: StreamExpectation = ''): Expected {
    return { code: 0, stdout: pulledStdout(destination, rels), stderr };
}

/** The warning a single-doc pull prints when the destination already tracks a folder. */
export const singleDocWarning = SINGLE_DOC_WARNING;

/** `n` of `m` planned files were written when a pull stopped (the counts the failure lines print). */
export const updatedFiles = (n: number, m: number): string => `${n} of ${m} files were updated`;

/** A write error at doc `rel`, with the files before it recorded (spec §1.5). */
export const cannotWriteLine = (rel: string, what: string, n: number, m: number): string =>
    `error: cannot write ${rel}: EIO: i/o error, ${what} (test hook) — ${updatedFiles(n, m)} and are tracked; pull again.\n`;

/** A target that changed after the checks (spec §1.5). */
export const changedLine = (rel: string, n: number, m: number): string =>
    `error: ${rel} changed after doc pull checked it — ${updatedFiles(n, m)} and are tracked. Pull again, or pass --overwrite to replace it.\n`;

/** A folder at a target (ruling 9). */
export const folderLine = (rel: string, n: number, m: number): string =>
    `error: ${rel} is a folder (doc pull writes a file there) — ${updatedFiles(n, m)} and are tracked. Move it aside and pull again.\n`;

/** The manifest itself could not be written: every file was written, the manifest is as it was. */
export const manifestNotWrittenLine = (what: string, n: number, m: number): string =>
    `error: cannot write ${MANIFEST_FILE}: EIO: i/o error, ${what} (test hook) — ${updatedFiles(n, m)}; the manifest was not changed.\n`;

/** The INV-C gate refused to record a manifest (spec §1.5): `reason` is the gate's own wording. */
export const gateLine = (rel: string, reason: string, n: number, m: number): string =>
    `error: doc pull stopped before recording a manifest that would not match the files (${rel}: ${reason}) — ${updatedFiles(n, m)}; the manifest was not changed.\n`;

/** The lock refusal (spec §1.4). */
export const lockLine = (out: string): string =>
    `error: ${out}/${LOCK_FILE} exists: another doc pull may be writing to ${out}. If none is running, delete that file and pull again.\n`;

/** A run a test hook killed: no exit code, the signal, and the streams it had written. */
export function killed(stderr: StreamExpectation = '', stdout: StreamExpectation = ''): Expected {
    return { code: null, signal: 'SIGKILL', stdout, stderr };
}

/** A failed pull's expectation: nothing on stdout, exit 1, the stderr the row names. */
export function failed(stderr: StreamExpectation): Expected {
    return { code: 1, stdout: '', stderr };
}

/** One spawned call must end as the row expects: exit status (never a signal), stdout and stderr. */
export function expectResult(result: CliResult, expected: Expected): void {
    expect({ code: result.code, signal: result.signal }, `exit status; stdout: ${result.stdout} stderr: ${result.stderr}`).toEqual({ code: expected.code, signal: expected.signal ?? null });
    expectStream('stdout', result.stdout, expected.stdout);
    expectStream('stderr', result.stderr, expected.stderr);
}

export interface Snapshot {
    entries: Record<string, string>;
    inodes: Record<string, number>;
}

/** Every entry under `dir` (dot-entries included): files by bytes, links by target, folders as `D`; plus every regular file's inode. */
export function snapshot(dir: string): Snapshot {
    const entries: Record<string, string> = {};
    const inodes: Record<string, number> = {};
    const walk = (abs: string, prefix: string): void => {
        for (const name of fs.readdirSync(abs).sort()) {
            const full = path.join(abs, name);
            const rel = prefix === '' ? name : `${prefix}/${name}`;
            const stat = fs.lstatSync(full);
            if (stat.isSymbolicLink()) {
                entries[rel] = `L:${fs.readlinkSync(full)}`;
            } else if (stat.isDirectory()) {
                entries[rel] = 'D';
                walk(full, rel);
            } else {
                entries[rel] = `F:${fs.readFileSync(full).toString('latin1')}`;
                inodes[rel] = stat.ino;
            }
        }
    };
    walk(dir, '');
    return { entries, inodes };
}

/** The entries doc pull keeps for itself in `out`: its lock and any temp file. Both must be gone after every exit. */
export const internalEntries = (out: string): string[] => fs.readdirSync(out).filter((name) => name === LOCK_FILE || name.startsWith('.sa-write-'));
export const read = (...parts: string[]): string => fs.readFileSync(path.join(...parts), 'utf8');
export const manifestOf = (out: string): { folder_path: string; docs: Record<string, Record<string, any>> } => JSON.parse(read(out, MANIFEST_FILE));

/** Whether the temp filesystem treats names that differ only by case as one file (spec §1.7). */
export function caseInsensitiveFilesystem(): boolean {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-case-probe-'));
    try {
        fs.writeFileSync(path.join(dir, 'aB'), 'x');
        return fs.existsSync(path.join(dir, 'Ab'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** A name in its composed (NFC) spelling, and the same name decomposed (NFD): they differ byte for byte. */
export const NFC_NAME = 'café';
export const NFD_NAME = 'café';

/** Whether the temp filesystem treats the composed and the decomposed spelling of one name as the same entry (spec §1.7). */
export function normalisingFilesystem(): boolean {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-nfc-probe-'));
    try {
        fs.writeFileSync(path.join(dir, NFC_NAME), 'x');
        return fs.existsSync(path.join(dir, NFD_NAME));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

export const fault = (spec: string): Record<string, string> => ({ SOLIDACTIONS_TEST_HOOKS: '1', SOLIDACTIONS_DOC_PULL_TEST_FAULT: spec });

/**
 * Registers the server and the per-row temp folders for the calling test file, and returns the row's handle.
 * Call once at the top of a sweep file.
 */
export function useDocPullHarness() {
    let server: http.Server;
    let port: number;
    let served: ServedDoc[] = [];
    /** When true the list answers folder_path_not_found, so the pull takes the single-doc fallback. */
    let singleForm = false;
    /** While set, the first `limit` list answers wait here until `release()`; the rest answer at once. */
    let listGate: { waiting: Array<() => void>; limit: number } | null = null;
    const dirOf = (d: ServedDoc): string => d.relative ?? '';

    function answerMcp(args: Record<string, any>): string {
        if (args.action === 'list' && singleForm) {
            return mcpResult({ code: 'folder_path_not_found', message: 'no such folder' }, true);
        }
        if (args.action === 'list') {
            const relative = String(args.folder_path).slice('docs'.length).replace(/^\//, '');
            const prefix = relative ? `${relative}/` : '';
            const folders = new Set(served
                .map(dirOf)
                .filter((dir) => dir.startsWith(prefix) && dir !== relative)
                .map((dir) => dir.slice(prefix.length).split('/')[0]));
            return mcpResult({
                folders: [...folders].map((name) => ({ name, folder_path: `docs/${prefix}${name}` })),
                docs: served.filter((d) => dirOf(d) === relative).map((d) => ({ id: d.id, title: d.title, doc_type: null })),
            });
        }
        if (args.action === 'read_doc' && args.id === undefined) {
            const d = served.find((candidate) => candidate.title === args.path?.title);
            if (!d) return mcpResult({ code: 'doc_not_found', message: 'no such doc' }, true);
            return mcpResult({ id: d.id, title: d.title, folder_path: 'docs', body: bodyOf(d), current_revision_id: d.revision, properties: mediaProps(d) });
        }
        if (args.action === 'bulk_read') {
            const ids: number[] = (args.items ?? []).map((item: { id: number }) => item.id);
            return mcpResult({
                results: ids.map((id, index) => {
                    const d = served.find((candidate) => candidate.id === id)!;
                    if (d.bulkStatus !== undefined && d.bulkStatus !== 'found') return { index, status: d.bulkStatus, id };
                    return { index, status: 'found', id, title: d.title, current_revision_id: d.revision, properties: mediaProps(d), body: bodyOf(d) };
                }),
            });
        }
        return mcpResult({ code: 'unexpected', message: `unexpected action ${String(args.action)}` }, true);
    }

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (chunk) => chunks.push(chunk));
            req.on('end', () => {
                const url = req.url ?? '';
                const mediaConfirm = url.match(/^\/api\/v1\/docs\/(\d+)\/media$/);
                if (mediaConfirm) {
                    const d = served.find((candidate) => candidate.id === Number(mediaConfirm[1]));
                    if (!d || d.kind !== 'media') {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ code: 'media_not_found', message: 'no media' }));
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ url: `http://127.0.0.1:${port}/blob/${d.id}`, mime: 'image/png', size: 4 }));
                    return;
                }
                const blob = url.match(/^\/blob\/(\d+)$/);
                if (blob) {
                    const d = served.find((candidate) => candidate.id === Number(blob[1]));
                    if (!d || d.kind !== 'media' || d.downloadFails) {
                        res.writeHead(d?.downloadFails ? 500 : 503);
                        res.end();
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
                    res.end(Buffer.from(d.bytes));
                    return;
                }
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                const respond = (): void => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(answerMcp(body.params.arguments));
                };
                if (listGate !== null && body.params.arguments.action === 'list' && listGate.waiting.length < listGate.limit) listGate.waiting.push(respond);
                else respond();
            });
        });
        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', () => {
                port = (server.address() as { port: number }).port;
                resolve();
            });
        });
    });

    afterAll(() => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))));

    /** Run the built CLI with a temp HOME pointing at the server; `extraEnv` sets the test hooks on purpose. */
    function startCli(cwd: string, args: string[], extraEnv: Record<string, string> = {}): { pid: number; result: Promise<CliResult> } {
        const home = path.join(cwd, 'home');
        fs.mkdirSync(home, { recursive: true });
        writeGlobal(home, { host: `http://127.0.0.1:${port}`, apiKey: 'test-api-key', workspaceId: 'ws-test-uuid' });
        let pid = 0;
        const result = new Promise<CliResult>((resolve, reject) => {
            const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
            for (const key of ['SOLIDACTIONS_HOST', 'SOLIDACTIONS_API_KEY', 'SOLIDACTIONS_WORKSPACE_ID', 'DEBUG', 'NODE_DEBUG', 'FORCE_COLOR', 'SOLIDACTIONS_TEST_HOOKS', 'SOLIDACTIONS_DOC_PULL_TEST_FAULT']) {
                delete env[key];
            }
            // The product's own opt-out: without it a background update check (a real network call) can print an
            // `AGENT NOTE` line on stderr of a later run in the same HOME, which would make every stderr check flaky.
            env.SOLIDACTIONS_NO_AGENT_NUDGES = '1';
            Object.assign(env, extraEnv);
            const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
            pid = child.pid ?? 0;
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk) => { stdout += chunk; });
            child.stderr.on('data', (chunk) => { stderr += chunk; });
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error(`CLI timed out. stdout: ${stdout} stderr: ${stderr}`));
            }, 30_000);
            child.on('close', (code, signal) => {
                clearTimeout(timer);
                resolve({ code, signal, stdout, stderr });
            });
            child.on('error', (error) => {
                clearTimeout(timer);
                reject(error);
            });
        });
        return { pid, result };
    }

    const runCli = (cwd: string, args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> => startCli(cwd, args, extraEnv).result;

    const handle = {
        root: '',
        out: '',
        outside: '',
        /** What the server serves from now on. */
        serve(docs: ServedDoc[]): void {
            served = docs;
        },
        /** One pull in the row's form, of `title` (the single-doc form names the doc); asserts the call ends as `expected`. */
        async pull(form: Form, title: string, expected: Expected, flags: string[] = ['-y'], faultSpec?: string): Promise<CliResult> {
            singleForm = form === 'single';
            const target = form === 'single' ? `docs/${title}` : 'docs';
            const result = await runCli(handle.root, ['doc', 'pull', target, handle.out, ...flags], faultSpec === undefined ? {} : fault(faultSpec));
            expectResult(result, expected);
            return result;
        },
        /** One pull started and not awaited: its pid (also what its lock file holds) and its eventual result. */
        start(form: Form, title: string, flags: string[] = ['-y'], faultSpec?: string): { pid: number; result: Promise<CliResult> } {
            singleForm = form === 'single';
            const target = form === 'single' ? `docs/${title}` : 'docs';
            return startCli(handle.root, ['doc', 'pull', target, handle.out, ...flags], faultSpec === undefined ? {} : fault(faultSpec));
        },
        /** Hold the first `limit` `list` answers (all of them by default) until `release()`; `waiting()` is how many pulls are blocked on one. */
        gateLists(limit = Infinity): { release(): void; waiting(): number } {
            const gate: { waiting: Array<() => void>; limit: number } = { waiting: [], limit };
            listGate = gate;
            return {
                release(): void {
                    listGate = null;
                    for (const respond of gate.waiting.splice(0)) respond();
                },
                waiting: () => gate.waiting.length,
            };
        },
        /** The previous pull's state: `docs` pulled as a folder into `out`; asserts a clean first pull. */
        async seed(docs: ServedDoc[]): Promise<void> {
            served = docs;
            singleForm = false;
            const result = await runCli(handle.root, ['doc', 'pull', 'docs', handle.out, '-y']);
            expectResult(result, pulledOk(handle.out, docs.filter((d) => !d.downloadFails).map(relOf)));
        },
    };

    beforeEach(() => {
        handle.root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-pull-inv-'));
        handle.out = path.join(handle.root, 'out');
        handle.outside = path.join(handle.root, 'outside');
        fs.mkdirSync(handle.outside);
    });

    afterEach(() => {
        fs.rmSync(handle.root, { recursive: true, force: true });
    });

    return handle;
}

/**
 * `doc pull` sanitises every piece of server-derived text it prints (cli#189).
 *
 * Titles, folder names, the bulk_read row status, tool and media-confirm
 * code/message values, and paths built from them must print without control,
 * C1 or bidi characters; files and the manifest on disk keep their raw names
 * (no migration). Spawn with FORCE_COLOR=0, so the only control characters in
 * the output can come from the server. A real in-process HTTP server, a real
 * temp HOME, the real built CLI; no mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sanitizeDisplayText } from '../src/utils/source-provenance';
import { makeTmpEnv, writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

// Evil title and folder from the plan: control, C1 and bidi characters.
const T = 'Evil\x1b[31mRED\x07\x9b2J\u202eX';
const G = 'Fold\u202eer\x9b';
// sanitizeSegment turns the C0 controls into `_`, keeping C1/bidi: the on-disk name.
const T_FILE = 'Evil_[31mRED_\x9b2J\u202eX.md';

let server: http.Server;
let port: number;

// Per-test MCP answers; reset per test.
let foldersByParent: Record<string, Array<{ id: number; name: string }>> = {};
let docsByParent: Record<string, Array<{ id: number; title: string }>> = {};
let bulkRows: Array<Record<string, unknown>> = [];
let mcpIsError = false;
let mcpErrorBody: object = {};
// A valid HTTP-200 JSON-RPC error envelope for the folder list (cli#189 I4).
let listRpcError: object | null = null;
// Per-test media answers.
let confirmStatus = 200;
let confirmBody: object = {};
let blobStatus = 200;

function mcpSuccess(toolData: object): string {
    return JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { isError: false, content: [{ type: 'text', text: JSON.stringify(toolData) }] },
    });
}

function mcpFailure(toolData: object): string {
    return JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { isError: true, content: [{ type: 'text', text: JSON.stringify(toolData) }] },
    });
}

beforeAll(async () => {
    server = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        request.on('end', () => {
            const json = (status: number, payload: unknown) => {
                response.writeHead(status, { 'Content-Type': 'application/json' });
                response.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
            };
            if (request.method === 'POST' && request.url === '/mcp') {
                let args: any = {};
                try {
                    args = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.params?.arguments ?? {};
                } catch { /* ignore */ }
                if (mcpIsError) {
                    json(200, mcpFailure(mcpErrorBody));
                    return;
                }
                if (args.action === 'bulk_read') {
                    json(200, mcpSuccess({ results: bulkRows }));
                    return;
                }
                if (listRpcError !== null) {
                    json(200, { jsonrpc: '2.0', id: 1, error: listRpcError });
                    return;
                }
                const folderPath = typeof args.folder_path === 'string' ? args.folder_path : '';
                json(200, mcpSuccess({
                    folders: (foldersByParent[folderPath] ?? []).map((f) => ({ ...f, folder_path: `${folderPath}/${f.name}` })),
                    docs: (docsByParent[folderPath] ?? []).map((d) => ({ ...d, properties: {}, doc_type: null })),
                }));
                return;
            }
            if (request.method === 'GET' && request.url === '/api/v1/docs/7/media') {
                json(confirmStatus, confirmBody);
                return;
            }
            if (request.method === 'GET' && request.url === '/blob/7') {
                response.writeHead(blobStatus, { 'Content-Type': 'application/octet-stream' });
                response.end(Buffer.from([9, 9, 9]));
                return;
            }
            json(404, { message: 'not found' });
        });
    });
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
}));

interface CliResult {
    stdout: string;
    stderr: string;
    status: number | null;
}

function runCli(args: string[], home: string, cwd: string): Promise<CliResult> {
    return new Promise((resolve, reject) => {
        const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, FORCE_COLOR: '0' };
        delete childEnv.SOLIDACTIONS_HOST;
        delete childEnv.SOLIDACTIONS_API_KEY;
        delete childEnv.SOLIDACTIONS_WORKSPACE_ID;
        delete childEnv.DEBUG;
        delete childEnv.NODE_DEBUG;

        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], { cwd, env: childEnv });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });

        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`CLI timed out. stdout: ${stdout} stderr: ${stderr}`));
        }, 15_000);

        child.on('close', (status) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, status });
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

/** Every file under dir, recursively; [] when dir is missing. */
function filesUnder(dir: string): string[] {
    if (!fs.existsSync(dir)) {
        return [];
    }
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...filesUnder(full));
        } else {
            out.push(full);
        }
    }
    return out;
}

const BANNED = ['\x1b', '\x07', '\x9b', '\x9d', '\u202e'];

function expectNoBanned(output: string): void {
    for (const banned of BANNED) {
        expect(output).not.toContain(banned);
    }
}

describe('doc pull sanitises server-derived display text', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();
        foldersByParent = {};
        docsByParent = {};
        bulkRows = [];
        mcpIsError = false;
        mcpErrorBody = {};
        listRpcError = null;
        confirmStatus = 200;
        confirmBody = {};
        blobStatus = 200;
        writeGlobal(env.home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'sk-test-x',
            workspaceId: 'ws-1',
            workspace: 'ws-1',
        });
    });
    afterEach(() => env.cleanup());

    it('lists a pulled path sanitised on stdout while the disk keeps the raw name', async () => {
        foldersByParent = { Root: [{ id: 100, name: G }] };
        docsByParent = { [`Root/${G}`]: [{ id: 7, title: T }] };
        bulkRows = [{
            index: 0, status: 'found', id: 7, title: T, folder_path: `Root/${G}`,
            current_revision_id: 9, properties: {}, body: '# Hi',
        }];
        const out = path.join(env.cwd, 'out');

        const result = await runCli(['doc', 'pull', 'Root', out], env.home, env.cwd);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Folder/Evil_[31mRED_2JX.md');
        expectNoBanned(result.stdout);
        expectNoBanned(result.stderr);
        expect(fs.existsSync(path.join(out, G, T_FILE))).toBe(true);
    });

    it('refuses a path that exists as a directory with sanitised names', async () => {
        docsByParent = { Root: [{ id: 7, title: T }] };
        bulkRows = [{
            index: 0, status: 'found', id: 7, title: T, folder_path: 'Root',
            current_revision_id: 9, properties: {}, body: '# T',
        }];
        const out = path.join(env.cwd, 'out');
        fs.mkdirSync(path.join(out, T_FILE), { recursive: true });

        const result = await runCli(['doc', 'pull', 'Root', out, '--yes'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('"Evil_[31mRED_2JX.md" exists and is not a regular file — cannot write doc 7 (Evil[31mRED2JX).');
        expectNoBanned(result.stdout);
        expectNoBanned(result.stderr);
    });

    it('sanitises the title on the could-not-fetch line of a doc whose bulk_read row failed', async () => {
        docsByParent = { Root: [{ id: 7, title: T }] };
        bulkRows = [{
            index: 0, status: 'error\x1b[2J', id: 7, title: T, folder_path: 'Root',
            current_revision_id: 9, properties: {}, body: '',
        }];
        const out = path.join(env.cwd, 'out');

        const result = await runCli(['doc', 'pull', 'Root', out], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('error: could not fetch 1 doc(s) from the server: 7 ("Evil[31mRED2JX") — their local files and tracking were left as they were; pull again.');
        expectNoBanned(result.stdout);
        expectNoBanned(result.stderr);
    });

    it('sanitises the media confirm code and message', async () => {
        docsByParent = { Root: [{ id: 7, title: 'hero.png' }] };
        bulkRows = [{
            index: 0, status: 'found', id: 7, title: 'hero.png', folder_path: 'Root',
            current_revision_id: 9, properties: { blob_sha: 'abc', mime: 'image/png', size: 3 }, body: '',
        }];
        confirmStatus = 403;
        confirmBody = { code: 'forbidden\x1b[2J', message: 'no\x9bpe' };
        const out = path.join(env.cwd, 'out');

        const result = await runCli(['doc', 'pull', 'Root', out], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('error: forbidden[2J: nope');
        expectNoBanned(result.stdout);
        expectNoBanned(result.stderr);
    });

    it('sanitises the title in a failed media download warning', async () => {
        docsByParent = { Root: [{ id: 7, title: T }] };
        bulkRows = [{
            index: 0, status: 'found', id: 7, title: T, folder_path: 'Root',
            current_revision_id: 9, properties: { blob_sha: 'abc', mime: 'image/png', size: 3 }, body: '',
        }];
        confirmStatus = 200;
        confirmBody = { url: `http://127.0.0.1:${port}/blob/7`, mime: 'image/png', size: 3 };
        blobStatus = 500;
        const out = path.join(env.cwd, 'out');

        const result = await runCli(['doc', 'pull', 'Root', out], env.home, env.cwd);

        expect(result.status).toBe(0);
        expect(result.stderr).toContain('warn: failed to download media for doc 7 (Evil[31mRED2JX): HTTP 500');
        expectNoBanned(result.stdout);
        expectNoBanned(result.stderr);
        // The failed download writes no media file; only the manifest sidecar is recorded.
        expect(filesUnder(out).map((file) => path.basename(file))).toEqual(['.solidactions-docs.json']);
    });

    it('sanitises a real filesystem write failure naming a server-titled file', async () => {
        const evilTitle = 'ReadOnly\x9b2J\u202eX';
        docsByParent = { Root: [{ id: 7, title: evilTitle }] };
        bulkRows = [{
            index: 0, status: 'found', id: 7, title: evilTitle, folder_path: 'Root',
            current_revision_id: 9, properties: {}, body: '# new',
        }];
        const out = path.join(env.cwd, 'out');
        fs.mkdirSync(out, { recursive: true });
        fs.chmodSync(out, 0o555);
        try {
            const result = await runCli(['doc', 'pull', 'Root', out, '--overwrite'], env.home, env.cwd);

            expect(result.status).toBe(1);
            expect(result.stderr).toContain('error:');
            expectNoBanned(result.stdout);
            expectNoBanned(result.stderr);
        } finally {
            fs.chmodSync(out, 0o755);
        }
    });

    it('escapes display-formatting characters in --json output while parsing back exact names', async () => {
        foldersByParent = { Root: [{ id: 100, name: G }] };
        docsByParent = { [`Root/${G}`]: [{ id: 7, title: T }] };
        bulkRows = [{
            index: 0, status: 'found', id: 7, title: T, folder_path: `Root/${G}`,
            current_revision_id: 9, properties: {}, body: '# Hi',
        }];
        const out = path.join(env.cwd, 'out');

        const result = await runCli(['doc', 'pull', 'Root', out, '--json'], env.home, env.cwd);

        expect(result.status).toBe(0);
        expectNoBanned(result.stdout);
        const parsed = JSON.parse(result.stdout);
        const relPath = `${G}/${T_FILE}`;
        expect(Object.keys(parsed.manifest.docs)).toContain(relPath);
        expect(parsed.manifest.docs[relPath].title).toBe(T);
        expect(fs.existsSync(path.join(out, G, T_FILE))).toBe(true);
    });

    it('sanitises a valid JSON-RPC error envelope on the folder list', async () => {
        listRpcError = { code: -32000, message: 'RPC_FAILURE\x1b[31mRED\x9b2J\u202eTITLE' };
        const out = path.join(env.cwd, 'out');

        const result = await runCli(['doc', 'pull', 'Root', out], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('error:');
        // Diagnostic meaning kept: the MCP tool and the server text, sanitised.
        expect(result.stderr).toContain('MCP docs_read: RPC_FAILURE[31mRED2JTITLE');
        expect(fs.existsSync(out)).toBe(false);
        expectNoBanned(result.stdout);
        expectNoBanned(result.stderr);
    });

    it('sanitises the tool code and message on a root list failure', async () => {
        mcpIsError = true;
        mcpErrorBody = { code: 'bad\x9b', message: 'Osc\x1b]0;pwned\x07Y' };
        const out = path.join(env.cwd, 'out');

        const result = await runCli(['doc', 'pull', 'Root', out], env.home, env.cwd);

        expect(result.status).toBe(1);
        const errorLines = result.stderr.split('\n').filter((line) => line.startsWith('error:'));
        // Exactly one: only the list error prints (code 'bad' is not
        // 'folder_path_not_found', so the read_doc fallback never runs).
        expect(errorLines.length).toBe(1);
        for (const line of errorLines) {
            expect(line).toBe('error: bad: Osc]0;pwnedY');
        }
        expectNoBanned(result.stdout);
        expectNoBanned(result.stderr);
    });
});

describe('sanitizeDisplayText', () => {
    it('strips C0, C1 and bidi characters from an evil title', () => {
        expect(sanitizeDisplayText(T)).toBe('Evil[31mRED2JX');
    });

    it('strips an OSC sequence, keeping its printable parts', () => {
        expect(sanitizeDisplayText('a\x1b]0;x\x07b')).toBe('a]0;xb');
    });

    it('strips C1 OSC and ST', () => {
        expect(sanitizeDisplayText('\x9d0;x\x9c')).toBe('0;x');
    });

    it('leaves a plain title unchanged', () => {
        expect(sanitizeDisplayText('plain title')).toBe('plain title');
    });
});

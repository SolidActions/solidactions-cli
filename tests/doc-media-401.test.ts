/**
 * Doc media requests name the host on a 401 (cli#185).
 *
 * `doc pull`'s media confirm (`GET /api/v1/docs/{id}/media` in `resolveMedia`)
 * and `doc push`'s tracked media upload (`POST /api/v1/docs/{id}/media`) must
 * print the shared host-naming 401 line (from `authFailedLine`), never the raw
 * body; other statuses keep their old text. MCP calls always answer 200 — the
 * MCP transport (Task 3) already owns MCP 401s. A real in-process HTTP server,
 * a real temp HOME, the real built CLI; no mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpEnv, writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

function sha256Hex(data: string | Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
}

let server: http.Server;
let port: number;

// What the media REST routes answer; reset per test.
let confirmStatus = 200;
let confirmBody: object = {};
let uploadStatus = 200;
let uploadBody: object = {};

function mcpSuccess(toolData: object): string {
    return JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { isError: false, content: [{ type: 'text', text: JSON.stringify(toolData) }] },
    });
}

const MEDIA_BLOB = { blob_sha: 'abc', mime: 'image/png', size: 3 };

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
                let action: unknown = null;
                try {
                    action = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.params?.arguments?.action ?? null;
                } catch { /* ignore */ }
                if (action === 'bulk_read') {
                    json(200, mcpSuccess({
                        results: [{
                            index: 0, status: 'found', id: 7, title: 'hero.png', folder_path: '',
                            current_revision_id: 9, properties: { ...MEDIA_BLOB }, body: '',
                        }],
                    }));
                    return;
                }
                json(200, mcpSuccess({ folders: [], docs: [{ id: 7, title: 'hero.png', properties: { ...MEDIA_BLOB } }] }));
                return;
            }
            if (request.method === 'GET' && request.url === '/api/v1/docs/7/media') {
                json(confirmStatus, confirmBody);
                return;
            }
            if (request.method === 'POST' && request.url === '/api/v1/docs/42/media') {
                json(uploadStatus, uploadBody);
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
        const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1' };
        delete childEnv.SOLIDACTIONS_HOST;
        delete childEnv.SOLIDACTIONS_API_KEY;
        delete childEnv.SOLIDACTIONS_WORKSPACE_ID;
        delete childEnv.DEBUG;
        delete childEnv.NODE_DEBUG;
        delete childEnv.FORCE_COLOR;

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

describe('doc media requests name the host on a 401', () => {
    let env: ReturnType<typeof makeTmpEnv>;
    const expectedLine = () =>
        `Authentication failed against http://127.0.0.1:${port}. Run "solidactions login --global" to re-configure.`;

    beforeEach(() => {
        env = makeTmpEnv();
        confirmStatus = 200;
        confirmBody = {};
        uploadStatus = 200;
        uploadBody = {};
        writeGlobal(env.home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'sk-test-x',
            workspaceId: 'ws-1',
            workspace: 'ws-1',
        });
    });
    afterEach(() => env.cleanup());

    it('doc pull names the host when the media confirm is refused', async () => {
        confirmStatus = 401;
        confirmBody = { code: 'unauthenticated', message: 'RAW-401' };
        const out = path.join(env.cwd, 'out');

        const result = await runCli(['doc', 'pull', 'media', out], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedLine());
        expect(result.stderr).not.toContain('unknown_error');
        expect(result.stderr).not.toContain('unauthenticated:');
        expect(result.stderr).not.toContain('RAW-401');
        expect(filesUnder(out)).toEqual([]);
    });

    it('doc pull keeps the old text when the media confirm is forbidden', async () => {
        confirmStatus = 403;
        confirmBody = { code: 'forbidden', message: 'nope' };
        const out = path.join(env.cwd, 'out');

        const result = await runCli(['doc', 'pull', 'media', out], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('error: forbidden: nope');
    });

    it('doc push names the host when the tracked media upload is refused', async () => {
        uploadStatus = 401;
        uploadBody = { message: 'RAW-401' };
        const oldBytes = 'old png bytes';
        const newBytes = 'new png bytes, totally different from the old ones';
        const docsDir = path.join(env.cwd, 'docs');
        fs.mkdirSync(docsDir, { recursive: true });
        fs.writeFileSync(path.join(docsDir, 'hero.png'), newBytes);
        fs.writeFileSync(path.join(docsDir, '.solidactions-docs.json'), JSON.stringify({
            folder_path: '/some/folder',
            docs: { 'hero.png': { id: 42, title: 'hero.png', current_revision_id: 7, media: true, body_sha256: sha256Hex(oldBytes) } },
        }));

        const result = await runCli(['doc', 'push', docsDir], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedLine());
        expect(result.stderr).not.toContain('RAW-401');
        expect(result.stderr).not.toContain('error: hero.png:');
    });

    it('doc push keeps the old text when the tracked media upload fails', async () => {
        uploadStatus = 500;
        uploadBody = { message: 'boom' };
        const oldBytes = 'old png bytes';
        const newBytes = 'new png bytes, totally different from the old ones';
        const docsDir = path.join(env.cwd, 'docs');
        fs.mkdirSync(docsDir, { recursive: true });
        fs.writeFileSync(path.join(docsDir, 'hero.png'), newBytes);
        fs.writeFileSync(path.join(docsDir, '.solidactions-docs.json'), JSON.stringify({
            folder_path: '/some/folder',
            docs: { 'hero.png': { id: 42, title: 'hero.png', current_revision_id: 7, media: true, body_sha256: sha256Hex(oldBytes) } },
        }));

        const result = await runCli(['doc', 'push', docsDir], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('error: hero.png: boom');
    });
});

/**
 * The MCP transport names the host on a 401 (cli#184).
 *
 * `postMcpTool` (src/utils/mcp.ts) is the one transport behind `callDocsTool`,
 * `callCrewsTool` and `callCrewsToolContent`. A 401 must print the shared
 * host-naming 401 line (from `authFailedLine`), never the raw body; a 403 keeps
 * its old `MCP request failed` text. A real in-process HTTP server, a real temp
 * HOME, the real built CLI; no mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpEnv, writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

let server: http.Server;
let port: number;

// What POST /mcp answers; reset per test. 'list-then-401' answers the first
// /mcp call with a one-doc list and every later call with 401.
let mode: '401' | '403' | 'list-then-401' = '401';
let mcpCalls = 0;

function mcpListOneDoc(): string {
    return JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
            isError: false,
            content: [{ type: 'text', text: JSON.stringify({ folders: [], docs: [{ id: 7, title: 'Doc', properties: {}, folder_id: 1, updated_at: '2026-01-01' }] }) }],
        },
    });
}

beforeAll(async () => {
    server = http.createServer((request, response) => {
        request.resume();
        request.on('end', () => {
            const json = (status: number, payload: unknown) => {
                response.writeHead(status, { 'Content-Type': 'application/json' });
                response.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
            };
            if (request.method === 'POST' && request.url === '/mcp') {
                mcpCalls += 1;
                if (mode === 'list-then-401') {
                    if (mcpCalls === 1) {
                        json(200, mcpListOneDoc());
                        return;
                    }
                    json(401, { message: 'RAW-401-BODY' });
                    return;
                }
                if (mode === '403') {
                    json(403, { message: 'RAW-403-BODY' });
                    return;
                }
                json(401, { message: 'RAW-401-BODY' });
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

describe('MCP transport names the host on a 401', () => {
    let env: ReturnType<typeof makeTmpEnv>;
    const expectedLine = () =>
        `Authentication failed against http://127.0.0.1:${port}. Run "solidactions login --global" to re-configure.`;

    beforeEach(() => {
        env = makeTmpEnv();
        mode = '401';
        mcpCalls = 0;
        writeGlobal(env.home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'sk-test-x',
            workspaceId: 'ws-1',
            workspace: 'ws-1',
        });
    });
    afterEach(() => env.cleanup());

    it('doc pull names the host when the MCP call is refused', async () => {
        const out = path.join(env.cwd, 'out');

        const result = await runCli(['doc', 'pull', 'F', out], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedLine());
        expect(result.stderr).not.toContain('RAW-401-BODY');
        expect(result.stderr).not.toContain('MCP request failed');
        expect(filesUnder(out)).toEqual([]);
    });

    it('skill list names the host when the MCP call is refused', async () => {
        const result = await runCli(['skill', 'list'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedLine());
        expect(result.stderr).not.toContain('RAW-401-BODY');
        expect(result.stderr).not.toContain('MCP request failed');
    });

    it('role pull names the host when the MCP call is refused', async () => {
        const roleDir = path.join(env.cwd, 'role');

        const result = await runCli(['role', 'pull', 'some-role', roleDir], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedLine());
        expect(result.stderr).not.toContain('RAW-401-BODY');
        expect(result.stderr).not.toContain('MCP request failed');
        expect(filesUnder(roleDir)).toEqual([]);
    });

    it('doc push names the host when the MCP call is refused', async () => {
        const docsDir = path.join(env.cwd, 'docs');
        fs.mkdirSync(docsDir, { recursive: true });
        fs.writeFileSync(path.join(docsDir, 'a.md'), '# A\n');

        const result = await runCli(['doc', 'push', docsDir], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedLine());
        expect(result.stderr).not.toContain('RAW-401-BODY');
        expect(result.stderr).not.toContain('MCP request failed');
    });

    it('doc pull names the host when a later MCP call is refused, writing nothing', async () => {
        mode = 'list-then-401';
        const out = path.join(env.cwd, 'out');

        const result = await runCli(['doc', 'pull', 'F', out], env.home, env.cwd);

        expect(mcpCalls).toBeGreaterThan(1);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expectedLine());
        expect(result.stderr).not.toContain('RAW-401-BODY');
        expect(result.stderr).not.toContain('MCP request failed');
        expect(filesUnder(out)).toEqual([]);
    });

    it('a 403 keeps the MCP request failed text and no host-naming 401 line', async () => {
        mode = '403';

        const result = await runCli(['skill', 'list'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('MCP request failed with HTTP 403');
        expect(result.stderr).not.toContain('Authentication failed');
    });
});

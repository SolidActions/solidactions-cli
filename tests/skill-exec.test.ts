/**
 * Tests for `solidactions skill exec <name> --target sandbox -- <command...>`
 * (the `--target sandbox` path — v1.30 behavior unchanged by Task 4). The
 * `--target host` path and the option-matrix/validation rules added in
 * Task 4 are covered by the built-CLI integration suite in
 * tests/skill-exec-target.test.ts (host execution needs a real fs cache and
 * `stdio: 'inherit'`, which this in-process harness can't observe).
 *
 * Test-double policy: no mock/spy/stub libraries. Uses a real in-process HTTP
 * server (Node's http.createServer) to stub the unified /mcp endpoint —
 * matching the pattern in tests/skill-push.test.ts.
 *
 * Unlike `skill run` (tests/skill-run.test.ts), which spawns the built CLI
 * binary because production code uses `stdio: 'inherit'` (unobservable via a
 * JS-level monkeypatch), `skill exec --target sandbox` writes remote
 * stdout/stderr via `process.stdout.write` / `process.stderr.write` directly.
 * That makes the in-process pattern (patchProcessExit + captured writes)
 * sufficient here — no subprocess needed.
 */
import * as http from 'http';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { skillExecWithConfig } from '../src/commands/skill-exec';
import type { Config } from '../src/utils/config';

interface CapturedRequest {
    method: string | undefined;
    path: string | undefined;
    headers: http.IncomingHttpHeaders;
    body: any;
}

let stubServer: http.Server;
let stubPort: number;
let lastCapture: CapturedRequest | null = null;

/** Canned MCP success response. */
function makeMcpSuccess(toolData: object): string {
    return JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
            isError: false,
            content: [{ type: 'text', text: JSON.stringify(toolData) }],
        },
    });
}

/** Canned MCP error response (isError: true). */
function makeMcpError(code: string, message: string): string {
    return JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ code, message }) }],
        },
    });
}

// Server state — a FIFO queue of canned responses; falls back to a default success.
const DEFAULT_RESPONSE = makeMcpSuccess({ stdout: 'hi', stderr: '', exit_code: 0, status: 'ok' });
let responseQueue: string[] = [];

function nextResponseBody(): string {
    return responseQueue.length > 0 ? responseQueue.shift()! : DEFAULT_RESPONSE;
}

beforeAll(async () => {
    stubServer = http.createServer((req, res) => {
        let rawBody = '';
        req.on('data', (chunk) => { rawBody += chunk; });
        req.on('end', () => {
            let parsedBody: any = null;
            try { parsedBody = JSON.parse(rawBody); } catch { /* ignore */ }

            lastCapture = { method: req.method, path: req.url, headers: req.headers, body: parsedBody };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(nextResponseBody());
        });
    });

    await new Promise<void>((resolve) => {
        stubServer.listen(0, '127.0.0.1', () => {
            stubPort = (stubServer.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => {
    return new Promise<void>((resolve, reject) => {
        stubServer.close((err) => (err ? reject(err) : resolve()));
    });
});

beforeEach(() => {
    lastCapture = null;
    responseQueue = [];
});

/** Build a Config that points at the stub server. */
function stubConfig(): Config {
    return {
        host: `http://127.0.0.1:${stubPort}`,
        apiKey: 'test-api-key',
        workspaceId: 'ws-test-uuid',
    };
}

/** Sentinel thrown by the patched process.exit so execution stops. */
class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

function patchProcessExit(): () => void {
    const orig = process.exit.bind(process);
    (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };
    return () => { (process as any).exit = orig; };
}

function captureWrites(stream: NodeJS.WriteStream): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = stream.write.bind(stream);
    (stream as any).write = (chunk: string) => { lines.push(String(chunk)); return true; };
    return { lines, restore: () => { (stream as any).write = orig; } };
}

async function run(name: string, commandParts: string[], options: Record<string, unknown>) {
    const restoreExit = patchProcessExit();
    const { lines: stdoutLines, restore: restoreStdout } = captureWrites(process.stdout);
    const { lines: stderrLines, restore: restoreStderr } = captureWrites(process.stderr);
    try {
        let code: number | undefined;
        try {
            await skillExecWithConfig(name, commandParts, options as any, stubConfig());
        } catch (e) {
            if (e instanceof ProcessExitError) code = e.code;
            else throw e;
        }
        return { code, stdout: stdoutLines.join(''), stderr: stderrLines.join('') };
    } finally {
        restoreStdout();
        restoreStderr();
        restoreExit();
    }
}

describe('skillExecWithConfig — shared skill (no --role)', () => {
    it('posts tools/call with name:crews_skills and action:sandbox_exec, exits 0, prints remote stdout', async () => {
        responseQueue = [makeMcpSuccess({ stdout: 'hi', stderr: '', exit_code: 0, status: 'ok' })];

        const { code, stdout } = await run('my-skill', ['node', 'scripts/q.js'], { target: 'sandbox' });

        expect(code).toBe(0);
        expect(stdout).toContain('hi');

        expect(lastCapture).not.toBeNull();
        expect(lastCapture!.method).toBe('POST');
        expect(lastCapture!.path).toBe('/mcp');
        expect(lastCapture!.headers['x-workspace-id']).toBe('ws-test-uuid');
        expect(lastCapture!.headers['authorization']).toBe('Bearer test-api-key');

        const body = lastCapture!.body;
        expect(body.method).toBe('tools/call');
        expect(body.params.name).toBe('crews_skills');
        expect(body.params.arguments.action).toBe('sandbox_exec');
        expect(body.params.arguments.identifier).toBe('my-skill');
        expect(body.params.arguments.command).toBe("'node' 'scripts/q.js'");
    });
});

describe('skillExecWithConfig — role-scoped skill (--role)', () => {
    it('posts tools/call with name:crews_roles and action:sandbox_exec, sends role and name arguments', async () => {
        responseQueue = [makeMcpSuccess({ stdout: 'hi', stderr: '', exit_code: 0, status: 'ok', available_variables: [] })];

        const { code } = await run('my-skill', ['node', 'scripts/q.js'], { target: 'sandbox', role: 'writer' });

        expect(code).toBe(0);
        expect(lastCapture).not.toBeNull();

        const body = lastCapture!.body;
        expect(body.params.name).toBe('crews_roles');
        expect(body.params.arguments.action).toBe('sandbox_exec');
        expect(body.params.arguments.role).toBe('writer');
        expect(body.params.arguments.name).toBe('my-skill');
    });
});

describe('skillExecWithConfig — remote exit_code propagation', () => {
    it('exits with the remote exit_code (non-zero)', async () => {
        responseQueue = [makeMcpSuccess({ stdout: '', stderr: 'boom', exit_code: 3, status: 'failed' })];

        const { code, stderr } = await run('my-skill', ['node', 'scripts/q.js'], { target: 'sandbox' });

        expect(code).toBe(3);
        expect(stderr).toContain('boom');
    });
});

describe('skillExecWithConfig — options passthrough', () => {
    it('sends --environment as top-level environment argument', async () => {
        await run('my-skill', ['echo', 'hi'], { target: 'sandbox', environment: 'staging' });
        expect(lastCapture!.body.params.arguments.environment).toBe('staging');
    });

    it('sends --in-crew as in_crew only when --role is also given', async () => {
        await run('my-skill', ['echo', 'hi'], { target: 'sandbox', role: 'writer', inCrew: 'crew-a' });
        expect(lastCapture!.body.params.arguments.in_crew).toBe('crew-a');
    });

    it('rejects --in-crew when --role is absent (option matrix: Task 4)', async () => {
        const { code, stderr } = await run('my-skill', ['echo', 'hi'], { target: 'sandbox', inCrew: 'crew-a' });
        expect(code).toBe(1);
        expect(stderr).toContain('--in-crew');
        expect(lastCapture).toBeNull();
    });
});

describe('skillExecWithConfig — command quoting', () => {
    it('shell-quotes each command word before joining into params.arguments.command, so shell metacharacters in an argv word (e.g. parens in a `node -e` script) survive the remote shell unmangled', async () => {
        const { code } = await run('my-skill', ['node', '-e', 'console.log(42)'], { target: 'sandbox' });

        expect(code).toBe(0);
        // Matches shellQuoteArg's single-quote-every-word behavior in skill-run.ts:
        // each word wrapped in '...', embedded single quotes escaped as '\''.
        expect(lastCapture!.body.params.arguments.command).toBe("'node' '-e' 'console.log(42)'");
    });
});

describe('skillExecWithConfig — error cases', () => {
    it('exits 1 with no command given, without making any HTTP request', async () => {
        const { code, stderr } = await run('my-skill', [], { target: 'sandbox' });
        expect(code).toBe(1);
        expect(stderr).toContain('no command given');
        expect(lastCapture).toBeNull();
    });

    it('surfaces an MCP error code and message and exits 1', async () => {
        responseQueue = [makeMcpError('skill_not_found', 'No skill with that identifier exists.')];

        const { code, stderr } = await run('missing-skill', ['echo', 'hi'], { target: 'sandbox' });

        expect(code).toBe(1);
        expect(stderr).toContain('skill_not_found');
        expect(stderr).toContain('No skill with that identifier exists.');
    });
});

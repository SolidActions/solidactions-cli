/**
 * Tests for `solidactions skill delete <name>`
 *
 * Uses a real in-process HTTP server to stub the /mcp/crews endpoint.
 * No mocks/stubs/spies — follows the pattern from skill-push.test.ts.
 */

import * as http from 'http';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { skillDeleteWithConfig } from '../src/commands/skill-delete';
import type { Config } from '../src/utils/config';

// ---------------------------------------------------------------------------
// Stub MCP server
// ---------------------------------------------------------------------------

interface CapturedRequest {
    method: string | undefined;
    path: string | undefined;
    headers: http.IncomingHttpHeaders;
    body: any;
}

let stubServer: http.Server;
let stubPort: number;
let lastCapture: CapturedRequest | null = null;
let allCaptures: CapturedRequest[] = [];

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

const DEFAULT_RESPONSE = makeMcpError('skill_not_found', 'No skill found');
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

            const capture: CapturedRequest = {
                method: req.method,
                path: req.url,
                headers: req.headers,
                body: parsedBody,
            };

            lastCapture = capture;
            allCaptures.push(capture);

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
    allCaptures = [];
    responseQueue = [];
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubConfig(workspaceId = 'ws-test-uuid'): Config {
    return {
        host: `http://127.0.0.1:${stubPort}`,
        apiKey: 'test-api-key',
        workspaceId,
    };
}

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

function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string) => { lines.push(String(chunk)); return true; };
    return { lines, restore: () => { (process.stderr as any).write = orig; } };
}

function captureStdout(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: any[]) => { lines.push(args.map(String).join(' ')); };
    return { lines, restore: () => { console.log = orig; } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('skillDeleteWithConfig', () => {
    it('sends action:delete with identifier to the skills tool and exits 0 on success', async () => {
        responseQueue = [makeMcpSuccess({ deleted: true, delete_token: 'tok-abc123' })];

        const restoreExit = patchProcessExit();
        const { lines: stdoutLines, restore: restoreOut } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillDeleteWithConfig('my-skill', {}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            expect(lastCapture).not.toBeNull();
            expect(lastCapture!.body.params.name).toBe('skills');
            expect(lastCapture!.body.params.arguments.action).toBe('delete');
            expect(lastCapture!.body.params.arguments.identifier).toBe('my-skill');
        } finally {
            restoreExit();
            restoreOut();
        }
    });

    it('prints a confirmation message containing the skill name on success', async () => {
        responseQueue = [makeMcpSuccess({ deleted: true, delete_token: 'tok-xyz' })];

        const restoreExit = patchProcessExit();
        const { lines: stdoutLines, restore: restoreOut } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillDeleteWithConfig('target-skill', {}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            const output = stdoutLines.join('\n');
            expect(output).toContain('target-skill');
            expect(output).toContain('deleted');
        } finally {
            restoreExit();
            restoreOut();
        }
    });

    it('with --json outputs raw delete result as JSON on success', async () => {
        const deleteResult = { deleted: true, delete_token: 'tok-json-456' };
        responseQueue = [makeMcpSuccess(deleteResult)];

        const restoreExit = patchProcessExit();
        const { lines: stdoutLines, restore: restoreOut } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillDeleteWithConfig('json-skill', { json: true }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            const output = stdoutLines.join('\n');
            const parsed = JSON.parse(output);
            expect(parsed.deleted).toBe(true);
            expect(parsed.delete_token).toBe('tok-json-456');
        } finally {
            restoreExit();
            restoreOut();
        }
    });

    it('on permission_denied writes error mentioning admin/permission to stderr and exits non-zero', async () => {
        responseQueue = [makeMcpError('permission_denied', 'Only Admins can delete skills.')];

        const restoreExit = patchProcessExit();
        const { lines: stderrLines, restore: restoreErr } = captureStderr();
        const { restore: restoreOut } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillDeleteWithConfig('protected-skill', {}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit).not.toBeNull();
            expect(caughtExit!.code).not.toBe(0);

            const stderrOutput = stderrLines.join('');
            expect(stderrOutput).toContain('error');
            // Must mention admin or permission to help user understand the issue
            const outputLower = stderrOutput.toLowerCase();
            const mentionsAdminOrPermission = outputLower.includes('admin') || outputLower.includes('permission');
            expect(mentionsAdminOrPermission).toBe(true);
        } finally {
            restoreExit();
            restoreErr();
            restoreOut();
        }
    });

    it('on skill_not_found writes error to stderr and exits non-zero', async () => {
        responseQueue = [makeMcpError('skill_not_found', 'No skill with that identifier exists.')];

        const restoreExit = patchProcessExit();
        const { lines: stderrLines, restore: restoreErr } = captureStderr();
        const { restore: restoreOut } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillDeleteWithConfig('ghost-skill', {}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit).not.toBeNull();
            expect(caughtExit!.code).not.toBe(0);
            expect(stderrLines.join('')).toContain('error');
        } finally {
            restoreExit();
            restoreErr();
            restoreOut();
        }
    });

    it('sends request with the exact identifier passed as the name argument', async () => {
        const skillName = 'precise-skill-name';
        responseQueue = [makeMcpSuccess({ deleted: true, delete_token: 'tok-precise' })];

        const restoreExit = patchProcessExit();
        const { restore: restoreOut } = captureStdout();

        try {
            try {
                await skillDeleteWithConfig(skillName, {}, stubConfig());
            } catch (e) {
                if (!(e instanceof ProcessExitError)) throw e;
            }

            expect(lastCapture!.body.params.arguments.identifier).toBe(skillName);
        } finally {
            restoreExit();
            restoreOut();
        }
    });
});

/**
 * Tests for `solidactions skill view <name>`
 *
 * Uses a real in-process HTTP server to stub the /mcp/crews endpoint.
 * No mocks/stubs/spies — follows the pattern from skill-push.test.ts.
 */

import * as http from 'http';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { skillViewWithConfig } from '../src/commands/skill-view';
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

describe('skillViewWithConfig', () => {
    it('sends action:read with identifier to the skills tool and exits 0', async () => {
        responseQueue = [makeMcpSuccess({
            identifier: 'my-skill',
            doc_id: 'doc-123',
            properties: { catalog_advertised: false },
            body: 'This is the skill body content',
            reference: {},
        })];

        const restoreExit = patchProcessExit();
        const { restore: restoreOut } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillViewWithConfig('my-skill', {}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            expect(lastCapture).not.toBeNull();
            expect(lastCapture!.body.params.name).toBe('crews_skills');
            expect(lastCapture!.body.params.arguments.action).toBe('read');
            expect(lastCapture!.body.params.arguments.identifier).toBe('my-skill');
        } finally {
            restoreExit();
            restoreOut();
        }
    });

    it('prints body and description to stdout in human mode', async () => {
        responseQueue = [makeMcpSuccess({
            identifier: 'cool-skill',
            doc_id: 'doc-456',
            properties: { description: 'A cool skill description' },
            body: 'The actual body content of the skill goes here',
            reference: {},
        })];

        const restoreExit = patchProcessExit();
        const { lines: stdoutLines, restore: restoreOut } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillViewWithConfig('cool-skill', {}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            const output = stdoutLines.join('\n');
            expect(output).toContain('cool-skill');
            expect(output).toContain('The actual body content of the skill goes here');
        } finally {
            restoreExit();
            restoreOut();
        }
    });

    it('with --json outputs raw read result as JSON', async () => {
        const readResult = {
            identifier: 'json-skill',
            doc_id: 'doc-789',
            properties: { catalog_advertised: true },
            body: 'Skill body for json output',
            reference: { 'helper.ts': 'helper content' },
        };
        responseQueue = [makeMcpSuccess(readResult)];

        const restoreExit = patchProcessExit();
        const { lines: stdoutLines, restore: restoreOut } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillViewWithConfig('json-skill', { json: true }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            const output = stdoutLines.join('\n');
            const parsed = JSON.parse(output);
            expect(parsed.identifier).toBe('json-skill');
            expect(parsed.doc_id).toBe('doc-789');
            expect(parsed.body).toBe('Skill body for json output');
        } finally {
            restoreExit();
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
                await skillViewWithConfig('nonexistent-skill', {}, stubConfig());
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

    it('on invalid_identifier_form error writes error to stderr and exits non-zero', async () => {
        responseQueue = [makeMcpError('invalid_identifier_form', 'Identifier must be kebab-case.')];

        const restoreExit = patchProcessExit();
        const { lines: stderrLines, restore: restoreErr } = captureStderr();
        const { restore: restoreOut } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillViewWithConfig('Bad Identifier', {}, stubConfig());
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

    it('sends request with the correct identifier passed as the name argument', async () => {
        const skillName = 'specific-skill-name';
        responseQueue = [makeMcpSuccess({
            identifier: skillName,
            doc_id: 'doc-specific',
            properties: {},
            body: 'specific body',
            reference: {},
        })];

        const restoreExit = patchProcessExit();
        const { restore: restoreOut } = captureStdout();

        try {
            try {
                await skillViewWithConfig(skillName, {}, stubConfig());
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

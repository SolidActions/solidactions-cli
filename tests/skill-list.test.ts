/**
 * Tests for `solidactions skill list`
 *
 * Uses a real in-process HTTP server to stub the /mcp/crews endpoint.
 * No mocks/stubs/spies — follows the pattern from skill-push.test.ts.
 */

import * as http from 'http';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { skillListWithConfig } from '../src/commands/skill-list';
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

const DEFAULT_RESPONSE = makeMcpSuccess({ skills: [] });
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

describe('skillListWithConfig', () => {
    it('sends action:list to the skills tool and exits 0', async () => {
        responseQueue = [makeMcpSuccess({
            skills: [
                { doc_id: 'doc-1', name: 'my-skill', description: 'Does things', catalog_advertised: false },
                { doc_id: 'doc-2', name: 'another-skill', description: 'Does other things', catalog_advertised: true },
            ],
        })];

        const restoreExit = patchProcessExit();
        const { lines: stdoutLines, restore: restoreOut } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillListWithConfig({}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            // Request was sent
            expect(lastCapture).not.toBeNull();
            expect(lastCapture!.body.params.name).toBe('crews_skills');
            expect(lastCapture!.body.params.arguments.action).toBe('list');

            // Both skill names appear in output
            const output = stdoutLines.join('\n');
            expect(output).toContain('my-skill');
            expect(output).toContain('another-skill');
        } finally {
            restoreExit();
            restoreOut();
        }
    });

    it('prints both skill names and descriptions in human mode', async () => {
        responseQueue = [makeMcpSuccess({
            skills: [
                { doc_id: 'doc-1', name: 'skill-alpha', description: 'Alpha description', catalog_advertised: false },
                { doc_id: 'doc-2', name: 'skill-beta', description: 'Beta description', catalog_advertised: false },
            ],
        })];

        const restoreExit = patchProcessExit();
        const { lines: stdoutLines, restore: restoreOut } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillListWithConfig({}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            const output = stdoutLines.join('\n');
            expect(output).toContain('skill-alpha');
            expect(output).toContain('Alpha description');
            expect(output).toContain('skill-beta');
            expect(output).toContain('Beta description');
        } finally {
            restoreExit();
            restoreOut();
        }
    });

    it('marks catalog_advertised skills with an (advertised) indicator in human mode', async () => {
        responseQueue = [makeMcpSuccess({
            skills: [
                { doc_id: 'doc-1', name: 'public-skill', description: 'Public', catalog_advertised: true },
                { doc_id: 'doc-2', name: 'private-skill', description: 'Private', catalog_advertised: false },
            ],
        })];

        const restoreExit = patchProcessExit();
        const { lines: stdoutLines, restore: restoreOut } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillListWithConfig({}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            const output = stdoutLines.join('\n');
            expect(output).toContain('advertised');
            // private-skill line should NOT contain "advertised"
            const privateSkillLine = stdoutLines.find((l) => l.includes('private-skill'));
            expect(privateSkillLine).toBeDefined();
            expect(privateSkillLine).not.toContain('advertised');
        } finally {
            restoreExit();
            restoreOut();
        }
    });

    it('with --json outputs raw JSON containing the skills array', async () => {
        const skillsData = {
            skills: [
                { doc_id: 'doc-1', name: 'json-skill', description: 'JSON description', catalog_advertised: false },
            ],
        };
        responseQueue = [makeMcpSuccess(skillsData)];

        const restoreExit = patchProcessExit();
        const { lines: stdoutLines, restore: restoreOut } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillListWithConfig({ json: true }, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            const output = stdoutLines.join('\n');
            const parsed = JSON.parse(output);
            expect(parsed).toHaveProperty('skills');
            expect(parsed.skills).toHaveLength(1);
            expect(parsed.skills[0].name).toBe('json-skill');
        } finally {
            restoreExit();
            restoreOut();
        }
    });

    it('when skills list is empty prints "No skills found." and exits 0 (not an error)', async () => {
        responseQueue = [makeMcpSuccess({ skills: [] })];

        const restoreExit = patchProcessExit();
        const { lines: stdoutLines, restore: restoreOut } = captureStdout();
        const { lines: stderrLines, restore: restoreErr } = captureStderr();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillListWithConfig({}, stubConfig());
            } catch (e) {
                if (e instanceof ProcessExitError) caughtExit = e;
                else throw e;
            }

            expect(caughtExit?.code).toBe(0);

            const output = stdoutLines.join('\n');
            expect(output).toContain('No skills found');
            // No error output
            expect(stderrLines.join('')).toBe('');
        } finally {
            restoreExit();
            restoreOut();
            restoreErr();
        }
    });

    it('passes limit to the MCP call when --limit is provided', async () => {
        responseQueue = [makeMcpSuccess({ skills: [] })];

        const restoreExit = patchProcessExit();
        const { restore: restoreOut } = captureStdout();

        try {
            try {
                await skillListWithConfig({ limit: 5 }, stubConfig());
            } catch (e) {
                if (!(e instanceof ProcessExitError)) throw e;
            }

            expect(lastCapture).not.toBeNull();
            expect(lastCapture!.body.params.arguments.limit).toBe(5);
        } finally {
            restoreExit();
            restoreOut();
        }
    });

    it('on MCP error writes to stderr and exits non-zero', async () => {
        responseQueue = [makeMcpError('internal_error', 'Something went wrong')];

        const restoreExit = patchProcessExit();
        const { lines: stderrLines, restore: restoreErr } = captureStderr();
        const { restore: restoreOut } = captureStdout();

        try {
            let caughtExit: ProcessExitError | null = null;
            try {
                await skillListWithConfig({}, stubConfig());
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
});

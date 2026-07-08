/**
 * Tests for `solidactions skill publish <name>` and the underlying
 * publish/snapshot helpers.
 *
 * Uses a real in-process HTTP server (Node's http.createServer) to stub the
 * /mcp endpoint. No mock/spy/stub libraries — follows the pattern in
 * skill-push.test.ts.
 */

import * as http from 'http';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { publishSkillByName, publishSkillByDocId } from '../src/utils/skill-snapshot';
import { skillPublishWithConfig } from '../src/commands/skill-publish';
import type { Config } from '../src/utils/config';

// ---------------------------------------------------------------------------
// Stub MCP server — records the last request and returns a canned response
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

/** Canned MCP success response for a skill create. */
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

// Server state — a FIFO queue of canned responses; falls back to a default create-success.
const DEFAULT_RESPONSE = makeMcpSuccess({ skill_doc_id: 'doc-abc123', reference_doc_ids: {} });
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

/** Build a Config that points at the stub server. */
function stubConfig(workspaceId = 'ws-test-uuid'): Config {
    return {
        host: `http://127.0.0.1:${stubPort}`,
        apiKey: 'test-api-key',
        workspaceId,
    };
}

/** Sentinel thrown by the patched process.exit so execution stops. */
class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

/**
 * Patch process.exit to throw ProcessExitError so tests can catch it.
 * Returns a function that restores the original process.exit.
 */
function patchProcessExit(): () => void {
    const orig = process.exit.bind(process);
    (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };
    return () => { (process as any).exit = orig; };
}

/**
 * Patch process.stderr.write to capture output.
 * Returns captured lines and a restore function.
 */
function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string) => { lines.push(String(chunk)); return true; };
    return { lines, restore: () => { (process.stderr as any).write = orig; } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('publishSkillByName', () => {
    it('reads by name then snapshots by doc_id when there are unpublished revisions', async () => {
        responseQueue = [
            makeMcpSuccess({ doc_id: 118, published: false, has_unpublished_revisions: true }),
            makeMcpSuccess({ snapshot_taken: true, snapshot_id: 900 }),
        ];
        const outcome = await publishSkillByName(stubConfig(), 'my-skill');
        expect(outcome).toEqual({ status: 'published', snapshotId: 900 });
        expect(allCaptures.length).toBe(2);
        expect(allCaptures[0].body.params.name).toBe('crews_skills');
        expect(allCaptures[0].body.params.arguments).toEqual({ action: 'read', identifier: 'my-skill' });
        expect(allCaptures[1].body.params.name).toBe('crews_versions');
        expect(allCaptures[1].body.params.arguments).toEqual({ action: 'take_snapshot', doc_id: 118 });
    });

    it('returns already_published (no snapshot call) when has_unpublished_revisions is false', async () => {
        responseQueue = [makeMcpSuccess({ doc_id: 5, has_unpublished_revisions: false, active_snapshot_id: 3 })];
        const outcome = await publishSkillByName(stubConfig(), 'my-skill');
        expect(outcome).toEqual({ status: 'already_published' });
        expect(allCaptures.length).toBe(1);
    });

    it('returns live_mode (no snapshot call) when metadata is absent', async () => {
        responseQueue = [makeMcpSuccess({ doc_id: 6, published: true })];
        const outcome = await publishSkillByName(stubConfig(), 'my-skill');
        expect(outcome).toEqual({ status: 'live_mode' });
        expect(allCaptures.length).toBe(1);
    });

    it('returns error when read resolution fails', async () => {
        responseQueue = [makeMcpError('skill_not_found', "No skill 'nope'.")];
        const outcome = await publishSkillByName(stubConfig(), 'nope');
        expect(outcome).toEqual({ status: 'error', code: 'skill_not_found', message: "No skill 'nope'." });
    });

    it('returns error when take_snapshot fails', async () => {
        responseQueue = [
            makeMcpSuccess({ doc_id: 7, has_unpublished_revisions: true }),
            makeMcpError('unauthorized', 'Only Developer or Admin can take snapshots'),
        ];
        const outcome = await publishSkillByName(stubConfig(), 'my-skill');
        expect(outcome).toEqual({ status: 'error', code: 'unauthorized', message: 'Only Developer or Admin can take snapshots' });
    });
});

describe('publishSkillByDocId', () => {
    it('snapshots directly and returns published', async () => {
        responseQueue = [makeMcpSuccess({ snapshot_taken: true, snapshot_id: 777 })];
        const outcome = await publishSkillByDocId(stubConfig(), 200);
        expect(outcome).toEqual({ status: 'published', snapshotId: 777 });
        expect(allCaptures.length).toBe(1);
        expect(allCaptures[0].body.params.name).toBe('crews_versions');
        expect(allCaptures[0].body.params.arguments).toEqual({ action: 'take_snapshot', doc_id: 200 });
    });
});

describe('skillPublishWithConfig — standalone command output', () => {
    it('prints published confirmation and exits 0 on success', async () => {
        responseQueue = [
            makeMcpSuccess({ doc_id: 8, has_unpublished_revisions: true }),
            makeMcpSuccess({ snapshot_taken: true, snapshot_id: 901 }),
        ];
        const restoreExit = patchProcessExit();
        const logs: string[] = []; const origLog = console.log; console.log = (m?: any) => { logs.push(String(m)); };
        try {
            let code: number | undefined;
            try { await skillPublishWithConfig('my-skill', {}, stubConfig()); }
            catch (e) { if (e instanceof ProcessExitError) code = e.code; else throw e; }
            expect(code).toBe(0);
            expect(logs.join('')).toContain("published 'my-skill'");
        } finally { console.log = origLog; restoreExit(); }
    });

    it('prints the server error and exits 1 on failure', async () => {
        responseQueue = [makeMcpError('skill_not_found', "No skill 'nope'.")];
        const restoreExit = patchProcessExit();
        const { lines, restore } = captureStderr();
        try {
            let code: number | undefined;
            try { await skillPublishWithConfig('nope', {}, stubConfig()); }
            catch (e) { if (e instanceof ProcessExitError) code = e.code; else throw e; }
            expect(code).toBe(1);
            expect(lines.join('')).toContain('skill_not_found');
        } finally { restore(); restoreExit(); }
    });
});

/**
 * Tests for callDocsTool — verifies it POSTs to /mcp/docs with the correct
 * JSON-RPC envelope, headers, and response unwrapping.
 *
 * Uses a real in-process HTTP server (Node's http.createServer) to stub the
 * /mcp/docs endpoint.  No mock/spy/stub libraries.
 */

import * as http from 'http';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { callDocsTool } from '../src/utils/mcp';
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

let nextResponse = makeMcpSuccess({ items: [] });

beforeAll(async () => {
    stubServer = http.createServer((req, res) => {
        let rawBody = '';
        req.on('data', (chunk) => { rawBody += chunk; });
        req.on('end', () => {
            let parsedBody: any = null;
            try { parsedBody = JSON.parse(rawBody); } catch { /* ignore */ }

            lastCapture = {
                method: req.method,
                path: req.url,
                headers: req.headers,
                body: parsedBody,
            };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(nextResponse);
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
    nextResponse = makeMcpSuccess({ items: [] });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Config that points at the stub server. */
function stubConfig(workspaceId = 'ws-docs-test'): Config {
    return {
        host: `http://127.0.0.1:${stubPort}`,
        apiKey: 'test-api-key',
        workspaceId,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('callDocsTool', () => {
    it('POSTs to /mcp/docs (not /mcp/crews)', async () => {
        await callDocsTool(stubConfig(), 'docs_vault', { action: 'list' });

        expect(lastCapture).not.toBeNull();
        expect(lastCapture!.path).toBe('/mcp/docs');
    });

    it('sends the correct X-Workspace-Id header', async () => {
        await callDocsTool(stubConfig('ws-abc-123'), 'docs_vault', { action: 'list' });

        expect(lastCapture!.headers['x-workspace-id']).toBe('ws-abc-123');
    });

    it('sends Accept header that includes text/event-stream (streamable-HTTP transport)', async () => {
        await callDocsTool(stubConfig(), 'docs_vault', { action: 'list' });

        const accept = lastCapture!.headers['accept'] as string;
        expect(accept).toContain('text/event-stream');
    });

    it('sends the correct JSON-RPC tools/call envelope with name and arguments', async () => {
        await callDocsTool(stubConfig(), 'docs_vault', { action: 'list' });

        const body = lastCapture!.body;
        expect(body.jsonrpc).toBe('2.0');
        expect(body.method).toBe('tools/call');
        expect(body.params.name).toBe('docs_vault');
        expect(body.params.arguments).toEqual({ action: 'list' });
    });

    it('uses POST method', async () => {
        await callDocsTool(stubConfig(), 'docs_vault', { action: 'list' });

        expect(lastCapture!.method).toBe('POST');
    });

    it('sends Authorization: Bearer header', async () => {
        await callDocsTool(stubConfig(), 'docs_vault', { action: 'list' });

        expect(lastCapture!.headers['authorization']).toBe('Bearer test-api-key');
    });

    it('unwraps response content[0].text and returns {ok:true, data} on success', async () => {
        const toolData = { items: [{ id: 'doc-1', title: 'My Doc' }] };
        nextResponse = makeMcpSuccess(toolData);

        const result = await callDocsTool(stubConfig(), 'docs_vault', { action: 'list' });

        expect(result.ok).toBe(true);
        expect(result.data).toEqual(toolData);
    });

    it('returns {ok:false, data:{code,message}} when isError:true in response', async () => {
        nextResponse = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify({ code: 'not_found', message: 'Vault not found.' }) }],
            },
        });

        const result = await callDocsTool(stubConfig(), 'docs_vault', { action: 'list' });

        expect(result.ok).toBe(false);
        expect(result.data).toEqual({ code: 'not_found', message: 'Vault not found.' });
    });
});

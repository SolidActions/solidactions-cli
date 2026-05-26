/**
 * Minimal MCP client for the SolidActions crews MCP server.
 *
 * Sends a single stateless JSON-RPC tools/call POST.  No initialize handshake
 * required — the streamable-HTTP transport at /mcp/crews accepts single
 * stateless POSTs (confirmed live).
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { Config } from './config';
import { getApiHeaders } from './api';

export interface McpToolResult {
    ok: boolean;
    data: any;
}

/**
 * Call a single MCP tool on /mcp/crews.
 *
 * Returns { ok: true, data: <success shape> } or { ok: false, data: { code, message } }.
 */
export async function callCrewsTool(config: Config, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const baseHeaders = getApiHeaders(config, 'application/json');
    // Override Accept to include text/event-stream for streamable-HTTP transport
    const headers: Record<string, string> = {
        ...baseHeaders,
        'Accept': 'application/json, text/event-stream',
    };

    const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
            name: toolName,
            arguments: args,
        },
    });

    const parsed = new URL(`${config.host}/mcp/crews`);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const responseData = await new Promise<string>((resolve, reject) => {
        const options: http.RequestOptions = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + (parsed.search || ''),
            method: 'POST',
            headers: {
                ...headers,
                'Content-Length': Buffer.byteLength(body),
            },
        };

        const req = transport.request(options, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`MCP request failed with HTTP ${res.statusCode}: ${raw}`));
                } else {
                    resolve(raw);
                }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });

    let parsed2: any;
    try {
        parsed2 = JSON.parse(responseData);
    } catch {
        throw new Error(`MCP server returned non-JSON response: ${responseData}`);
    }

    const result = parsed2?.result;
    const isError: boolean = result?.isError === true;
    const textContent: string = result?.content?.[0]?.text ?? '{}';

    let toolData: any;
    try {
        toolData = JSON.parse(textContent);
    } catch {
        throw new Error(`MCP tool result content is not valid JSON: ${textContent}`);
    }

    return { ok: !isError, data: toolData };
}

/**
 * Minimal MCP client for the SolidActions in-app MCP servers.
 *
 * Sends a single stateless JSON-RPC tools/call POST.  No initialize handshake
 * required — the streamable-HTTP transport accepts single stateless POSTs
 * (confirmed live).
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { Config } from './config';
import { getApiHeaders } from './api';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../../package.json');
const CLI_VERSION: string = pkg.version;

export interface McpToolResult {
    ok: boolean;
    data: any;
}

interface McpRawResult {
    isError: boolean;
    content: any[];
}

/** Internal: POST one tools/call and return the raw result envelope (isError + content blocks). */
async function postMcpTool(config: Config, endpointPath: string, toolName: string, args: Record<string, unknown>): Promise<McpRawResult> {
    const baseHeaders = getApiHeaders(config, 'application/json');
    const headers: Record<string, string> = {
        ...baseHeaders,
        'Accept': 'application/json, text/event-stream',
    };

    const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
    });

    const parsed = new URL(`${config.host}${endpointPath}`);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const responseData = await new Promise<string>((resolve, reject) => {
        const options: http.RequestOptions = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + (parsed.search || ''),
            method: 'POST',
            headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        };

        const req = transport.request(options, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                if (res.statusCode === 404) {
                    reject(new Error(`MCP request failed: ${parsed.host} has no ${endpointPath} endpoint — the server may be older or newer than this CLI (${CLI_VERSION}). Raw: HTTP 404 ${raw}`));
                } else if (res.statusCode && res.statusCode >= 400) {
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
    return { isError: result?.isError === true, content: result?.content ?? [] };
}

/**
 * Internal: call a single MCP tool and JSON-parse its first text content block.
 *
 * Returns { ok: true, data: <success shape> } or { ok: false, data: { code, message } }.
 */
async function callMcpTool(config: Config, endpointPath: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const raw = await postMcpTool(config, endpointPath, toolName, args);
    const textContent: string = raw.content?.[0]?.text ?? '{}';

    let toolData: any;
    try {
        toolData = JSON.parse(textContent);
    } catch {
        throw new Error(`MCP tool result content is not valid JSON: ${textContent}`);
    }

    return { ok: !raw.isError, data: toolData };
}

const UNIFIED_MCP_PATH = '/mcp';

// Server consolidated per-domain MCP servers into one endpoint with namespaced tools.
const CREWS_TOOL_NAMES: Record<string, string> = { skills: 'crews_skills', roles: 'crews_roles' };

/**
 * Call a single MCP tool on the unified /mcp endpoint, mapping legacy crews
 * tool names ('skills'/'roles') to their namespaced equivalents.
 */
export async function callCrewsTool(config: Config, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return callMcpTool(config, UNIFIED_MCP_PATH, CREWS_TOOL_NAMES[toolName] ?? toolName, args);
}

/**
 * Call a single MCP tool on the unified /mcp endpoint.
 */
export async function callDocsTool(config: Config, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return callMcpTool(config, UNIFIED_MCP_PATH, toolName, args);
}

export interface McpContentResult {
    ok: boolean;
    content: any[];
}

/**
 * Call a crews MCP tool and return the RAW content blocks. Needed for
 * read_reference_file, whose success responses can be an MCP image block
 * (base64 bytes) rather than a JSON text block — JSON-parsing content[0].text
 * (callCrewsTool) would throw on those.
 */
export async function callCrewsToolContent(config: Config, toolName: string, args: Record<string, unknown>): Promise<McpContentResult> {
    const raw = await postMcpTool(config, UNIFIED_MCP_PATH, CREWS_TOOL_NAMES[toolName] ?? toolName, args);
    return { ok: !raw.isError, content: raw.content };
}

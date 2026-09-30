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

/** A JSON-RPC `error` member in the server's response (protocol-level failure, not a tool isError). */
export class McpRpcError extends Error {
    constructor(public readonly code: number, message: string) {
        super(message);
        this.name = 'McpRpcError';
    }
}

export interface McpToolResult {
    ok: boolean;
    data: any;
}

interface McpRawResult {
    isError: boolean;
    content: any[];
}

/** Total HTTP attempts for one call when the server answers 429 (the first try plus 2 retries). */
const RATE_LIMIT_MAX_ATTEMPTS = 3;
/** Wait used when a 429 carries no usable Retry-After. */
const RATE_LIMIT_DEFAULT_WAIT_SEC = 5;
/** No single wait exceeds this, whatever the server asks for. */
const RATE_LIMIT_MAX_WAIT_SEC = 60;

interface HttpAttempt {
    status: number;
    retryAfter: string | string[] | undefined;
    raw: string;
}

/** Seconds to wait for a Retry-After value (integer seconds or HTTP-date, RFC 9110); default when missing/invalid; capped. */
function retryAfterSeconds(header: string | string[] | undefined): number {
    const value = (Array.isArray(header) ? header[0] : header)?.trim();
    let sec = RATE_LIMIT_DEFAULT_WAIT_SEC;
    if (value) {
        if (/^\d+$/.test(value)) {
            sec = parseInt(value, 10);
        } else {
            const at = Date.parse(value);
            if (!Number.isNaN(at)) sec = Math.max(0, Math.ceil((at - Date.now()) / 1000));
        }
    }
    return Math.min(sec, RATE_LIMIT_MAX_WAIT_SEC);
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

    const attempt = () => new Promise<HttpAttempt>((resolve, reject) => {
        const options: http.RequestOptions = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + (parsed.search || ''),
            method: 'POST',
            headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        };

        const req = transport.request(options, (res) => {
            // Collect bytes and decode once: appending Buffer chunks to a string decodes
            // each chunk separately and corrupts multibyte UTF-8 split across chunks.
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
            res.on('end', () => {
                resolve({
                    status: res.statusCode ?? 0,
                    retryAfter: res.headers['retry-after'],
                    raw: Buffer.concat(chunks).toString('utf8'),
                });
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });

    let last: HttpAttempt;
    for (let n = 1; ; n++) {
        last = await attempt();
        if (last.status !== 429 || n >= RATE_LIMIT_MAX_ATTEMPTS) break;
        const waitSec = retryAfterSeconds(last.retryAfter);
        process.stderr.write(`solidactions: rate limited by server (429); retrying in ${waitSec}s (attempt ${n + 1}/${RATE_LIMIT_MAX_ATTEMPTS})\n`);
        await new Promise<void>((resolve) => setTimeout(resolve, waitSec * 1000));
    }

    if (last.status === 404) {
        throw new Error(`MCP request failed: ${parsed.host} has no ${endpointPath} endpoint — the server may be older or newer than this CLI (${CLI_VERSION}). Raw: HTTP 404 ${last.raw}`);
    }
    if (last.status >= 400) {
        throw new Error(`MCP request failed with HTTP ${last.status}: ${last.raw}`);
    }
    const responseData = last.raw;

    let parsed2: any;
    try {
        parsed2 = JSON.parse(responseData);
    } catch {
        throw new Error(`MCP server returned non-JSON response: ${responseData}`);
    }

    if (parsed2?.error) {
        throw new McpRpcError(parsed2.error.code ?? -1, `MCP ${toolName}: ${parsed2.error.message ?? JSON.stringify(parsed2.error)}`);
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
    if (!raw.content || raw.content.length === 0) {
        return { ok: false, data: { code: 'empty_result', message: `MCP ${toolName} returned no content` } };
    }
    const textContent: string = raw.content[0]?.text ?? '{}';

    let toolData: any;
    try {
        toolData = JSON.parse(textContent);
    } catch {
        throw new Error(`MCP tool result content is not valid JSON: ${textContent}`);
    }

    return { ok: !raw.isError, data: toolData };
}

const UNIFIED_MCP_PATH = '/mcp';

export type CrewsGroup = 'skills' | 'roles';

interface CrewsRoute {
    tool: string;
    /** Public action name when it differs from the CLI's action. */
    action?: string;
    /** CLI param name -> public param name, where the catalog renamed a field. */
    rename?: Record<string, string>;
}

// Current catalog (solidactions-app ToolCatalog.php): the public tool depends on the action.
// Only actions the CLI actually sends are routed; anything else throws in resolveCrewsCall.
const CREWS_ROUTES: Record<CrewsGroup, Record<string, CrewsRoute>> = {
    skills: {
        list: { tool: 'crews_skills_read' },
        read: { tool: 'crews_skills_read' },
        read_reference_file: { tool: 'crews_skills_read' },
        create: { tool: 'crews_skills_manage' },
        edit: { tool: 'crews_skills_manage' },
        delete: { tool: 'crews_delete', action: 'delete_skill' },
        sandbox_exec: { tool: 'crews_sandbox', action: 'skill_exec', rename: { environment: 'skill_exec_environment' } },
    },
    roles: {
        list: { tool: 'crews_roles_read' },
        read: { tool: 'crews_roles_read' },
        list_skills: { tool: 'crews_roles_read' },
        read_skill: { tool: 'crews_roles_read' },
        read_reference_file: { tool: 'crews_roles_read' },
        create: { tool: 'crews_roles_manage' },
        edit: { tool: 'crews_roles_manage' },
        create_skill: { tool: 'crews_roles_manage' },
        edit_skill: { tool: 'crews_roles_manage' },
        sandbox_exec: { tool: 'crews_sandbox', action: 'role_exec', rename: { environment: 'role_exec_environment' } },
    },
};

/**
 * Map a CLI-level crews call (group + action) to the public MCP tool, action and
 * param names of the current catalog. Throws for an action the CLI has no route for.
 */
export function resolveCrewsCall(group: CrewsGroup, args: Record<string, unknown>): { tool: string; args: Record<string, unknown> } {
    const action = String(args.action ?? '');
    const route = CREWS_ROUTES[group][action];
    if (!route) throw new Error(`unsupported crews action: ${group}.${action}`);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
        if (v === undefined) continue;
        out[route.rename?.[k] ?? k] = v;
    }
    if (route.action) out.action = route.action;
    return { tool: route.tool, args: out };
}

function isCrewsGroup(name: string): name is CrewsGroup {
    return name === 'skills' || name === 'roles';
}

/**
 * Call a crews MCP tool on the unified /mcp endpoint. 'skills' / 'roles' are CLI
 * groups resolved per action via resolveCrewsCall; any other name (e.g.
 * 'crews_history_manage') is passed through unchanged.
 */
export async function callCrewsTool(config: Config, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (isCrewsGroup(toolName)) {
        const r = resolveCrewsCall(toolName, args);
        return callMcpTool(config, UNIFIED_MCP_PATH, r.tool, r.args);
    }
    return callMcpTool(config, UNIFIED_MCP_PATH, toolName, args);
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
    const r = isCrewsGroup(toolName) ? resolveCrewsCall(toolName, args) : { tool: toolName, args };
    const raw = await postMcpTool(config, UNIFIED_MCP_PATH, r.tool, r.args);
    return { ok: !raw.isError, content: raw.content };
}

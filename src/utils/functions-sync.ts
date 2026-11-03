import fs from 'fs';
import path from 'path';
import axios from 'axios';
import type { SolidActionsConfig } from './env';
import type { Config } from './config';
import { getApiHeaders } from './api';

export interface CodeFunction {
    id: string;
    name: string;
    file: string;
    description?: string;
    webhook?: boolean;
    webhook_auth?: 'hmac' | 'basic' | 'header' | 'none';
    mcp?: boolean;
    mcp_tool_name?: string;
    timeout?: number;
    confirm?: boolean;
    input_schema?: Record<string, unknown>;
}

export function listCodeFunctions(config: SolidActionsConfig): CodeFunction[] {
    return ((config.functions ?? []) as unknown[]).filter(entry =>
        typeof entry === 'object' && entry !== null && (entry as { owner?: unknown }).owner !== 'editor',
    ).map(entry => {
        const fn = entry as CodeFunction;
        return {
            id: fn.id,
            name: fn.name,
            file: fn.file,
            ...(fn.description === undefined ? {} : { description: fn.description }),
            ...(fn.webhook === undefined ? {} : { webhook: fn.webhook }),
            ...(fn.webhook_auth === undefined ? {} : { webhook_auth: fn.webhook_auth }),
            ...(fn.mcp === undefined ? {} : { mcp: fn.mcp }),
            ...(fn.mcp_tool_name === undefined ? {} : { mcp_tool_name: fn.mcp_tool_name }),
            ...(fn.timeout === undefined ? {} : { timeout: fn.timeout }),
            ...(fn.confirm === undefined ? {} : { confirm: fn.confirm }),
            ...(fn.input_schema === undefined ? {} : { input_schema: fn.input_schema }),
        };
    });
}

export function readFunctionSources(sourceDir: string, functions: CodeFunction[]): Map<string, string> {
    return new Map(functions.map(fn => [fn.id, fs.readFileSync(path.join(sourceDir, fn.file), 'utf8')]));
}

export interface FunctionsSyncPayload {
    code_ref: { branch: string | null; short_sha: string | null; commit_sha: string | null; dirty: boolean | null } | null;
    functions: (CodeFunction & { source: string })[];
}

export function buildFunctionsSyncPayload(functions: CodeFunction[], sources: Map<string, string>, codeRef: FunctionsSyncPayload['code_ref']): FunctionsSyncPayload {
    return { code_ref: codeRef, functions: functions.map(fn => ({ ...fn, source: sources.get(fn.id)! })) };
}

export interface FunctionSyncResultRow {
    id: string;
    status: 'live' | 'unchanged' | 'error';
    error: { code: string; message: string } | null;
    webhook_url: string | null;
}

export function formatFunctionsSummary(rows: FunctionSyncResultRow[], retired: { id: string }[], retireErrors: { id: string; error: { code: string; message: string } }[]): string[] {
    return [
        ...rows.map(row => row.status === 'error'
            ? `function ${row.id}: error ${row.error!.code}: ${row.error!.message}`
            : `function ${row.id}: ${row.status}${row.webhook_url === null ? '' : ` ${row.webhook_url}`}`),
        ...retired.map(row => `function ${row.id}: retired`),
        ...retireErrors.map(row => `function ${row.id}: retired, its script delete failed and will retry: ${row.error.message}`),
    ];
}

export type FunctionsSyncOutcome = 'ok' | 'failed' | 'skipped-old-server';

function responseBodyCode(body: unknown): string | null {
    if (body !== null && typeof body === 'object' && 'code' in body && typeof body.code === 'string') return body.code;
    return null;
}

export function functionsSyncOutcome(input: { httpStatus: number | null; transportError: boolean; body: unknown; rows: FunctionSyncResultRow[]; retireErrors: unknown[]; sentFunctionCount: number }): FunctionsSyncOutcome {
    if (input.transportError) return 'failed';
    if (input.httpStatus === 404 && input.sentFunctionCount === 0) return 'skipped-old-server';
    if (input.httpStatus === 503 && input.sentFunctionCount === 0 && responseBodyCode(input.body) === 'functions_disabled') return 'skipped-old-server';
    if (input.httpStatus === null || input.httpStatus < 200 || input.httpStatus >= 300) return 'failed';
    return input.rows.some(row => row.status === 'error') ? 'failed' : 'ok';
}

/** Joins the functions and pages outcomes for the deploy exit code. */
export function joinSyncOutcomes(functionsOutcome: FunctionsSyncOutcome, pagesOutcome: FunctionsSyncOutcome): FunctionsSyncOutcome {
    if (functionsOutcome === 'failed' || pagesOutcome === 'failed') return 'failed';
    if (functionsOutcome === 'ok' || pagesOutcome === 'ok') return 'ok';
    return 'skipped-old-server';
}

export function formatFunctionsSyncFailure(input: { httpStatus: number | null; transportError: boolean; body: unknown; sentFunctionCount: number }): string | null {
    if (input.transportError) return 'functions sync failed: could not reach the server';
    if (input.httpStatus !== null && input.httpStatus >= 200 && input.httpStatus < 300) return null;
    if (input.httpStatus === 404) return input.sentFunctionCount === 0 ? null : 'This server does not support functions yet; upgrade the platform';
    if (input.httpStatus === 503 && input.sentFunctionCount === 0 && responseBodyCode(input.body) === 'functions_disabled') return null;
    if (input.body !== null && typeof input.body === 'object' && 'code' in input.body && 'message' in input.body && typeof input.body.code === 'string' && typeof input.body.message === 'string') {
        return `functions sync failed (${input.httpStatus} ${input.body.code}): ${input.body.message}`;
    }
    // Laravel's own validation 422 carries `message` and `errors` but no `code`.
    if (input.body !== null && typeof input.body === 'object' && 'message' in input.body && typeof input.body.message === 'string') {
        return `functions sync failed (HTTP ${input.httpStatus}): ${input.body.message}`;
    }
    return `functions sync failed (HTTP ${input.httpStatus})`;
}

/** HTTP client timeout for the functions/sync call (P7: the server holds the request up to 180 s). */
export const FUNCTIONS_SYNC_TIMEOUT_MS = 210_000;

export async function syncFunctions(config: Config, projectSlug: string, payload: FunctionsSyncPayload): Promise<{ httpStatus: number | null; transportError: boolean; body: any }> {
    try {
        const response = await axios.put(`${config.host}/api/v1/projects/${encodeURIComponent(projectSlug)}/functions/sync`, payload, { headers: getApiHeaders(config, 'application/json'), timeout: FUNCTIONS_SYNC_TIMEOUT_MS });
        return { httpStatus: response.status, transportError: false, body: response.data };
    } catch (error: any) {
        return { httpStatus: error.response?.status ?? null, transportError: !error.response, body: error.response?.data ?? null };
    }
}

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import type { SolidActionsConfig } from './env';
import type { Config } from './config';
import { getApiHeaders } from './api';
import { isPagePointer } from './validate-items';

export interface PageFile {
    slug: string;
    name: string;
    path: string;
    kind: 'visual' | 'dashboard';
    home: boolean;
    sources?: Record<string, unknown>[];
}

export function listCodePages(config: SolidActionsConfig): PageFile[] {
    return (config.pages ?? []).filter(page => !isPagePointer(page)).map(page => ({
        slug: page.id,
        name: page.name,
        path: page.file,
        kind: page.file.endsWith('.html') ? 'visual' : 'dashboard',
        home: page.home ?? false,
        ...(page.sources === undefined ? {} : { sources: page.sources }),
    }));
}

export function readPageBodies(sourceDir: string, pages: PageFile[]): Map<string, string> {
    return new Map(pages.map(page => [page.slug, fs.readFileSync(path.join(sourceDir, page.path), 'utf8')]));
}

export interface PagesSyncPayload {
    deployment_id: string | null;
    code_ref: { branch: string | null; short_sha: string | null; commit_sha: string | null; dirty: boolean | null } | null;
    pages: (PageFile & { body: string })[];
}

export function buildPagesSyncPayload(pages: PageFile[], bodies: Map<string, string>, deploymentId: string | null, codeRef: PagesSyncPayload['code_ref']): PagesSyncPayload {
    return { deployment_id: deploymentId, code_ref: codeRef, pages: pages.map(page => ({ ...page, body: bodies.get(page.slug)! })) };
}

export interface PagesSyncResultRow {
    slug: string;
    id: number | null;
    status: 'live' | 'error';
    error: { code: string; message: string } | null;
    url: string | null;
}

export function formatPagesSummary(rows: PagesSyncResultRow[], trashed: { slug: string; id: number }[], trashErrors: { slug: string; error: { code: string; message: string } }[]): string[] {
    return [
        ...rows.map(row => row.status === 'live'
            ? `page ${row.slug}: live${row.url === null ? '' : ` ${row.url}`}`
            : `page ${row.slug}: error ${row.error!.code}: ${row.error!.message}`),
        ...trashed.map(row => `page ${row.slug}: moved to trash (id ${row.id})`),
        ...trashErrors.map(row => `page ${row.slug}: could not move to trash: ${row.error.code}: ${row.error.message}`),
    ];
}

export type PagesSyncOutcome = 'ok' | 'failed' | 'skipped-old-server';

export function pagesSyncOutcome(input: { httpStatus: number | null; transportError: boolean; rows: PagesSyncResultRow[]; trashErrors: unknown[]; sentPageCount: number }): PagesSyncOutcome {
    if (input.transportError) return 'failed';
    if (input.httpStatus === 404 && input.sentPageCount === 0) return 'skipped-old-server';
    if (input.httpStatus === null || input.httpStatus < 200 || input.httpStatus >= 300) return 'failed';
    return input.rows.some(row => row.status === 'error') || input.trashErrors.length > 0 ? 'failed' : 'ok';
}

export function formatPagesSyncFailure(input: { httpStatus: number | null; transportError: boolean; body: unknown; sentPageCount: number }): string | null {
    if (input.transportError) return 'pages sync failed: could not reach the server';
    if (input.httpStatus !== null && input.httpStatus >= 200 && input.httpStatus < 300) return null;
    if (input.httpStatus === 404) return input.sentPageCount === 0 ? null : 'This server does not support pages: yet; upgrade the platform';
    if (input.body !== null && typeof input.body === 'object' && 'code' in input.body && 'message' in input.body && typeof input.body.code === 'string' && typeof input.body.message === 'string') {
        return `pages sync failed (${input.httpStatus} ${input.body.code}): ${input.body.message}`;
    }
    return `pages sync failed (HTTP ${input.httpStatus})`;
}

export function terminalExitCode(input: { buildFailed: boolean; yamlSyncFailed: boolean; outcome: PagesSyncOutcome }): 0 | 1 {
    return input.buildFailed || input.yamlSyncFailed || input.outcome === 'failed' ? 1 : 0;
}

export async function syncPages(config: Config, projectSlug: string, payload: PagesSyncPayload): Promise<{ httpStatus: number | null; transportError: boolean; body: any }> {
    try {
        const response = await axios.put(`${config.host}/api/v1/projects/${encodeURIComponent(projectSlug)}/pages/sync`, payload, { headers: getApiHeaders(config, 'application/json') });
        return { httpStatus: response.status, transportError: false, body: response.data };
    } catch (error: any) {
        return { httpStatus: error.response?.status ?? null, transportError: !error.response, body: error.response?.data ?? null };
    }
}

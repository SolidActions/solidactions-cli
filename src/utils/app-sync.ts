import axios from 'axios';
import type { SolidActionsConfig } from './env';
import type { Config } from './config';
import { getApiHeaders } from './api';

export interface AppSyncPayload {
    app: Record<string, unknown> | null;
}

export type AppSyncResult = { httpStatus: number | null; transportError: boolean; body: any };

const PALETTE_KEYS = ['sidebar_bg', 'sidebar_fg', 'accent', 'mark'] as const;
const THEME_MODES = ['light', 'dark'] as const;

/** The `app:` block exactly as the yaml holds it; the server is the only validator. */
export function buildAppSyncPayload(config: SolidActionsConfig): AppSyncPayload {
    return { app: (config.app ?? null) as Record<string, unknown> | null };
}

/**
 * One warning per palette key present in the yaml with a null value: an
 * unquoted #hex is a yaml comment, so the value arrives as null.
 */
export function emptyColourWarnings(app: unknown): string[] {
    const theme = isRecord(app) ? app.theme : null;
    if (!isRecord(theme)) return [];
    const warnings: string[] = [];
    for (const mode of THEME_MODES) {
        const palette = theme[mode];
        if (!isRecord(palette)) continue;
        for (const key of PALETTE_KEYS) {
            if (key in palette && palette[key] === null) {
                warnings.push(`app.theme.${mode}.${key} is empty: quote hex colours in yaml ("#e0a458")`);
            }
        }
    }
    return warnings;
}

export function formatAppSync(result: AppSyncResult, sentApp: boolean): { lines: string[]; failed: boolean } {
    if (result.transportError) {
        return { lines: ['App settings sync FAILED: could not reach the server'], failed: true };
    }
    const status = result.httpStatus;
    if (status !== null && status >= 200 && status < 300) {
        return { lines: successLines(result.body, sentApp), failed: false };
    }
    if (status === 404) {
        return sentApp
            ? { lines: ['This server does not support app: yet; upgrade the platform'], failed: true }
            : { lines: [], failed: false };
    }
    if (status === 422) {
        return { lines: ['App settings refused:', ...errorLines(result.body?.errors)], failed: true };
    }
    if (status === 401) {
        return { lines: ['App settings sync FAILED: not signed in'], failed: true };
    }
    const message = typeof result.body?.message === 'string' && result.body.message !== '' ? result.body.message : `HTTP ${status}`;
    return { lines: [`App settings sync FAILED: ${message}`], failed: true };
}

function successLines(body: any, sentApp: boolean): string[] {
    switch (body?.outcome) {
        case 'set':
            return [`✓ App settings applied (sidebar: ${body.app?.sidebar ?? 'shown'}, theme: ${themeSummary(body.app?.theme)})`];
        case 'unchanged':
            return sentApp ? ['✓ App settings unchanged'] : [];
        case 'cleared':
            return ['✓ App settings cleared (the app: block was removed)'];
        default:
            return [];
    }
}

function themeSummary(theme: unknown): string {
    if (!isRecord(theme)) return 'none';
    const light = isRecord(theme.light);
    const dark = isRecord(theme.dark);
    if (light && dark) return 'light+dark';
    if (light) return 'light';
    if (dark) return 'dark';
    return 'none';
}

function errorLines(errors: unknown): string[] {
    if (!isRecord(errors)) return [];
    return Object.entries(errors).flatMap(([field, messages]) =>
        (Array.isArray(messages) ? messages : [messages]).map(message => `  ${field}: ${String(message)}`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function syncApp(config: Config, projectSlug: string, payload: AppSyncPayload): Promise<AppSyncResult> {
    try {
        const response = await axios.put(`${config.host}/api/v1/projects/${encodeURIComponent(projectSlug)}/app/sync`, payload, { headers: getApiHeaders(config, 'application/json') });
        return { httpStatus: response.status, transportError: false, body: response.data };
    } catch (error: any) {
        return { httpStatus: error.response?.status ?? null, transportError: !error.response, body: error.response?.data ?? null };
    }
}

import axios, { AxiosResponse } from 'axios';
import { Config } from './config';
import { getApiHeaders } from './api';
import { buildProjectSlug, slugifyName } from './slug';

/**
 * GET a project by the name as typed, then — on a 404 only — by its canonical slug when
 * that differs (cli#102). The server stores `Issue970-QX` as `issue970-qx`; without the
 * retry a redeploy 404s, tries to create, and collides with the slug that already exists.
 * The typed spelling goes first so a legacy slug the slugifier would rewrite still resolves.
 */
export async function getProjectBySlugOrCanonical(config: Config, typed: string, canonical: string): Promise<AxiosResponse> {
    try {
        return await axios.get(`${config.host}/api/v1/projects/${typed}`, { headers: getApiHeaders(config) });
    } catch (error: any) {
        if (error.response?.status !== 404 || canonical === '' || canonical === typed) {
            throw error;
        }
        return axios.get(`${config.host}/api/v1/projects/${canonical}`, { headers: getApiHeaders(config) });
    }
}

/** The slug a command used before cli#161, then the canonical slug — no duplicates, no empty canonical. */
export function projectSlugCandidates(typed: string, environment?: string): string[] {
    const today = environment === undefined || environment === 'production' ? typed : `${typed}-${environment}`;
    const out = [today];
    if (slugifyName(typed) !== '') {
        const canonical = buildProjectSlug(typed, environment ?? 'production');
        if (!out.includes(canonical)) out.push(canonical);
    }
    return out;
}

/**
 * Resolve a user-typed project to the slug the server stores (cli#161): try each candidate, move on only
 * on a 404, and return the server's slug. Any other error propagates to the command's own handling. When
 * every candidate 404s, return the first so the command's existing not-found message runs unchanged.
 */
export async function resolveProjectSlug(config: Config, typed: string, environment?: string): Promise<string> {
    const candidates = projectSlugCandidates(typed, environment);
    for (const candidate of candidates) {
        try {
            // Unencoded, as the commands put the slug into their own URLs (PM ruling 6).
            const response = await axios.get(`${config.host}/api/v1/projects/${candidate}`, { headers: getApiHeaders(config) });
            return (typeof response.data?.slug === 'string' && response.data.slug) || candidate;
        } catch (error: any) {
            // PM ruling 3: a token may be allowed the command's own route but not the project read —
            // a 403 here is not a failure; let the command's own request decide.
            if (error.response?.status === 403) return candidates[0];
            if (error.response?.status !== 404) throw error;
        }
    }
    return candidates[0];
}

export interface ProjectRungMatch {
    /** The single project the rungs settled on, or null when no rung hit. */
    project: any | null;
    /** Every project the last (case-insensitive) rung matched, when more than one. */
    ambiguous: any[];
}

/**
 * Match a typed project against `GET /api/v1/projects` rows in rungs, stopping
 * at the first rung with a hit: exact name, exact slug, canonical slug, then a
 * case-insensitive name (PM ruling 4: more than one hit there is ambiguous).
 * Shared by `run list`'s retry and `lookupProjectFamilyEnvironments`.
 */
export function matchProjectRungs(projects: any[], typed: string): ProjectRungMatch {
    if (!Array.isArray(projects)) return { project: null, ambiguous: [] };
    const byName = projects.find((p: any) => p?.name === typed);
    if (byName) return { project: byName, ambiguous: [] };
    const bySlug = projects.find((p: any) => p?.slug === typed);
    if (bySlug) return { project: bySlug, ambiguous: [] };
    const canonical = slugifyName(typed);
    if (canonical !== '') {
        const byCanonical = projects.find((p: any) => p?.slug === canonical);
        if (byCanonical) return { project: byCanonical, ambiguous: [] };
    }
    const lowered = typed.toLowerCase();
    const ci = projects.filter((p: any) => typeof p?.name === 'string' && p.name.toLowerCase() === lowered);
    if (ci.length > 1) return { project: null, ambiguous: ci };
    return { project: ci[0] ?? null, ambiguous: [] };
}

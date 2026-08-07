import axios from 'axios';
import chalk from 'chalk';
import { Config } from './config';
import { getApiHeaders } from './api';
import { callCrewsTool } from './mcp';

export interface CrewRecord {
    id: string | number;
    name: string;
    path?: string;
}

export const CREW_ENV_VALUES = ['production', 'staging', 'dev', 'all'] as const;
export type CrewEnvValue = typeof CREW_ENV_VALUES[number];

export function isValidCrewEnv(value: string): value is CrewEnvValue {
    return (CREW_ENV_VALUES as readonly string[]).includes(value);
}

export function crewEnvError(value: string): string {
    return `Invalid --env "${value}" — must be one of: ${CREW_ENV_VALUES.join(', ')}.`;
}

/** True when the crew argument should be used as an id directly, bypassing name lookup. */
export function isNumericCrewArg(input: string): boolean {
    return /^\d+$/.test(input);
}

export type CrewMatchResult =
    | { status: 'ok'; crew: CrewRecord }
    | { status: 'not_found' }
    | { status: 'ambiguous'; candidates: CrewRecord[] };

/** Pure: case-insensitive name match against a fetched crew list. */
export function matchCrewByName(input: string, crews: CrewRecord[]): CrewMatchResult {
    const matches = crews.filter((c) => c.name.toLowerCase() === input.toLowerCase());
    if (matches.length === 0) return { status: 'not_found' };
    if (matches.length > 1) return { status: 'ambiguous', candidates: matches };
    return { status: 'ok', crew: matches[0] };
}

export async function fetchCrews(config: Config): Promise<CrewRecord[]> {
    const response = await axios.get(`${config.host}/api/v1/crews`, { headers: getApiHeaders(config) });
    return response.data?.data ?? [];
}

/**
 * Resolve a crew CLI argument to an id. Numeric input is used directly as
 * the id (no network call) — lets scripts skip the name lookup entirely and
 * sidesteps ambiguity. Non-numeric input is matched by case-insensitive name
 * against `GET /api/v1/crews`; ambiguous matches list candidates by id so
 * the caller can retry unambiguously.
 */
export async function resolveCrewId(config: Config, input: string): Promise<CrewRecord> {
    if (isNumericCrewArg(input)) {
        return { id: input, name: input };
    }

    let crews: CrewRecord[];
    try {
        crews = await fetchCrews(config);
    } catch (error: any) {
        console.error(chalk.red('Failed to list crews:'), error.response?.data?.message || error.message);
        process.exit(1);
    }

    const result = matchCrewByName(input, crews);
    if (result.status === 'not_found') {
        console.error(chalk.red(`Crew "${input}" not found.`));
        process.exit(1);
    }
    if (result.status === 'ambiguous') {
        console.error(chalk.red(`Multiple crews named "${input}" found — specify by id instead:`));
        for (const c of result.candidates) {
            console.error(chalk.gray(`  id=${c.id}${c.path ? `  path=${c.path}` : ''}`));
        }
        process.exit(1);
    }
    return result.crew;
}

/**
 * Resolve the containment crew path for a role-scoped skill. --in-crew names it
 * directly; otherwise roles.list is consulted (each entry carries in_crew).
 * roles.read_skill does NOT return the crew, so this lookup is load-bearing for
 * both variable resolution and cache scoping.
 */
export async function resolveRoleCrewPath(config: Config, role: string, inCrew?: string): Promise<string> {
    if (inCrew) return inCrew;

    const result = await callCrewsTool(config, 'roles', { action: 'list' });
    if (!result.ok) {
        console.error(chalk.red(`Failed to list roles: ${result.data?.message ?? 'unknown error'}`));
        process.exit(1);
    }
    const roles: Array<{ identifier: string; in_crew: string | null }> = result.data?.roles ?? [];
    const matches = roles.filter((r) => r.identifier === role);

    if (matches.length === 0) {
        console.error(chalk.red(`Role "${role}" not found.`));
        process.exit(1);
    }
    if (matches.length > 1) {
        console.error(chalk.red(`Role "${role}" exists in multiple crews — pass --in-crew <crew>:`));
        for (const m of matches) console.error(chalk.gray(`  --in-crew ${m.in_crew ?? '(legacy flat role)'}`));
        process.exit(1);
    }
    if (!matches[0].in_crew) {
        console.error(chalk.red(`Role "${role}" is a legacy flat role with no crew — crew variables cannot be resolved.`));
        process.exit(1);
    }
    return matches[0].in_crew;
}

/** Map a containment crew path (e.g. "acme/marketing") to the crew doc id used by /variables/resolve. */
export async function crewIdForPath(config: Config, crewPath: string): Promise<string | number> {
    const crews = await fetchCrews(config);
    const byPath = crews.filter((c) => c.path === crewPath);
    if (byPath.length === 1) return byPath[0].id;

    const lastSegment = crewPath.split('/').pop() ?? crewPath;
    const byName = crews.filter((c) => c.name.toLowerCase() === lastSegment.toLowerCase());
    if (byName.length === 1) return byName[0].id;

    console.error(chalk.red(`Could not resolve crew "${crewPath}" to a crew id (matched ${byPath.length} by path, ${byName.length} by name).`));
    process.exit(1);
}

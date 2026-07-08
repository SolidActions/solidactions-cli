import axios from 'axios';
import chalk from 'chalk';
import { Config } from './config';
import { getApiHeaders } from './api';

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

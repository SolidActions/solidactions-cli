import axios from 'axios';
import chalk from 'chalk';
import { Config } from './config';

export interface WorkspaceLookupRecord {
    id: string;
    slug?: string;
    name: string;
}

/**
 * Pure: given a list of workspaces and an input string, return the matching
 * workspace. Match order: id, slug, name (first match wins). Cross-tenant
 * collisions resolve to the first match in the list (pre-existing behavior;
 * see sol-r0b-test-todo.md for follow-up).
 */
export function matchWorkspace(
    input: string,
    workspaces: WorkspaceLookupRecord[],
): WorkspaceLookupRecord | undefined {
    return workspaces.find((w) => w.id === input || w.slug === input || w.name === input);
}

/**
 * Network: fetch the full list of workspaces the current API key can see.
 * Normalizes the API's grouped/array response shapes.
 */
export async function fetchWorkspaces(config: Config): Promise<WorkspaceLookupRecord[]> {
    const response = await axios.get(`${config.host}/api/v1/workspaces`, {
        headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Accept': 'application/json',
        },
    });
    const grouped = response.data.workspaces || response.data.teams || response.data.data || response.data;
    const out: WorkspaceLookupRecord[] = [];
    if (typeof grouped === 'object' && !Array.isArray(grouped)) {
        for (const orgWorkspaces of Object.values(grouped)) {
            out.push(...(orgWorkspaces as WorkspaceLookupRecord[]));
        }
    } else if (Array.isArray(grouped)) {
        out.push(...(grouped as WorkspaceLookupRecord[]));
    }
    return out;
}

/**
 * High-level: fetch + match. Errors with a clear CLI message and exits
 * non-zero if no match is found.
 */
export async function resolveWorkspaceInput(
    config: Config,
    input: string,
): Promise<WorkspaceLookupRecord> {
    let workspaces: WorkspaceLookupRecord[];
    try {
        workspaces = await fetchWorkspaces(config);
    } catch (error: any) {
        console.error(chalk.red('Failed to list workspaces:'), error.response?.data?.message || error.message);
        process.exit(1);
    }
    const match = matchWorkspace(input, workspaces);
    if (!match) {
        console.error(chalk.red(`Workspace "${input}" not found. Run \`solidactions workspace list\` to list available workspaces.`));
        process.exit(1);
    }
    return match;
}

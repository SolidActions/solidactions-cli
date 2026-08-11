import axios from 'axios';
import chalk from 'chalk';
import readline from 'readline';
import { Config } from './config';

export interface WorkspaceLookupRecord {
    id: string;
    slug?: string;
    name: string;
    org_name?: string;
    role?: string;
}

/** Device-flow token scope, as returned by GET /api/v1/workspaces. Null for user-scoped Sanctum PATs. */
export interface WorkspaceScope {
    mode: 'all' | 'subset' | 'single';
    workspace_ids: string[];
}

export interface FetchWorkspacesResult {
    workspaces: WorkspaceLookupRecord[];
    scope: WorkspaceScope | null;
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
export async function fetchWorkspaces(config: Config): Promise<FetchWorkspacesResult> {
    const response = await axios.get(`${config.host}/api/v1/workspaces`, {
        headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Accept': 'application/json',
        },
    });
    const grouped = response.data.workspaces || response.data.teams || response.data.data || response.data;
    const out: WorkspaceLookupRecord[] = [];
    if (typeof grouped === 'object' && !Array.isArray(grouped)) {
        for (const [orgName, orgWorkspaces] of Object.entries(grouped)) {
            for (const ws of orgWorkspaces as Array<WorkspaceLookupRecord & { tenant_name?: string }>) {
                out.push({ ...ws, org_name: ws.tenant_name || orgName });
            }
        }
    } else if (Array.isArray(grouped)) {
        out.push(...(grouped as WorkspaceLookupRecord[]));
    }
    const scope = (response.data.scope as WorkspaceScope | null) ?? null;
    return { workspaces: out, scope };
}

/** Workspace name, qualified with its org name when known (e.g. `"Foo — organization Bar"`). */
export function formatWorkspaceWithOrg(ws: WorkspaceLookupRecord): string {
    return ws.org_name ? `${ws.name} — organization ${ws.org_name}` : ws.name;
}

/**
 * Prompt the user to pick a workspace from an already-fetched list. Auto-
 * selects when there's exactly one. Invalid answers re-prompt; EOF or a
 * closed input returns undefined without selecting anything.
 */
export interface WorkspaceSelectionDependencies {
    question?: () => Promise<string | undefined>;
    label?: (ws: WorkspaceLookupRecord) => string;
}

export async function selectWorkspaceInteractively(
    workspaces: WorkspaceLookupRecord[],
    dependencies: WorkspaceSelectionDependencies = {},
): Promise<WorkspaceLookupRecord | undefined> {
    if (workspaces.length === 0) {
        console.log(chalk.yellow('No workspaces found. Create one at your SolidActions dashboard, then run `solidactions workspace set <name>`.'));
        return undefined;
    }
    if (workspaces.length === 1) {
        console.log(chalk.gray(`Auto-selected workspace: ${formatWorkspaceWithOrg(workspaces[0])}`));
        return workspaces[0];
    }

    const label = dependencies.label ?? ((ws: WorkspaceLookupRecord) => (ws.role ? `${ws.name} (${ws.role})` : ws.name));
    // Header + grouping preamble are only useful once there's more than one
    // org to disambiguate; a single-org account would otherwise get a
    // redundant sole header and a pointless "grouped by organization" line.
    const orgNames = new Set(workspaces.map((ws) => ws.org_name).filter((name): name is string => !!name));
    const grouped = orgNames.size > 1;

    console.log(chalk.blue('\nSelect your default workspace (change anytime with `solidactions workspace set`):\n'));
    if (grouped) {
        console.log(chalk.gray('Workspaces are grouped by organization.\n'));
    }
    let lastOrg: string | undefined;
    workspaces.forEach((ws, i) => {
        if (grouped && ws.org_name !== lastOrg) {
            console.log(`  ${chalk.bold(ws.org_name ?? '')}`);
            lastOrg = ws.org_name;
        }
        const indent = grouped ? '    ' : '  ';
        console.log(`${indent}${chalk.white(`${i + 1}.`)} ${label(ws)}`);
    });
    console.log('');

    const rl = dependencies.question
        ? null
        : readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = dependencies.question ?? (async () => {
        if (!rl || (rl as any).closed) return undefined;
        return new Promise<string | undefined>((resolve) => {
            let answered = false;
            const onClose = () => {
                if (!answered) resolve(undefined);
            };
            rl.once('close', onClose);
            rl.question(chalk.blue('Enter number: '), (answer) => {
                answered = true;
                rl.removeListener('close', onClose);
                resolve(answer);
            });
        });
    });

    try {
        while (true) {
            const answer = await question();
            if (answer === undefined) {
                console.log(chalk.yellow(
                    'Workspace selection cancelled. Run `solidactions workspace list`, then '
                    + '`solidactions workspace set <name>` when ready.',
                ));
                return undefined;
            }
            const index = parseInt(answer, 10) - 1;
            if (!isNaN(index) && index >= 0 && index < workspaces.length) {
                const selected = workspaces[index];
                console.log(chalk.green(`Selected: ${formatWorkspaceWithOrg(selected)}`));
                return selected;
            }
            console.error(chalk.red('Invalid selection. Enter one of the numbers shown.'));
        }
    } finally {
        rl?.close();
    }
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
    let scope: WorkspaceScope | null = null;
    try {
        ({ workspaces, scope } = await fetchWorkspaces(config));
    } catch (error: any) {
        console.error(chalk.red('Failed to list workspaces:'), error.response?.data?.message || error.message);
        process.exit(1);
    }
    const match = matchWorkspace(input, workspaces);
    if (!match) {
        // A scoped (single/subset) session only ever lists the workspaces its
        // OAuth grant covers, so a miss can mean either "doesn't exist" OR
        // "exists but out of this session's scope" — disambiguate so the user
        // knows re-auth with broader scope may be the fix, not a typo.
        if (scope && (scope.mode === 'single' || scope.mode === 'subset')) {
            console.error(chalk.red(
                `Workspace "${input}" not found in this session's authorized workspaces `
                + `(scope: ${scope.mode}${scope.workspace_ids.length ? `, covering ${scope.workspace_ids.join(', ')}` : ''}). `
                + 'If it exists but is out of scope, re-authenticate with broader scope: `solidactions login --device`.',
            ));
        } else {
            console.error(chalk.red(`Workspace "${input}" not found. Run \`solidactions workspace list\` to list available workspaces.`));
        }
        process.exit(1);
    }
    return match;
}

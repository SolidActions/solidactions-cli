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
    tenant_id?: string;
    tenant_name?: string;
    tenant_slug?: string;
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

export type WorkspaceMatchResult =
    | { kind: 'match'; workspace: WorkspaceLookupRecord }
    | { kind: 'ambiguous'; input: string; candidates: WorkspaceLookupRecord[] }
    | { kind: 'org-only'; input: string; orgWorkspaces: WorkspaceLookupRecord[] }
    | { kind: 'not-found'; input: string };

/**
 * Pure: given a list of workspaces and an input string, classify the match.
 * Match order: id, slug, name — but unlike a bare first-match, NAME matches
 * are checked for collisions before being trusted, because org names and
 * workspace names share a namespace (#1196):
 *   - the input can be an org name that also happens to be one of that org's
 *     workspace names, silently landing the user in the org-wide workspace
 *     instead of the one they meant;
 *   - the input can be an org name that owns no workspace of that name at
 *     all, which a bare miss reports as "not found" even though it's right
 *     there on `workspace list`;
 *   - the same workspace name can exist in two different orgs.
 * `id` and `slug` matches are exact handles (unique in practice) and stay
 * ambiguity-free so scripted `workspace set <slug|uuid>` keeps working
 * unprompted; only name matches get the extra checks.
 */
export function classifyWorkspaceInput(
    input: string,
    workspaces: WorkspaceLookupRecord[],
): WorkspaceMatchResult {
    const idMatch = workspaces.find((w) => w.id === input);
    if (idMatch) {
        return { kind: 'match', workspace: idMatch };
    }

    const slugMatches = workspaces.filter((w) => w.slug === input);
    if (slugMatches.length === 1) {
        return { kind: 'match', workspace: slugMatches[0] };
    }
    if (slugMatches.length > 1) {
        return { kind: 'ambiguous', input, candidates: slugMatches };
    }

    const nameMatches = workspaces.filter((w) => w.name === input);
    const orgWorkspaces = workspaces.filter((w) => (w.org_name || w.tenant_name) === input);

    if (nameMatches.length === 0) {
        if (orgWorkspaces.length > 0) {
            return { kind: 'org-only', input, orgWorkspaces };
        }
        return { kind: 'not-found', input };
    }

    if (nameMatches.length > 1) {
        return { kind: 'ambiguous', input, candidates: nameMatches };
    }

    const soleMatch = nameMatches[0];
    const otherOrgWorkspaces = orgWorkspaces.filter((w) => w.id !== soleMatch.id);
    if (orgWorkspaces.length > 0 && otherOrgWorkspaces.length > 0) {
        // Payload order, not "match first": filter the original array by the
        // candidate id set rather than concatenating soleMatch ahead of the
        // rest, so the ambiguity list reads in the order `workspace list`
        // would show it.
        const candidateIds = new Set([soleMatch.id, ...otherOrgWorkspaces.map((w) => w.id)]);
        const candidates = workspaces.filter((w) => candidateIds.has(w.id));
        return { kind: 'ambiguous', input, candidates };
    }

    return { kind: 'match', workspace: soleMatch };
}

/** One candidate's identifying details, for ambiguity/org-only listings. */
function describeCandidate(ws: WorkspaceLookupRecord): string {
    const orgName = ws.org_name || ws.tenant_name;
    const parts = [ws.name];
    if (orgName) {
        parts.push(`organization: ${orgName}`);
    }
    if (ws.role) {
        parts.push(`role: ${ws.role}`);
    }
    if (ws.slug) {
        parts.push(`slug: ${ws.slug}`);
    }
    parts.push(`id: ${ws.id}`);
    return `  - ${parts.join(', ')}`;
}

/**
 * Pure: build the plain (uncoloured) failure message body for a
 * non-`match` classification. Callers wrap this in `chalk.red` at the call
 * site. `not-found` returns the pre-existing message text so error copy
 * doesn't regress for the common miss case.
 */
export function describeWorkspaceMatchFailure(result: WorkspaceMatchResult): string {
    switch (result.kind) {
        case 'ambiguous': {
            // The org-collision case (input is a name AND an org, e.g. #1196's
            // 10TC/10TC Sales) only has ONE workspace actually named the
            // input — "matches more than one workspace" would be false there.
            // The plain cross-name case (two+ workspaces genuinely sharing a
            // name) keeps that wording because it's true.
            const isAlsoOrgName = result.candidates.some((w) => (w.org_name || w.tenant_name) === result.input);
            const headline = isAlsoOrgName
                ? `"${result.input}" is both an organization name and a workspace name — it could mean any of the following workspaces:`
                : `"${result.input}" is ambiguous — it matches more than one workspace:`;
            const lines = [
                headline,
                ...result.candidates.map(describeCandidate),
                'Re-run with the workspace\'s slug or ID instead.',
            ];
            return lines.join('\n');
        }
        case 'org-only': {
            const lines = [
                `"${result.input}" is an organization, not a workspace.`,
                'Its workspaces:',
                ...result.orgWorkspaces.map(describeCandidate),
                'Pick one by name, slug or ID.',
            ];
            return lines.join('\n');
        }
        case 'not-found':
            return `Workspace "${result.input}" not found. Run \`solidactions workspace list\` to list available workspaces.`;
        case 'match':
            return '';
    }
}

export interface WorkspaceOrgGroup {
    /**
     * Org display name, qualified with the tenant slug (or tenant id) when
     * another org shares the name. Undefined when the payload carries no org
     * identity at all, in which case the caller should render no header.
     */
    header?: string;
    workspaces: WorkspaceLookupRecord[];
}

/**
 * Pure: group workspaces by tenant for display, preserving payload order.
 *
 * Two different orgs may share a display name (a consultant's employer and
 * their client both called "Acme"), so groups are keyed by tenant id and only
 * the colliding names get a qualifier — the one thing that tells the two apart.
 */
export function groupWorkspacesByOrg(workspaces: WorkspaceLookupRecord[]): WorkspaceOrgGroup[] {
    const groups = new Map<string, { name?: string; qualifier?: string; workspaces: WorkspaceLookupRecord[] }>();

    for (const ws of workspaces) {
        const name = ws.org_name || ws.tenant_name || undefined;
        const key = ws.tenant_id || name || '';
        let group = groups.get(key);
        if (!group) {
            group = { name, qualifier: ws.tenant_slug || ws.tenant_id, workspaces: [] };
            groups.set(key, group);
        }
        group.workspaces.push(ws);
    }

    const nameCounts = new Map<string, number>();
    for (const group of groups.values()) {
        if (group.name) {
            nameCounts.set(group.name, (nameCounts.get(group.name) ?? 0) + 1);
        }
    }

    return [...groups.values()].map((group) => {
        const ambiguous = !!group.name && (nameCounts.get(group.name) ?? 0) > 1;
        return {
            header: group.name && ambiguous && group.qualifier
                ? `${group.name} (${group.qualifier})`
                : group.name,
            workspaces: group.workspaces,
        };
    });
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
    const result = classifyWorkspaceInput(input, workspaces);
    if (result.kind === 'match') {
        return result.workspace;
    }
    if (result.kind === 'ambiguous' || result.kind === 'org-only') {
        console.error(chalk.red(describeWorkspaceMatchFailure(result)));
        process.exit(1);
    }
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
        console.error(chalk.red(describeWorkspaceMatchFailure(result)));
    }
    process.exit(1);
}

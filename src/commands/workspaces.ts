import chalk from 'chalk';
import { authFailedLine, formatApiFailure, requireResolvedConfig } from '../utils/api';
import { writeWorkspaceToFile } from '../utils/config';
import { decideWriteTarget, pathForTarget, ensureGitignoreCovers } from '../utils/config-write-target';
import { fetchWorkspaces, formatWorkspaceWithOrg, groupWorkspacesByOrg, resolveWorkspaceInput, WorkspaceLookupRecord } from '../utils/workspace-lookup';

export async function workspacesList() {
    const resolved = requireResolvedConfig();
    const config = resolved.config;

    // Grouping keys are tenant ids (app#1214), so the org header and the
    // same-name disambiguation both come from per-row tenant data, never
    // from the key.
    let workspaces: WorkspaceLookupRecord[];
    try {
        ({ workspaces } = await fetchWorkspaces(config));
    } catch (error: any) {
        if (error.response?.status === 401) {
            console.error(chalk.red(authFailedLine(config.host)));
        } else if (error.response) {
            console.error(chalk.red(formatApiFailure(error.response.status, error.response.data)));
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }

    console.log(chalk.blue(`\nYour workspaces:\n`));

    if (workspaces.length === 0) {
        console.log(chalk.yellow('No workspaces found.'));
        warnDanglingPin(config.workspace, config.workspaceId, resolved.sources.workspaceId, true);
        return;
    }

    for (const group of groupWorkspacesByOrg(workspaces)) {
        if (group.header) {
            console.log(`  ${chalk.white(group.header)}`);
        }
        for (const ws of group.workspaces) {
            const current = config.workspaceId === ws.id ? chalk.green(' ← current') : '';
            const slug = ws.slug ? `  ${chalk.gray(ws.slug)}` : '';
            console.log(`    ${chalk.white(ws.name)} ${chalk.gray(`(${ws.role})`)}${slug}${current}`);
            console.log(chalk.gray(`      ID: ${ws.id}`));
        }
    }

    // cli#113: a pin the list doesn't contain gets no "← current" — say so instead of looking normal.
    if (config.workspaceId && !workspaces.some((ws) => ws.id === config.workspaceId)) {
        warnDanglingPin(config.workspace, config.workspaceId, resolved.sources.workspaceId, false);
    }
    console.log('');
}

/**
 * Warn about a pinned workspace the server's list does not contain (cli#113).
 * Runs against an empty list too: losing access to every workspace is exactly
 * the lost-access case, so the pin is evaluated rather than skipped. With
 * nothing listed there is nothing to pick from, so the remedy says how to
 * clear or change the pin instead of pointing at the list.
 */
function warnDanglingPin(
    workspace: string | undefined,
    workspaceId: string | undefined,
    workspaceIdSource: unknown,
    emptyList: boolean,
): void {
    if (!workspaceId) return;
    const label = workspace ? `${workspace} (${workspaceId})` : workspaceId;
    const from = workspaceIdSource === 'env'
        ? '$SOLIDACTIONS_WORKSPACE_ID'
        : workspaceIdSource === 'cli'
            ? 'the -w/--workspace-override flag'
            : workspaceIdSource;
    console.log('');
    console.log(chalk.yellow(`warn: the active workspace ${label} (from ${from}) is not in this list — it may belong to another host, or you may no longer have access.`));
    if (workspaceIdSource === 'env') {
        // `workspace set` refuses while $SOLIDACTIONS_WORKSPACE_ID is set, list or no list.
        console.log(chalk.yellow(`Unset $SOLIDACTIONS_WORKSPACE_ID, then select a workspace with \`solidactions workspace set <slug>\`${emptyList ? ' once `workspace list` shows one' : ''}.`));
    } else if (emptyList) {
        // `workspace set` resolves an accessible workspace first, so it cannot
        // clear or change a pin when the list is empty: name the action that
        // applies to where this pin came from instead.
        if (workspaceIdSource === 'cli') {
            console.log(chalk.yellow('Re-run without -w/--workspace-override, then select a workspace with `solidactions workspace set <slug>` once `workspace list` shows one.'));
        } else {
            console.log(chalk.yellow(`Remove the workspace pin (workspaceId and related keys) from ${from}, then select a workspace with \`solidactions workspace set <slug>\` once \`workspace list\` shows one.`));
        }
    } else {
        console.log(chalk.yellow('Pick one from the list with `solidactions workspace set <slug> --local` (or --global).'));
    }
}

interface WorkspaceSetOptions {
    local?: boolean;
    global?: boolean;
    gitignore?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeUuid(input: string): boolean {
    return UUID_RE.test(input);
}

export async function workspaceSet(input: string, options: WorkspaceSetOptions = {}) {
    if (process.env.SOLIDACTIONS_WORKSPACE_ID) {
        console.error(chalk.red(
            'SOLIDACTIONS_WORKSPACE_ID is set in the environment; the change would not take effect. ' +
            'Unset the env var or edit the config file directly.',
        ));
        process.exit(1);
    }

    const config = requireResolvedConfig().config;

    if ((config.scopeMode === 'single' || config.scopeMode === 'subset') && config.scopedWorkspaceIds) {
        // Best-effort pre-check: the scope list holds raw ids, so only an id
        // input can be checked locally; slug/name inputs fall through to the
        // server's authoritative 403 workspace_forbidden (surfaced cleanly).
        const isKnownOutOfScope = config.scopedWorkspaceIds.length > 0
            && !config.scopedWorkspaceIds.includes(input);
        if (isKnownOutOfScope && looksLikeUuid(input)) {
            console.error(chalk.red(
                `This session is scoped to workspace(s) ${config.scopedWorkspaceIds.join(', ')}. `
                + 'Re-run `solidactions login --device` to change scope.',
            ));
            process.exit(1);
        }
    }

    const workspace = await resolveWorkspaceInput(config, input);

    const target = await decideWriteTarget({ local: options.local, global: options.global });
    const targetPath = pathForTarget(target);

    writeWorkspaceToFile(targetPath, workspace.slug ?? workspace.name, workspace.id, workspace.org_name);

    if (target === 'local') {
        await ensureGitignoreCovers(process.cwd(), !!options.gitignore);
    }

    // Lead with org AND slug: "Main" can be three different workspaces (cli#112).
    const label = workspace.slug
        ? `${formatWorkspaceWithOrg(workspace)}, slug ${workspace.slug}`
        : formatWorkspaceWithOrg(workspace);
    console.log(chalk.green(`Workspace set to: ${label} (${workspace.id})`));
    console.log(chalk.gray(`Saved to ${targetPath}`));
}

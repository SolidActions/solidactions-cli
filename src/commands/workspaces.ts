import chalk from 'chalk';
import { requireConfig, requireResolvedConfig } from '../utils/api';
import { writeWorkspaceToFile } from '../utils/config';
import { decideWriteTarget, pathForTarget, ensureGitignoreCovers } from '../utils/config-write-target';
import { fetchWorkspaces, formatWorkspaceWithOrg, groupWorkspacesByOrg, resolveWorkspaceInput, WorkspaceLookupRecord } from '../utils/workspace-lookup';

export async function workspacesList() {
    const config = requireConfig();

    // Grouping keys are tenant ids (app#1214), so the org header and the
    // same-name disambiguation both come from per-row tenant data, never
    // from the key.
    let workspaces: WorkspaceLookupRecord[];
    try {
        ({ workspaces } = await fetchWorkspaces(config));
    } catch (error: any) {
        console.error(chalk.red('Failed to list workspaces:'), error.response?.data?.message || error.message);
        process.exit(1);
    }

    console.log(chalk.blue(`\nYour workspaces:\n`));

    if (workspaces.length === 0) {
        console.log(chalk.yellow('No workspaces found.'));
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
    console.log('');
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

    console.log(chalk.green(`Workspace set to: ${formatWorkspaceWithOrg(workspace)} (${workspace.id})`));
    console.log(chalk.gray(`Saved to ${targetPath}`));
}

import axios from 'axios';
import chalk from 'chalk';
import { requireConfig, requireResolvedConfig } from '../utils/api';
import { writeWorkspaceToFile } from '../utils/config';
import { decideWriteTarget, pathForTarget, ensureGitignoreCovers } from '../utils/config-write-target';
import { resolveWorkspaceInput } from '../utils/workspace-lookup';

export async function workspacesList() {
    const config = requireConfig();

    try {
        const response = await axios.get(`${config.host}/api/v1/workspaces`, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
            },
        });

        // API returns { workspaces: { "Org Name": [{ id, name, role, tenant_name, ... }] } }
        const grouped = response.data.workspaces || response.data.data || response.data;

        let hasWorkspaces = false;
        console.log(chalk.blue(`\nYour workspaces:\n`));

        if (typeof grouped === 'object' && !Array.isArray(grouped)) {
            for (const orgName of Object.keys(grouped)) {
                console.log(`  ${chalk.white(orgName)}`);
                for (const ws of grouped[orgName]) {
                    hasWorkspaces = true;
                    const current = config.workspaceId === ws.id ? chalk.green(' ← current') : '';
                    console.log(`    ${chalk.white(ws.name)} ${chalk.gray(`(${ws.role})`)}${current}`);
                    console.log(chalk.gray(`      ID: ${ws.id}`));
                }
            }
        } else if (Array.isArray(grouped)) {
            for (const ws of grouped) {
                hasWorkspaces = true;
                const current = config.workspaceId === ws.id ? chalk.green(' ← current') : '';
                console.log(`  ${chalk.white(ws.name)} ${chalk.gray(`(${ws.org_name || ''}, ${ws.role})`)}${current}`);
                console.log(chalk.gray(`    ID: ${ws.id}`));
            }
        }

        if (!hasWorkspaces) {
            console.log(chalk.yellow('No workspaces found.'));
            return;
        }
        console.log('');
    } catch (error: any) {
        console.error(chalk.red('Failed to list workspaces:'), error.response?.data?.message || error.message);
        process.exit(1);
    }
}

interface WorkspaceSetOptions {
    local?: boolean;
    global?: boolean;
    gitignore?: boolean;
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

    const workspace = await resolveWorkspaceInput(config, input);

    const target = await decideWriteTarget({ local: options.local, global: options.global });
    const targetPath = pathForTarget(target);

    writeWorkspaceToFile(targetPath, workspace.slug ?? workspace.name, workspace.id);

    if (target === 'local') {
        await ensureGitignoreCovers(process.cwd(), !!options.gitignore);
    }

    console.log(chalk.green(`Workspace set to: ${workspace.name} (${workspace.id})`));
    console.log(chalk.gray(`Saved to ${targetPath}`));
}

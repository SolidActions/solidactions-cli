import axios from 'axios';
import chalk from 'chalk';
import { requireConfig, getApiHeaders } from '../utils/api';
import { saveConfig } from './init';

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

export async function workspaceSet(workspaceId: string) {
    const config = requireConfig();

    // Validate the workspace exists and user has access
    try {
        const response = await axios.get(`${config.host}/api/v1/workspaces`, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
            },
        });

        // Flatten grouped response
        const grouped = response.data.workspaces || response.data.data || response.data;
        let allWorkspaces: any[] = [];
        if (typeof grouped === 'object' && !Array.isArray(grouped)) {
            for (const orgWorkspaces of Object.values(grouped)) {
                allWorkspaces.push(...(orgWorkspaces as any[]));
            }
        } else if (Array.isArray(grouped)) {
            allWorkspaces = grouped;
        }
        const workspace = allWorkspaces.find((w: any) => w.id === workspaceId || w.slug === workspaceId || w.name === workspaceId);

        if (!workspace) {
            console.error(chalk.red(`Workspace "${workspaceId}" not found. Run \`solidactions workspaces\` to list available workspaces.`));
            process.exit(1);
        }

        config.workspaceId = workspace.id;
        saveConfig(config);
        console.log(chalk.green(`Workspace set to: ${workspace.name} (${workspace.id})`));
    } catch (error: any) {
        console.error(chalk.red('Failed to set workspace:'), error.response?.data?.message || error.message);
        process.exit(1);
    }
}

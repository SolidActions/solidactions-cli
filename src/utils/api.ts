import axios from 'axios';
import chalk from 'chalk';
import readline from 'readline';
import { getConfig, saveConfig, Config } from '../commands/init';

/**
 * Get standard API headers including X-Workspace-Id if configured.
 */
export function getApiHeaders(config: Config, contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {
        'Authorization': `Bearer ${config.apiKey}`,
        'Accept': 'application/json',
    };

    if (contentType) {
        headers['Content-Type'] = contentType;
    }

    if (config.workspaceId) {
        headers['X-Workspace-Id'] = config.workspaceId;
    }

    return headers;
}

/**
 * Ensure a workspace is selected. If not configured, fetches workspaces and auto-selects
 * (if only one) or prompts the user to choose.
 *
 * Returns the config with workspaceId set, or exits if no workspaces available.
 */
export async function ensureWorkspaceSelected(config: Config): Promise<Config> {
    if (config.workspaceId) {
        return config;
    }

    // Fetch workspaces from API (this endpoint doesn't require X-Workspace-Id)
    let workspaces: Array<{ id: string; name: string; org_name: string; role: string }>;
    try {
        const response = await axios.get(`${config.host}/api/v1/workspaces`, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
            },
        });

        // API returns { workspaces: { "Org Name": [{ id, name, role, tenant_name, ... }] } }
        // Flatten the grouped structure into a flat array
        const grouped = response.data.workspaces || response.data.teams || response.data.data || response.data;
        if (typeof grouped === 'object' && !Array.isArray(grouped)) {
            workspaces = [];
            for (const orgName of Object.keys(grouped)) {
                for (const ws of grouped[orgName]) {
                    workspaces.push({
                        id: ws.id,
                        name: ws.name,
                        org_name: ws.tenant_name || orgName,
                        role: ws.role,
                    });
                }
            }
        } else {
            workspaces = Array.isArray(grouped) ? grouped : [];
        }
    } catch (error: any) {
        if (error.response?.status === 401) {
            console.error(chalk.red('Authentication failed. Run `solidactions init <api-key>` to reconfigure.'));
        } else {
            console.error(chalk.red('Failed to fetch workspaces:'), error.response?.data?.message || error.message);
        }
        process.exit(1);
    }

    if (workspaces.length === 0) {
        console.error(chalk.red('No workspaces found. Create a workspace at your SolidActions dashboard first.'));
        process.exit(1);
    }

    let selected: typeof workspaces[0];

    if (workspaces.length === 1) {
        selected = workspaces[0];
        console.log(chalk.gray(`Auto-selected workspace: ${selected.name}`));
    } else {
        // Prompt user to select
        console.log(chalk.blue('\nSelect a workspace:\n'));
        workspaces.forEach((ws, i) => {
            console.log(`  ${chalk.white(`${i + 1}.`)} ${ws.name} ${chalk.gray(`(${ws.org_name}, ${ws.role})`)}`);
        });
        console.log('');

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
            rl.question(chalk.blue('Enter number: '), resolve);
        });
        rl.close();

        const index = parseInt(answer, 10) - 1;
        if (isNaN(index) || index < 0 || index >= workspaces.length) {
            console.error(chalk.red('Invalid selection.'));
            process.exit(1);
        }
        selected = workspaces[index];
    }

    // Save workspace selection to config
    config.workspaceId = selected.id;
    saveConfig(config);
    console.log(chalk.green(`Workspace set: ${selected.name}`));

    return config;
}

/**
 * Get config and ensure it's initialized. Exits if not.
 */
export function requireConfig(): Config {
    const config = getConfig();
    if (!config?.apiKey) {
        console.error(chalk.red('Not initialized. Run `solidactions init <api-key>` first.'));
        process.exit(1);
    }
    return config;
}

/**
 * Get config with workspace selected. Use this for any command that needs workspace context.
 */
export async function requireConfigWithWorkspace(): Promise<Config> {
    const config = requireConfig();
    return ensureWorkspaceSelected(config);
}


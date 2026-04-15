import axios from 'axios';
import chalk from 'chalk';
import readline from 'readline';
import { saveConfig } from '../commands/init';
import { Config, ResolvedConfig, resolveConfig } from './config';

export function getApiHeaders(config: Config, contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {
        'Authorization': `Bearer ${config.apiKey}`,
        'Accept': 'application/json',
    };
    if (contentType) headers['Content-Type'] = contentType;
    if (config.workspaceId) headers['X-Workspace-Id'] = config.workspaceId;
    return headers;
}

/**
 * Get the full resolution (config + sources + activePath). Exits if nothing resolvable.
 */
export function requireResolvedConfig(): ResolvedConfig {
    const resolved = resolveConfig();
    if (!resolved || !resolved.config.apiKey) {
        console.error(chalk.red('Not initialized. Run `solidactions init <api-key>` first.'));
        process.exit(1);
    }
    return resolved;
}

export function requireConfig(): Config {
    return requireResolvedConfig().config;
}

export async function ensureWorkspaceSelected(config: Config): Promise<Config> {
    if (config.workspaceId) {
        return config;
    }

    // Re-resolve so we know whether a save would be redundant (env-provided) or meaningful (file-backed).
    const resolved = resolveConfig();
    const workspaceSource = resolved?.sources.workspaceId ?? null;

    let workspaces: Array<{ id: string; name: string; org_name: string; role: string }>;
    try {
        const response = await axios.get(`${config.host}/api/v1/workspaces`, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
            },
        });
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

    config.workspaceId = selected.id;

    if (workspaceSource !== 'env') {
        saveConfig(config);
    }
    console.log(chalk.green(`Workspace set: ${selected.name}`));

    return config;
}

export async function requireConfigWithWorkspace(): Promise<Config> {
    const config = requireConfig();
    return ensureWorkspaceSelected(config);
}

import chalk from 'chalk';
import { ensureWorkspaceSelected } from '../utils/api';
import { workspaceSet } from './workspaces';
import {
    Config,
    resolveConfig,
    readConfigFile,
    writeConfigFile,
    removeConfigFile,
    getGlobalConfigPath,
} from '../utils/config';

export type { Config };

export function getConfig(): Config | null {
    const resolved = resolveConfig();
    return resolved ? resolved.config : null;
}

export function saveConfig(config: Config): void {
    const resolved = resolveConfig();
    const targetPath = resolved ? resolved.activePath : getGlobalConfigPath();
    writeConfigFile(targetPath, config);
}

export function clearConfig(): void {
    removeConfigFile(getGlobalConfigPath());
}

export async function init(apiKey: string, options: { dev?: boolean; host?: string; workspace?: string }) {
    // Determine host
    let host: string;
    if (options.host) {
        host = options.host;
    } else if (options.dev) {
        host = 'http://localhost:8000';
    } else {
        host = 'https://app.solidactions.com';
    }

    // Validate API key format (should be a Sanctum token)
    if (!apiKey || apiKey.trim().length === 0) {
        console.error(chalk.red('Error: API key is required.'));
        console.log(chalk.gray('Generate an API key at: ') + chalk.blue(`${host}/settings/api-keys`));
        process.exit(1);
    }

    console.log(chalk.blue(`Initializing SolidActions CLI...`));
    console.log(chalk.gray(`Host: ${host}`));

    // Save the configuration
    const config: Config = {
        host,
        apiKey: apiKey.trim(),
    };
    saveConfig(config);

    console.log(chalk.green('CLI initialized successfully!'));
    console.log(chalk.gray(`Configuration saved to ${getGlobalConfigPath()}`));
    console.log('');

    // Set workspace — explicit flag or interactive prompt
    try {
        if (options.workspace) {
            await workspaceSet(options.workspace);
        } else {
            await ensureWorkspaceSelected(config);
        }
    } catch {
        console.log(chalk.yellow('Could not set workspace. Run `solidactions workspace set` later.'));
    }

    console.log('');
    console.log(chalk.blue('Quick start:'));
    console.log(chalk.gray('  solidactions project deploy <name>    Deploy current directory'));
    console.log(chalk.gray('  solidactions run start <proj> <wf>    Run a workflow'));
    console.log(chalk.gray('  solidactions run list                 List recent runs'));
}

export async function logout() {
    if (readConfigFile(getGlobalConfigPath())) {
        clearConfig();
        console.log(chalk.green('Logged out successfully.'));
    } else {
        console.log(chalk.gray('Not logged in.'));
    }
}

export async function whoami() {
    const config = getConfig();
    if (!config) {
        console.log(chalk.yellow('Not initialized.'));
        console.log(chalk.gray('Run "solidactions init <api-key>" to configure.'));
        process.exit(1);
    }

    console.log(chalk.blue('Current configuration:'));
    console.log(`  Host: ${config.host}`);
    console.log(`  API Key: ${config.apiKey.substring(0, 8)}...${config.apiKey.slice(-4)}`);
}

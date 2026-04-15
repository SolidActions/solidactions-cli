import readline from 'readline';
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
    getLocalConfigPath,
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

async function promptLocation(): Promise<'local' | 'global'> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
        rl.question(chalk.blue('Save config locally (./.solidactions) or globally (~/.solidactions)? [global] '), resolve);
    });
    rl.close();
    const normalized = answer.trim().toLowerCase();
    if (normalized === 'local' || normalized === 'l') return 'local';
    return 'global';
}

export async function init(
    apiKey: string,
    options: { dev?: boolean; host?: string; workspace?: string; local?: boolean; global?: boolean; gitignore?: boolean },
) {
    let host: string;
    if (options.host) {
        host = options.host;
    } else if (options.dev) {
        host = 'http://localhost:8000';
    } else {
        host = 'https://app.solidactions.com';
    }

    if (!apiKey || apiKey.trim().length === 0) {
        console.error(chalk.red('Error: API key is required.'));
        console.log(chalk.gray('Generate an API key at: ') + chalk.blue(`${host}/settings/api-keys`));
        process.exit(1);
    }

    // Determine target location.
    let target: 'local' | 'global';
    if (options.local && options.global) {
        console.error(chalk.red('Error: --local and --global are mutually exclusive.'));
        process.exit(1);
    } else if (options.local) {
        target = 'local';
    } else if (options.global) {
        target = 'global';
    } else if (process.stdin.isTTY) {
        target = await promptLocation();
    } else {
        console.error(chalk.red('Refusing to init non-interactively. Pass --local or --global.'));
        process.exit(1);
    }

    const targetPath = target === 'local' ? getLocalConfigPath() : getGlobalConfigPath();

    console.log(chalk.blue(`Initializing SolidActions CLI...`));
    console.log(chalk.gray(`Host: ${host}`));

    if (readConfigFile(targetPath)) {
        console.log(chalk.yellow(`Existing config at ${targetPath} will be overwritten.`));
    }

    const config: Config = {
        host,
        apiKey: apiKey.trim(),
    };
    writeConfigFile(targetPath, config);

    // TODO(chunk-d): call ensureGitignoreCovers here when target === 'local'

    console.log(chalk.green('CLI initialized successfully!'));
    console.log(chalk.gray(`Configuration saved to ${targetPath}`));
    console.log('');

    // Workspace selection — ensureWorkspaceSelected writes to the right file via the resolver.
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

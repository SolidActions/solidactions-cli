import chalk from 'chalk';
import { ensureWorkspaceSelected } from '../utils/api';
import { workspaceSet } from './workspaces';
import {
    Config,
    ConfigSource,
    resolveConfig,
    readConfigFile,
    writeConfigFile,
    removeConfigFile,
    findLocalConfigPath,
    getGlobalConfigPath,
} from '../utils/config';
import { decideWriteTarget, pathForTarget, ensureGitignoreCovers } from '../utils/config-write-target';

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


export async function login(
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
    const target = await decideWriteTarget({ local: options.local, global: options.global });
    const targetPath = pathForTarget(target);

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

    if (target === 'local') {
        await ensureGitignoreCovers(process.cwd(), !!options.gitignore);
    }

    console.log(chalk.green('Logged in successfully!'));
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
    console.log(chalk.blue('Next step — scaffold a new project (includes AI tooling):'));
    console.log(chalk.gray('  solidactions init <project-name>      Creates ./<project-name>/ with scaffold + AI skills'));
    console.log(chalk.gray('  solidactions init                     Scaffolds in the current (empty) directory'));
    console.log('');
    console.log(chalk.blue('Quick start:'));
    console.log(chalk.gray('  solidactions project deploy <name>    Deploy current directory'));
    console.log(chalk.gray('  solidactions run start <proj> <wf>    Run a workflow'));
    console.log(chalk.gray('  solidactions run list                 List recent runs'));
}

export function logout(options: { local?: boolean; global?: boolean } = {}) {
    if (options.local && options.global) {
        console.error(chalk.red('Error: --local and --global are mutually exclusive.'));
        process.exit(1);
    }

    const globalPath = getGlobalConfigPath();
    const localPath = findLocalConfigPath(process.cwd());

    let targetPath: string | null;
    if (options.local) {
        targetPath = localPath;
        if (!targetPath) {
            console.error(chalk.red(`No local config found in ${process.cwd()} or any parent directory.`));
            process.exit(1);
        }
    } else if (options.global) {
        targetPath = globalPath;
    } else {
        targetPath = localPath ?? globalPath;
    }

    const removed = removeConfigFile(targetPath);
    if (removed) {
        console.log(chalk.green(`Logged out. Removed ${targetPath}`));
    } else {
        console.log(chalk.gray(`Not logged in (no config at ${targetPath}).`));
    }
}

export function whoami() {
    const resolved = resolveConfig();
    if (!resolved || !resolved.config.apiKey) {
        console.log(chalk.yellow('Not initialized.'));
        console.log(chalk.gray('Run "solidactions login <api-key>" to configure.'));
        process.exit(1);
    }

    const { config, sources } = resolved;
    const maskedKey = config.apiKey.length > 12
        ? `${config.apiKey.substring(0, 8)}...${config.apiKey.slice(-4)}`
        : config.apiKey;

    const fmt = (src: ConfigSource): string => {
        if (src === 'env') return chalk.gray('(from $SOLIDACTIONS_* env var)');
        if (src === 'cli') return chalk.gray('(from -w flag)');
        if (src === null) return chalk.gray('(unset)');
        return chalk.gray(`(from ${src})`);
    };

    const workspaceLabel = config.workspace
        ? `${config.workspace}${config.workspaceId ? ` (${config.workspaceId})` : ''}`
        : config.workspaceId
            ? `${config.workspaceId} (slug unknown — run 'workspace set <slug>' to populate)`
            : '';

    console.log(chalk.blue('Current configuration:'));
    console.log(`  Host:        ${config.host.padEnd(50)} ${fmt(sources.host)}`);
    console.log(`  API Key:     ${maskedKey.padEnd(50)} ${fmt(sources.apiKey)}`);
    console.log(`  Workspace:   ${workspaceLabel.padEnd(50)} ${fmt(sources.workspaceId)}`);
}

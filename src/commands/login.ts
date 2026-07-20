import fs from 'fs';
import readline from 'readline';
import chalk from 'chalk';
import prompts from 'prompts';
import {
    Config,
    ConfigSource,
    resolveConfig,
    writeConfigFile,
    removeConfigFile,
    findLocalConfigPath,
    getGlobalConfigPath,
} from '../utils/config';
import { decideWriteTarget, pathForTarget, ensureGitignoreCovers, confirmOverwrite } from '../utils/config-write-target';
import { fetchWorkspaces, matchWorkspace, WorkspaceLookupRecord, WorkspaceScope } from '../utils/workspace-lookup';

export type { Config };

export const API_KEY_PROMPT = {
    type: 'password' as const,
    name: 'apiKey' as const,
    message: 'SolidActions API key',
};

interface LoginSecretOptions {
    stdin?: boolean;
}

interface LoginSecretDependencies {
    input?: NodeJS.ReadableStream;
    isTTY?: boolean;
    prompt?: () => Promise<string | undefined>;
}

async function readAll(input: NodeJS.ReadableStream): Promise<string> {
    let value = '';
    for await (const chunk of input) {
        value += chunk.toString();
    }
    return value;
}

/**
 * Resolve a login secret without requiring it in argv. The positional key is
 * retained for backwards compatibility, while new interactive documentation
 * uses the masked prompt and automation can opt into stdin explicitly.
 */
export async function resolveLoginApiKey(
    apiKey: string | undefined,
    options: LoginSecretOptions = {},
    dependencies: LoginSecretDependencies = {},
): Promise<string> {
    if (apiKey && options.stdin) {
        throw new Error('Pass the API key either as the legacy positional argument or via --stdin, not both.');
    }

    let resolved = apiKey;

    if (options.stdin) {
        resolved = await readAll(dependencies.input ?? process.stdin);
    } else if (!resolved) {
        const isTTY = dependencies.isTTY ?? process.stdin.isTTY === true;
        if (!isTTY) {
            throw new Error(
                'API key is required in non-interactive mode. Pipe it with --stdin, ' +
                'or set SOLIDACTIONS_API_KEY without running login.',
            );
        }

        const prompt = dependencies.prompt ?? (async () => {
            const response = await prompts(API_KEY_PROMPT);
            return response.apiKey as string | undefined;
        });
        resolved = await prompt();

        if (resolved === undefined) {
            throw new Error('Login cancelled.');
        }
    }

    const trimmed = resolved?.trim();
    if (!trimmed) {
        throw new Error('API key is required.');
    }

    return trimmed;
}

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


export function resolveLoginHost(options: { dev?: boolean; host?: string }): { host: string; isDefault: boolean } {
    if (options.host) {
        return { host: options.host, isDefault: false };
    }
    if (options.dev) {
        return { host: 'http://localhost:8000', isDefault: false };
    }
    return { host: 'https://app.solidactions.com', isDefault: true };
}

/**
 * Path for a timestamped backup of `targetPath`, e.g.
 * `config.json.bak-2026-07-05T12-30-00Z`. Pure — takes `now` so tests are
 * deterministic.
 */
export function backupPathFor(targetPath: string, now: Date = new Date()): string {
    const timestamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
    return `${targetPath}.bak-${timestamp}`;
}

const LOGIN_REFUSAL_MESSAGE =
    'Refusing to write config non-interactively. Pass --global to update the machine-wide config ' +
    'at ~/.solidactions/config.json (a backup is kept if one exists), or --local to write ' +
    './.solidactions/config.json for just this directory.';

export function loginHostLines(resolved: { host: string; isDefault: boolean }): string[] {
    if (resolved.isDefault) {
        return [
            `Logging into ${resolved.host} (SolidActions Cloud)`,
            '  Self-hosted or local dev? Pass --host <url> (or --dev for http://localhost:8000)',
        ];
    }
    return [`Host: ${resolved.host}`];
}

/**
 * Prompt the user to pick a workspace from an already-fetched list. Auto-
 * selects when there's exactly one. Returns undefined if none exist.
 */
async function selectWorkspaceInteractively(
    workspaces: WorkspaceLookupRecord[],
): Promise<WorkspaceLookupRecord | undefined> {
    if (workspaces.length === 0) {
        console.log(chalk.yellow('No workspaces found. Create one at your SolidActions dashboard, then run `solidactions workspace set <name>`.'));
        return undefined;
    }
    if (workspaces.length === 1) {
        console.log(chalk.gray(`Auto-selected workspace: ${workspaces[0].name}`));
        return workspaces[0];
    }

    console.log(chalk.blue('\nSelect your default workspace (change anytime with `solidactions workspace set`):\n'));
    workspaces.forEach((ws, i) => {
        console.log(`  ${chalk.white(`${i + 1}.`)} ${ws.name}`);
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
    return workspaces[index];
}

/**
 * Shared tail of `login`, reused verbatim by `deviceLogin`: resolve the
 * workspace against an already-fetched list, determine the write target,
 * back up + write the config file once, and print the success output.
 */
export async function completeLogin(
    config: Config,
    workspaces: WorkspaceLookupRecord[],
    options: { workspace?: string; local?: boolean; global?: boolean; gitignore?: boolean },
    scope: WorkspaceScope | null = null,
): Promise<void> {
    // Device-flow tokens carry a scope (mode + workspace_ids) that later
    // gates `workspace set`; absent for user-scoped Sanctum PATs.
    if (scope) {
        config.scopeMode = scope.mode;
        config.scopedWorkspaceIds = scope.workspace_ids;
    }

    // 2. Resolve the workspace (still before writing).
    if (options.workspace) {
        const match = matchWorkspace(options.workspace, workspaces);
        if (!match) {
            console.error(chalk.red(`Workspace "${options.workspace}" not found. Run \`solidactions workspace list\` to list available workspaces.`));
            process.exit(1);
            return;
        }
        config.workspace = match.slug ?? match.name;
        config.workspaceId = match.id;
    } else if (process.stdin.isTTY) {
        const selected = await selectWorkspaceInteractively(workspaces);
        if (selected) {
            config.workspace = selected.slug ?? selected.name;
            config.workspaceId = selected.id;
        }
    } else {
        console.log(chalk.yellow('No workspace set — run `solidactions workspace set <name>` later.'));
    }

    // 3. Determine target location, back up if needed, and write ONCE.
    const target = await decideWriteTarget({ local: options.local, global: options.global }, undefined, LOGIN_REFUSAL_MESSAGE);
    const targetPath = pathForTarget(target);

    const existingRaw = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf-8') : null;
    const wouldChange = existingRaw !== null && existingRaw.trim() !== JSON.stringify(config, null, 2).trim();

    if (wouldChange) {
        const backupPath = backupPathFor(targetPath);
        const proceed = await confirmOverwrite(targetPath, backupPath);
        if (!proceed) {
            console.log(chalk.yellow('Aborted. No changes were made.'));
            process.exit(0);
        }
        fs.copyFileSync(targetPath, backupPath);
        console.log(chalk.gray(`Backup saved to ${backupPath}`));
    }

    writeConfigFile(targetPath, config);

    if (target === 'local') {
        await ensureGitignoreCovers(process.cwd(), !!options.gitignore);
    }

    console.log(chalk.green('Logged in successfully!'));
    console.log(chalk.gray(`Configuration saved to ${targetPath}`));
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

export async function login(
    apiKey: string,
    options: { dev?: boolean; host?: string; workspace?: string; local?: boolean; global?: boolean; gitignore?: boolean },
) {
    const resolved = resolveLoginHost(options);
    const host = resolved.host;

    if (!apiKey || apiKey.trim().length === 0) {
        console.error(chalk.red('Error: API key is required.'));
        console.log(chalk.gray('Generate an API key at: ') + chalk.blue(`${host}/settings/api-keys`));
        process.exit(1);
    }

    console.log(chalk.blue(`Initializing SolidActions CLI...`));
    for (const line of loginHostLines(resolved)) {
        console.log(resolved.isDefault ? chalk.yellow(line) : chalk.gray(line));
    }

    const config: Config = {
        host,
        apiKey: apiKey.trim(),
    };

    // 1. Validate the key BEFORE any disk write.
    let workspaces: WorkspaceLookupRecord[];
    let scope: WorkspaceScope | null;
    try {
        ({ workspaces, scope } = await fetchWorkspaces(config));
    } catch (e: any) {
        if (e.response?.status === 401) {
            console.error(chalk.red(`Invalid API key for ${host}.`));
        } else {
            console.error(chalk.red(`Could not reach ${host}: ${e.message}`));
        }
        process.exit(1);
        return;
    }

    await completeLogin(config, workspaces, options, scope);
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
        console.log(chalk.gray(`Not logged in (no config at ${targetPath}) — nothing to remove.`));
        process.exit(0);
    }
}

export function whoami() {
    const resolved = resolveConfig();
    if (!resolved || !resolved.config.apiKey) {
        console.log(chalk.yellow('Not initialized.'));
        console.log(chalk.gray('Run "solidactions login --global" to configure.'));
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

    const isFileSource = (src: ConfigSource): boolean => src !== null && src !== 'env' && src !== 'cli';
    const workspaceInheritedFromOtherFile = isFileSource(sources.workspaceId) && sources.workspaceId !== sources.apiKey;

    console.log(chalk.blue('Current configuration:'));
    console.log(`  Host:        ${config.host.padEnd(50)} ${fmt(sources.host)}`);
    console.log(`  API Key:     ${maskedKey.padEnd(50)} ${fmt(sources.apiKey)}`);
    console.log(`  Workspace:   ${workspaceLabel.padEnd(50)} ${fmt(sources.workspaceId)}${workspaceInheritedFromOtherFile ? chalk.yellow(' (inherited from a different config file)') : ''}`);
}

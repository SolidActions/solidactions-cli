import axios from 'axios';
import chalk from 'chalk';
import readline from 'readline';
import { Config, ResolvedConfig, resolveConfig, writeConfigFile, getGlobalConfigPath } from './config';
import { resolveWorkspaceInput } from './workspace-lookup';

// Backend (solidactions-app PR #128) returns: "Project '<slug>' not found in your active workspace '<workspace-slug>'."
// We require the literal single-quotes around the slug so plausible future error messages
// like "Project files not found ..." don't false-match.
const NOT_FOUND_IN_WORKSPACE = /Project '.+' not found in your active workspace/;

/**
 * Inspect an axios error and, if its response message matches the new
 * workspace-not-found 404 from solidactions-app PR #128, append a
 * remediation hint. Exported for unit testing; the live interceptor
 * below calls it.
 */
export function augmentNotFoundMessage(error: any): any {
    const msg = error?.response?.data?.message;
    if (
        typeof msg === 'string'
        && NOT_FOUND_IN_WORKSPACE.test(msg)
        && !msg.includes('Did you mean to switch workspaces?')
    ) {
        const hint = "Did you mean to switch workspaces? Run 'solidactions workspace set <name> --local' to pin this directory.";
        error.response.data.message = `${msg}\n\n${hint}`;
    }
    return error;
}

axios.interceptors.response.use(
    (response) => response,
    (error) => Promise.reject(augmentNotFoundMessage(error)),
);

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
 * Best-effort lookup of the environments a project family actually has
 * (e.g. "production, dev"), for a friendlier 404 message. Returns null on
 * any failure — callers should treat that as "no extra detail available."
 */
export async function describeProjectEnvironments(config: Config, projectName: string): Promise<string | null> {
    try {
        const res = await axios.get(`${config.host}/api/v1/projects`, { headers: getApiHeaders(config) });
        const rows = res.data?.data ?? res.data ?? [];
        const hit = rows.find((p: any) => p.name === projectName || p.slug === projectName);
        const envs: string[] | undefined = hit?.environments;
        return envs?.length ? envs.join(', ') : null;
    } catch {
        return null;
    }
}

/**
 * Get the full resolution (config + sources + activePath). Exits if nothing resolvable.
 */
export function requireResolvedConfig(): ResolvedConfig {
    const resolved = resolveConfig();
    if (!resolved || !resolved.config.apiKey) {
        console.error(chalk.red('Not initialized. Run `solidactions login <api-key>` first.'));
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
            console.error(chalk.red('Authentication failed. Run `solidactions login <api-key>` to reconfigure.'));
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
        const targetPath = resolved?.activePath ?? getGlobalConfigPath();
        writeConfigFile(targetPath, config);
    }
    console.log(chalk.green(`Workspace set: ${selected.name}`));

    return config;
}

export async function requireConfigWithWorkspace(): Promise<Config> {
    const resolved = requireResolvedConfig();
    let config = resolved.config;

    // -w override path: source label 'cli' on the workspace field means
    // setCliWorkspaceOverride was called. workspaceId was cleared by resolveConfig
    // because we don't yet know if the input was a slug or UUID. Resolve now.
    if (resolved.sources.workspace === 'cli' && !config.workspaceId) {
        const ws = await resolveWorkspaceInput(config, config.workspace!);
        config = { ...config, workspace: ws.slug ?? ws.name, workspaceId: ws.id };
        return config;
    }

    if (!config.workspaceId && !process.stdin.isTTY) {
        console.error(chalk.red(
            'No workspace set for this config. Run `solidactions workspace set <name-or-id> --local` (or --global).',
        ));
        process.exit(1);
    }

    return ensureWorkspaceSelected(config);
}

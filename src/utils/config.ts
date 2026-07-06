// src/utils/config.ts
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface Config {
    host: string;
    apiKey: string;
    workspace?: string;     // human-readable slug; cosmetic
    workspaceId?: string;   // canonical UUID used in API calls
}

export type ConfigSource = 'env' | string | null;

export interface ResolvedConfig {
    config: Config;
    sources: {
        host: ConfigSource;
        apiKey: ConfigSource;
        workspace: ConfigSource;
        workspaceId: ConfigSource;
    };
    activePath: string; // path write-mutating commands should target
}

const LOCAL_DIR_NAME = '.solidactions';
const LOCAL_FILE_NAME = 'config.json';

let cliWorkspaceOverride: string | undefined = undefined;

/**
 * Set the workspace override from the top-level `-w/--workspace` CLI flag.
 * Module-level state — set once at CLI startup before any subcommand runs.
 * Pass `undefined` to clear (used in tests).
 */
export function setCliWorkspaceOverride(value: string | undefined): void {
    cliWorkspaceOverride = value;
}

export function getGlobalConfigPath(): string {
    return path.join(os.homedir(), '.solidactions', 'config.json');
}

export function getLocalConfigPath(cwd: string = process.cwd()): string {
    return path.join(cwd, LOCAL_DIR_NAME, LOCAL_FILE_NAME);
}

/**
 * Walk up from startDir looking for `.solidactions/config.json`.
 * Stops at filesystem root.
 *
 * Skips both `os.homedir()` (HOME-respecting) and `os.userInfo().homedir`
 * (OS-level real home) so the global config is never matched as a local hit,
 * even when `$HOME` is redirected (test fixtures, sandboxes). In normal runtime
 * the two paths are the same and the Set collapses to one entry.
 *
 * Returns the absolute path of the nearest local config, or null.
 */
export function findLocalConfigPath(startDir: string = process.cwd()): string | null {
    const skip = new Set<string>([os.homedir()]);
    try {
        skip.add(os.userInfo().homedir);
    } catch {
        // os.userInfo() can throw on some platforms (e.g., uid not in /etc/passwd
        // inside containers). Treat it as best-effort — fall back to just os.homedir().
    }
    let dir = path.resolve(startDir);
    while (true) {
        if (!skip.has(dir)) {
            const candidate = path.join(dir, LOCAL_DIR_NAME, LOCAL_FILE_NAME);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return null;
        }
        dir = parent;
    }
}

/**
 * Read a config file. Normalizes the legacy `token` field into `apiKey`.
 * Returns null if the file does not exist or cannot be parsed.
 */
export function readConfigFile(filePath: string): Config | null {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (raw.token && !raw.apiKey) {
            raw.apiKey = raw.token;
        }
        return raw as Config;
    } catch {
        return null;
    }
}

/**
 * Atomic write: writes to `<filePath>.tmp` and renames into place.
 * Creates parent directory with mode 0o700 if missing.
 * File is written with mode 0o600.
 */
export function writeConfigFile(filePath: string, config: Config): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
}

/**
 * Write a workspace pin to the given config file path. Shallow-merges over
 * any existing keys (preserves host/apiKey if already present). Re-uses
 * writeConfigFile's atomic-write + 0o600 mode contract.
 */
export function writeWorkspaceToFile(filePath: string, workspace: string, workspaceId: string): void {
    const existing: Partial<Config> = readConfigFile(filePath) ?? {};
    writeConfigFile(filePath, { ...existing, workspace, workspaceId } as Config);
}

export function removeConfigFile(filePath: string): boolean {
    if (!fs.existsSync(filePath)) {
        return false;
    }
    fs.unlinkSync(filePath);
    return true;
}

function readEnvOverrides(): Partial<Config> {
    const env: Partial<Config> = {};
    if (process.env.SOLIDACTIONS_HOST) env.host = process.env.SOLIDACTIONS_HOST;
    if (process.env.SOLIDACTIONS_API_KEY) env.apiKey = process.env.SOLIDACTIONS_API_KEY;
    if (process.env.SOLIDACTIONS_WORKSPACE_ID) env.workspaceId = process.env.SOLIDACTIONS_WORKSPACE_ID;
    return env;
}

/**
 * Pure merge of three config layers. Picks each Config field from the highest
 * layer that defines it: env > local > global. Returns null only when no source
 * contributes a host or apiKey (i.e. nothing usable).
 *
 * Invariant the caller must uphold: if `local` is non-null, `localPath` must
 * also be non-null. (`local` is the parsed contents of a file at `localPath`;
 * the path is required for source attribution.) `global` may be null even when
 * `globalPath` is provided — `globalPath` is only used as a source label when
 * `global` contributes a value.
 */
export function mergeConfigs(
    env: Partial<Config>,
    local: Partial<Config> | null,
    localPath: string | null,
    global: Partial<Config> | null,
    globalPath: string,
): { config: Config; sources: ResolvedConfig['sources'] } | null {
    const pick = <K extends keyof Config>(
        key: K,
    ): { value: Config[K] | undefined; source: ConfigSource } => {
        if (env[key] !== undefined) return { value: env[key] as Config[K], source: 'env' };
        if (local && local[key] !== undefined) return { value: local[key], source: localPath! };
        if (global && global[key] !== undefined) return { value: global[key], source: globalPath };
        return { value: undefined, source: null };
    };

    const host = pick('host');
    const apiKey = pick('apiKey');

    // A local config that defines its own credentials (host or apiKey) is
    // anchored to a different account/tenant than the global config — its
    // workspace/workspaceId must never fall back to global (F-C3).
    // Pure workspace-pin local files (no host/apiKey of their own) keep
    // inheriting global credentials and so may still inherit the workspace.
    const localDefinesCreds = !!(local && (local.host !== undefined || local.apiKey !== undefined));
    const pickWorkspaceField = <K extends 'workspace' | 'workspaceId'>(
        key: K,
    ): { value: Config[K] | undefined; source: ConfigSource } => {
        if (env[key] !== undefined) return { value: env[key] as Config[K], source: 'env' };
        if (local && local[key] !== undefined) return { value: local[key], source: localPath! };
        if (!localDefinesCreds && global && global[key] !== undefined) return { value: global[key], source: globalPath };
        return { value: undefined, source: null };
    };

    const workspace = pickWorkspaceField('workspace');
    const workspaceId = pickWorkspaceField('workspaceId');

    if (!host.value && !apiKey.value) {
        return null;
    }

    return {
        config: {
            host: (host.value ?? '') as string,
            apiKey: (apiKey.value ?? '') as string,
            workspace: workspace.value as string | undefined,
            workspaceId: workspaceId.value as string | undefined,
        },
        sources: {
            host: host.source,
            apiKey: apiKey.source,
            workspace: workspace.source,
            workspaceId: workspaceId.source,
        },
    };
}

/**
 * Resolve config by merging three layers field-by-field (env > local > global).
 * Returns null only when no source contributes an apiKey AND host (i.e. nothing usable).
 * `activePath` is the file a write-mutating command should target: nearest local if present, else global.
 */
export function resolveConfig(cwd: string = process.cwd()): ResolvedConfig | null {
    const env = readEnvOverrides();
    const localPath = findLocalConfigPath(cwd);
    const local = localPath ? readConfigFile(localPath) : null;
    const globalPath = getGlobalConfigPath();
    const global = readConfigFile(globalPath);

    const merged = mergeConfigs(env, local, localPath, global, globalPath);
    if (!merged) return null;

    if (cliWorkspaceOverride !== undefined) {
        merged.config.workspace = cliWorkspaceOverride;
        merged.config.workspaceId = undefined;
        merged.sources.workspace = 'cli';
        merged.sources.workspaceId = 'cli';
    }

    return {
        config: merged.config,
        sources: merged.sources,
        activePath: localPath ?? globalPath,
    };
}

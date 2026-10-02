// src/utils/config.ts
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface Config {
    host: string;
    apiKey: string;
    workspace?: string;     // human-readable slug; cosmetic
    workspaceId?: string;   // canonical UUID used in API calls
    workspaceOrg?: string;  // organization name for workspaceId; cosmetic, enables org-qualified display offline
    scopeMode?: 'all' | 'subset' | 'single'; // set for device-flow tokens; absent for user-scoped Sanctum PATs
    scopedWorkspaceIds?: string[];           // present when scopeMode is 'subset' or 'single'
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
    credentialConflict?: CredentialConflict;
}

/**
 * A resolved host that the resolved API key does not belong to (cli#124): the host came
 * from a layer ABOVE the layer that supplied the key, and differs from the key's own host.
 */
export interface CredentialConflict {
    host: string;
    hostSource: ConfigSource;
    keyHost: string | undefined;
    keySource: ConfigSource;
    /** Env-key case only: a file host that disagrees with the resolved host. */
    otherHost?: string;
    otherHostSource?: ConfigSource;
}

/** The host an env key goes to when no layer names one (PM ruling 10); the same default `login` uses. */
export const DEFAULT_HOST = 'https://app.solidactions.com';

/** Hosts compare equal ignoring surrounding space, trailing slashes and case. */
export function normalizeHost(host: string): string {
    return host.trim().replace(/\/+$/, '').toLowerCase();
}

function describeSource(source: ConfigSource, envVar: string): string {
    return source === 'env' ? `$${envVar}` : String(source);
}

/** The refusal shown when a key would be sent to a host it was not configured with. Never includes the key. */
export function credentialConflictMessage(conflict: CredentialConflict): string {
    if (conflict.keySource === 'env') {
        // An env key with no SOLIDACTIONS_HOST may only go to the global config's host or the
        // default host — never to a host a folder's config names (PM rulings 1 and 10).
        const globalNote = conflict.otherHost !== undefined
            ? ` (the global config names ${conflict.otherHost})`
            : '';
        return [
            `Refusing to send the API key from $SOLIDACTIONS_API_KEY to ${conflict.host} (host from ${describeSource(conflict.hostSource, 'SOLIDACTIONS_HOST')}): without SOLIDACTIONS_HOST, a key from the environment only goes to the host in the global config or the default host ${DEFAULT_HOST}${globalNote}.`,
            'Fix: set SOLIDACTIONS_HOST to the host that key belongs to.',
        ].join('\n');
    }
    const hostFrom = describeSource(conflict.hostSource, 'SOLIDACTIONS_HOST');
    const keyFrom = describeSource(conflict.keySource, 'SOLIDACTIONS_API_KEY');
    const keyHome = conflict.keyHost ?? 'no host (that config sets none)';
    const fixes = conflict.hostSource === 'env'
        ? ['unset SOLIDACTIONS_HOST', 'or set SOLIDACTIONS_API_KEY to a key for that host as well']
        : [`run \`solidactions login --local --host ${conflict.host}\` in this folder to store a key for ${conflict.host}`, `or remove "host" from ${hostFrom}`];
    if (conflict.keyHost === undefined) {
        fixes.push(`or add "host" to ${keyFrom}`);
    }
    return [
        `Refusing to send the API key from ${keyFrom} to ${conflict.host} (host from ${hostFrom}): that key is configured for ${keyHome}.`,
        `Fix: ${fixes.join(', ')}.`,
    ].join('\n');
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
export function writeWorkspaceToFile(filePath: string, workspace: string, workspaceId: string, org?: string): void {
    const existing: Partial<Config> = readConfigFile(filePath) ?? {};
    writeConfigFile(filePath, { ...existing, workspace, workspaceId, workspaceOrg: org } as Config);
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
 * Credential-pair rule (cli#124): host and apiKey travel together. A host set in a
 * layer ABOVE the layer that supplied the key must equal the key's own host, or the
 * merge reports a `credentialConflict` and withholds the key (`apiKey: ''`) — a key
 * is only ever sent to the host configured with it. An env key without
 * SOLIDACTIONS_HOST may go only to the global config's host, or to DEFAULT_HOST when
 * no file names a host; it never goes to a folder config's host.
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
): { config: Config; sources: ResolvedConfig['sources']; credentialConflict?: CredentialConflict } | null {
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
    // org must travel with the SAME layer that supplied workspaceId — never picked
    // independently — so a local file pinning workspace A never inherits the global
    // file's org name for a workspace it didn't name (the confusion #1194 fixed).
    const pickWorkspaceField = <K extends 'workspace' | 'workspaceId'>(
        key: K,
    ): { value: Config[K] | undefined; source: ConfigSource; org: string | undefined } => {
        if (env[key] !== undefined) return { value: env[key] as Config[K], source: 'env', org: undefined };
        if (local && local[key] !== undefined) return { value: local[key], source: localPath!, org: local.workspaceOrg };
        if (!localDefinesCreds && global && global[key] !== undefined) return { value: global[key], source: globalPath, org: global.workspaceOrg };
        return { value: undefined, source: null, org: undefined };
    };

    const workspace = pickWorkspaceField('workspace');
    const workspaceId = pickWorkspaceField('workspaceId');

    // Never env-settable — config-file layers only (local > global).
    const scopeMode = pick('scopeMode');
    const scopedWorkspaceIds = pick('scopedWorkspaceIds');

    if (!host.value && !apiKey.value) {
        return null;
    }

    // cli#124: host and apiKey are picked per field above, so a host set in a HIGHER layer
    // than the key's layer would carry that key to a host it was never configured for.
    // The key may only travel with the host of its own layer, or of a layer below it.
    const layers: Array<{ cfg: Partial<Config>; source: ConfigSource }> = [{ cfg: env, source: 'env' }];
    if (local) layers.push({ cfg: local, source: localPath! });
    if (global) layers.push({ cfg: global, source: globalPath });
    const keyIndex = layers.findIndex((l) => l.cfg.apiKey !== undefined);
    const hostIndex = layers.findIndex((l) => l.cfg.host !== undefined);
    let credentialConflict: CredentialConflict | undefined;
    if (keyIndex !== -1 && hostIndex !== -1 && hostIndex < keyIndex) {
        const keyHost = layers.slice(keyIndex).find((l) => l.cfg.host !== undefined)?.cfg.host;
        const resolvedHost = layers[hostIndex].cfg.host as string;
        if (keyHost === undefined || normalizeHost(keyHost) !== normalizeHost(resolvedHost)) {
            credentialConflict = {
                host: resolvedHost,
                hostSource: layers[hostIndex].source,
                keyHost,
                keySource: layers[keyIndex].source,
            };
        }
    }
    // PM rulings 1 and 10 (build card task-buildclitrust-bc78): a key from env with no
    // SOLIDACTIONS_HOST has no host of its own, so the check above never fires for it. It may
    // go only to the GLOBAL config's host or the default host — never to a host a folder's
    // config names (a cloned repo's .solidactions/config.json must not receive an exported
    // key), unless that host is the same as the global one.
    let defaultHost = false;
    if (keyIndex === 0 && env.host === undefined) {
        const localHost = local?.host;
        const globalHost = global?.host;
        if (localHost !== undefined && (globalHost === undefined || normalizeHost(localHost) !== normalizeHost(globalHost))) {
            credentialConflict = {
                host: localHost,
                hostSource: localPath!,
                keyHost: undefined,
                keySource: 'env',
                ...(globalHost !== undefined ? { otherHost: globalHost, otherHostSource: globalPath } : {}),
            };
        } else if (localHost === undefined && globalHost === undefined) {
            defaultHost = true;
        }
    }

    return {
        config: {
            host: (defaultHost ? DEFAULT_HOST : host.value ?? '') as string,
            apiKey: (credentialConflict ? '' : apiKey.value ?? '') as string,
            workspace: workspace.value as string | undefined,
            workspaceId: workspaceId.value as string | undefined,
            workspaceOrg: workspaceId.org,
            scopeMode: scopeMode.value as Config['scopeMode'],
            scopedWorkspaceIds: scopedWorkspaceIds.value as string[] | undefined,
        },
        sources: {
            host: defaultHost ? 'default' : host.source,
            apiKey: apiKey.source,
            workspace: workspace.source,
            workspaceId: workspaceId.source,
        },
        ...(credentialConflict ? { credentialConflict } : {}),
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
        // Org is unknown until resolveWorkspaceInput() re-resolves it for the override
        // (requireConfigWithWorkspace's -w branch sets it there) — a stale file-layer
        // org must not linger and get attributed to whatever workspace -w turns out to be.
        merged.config.workspaceOrg = undefined;
        merged.sources.workspace = 'cli';
        merged.sources.workspaceId = 'cli';
    }

    return {
        config: merged.config,
        sources: merged.sources,
        activePath: localPath ?? globalPath,
        credentialConflict: merged.credentialConflict,
    };
}

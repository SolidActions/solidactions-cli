// src/utils/config.ts
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface Config {
    host: string;
    apiKey: string;
    workspaceId?: string;
}

export type ConfigSource = 'env' | string | null;

export interface ResolvedConfig {
    config: Config;
    sources: {
        host: ConfigSource;
        apiKey: ConfigSource;
        workspaceId: ConfigSource;
    };
    activePath: string; // path write-mutating commands should target
}

const GLOBAL_DIR = path.join(os.homedir(), '.solidactions');
const GLOBAL_FILE = path.join(GLOBAL_DIR, 'config.json');
const LOCAL_DIR_NAME = '.solidactions';
const LOCAL_FILE_NAME = 'config.json';

export function getGlobalConfigPath(): string {
    return GLOBAL_FILE;
}

export function getLocalConfigPath(cwd: string = process.cwd()): string {
    return path.join(cwd, LOCAL_DIR_NAME, LOCAL_FILE_NAME);
}

/**
 * Walk up from startDir looking for `.solidactions/config.json`.
 * Stops at filesystem root. **Skips `$HOME` itself** so the global config
 * at `~/.solidactions/config.json` is never matched as a local hit.
 * Returns the absolute path of the nearest local config, or null.
 */
export function findLocalConfigPath(startDir: string = process.cwd()): string | null {
    const home = os.homedir();
    let dir = path.resolve(startDir);
    while (true) {
        if (dir !== home) {
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

export function removeConfigFile(filePath: string): boolean {
    if (!fs.existsSync(filePath)) {
        return false;
    }
    fs.unlinkSync(filePath);
    return true;
}

import fs from 'fs';
import yaml from 'js-yaml';

/**
 * Parsed variable declaration from YAML.
 * New format examples:
 *   - TEST_ENV_VAR                    -> { key: "TEST_ENV_VAR", mappedTo: null }
 *   - MAPPED_SECRET: JIMBO            -> { key: "MAPPED_SECRET", mappedTo: "JIMBO" }
 *   - DATABASE_URL: DATABASE_URL      -> { key: "DATABASE_URL", mappedTo: "DATABASE_URL" }
 */
export interface ParsedEnvVar {
    key: string;
    mappedTo: string | null;
    oauthName: string | null;
    databaseName: string | null;
}

export interface SolidActionsConfig {
    /** Project name declared at the top of solidactions.yaml (e.g. "sdk-test"). */
    project?: string;
    workflows: { id?: string; name: string; command?: string; file?: string; enabled?: boolean; trigger?: string; webhook?: { auth?: string; method?: string | string[]; mode?: string; timeout?: number } }[];
    env?: (string | { [key: string]: string | { oauth: string } | { database: string } })[];
    deploy?: {
        exclude?: string[];
        gitignore?: boolean;
    };
}

/**
 * Parse a .env file into a key-value map.
 */
export function parseEnvFile(filePath: string): Map<string, string> {
    const envMap = new Map<string, string>();

    if (!fs.existsSync(filePath)) {
        return envMap;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        const equalsIndex = trimmed.indexOf('=');
        if (equalsIndex === -1) {
            continue;
        }

        const key = trimmed.substring(0, equalsIndex).trim();
        let value = trimmed.substring(equalsIndex + 1).trim();

        // Remove surrounding quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        envMap.set(key, value);
    }

    return envMap;
}

/**
 * Parse YAML env declarations into structured format.
 * Handles the new simplified format:
 *   - VAR_NAME                     -> { key: "VAR_NAME", mappedTo: null }
 *   - VAR_NAME: GLOBAL              -> { key: "VAR_NAME", mappedTo: "GLOBAL" }
 *   - VAR_NAME:\n    oauth: "Name"    -> { key: "VAR_NAME", oauthName: "Name" }
 *   - VAR_NAME:\n    database: "Name" -> { key: "VAR_NAME", databaseName: "Name" }
 */
export function parseYamlEnvVars(config: SolidActionsConfig): ParsedEnvVar[] {
    const parsedVars: ParsedEnvVar[] = [];

    if (!config.env || !Array.isArray(config.env)) {
        return parsedVars;
    }

    for (const item of config.env) {
        if (typeof item === 'string') {
            // Simple string: - VAR_NAME (declared only, needs configuration)
            parsedVars.push({ key: item, mappedTo: null, oauthName: null, databaseName: null });
        } else if (typeof item === 'object' && item !== null) {
            // Object: - VAR_NAME: GLOBAL_NAME, - VAR_NAME: { oauth: connection-name },
            // or - VAR_NAME: { database: database-name }
            const keys = Object.keys(item);
            if (keys.length === 1) {
                const key = keys[0];
                const value = item[key];
                if (typeof value === 'object' && value !== null && 'oauth' in value) {
                    if (typeof value.oauth !== 'string' || !value.oauth) {
                        throw new Error(`Invalid env config for ${key}: 'oauth' must be a non-empty string`);
                    }
                    parsedVars.push({ key, mappedTo: null, oauthName: value.oauth, databaseName: null });
                } else if (typeof value === 'object' && value !== null && 'database' in value) {
                    if (typeof value.database !== 'string' || !value.database) {
                        throw new Error(`Invalid env config for ${key}: 'database' must be a non-empty string`);
                    }
                    parsedVars.push({ key, mappedTo: null, oauthName: null, databaseName: value.database });
                } else {
                    parsedVars.push({ key, mappedTo: value || null, oauthName: null, databaseName: null });
                }
            }
        }
    }

    return parsedVars;
}

/**
 * Extract declared variable keys from solidactions.yaml env config.
 * Returns a set of variable keys that are declared in YAML.
 */
export function getYamlDeclaredVars(config: SolidActionsConfig): Set<string> {
    const parsedVars = parseYamlEnvVars(config);
    return new Set(parsedVars.map(v => v.key));
}

/**
 * Load and parse a solidactions.yaml config file.
 */
export function loadSolidActionsConfig(yamlPath: string): SolidActionsConfig {
    const content = fs.readFileSync(yamlPath, 'utf8');
    return yaml.load(content) as SolidActionsConfig;
}

/**
 * Reserved runtime env-name prefix. SOLIDACTIONS_* names are set by the
 * platform at dispatch time (SOLIDACTIONS_API_KEY, SOLIDACTIONS_API_URL, run
 * context); a custom variable with such a name clobbers the platform
 * credential — the field failure mode is a bare 401 out of
 * InvokeSystemDatabase.init before any workflow code runs. Case-sensitive,
 * matching the server-side rule (App\Support\ReservedEnvNames).
 */
export const RESERVED_ENV_PREFIX = 'SOLIDACTIONS_';

/** Case-insensitive: the server rejects any casing of the prefix, not just uppercase. */
export function isReservedEnvName(key: string): boolean {
    return key.toUpperCase().startsWith(RESERVED_ENV_PREFIX);
}

export function reservedEnvNameError(key: string): string {
    const suggestion = key.replace(/^SOLIDACTIONS_/i, 'MY_');
    return `"${key}" uses the reserved ${RESERVED_ENV_PREFIX} prefix. These names are set by the platform at runtime (API credentials, run context) and a custom variable would clobber them, causing authentication failures. Choose a different name (e.g. "${suggestion}").`;
}

/** Env/variable key naming rule: letters, digits, underscore; no leading digit. */
export function isValidEnvName(key: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

export function envNameError(key: string): string {
    if (key.trim() === '') return 'Variable key is required.';
    return `Invalid variable name "${key}" — names must match [A-Za-z_][A-Za-z0-9_]* (letters, digits, underscore; no leading digit).`;
}

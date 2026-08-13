/**
 * solidactions skill dev <dir> [--crew <c>] [--environment <env>] [--env-file <f>] -- <command...>
 *
 * Local analogue of the crews MCP sandbox_exec: runs <command> with cwd=<dir>
 * (matching the sandbox's cwd=/work/skills/<slug>), with crew variables
 * fetched at runtime from /api/v1/crews/{id}/variables/resolve. Secrets are
 * included only when the API key holds env:reveal; skipped names are printed.
 * DELIBERATE DIVERGENCE from remote sandbox_exec: default environment is `dev`
 * (this is a dev tool); remote defaults to production. Always prints the env.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import axios from 'axios';
import chalk from 'chalk';
import yaml from 'js-yaml';
import { Config } from '../utils/config';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { resolveCrewId } from '../utils/crew';

const RESERVED_KEYS = ['WORKFLOW_INPUT', 'WORKFLOW_INPUT_URL', 'STEPS_TRIGGER_ID', 'TENANT_ID', 'SA_PROXY_URL', 'SA_PROXY_TOKEN', 'WORKFLOW_SLUG', 'PATH', 'HOME'];
const RESERVED_PREFIXES = ['SOLIDACTIONS_'];

function isReservedEnvName(name: string): boolean {
    return RESERVED_KEYS.includes(name) || RESERVED_PREFIXES.some((p) => name.toUpperCase().startsWith(p));
}

/**
 * Single-quote a commander-parsed argument for re-injection into a shell
 * command line. commander's `<command...>` variadic already split the
 * user's invocation into discrete argv words (the outer shell did any
 * quote-stripping); joining those words back together with bare spaces and
 * handing them to `sh -c` would let the inner shell reinterpret any
 * metacharacters they contain (spaces, quotes, parens, `&&`, ...). Quoting
 * each word individually keeps it intact as a single shell token, while
 * still letting `shell: true` run multi-word commands.
 */
export function shellQuoteArg(arg: string): string {
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function parseEnvFile(content: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of content.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}

export function assembleEnv(opts: {
    resolved: Record<string, string>;
    fileVars: Record<string, string>;
    storageScope: string | null;
    dir: string;
    config: Config;
}): { env: Record<string, string>; warnings: string[] } {
    const warnings: string[] = [];
    const env: Record<string, string> = {};

    for (const [key, value] of Object.entries(opts.resolved)) {
        // The resolve endpoint owns this database credential manifest. Local
        // execution must pass it through with the mapped JSON values so the
        // SDK can recognize database variables. All other platform-reserved
        // names remain ignored and are re-added by the CLI where applicable.
        if (key !== 'SOLIDACTIONS__DB_KEYS' && isReservedEnvName(key)) {
            warnings.push(`crew variable '${key}' is reserved (set by the platform at runtime) — ignored`);
            continue;
        }
        env[key] = value;
    }

    for (const [key, value] of Object.entries(opts.fileVars)) {
        if (isReservedEnvName(key)) {
            warnings.push(`env-file key '${key}' is reserved (set by the platform at runtime) — ignored`);
            continue;
        }
        if (key in env) {
            warnings.push(`env-file override shadows crew variable: ${key}`);
        }
        env[key] = value;
    }

    if (opts.storageScope === 'crew') {
        env.SOLIDACTIONS_STATE_DIR = path.join(opts.dir, '.sa-state');
    } else if (opts.storageScope === 'workspace') {
        env.SOLIDACTIONS_SHARED_DIR = path.join(os.homedir(), '.solidactions', 'shared', opts.config.workspaceId ?? 'default');
    }

    env.SOLIDACTIONS_API_URL = `${opts.config.host}/api/v1`;
    env.SOLIDACTIONS_API_TOKEN = opts.config.apiKey;
    env.SOLIDACTIONS_WORKSPACE_ID = opts.config.workspaceId ?? '';

    return { env, warnings };
}

function readStorageScope(dir: string): string | null {
    const skillMd = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(skillMd)) return null;
    const content = fs.readFileSync(skillMd, 'utf8');
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;
    const fm = yaml.load(match[1]) as Record<string, any> | null;
    const scope = fm?.storage?.scope ?? fm?.['storage.scope'] ?? null;
    return scope === 'crew' || scope === 'workspace' ? scope : null;
}

export interface ExecLocallyArgs {
    dir: string;
    commandParts: string[];
    environment: string;
    resolved: Record<string, string>;
    skippedSecrets: string[];
    envFile?: string;
    config: Config;
    banner: string;
}

/**
 * Shared local runner: env assembly + provenance banner + spawn. Used by both
 * `skill dev` (working copy) and `skill exec --target host` (cached artifact).
 */
export function execLocally(args: ExecLocallyArgs): never {
    const fileVars = args.envFile ? parseEnvFile(fs.readFileSync(path.resolve(args.envFile), 'utf8')) : {};
    const storageScope = readStorageScope(args.dir);
    const { env, warnings } = assembleEnv({
        resolved: args.resolved, fileVars, storageScope, dir: args.dir, config: args.config,
    });

    for (const w of warnings) process.stderr.write(chalk.yellow(`warn: ${w}\n`));
    if (env.SOLIDACTIONS_STATE_DIR) fs.mkdirSync(env.SOLIDACTIONS_STATE_DIR, { recursive: true });
    if (env.SOLIDACTIONS_SHARED_DIR) fs.mkdirSync(env.SOLIDACTIONS_SHARED_DIR, { recursive: true });

    process.stderr.write(chalk.blue(`${args.banner}\n`));
    if (args.skippedSecrets.length > 0) {
        process.stderr.write(chalk.yellow(
            `${args.skippedSecrets.length} secret ${args.skippedSecrets.length === 1 ? 'var' : 'vars'} unavailable (${args.skippedSecrets.join(', ')}): ` +
            `your API key lacks the 'env:reveal' ability. Mint a key with env:reveal, set a dev value with \`solidactions crew env set\`, or use --env-file.\n`,
        ));
    }

    const result = spawnSync(args.commandParts.map(shellQuoteArg).join(' '), {
        shell: true,
        cwd: args.dir,
        stdio: 'inherit',
        env: { ...process.env, ...env },
    });
    process.exit(result.status ?? 1);
}

export interface SkillRunOptions {
    crew?: string;
    environment?: string;
    envFile?: string;
}

export async function skillRunWithConfig(
    dir: string,
    commandParts: string[],
    options: SkillRunOptions,
    config: Config,
): Promise<void> {
    const absDir = path.resolve(dir);
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
        process.stderr.write(chalk.red(`error: '${dir}' is not a directory — skill dev runs a local working folder. To execute the stored skill locally: skill exec ${dir} --target host\n`));
        process.exit(1);
    }
    if (!fs.existsSync(path.join(absDir, 'SKILL.md'))) {
        process.stderr.write(chalk.red(`error: ${dir} does not contain a SKILL.md\n`));
        process.exit(1);
    }
    if (commandParts.length === 0) {
        process.stderr.write(chalk.red('error: no command given — usage: skill dev <dir> -- <command...>\n'));
        process.exit(1);
    }

    const environment = options.environment ?? 'dev';

    // Crew vars: --crew wins; else no crew vars (shared-skill parity).
    let resolved: Record<string, string> = {};
    let skippedSecrets: string[] = [];
    if (options.crew) {
        const crew = await resolveCrewId(config, options.crew);
        try {
            const response = await axios.get(
                `${config.host}/api/v1/crews/${crew.id}/variables/resolve?environment=${encodeURIComponent(environment)}`,
                { headers: getApiHeaders(config) },
            );
            resolved = response.data?.variables ?? {};
            skippedSecrets = response.data?.skipped_secrets ?? [];
        } catch (e: any) {
            process.stderr.write(chalk.red(`error: failed to resolve crew variables: ${e?.response?.data?.message ?? e.message}\n`));
            process.exit(1);
        }
    } else {
        process.stderr.write(chalk.gray('no --crew given — running without crew variables (shared-skill parity)\n'));
    }

    const plainCount = Object.keys(resolved).length;
    execLocally({
        dir: absDir,
        commandParts,
        environment,
        resolved,
        skippedSecrets,
        envFile: options.envFile,
        config,
        banner: `▶ working copy ${dir} → local (${environment}) — ${plainCount} crew vars`,
    });
}

export async function skillRun(dir: string, commandParts: string[], options: SkillRunOptions): Promise<void> {
    const config = await requireConfigWithWorkspace();
    await skillRunWithConfig(dir, commandParts, options, config);
}

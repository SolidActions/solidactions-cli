/**
 * solidactions skill pull <name> [dest]
 *
 * Fetches a skill from the crews library and reconstructs a local skill folder
 * (the inverse of `skill push`): writes <dest>/SKILL.md + any bundled reference
 * files under <dest>/. Default dest = ./<name>/. Shared-library skills by
 * default; --role [--in-crew] pulls a role-scoped skill.
 *
 * The destination is replaced as a unit (writeDirAtomic): after a pull it holds
 * exactly the fetched files — old complete copy or new complete copy, never a
 * mix, and no stale files.
 *
 * --json mode: prints the raw read result from the server and exits WITHOUT
 * writing any files. This is useful for scripting/inspection. The default
 * (no --json) writes the folder.
 */

import path from 'path';
import chalk from 'chalk';
import { Config } from '../utils/config';
import { requireConfigWithWorkspace } from '../utils/api';
import { callCrewsTool } from '../utils/mcp';
import { reconstructSkillMd, fetchBinaryReference } from '../utils/skill-bundle';
import { writeDirAtomic, assertReplaceableDir } from '../utils/atomic-dir';

export interface SkillPullOptions {
    json?: boolean;
    role?: string;
    inCrew?: string;
}

/** Filename of the provenance sidecar written alongside a pulled skill. */
export const SKILL_SIDECAR = '.solidactions-skill.json';

/** A user-facing pull failure (message is printed as-is after `error: `). */
class SkillPullError extends Error {}

type ReadOpts = { role?: string; inCrew?: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Same rule as writeDirAtomic, so unsafe reference keys can be skipped with a warning instead of aborting the pull. */
function isUnsafeKey(key: string): boolean {
    return path.isAbsolute(key) || key.split(/[\\/]/).includes('..');
}

/** Call skills.read (shared) or roles.read_skill (--role) and return the raw payload. */
async function readSkillData(config: Config, name: string, opts: ReadOpts): Promise<any> {
    const isRole = Boolean(opts.role);
    let result: Awaited<ReturnType<typeof callCrewsTool>>;
    try {
        result = isRole
            ? await callCrewsTool(config, 'roles', {
                action: 'read_skill',
                role: opts.role,
                name,
                in_crew: opts.inCrew,
            })
            : await callCrewsTool(config, 'skills', { action: 'read', identifier: name });
    } catch (e: any) {
        throw new SkillPullError(e.message);
    }

    if (!result.ok) {
        const code = result.data?.code ?? 'unknown_error';
        const message = result.data?.message ?? 'MCP returned an error with no message';
        if (!isRole && code === 'skill_not_found') {
            throw new SkillPullError(
                `${code}: ${message}\n` +
                `'${name}' is not in the shared library; if it belongs to a role, pass --role ROLE [--in-crew CREW]`,
            );
        }
        throw new SkillPullError(`${code}: ${message}`);
    }
    return result.data;
}

/**
 * Read, validate and return the full file map for a skill (SKILL.md, references,
 * provenance sidecar) WITHOUT writing anything. Keys are relative paths.
 * Throws SkillPullError-style Errors on server errors or a malformed response.
 */
export async function fetchSkillFiles(
    config: Config,
    name: string,
    opts: { role?: string; inCrew?: string } = {},
): Promise<Record<string, string | Buffer>> {
    const data = await readSkillData(config, name, opts);
    return buildSkillFiles(config, name, opts, data);
}

async function buildSkillFiles(
    config: Config,
    name: string,
    opts: ReadOpts,
    data: any,
): Promise<Record<string, string | Buffer>> {
    // Shape guard — before anything is written or fetched further.
    if (!isPlainObject(data) || typeof data.body !== 'string' || !isPlainObject(data.properties)) {
        const keys = isPlainObject(data) ? Object.keys(data) : [];
        throw new SkillPullError(`unexpected response shape from server (keys received: ${keys.length ? keys.join(', ') : '(none)'})`);
    }
    if (data.reference !== undefined && data.reference !== null && !isPlainObject(data.reference)) {
        throw new SkillPullError(`unexpected response shape from server: 'reference' is not an object (keys received: ${Object.keys(data).join(', ')})`);
    }

    const isRole = Boolean(opts.role);
    const group = isRole ? 'roles' : 'skills';
    const locator: Record<string, unknown> = isRole
        ? { role: opts.role, name, in_crew: opts.inCrew }
        : { identifier: name };

    const files: Record<string, string | Buffer> = {};

    for (const [key, value] of Object.entries((data.reference ?? {}) as Record<string, unknown>)) {
        if (isUnsafeKey(key)) {
            process.stderr.write(chalk.yellow(`warn: skipping unsafe reference key: ${key}\n`));
            continue;
        }
        if (typeof value === 'string') {
            files[key] = value;
        } else if (isPlainObject(value) && value.binary === true) {
            files[key] = await fetchBinaryReference(config, group, locator, key, {
                size: value.size as number,
                blobSha: value.blob_sha as string,
            });
        } else {
            throw new SkillPullError(`unexpected response shape from server: reference '${key}' is neither text nor a binary descriptor`);
        }
    }

    // Build the frontmatter from `properties`, OMITTING `type` (the server sets it;
    // stripping mirrors parseSkillFile on push so push -> pull -> push is idempotent).
    files['SKILL.md'] = reconstructSkillMd(data.properties, data.body);

    // Provenance sidecar so downstream commands (e.g. `skill push`) can detect drift.
    const sidecar: Record<string, unknown> = {
        identifier: data.identifier,
        doc_id: typeof data.doc_id === 'string' ? parseInt(data.doc_id, 10) : data.doc_id,
        head_revision_id: typeof data.head_revision_id === 'string' ? parseInt(data.head_revision_id, 10) : (data.head_revision_id ?? null),
        role: opts.role ?? null,
    };
    if (isRole) sidecar.in_crew = opts.inCrew ?? null;
    files[SKILL_SIDECAR] = JSON.stringify(sidecar, null, 2) + '\n';

    return files;
}

/** Fetch a skill and replace `dest` with it as a unit. Throws on failure; nothing is written on error. */
export async function pullSkillWithConfig(
    name: string,
    dest: string,
    config: Config,
    opts: { role?: string; inCrew?: string } = {},
): Promise<void> {
    assertReplaceableDir(dest, SKILL_SIDECAR);
    writeDirAtomic(path.resolve(dest), await fetchSkillFiles(config, name, opts));
}

function fail(message: string): never {
    process.stderr.write(chalk.red(`error: ${message}\n`));
    process.exit(1);
}

/**
 * Core CLI implementation — accepts an injected config so tests can point at a
 * stub server without touching the filesystem config.
 */
export async function skillPullWithConfig(
    name: string,
    dest: string | undefined,
    options: SkillPullOptions,
    config: Config,
): Promise<void> {
    if (options.inCrew && !options.role) fail('--in-crew requires --role.');
    if (dest === undefined && (name === '.' || name === '..' || name.includes('/') || name.includes('\\'))) {
        fail(`'${name}' cannot be used as a default destination folder; pass an explicit [dest] directory`);
    }

    const readOpts: ReadOpts = { role: options.role, inCrew: options.inCrew };
    const out = dest ?? './' + name;

    // Replacing a folder is destructive: refuse before any network call or write.
    if (!options.json) {
        try {
            assertReplaceableDir(out, SKILL_SIDECAR);
        } catch (e: any) {
            fail(e.message);
        }
    }

    let data: any;
    try {
        data = await readSkillData(config, name, readOpts);
    } catch (e: any) {
        fail(e.message);
    }

    // --json mode: print raw result and exit WITHOUT writing files.
    if (options.json) {
        console.log(JSON.stringify(data));
        process.exit(0);
    }

    let files: Record<string, string | Buffer>;
    try {
        files = await buildSkillFiles(config, name, readOpts, data);
    } catch (e: any) {
        fail(e.message);
    }

    try {
        writeDirAtomic(path.resolve(out), files);
    } catch (e: any) {
        fail(`failed to write ${out}: ${e.message}`);
    }

    const writtenCount = Object.keys(files).filter((k) => k !== 'SKILL.md' && k !== SKILL_SIDECAR).length;
    const refSummary = writtenCount === 1 ? '1 reference' : `${writtenCount} references`;
    console.log(chalk.green(`pulled skill '${name}' → ${out} (${refSummary})`));
    process.exit(0);
}

/**
 * Entry point called from index.ts.
 */
export async function skillPull(
    name: string,
    dest: string | undefined,
    options: SkillPullOptions,
): Promise<void> {
    const config = await requireConfigWithWorkspace();
    await skillPullWithConfig(name, dest, options, config);
}

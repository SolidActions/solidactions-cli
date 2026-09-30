/**
 * solidactions role pull <name> [dir] [--in-crew <crew>] [--no-skills]
 *
 * Fetches a role's PUBLISHED definition from the crews library and reconstructs a
 * local role folder that `role push` accepts as a no-op:
 *
 *   <dir>/SKILL.md                  role frontmatter + body (the format role push reads)
 *   <dir>/.solidactions-role.json   provenance sidecar (name, in_crew, ...); also the
 *                                   marker that lets a later pull replace this folder
 *   <dir>/skills/<skill>/...        each role-scoped skill (unless --no-skills), in the
 *                                   same layout as `skill pull --role`
 *
 * Everything is fetched first and then written with ONE writeDirAtomic, so a failed
 * fetch writes nothing and a successful pull replaces the folder as a unit.
 *
 * Inherited properties are merged by the server (RoleActivator) and are pulled as the
 * effective value: the folder holds what the role resolves to, not only what it sets itself.
 */

import path from 'path';
import yaml from 'js-yaml';
import chalk from 'chalk';
import { Config } from '../utils/config';
import { requireConfigWithWorkspace } from '../utils/api';
import { callCrewsTool } from '../utils/mcp';
import { writeDirAtomic, assertReplaceableDir } from '../utils/atomic-dir';
import { ROLE_FRONTMATTER_PARAMS } from './skill-push';
import { fetchSkillFiles } from './skill-pull';

export interface RolePullOptions {
    /** Crew path containing the role; disambiguates a role name that exists in several crews. */
    inCrew?: string;
    /** Also pull the role-scoped skills into skills/<skill>/. Default true. */
    withSkills?: boolean;
}

/** Filename of the provenance sidecar written into a pulled role folder (and the replace marker). */
export const ROLE_SIDECAR = '.solidactions-role.json';

/** A user-facing pull failure (message is printed as-is after `error: `). */
class RolePullError extends Error {}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A skill name becomes a path segment under skills/, so it must be a single safe segment. */
function assertSafeSegment(skill: unknown): asserts skill is string {
    if (typeof skill !== 'string' || skill === '' || skill === '.' || skill === '..' || /[\\/]/.test(skill)) {
        throw new RolePullError(`server returned an unsafe skill name: ${JSON.stringify(skill)}`);
    }
}

function mapReadError(code: string, message: string, name: string, inCrew?: string): string {
    if (code === 'no_snapshot') {
        return `role ${name} has no published version (no_snapshot); publish it first, or set version_mode: live`;
    }
    if (code === 'role_not_found') {
        return `role '${name}' not found${inCrew ? ` in crew '${inCrew}'` : ''} (role_not_found); check the name, or pass --in-crew CREW to say which crew it lives in`;
    }
    if (code === 'ambiguous_role') {
        return `role '${name}' exists in multiple crews (ambiguous_role); pass --in-crew CREW to choose one`;
    }
    return `${code}: ${message}`;
}

/** Render SKILL.md exactly as `role push` parses it back (body follows the closing --- line verbatim). */
function renderRoleMd(properties: Record<string, unknown>, body: string): string {
    const fm: Record<string, unknown> = { name: properties.name, description: properties.description };
    for (const key of ROLE_FRONTMATTER_PARAMS) {
        if (properties[key] !== undefined && properties[key] !== null) fm[key] = properties[key];
    }
    return `---\n${yaml.dump(fm, { lineWidth: -1 })}---\n${body}`;
}

/**
 * Fetch the role (and, unless withSkills is false, its skills) and replace `dest` with
 * the result as a unit. Throws on any failure, having written nothing.
 */
export async function pullRoleWithConfig(
    name: string,
    dest: string,
    config: Config,
    opts: RolePullOptions = {},
): Promise<void> {
    const inCrew = opts.inCrew;
    const withSkills = opts.withSkills ?? true;

    // Replacing a folder is destructive: refuse before any network call or write.
    assertReplaceableDir(dest, ROLE_SIDECAR);

    const crewArgs: Record<string, unknown> = inCrew ? { in_crew: inCrew } : {};
    const read = await callCrewsTool(config, 'roles', { action: 'read', name, ...crewArgs });
    if (!read.ok) {
        throw new RolePullError(mapReadError(read.data?.code ?? 'unknown_error', read.data?.message ?? 'MCP returned an error with no message', name, inCrew));
    }
    const data = read.data;
    if (!isPlainObject(data) || typeof data.body !== 'string' || !isPlainObject(data.properties)) {
        const keys = isPlainObject(data) ? Object.keys(data) : [];
        throw new RolePullError(`unexpected response shape from server (keys received: ${keys.length ? keys.join(', ') : '(none)'})`);
    }
    const properties = data.properties;
    if (typeof properties.description !== 'string' || properties.description === '') {
        throw new RolePullError(`role '${name}' has no description, so it cannot be written as a pushable SKILL.md`);
    }
    const roleName = typeof properties.name === 'string' && properties.name ? properties.name : name;

    // Values the server redacted are not the real values; pushing them back would corrupt the role.
    const redacted = Array.isArray(data.redacted_keys) ? (data.redacted_keys as unknown[]).filter((k): k is string => typeof k === 'string') : [];
    const usable: Record<string, unknown> = { ...properties, name: roleName };
    for (const key of redacted) {
        if (key in usable && key !== 'name' && key !== 'description') {
            delete usable[key];
            process.stderr.write(chalk.yellow(`warn: property '${key}' is redacted by the server and was not written\n`));
        }
    }

    const files: Record<string, string | Buffer> = {};
    files['SKILL.md'] = renderRoleMd(usable, data.body);

    if (withSkills) {
        const list = await callCrewsTool(config, 'roles', { action: 'list_skills', role: name, ...crewArgs });
        if (!list.ok) {
            throw new RolePullError(mapReadError(list.data?.code ?? 'unknown_error', list.data?.message ?? 'MCP returned an error with no message', name, inCrew));
        }
        const skills: unknown = list.data?.skills;
        if (!Array.isArray(skills)) {
            throw new RolePullError(`unexpected response shape from list_skills (keys received: ${isPlainObject(list.data) ? Object.keys(list.data).join(', ') : '(none)'})`);
        }
        for (const entry of skills) {
            const skillName = isPlainObject(entry) ? (entry.name ?? entry.identifier) : entry;
            assertSafeSegment(skillName);
            const skillFiles = await fetchSkillFiles(config, skillName, { role: name, inCrew });
            for (const [rel, content] of Object.entries(skillFiles)) {
                files[`skills/${skillName}/${rel}`] = content;
            }
        }
    }

    files[ROLE_SIDECAR] = JSON.stringify({
        name: roleName,
        in_crew: inCrew ?? null,
        doc_id: typeof data.doc_id === 'string' ? parseInt(data.doc_id, 10) : (data.doc_id ?? null),
        head_revision_id: typeof data.head_revision_id === 'string' ? parseInt(data.head_revision_id, 10) : (data.head_revision_id ?? null),
        active_snapshot_revision_id: typeof data.active_snapshot_revision_id === 'string'
            ? parseInt(data.active_snapshot_revision_id, 10)
            : (data.active_snapshot_revision_id ?? null),
    }, null, 2) + '\n';

    writeDirAtomic(path.resolve(dest), files);
}

function fail(message: string): never {
    process.stderr.write(chalk.red(`error: ${message}\n`));
    process.exit(1);
}

/** CLI wrapper: validates the destination, runs the pull, prints the result and exits. */
export async function rolePullWithConfig(
    name: string,
    dest: string | undefined,
    options: { inCrew?: string; skills?: boolean },
    config: Config,
): Promise<void> {
    if (dest === undefined && (name === '.' || name === '..' || name.includes('/') || name.includes('\\'))) {
        fail(`'${name}' cannot be used as a default destination folder; pass an explicit [dir] directory`);
    }
    const out = dest ?? './' + name;
    try {
        await pullRoleWithConfig(name, out, config, { inCrew: options.inCrew, withSkills: options.skills !== false });
    } catch (e: any) {
        fail(e.message);
    }
    console.log(chalk.green(`pulled role '${name}' → ${out}`));
    process.exit(0);
}

/**
 * Entry point called from index.ts.
 */
export async function rolePull(
    name: string,
    dest: string | undefined,
    options: { inCrew?: string; skills?: boolean },
): Promise<void> {
    const config = await requireConfigWithWorkspace();
    await rolePullWithConfig(name, dest, options, config);
}

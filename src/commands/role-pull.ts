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
 * The role's skill preload configuration is not a property: the server stores
 * always_load_skills / available_skills as role_skill_links rows and returns them top-level
 * in `read`. They are exported into the always_load_skills / available_skills frontmatter
 * fields (identifiers such as "shared/triage", in the server's order), which role push sends
 * back top-level. Skills that sit in the role's own skills/ folder are auto-discovered by the
 * server and appear in its available_skills index under a bare name; those are not links, so
 * bare names are left out of available_skills (they travel in skills/ instead).
 *
 * Inherited properties and skill links are merged by the server (RoleActivator) and are pulled
 * as the effective value: the folder holds what the role resolves to, not only what it sets
 * itself. A role with inherits_from therefore gets a warning: role push of the folder would
 * store the inherited values on the child.
 */

import path from 'path';
import yaml from 'js-yaml';
import chalk from 'chalk';
import { Config } from '../utils/config';
import { requireConfigWithWorkspace } from '../utils/api';
import { callCrewsTool } from '../utils/mcp';
import { writeDirAtomic, assertReplaceableDir } from '../utils/atomic-dir';
import { ROLE_FRONTMATTER_PARAMS } from './skill-push';
import { fetchSkillFiles, ROLE_SIDECAR } from './skill-pull';

export interface RolePullOptions {
    /** Crew path containing the role; disambiguates a role name that exists in several crews. */
    inCrew?: string;
    /** Also pull the role-scoped skills into skills/<skill>/. Default true. */
    withSkills?: boolean;
}

export { ROLE_SIDECAR };

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

/**
 * Pull the skill identifiers out of a `read` payload's always_load_skills (resolved bundles) or
 * available_skills (description entries): both carry the link's `identifier`, in server order.
 * A missing field means none; a malformed one is an error rather than a silent loss.
 */
function skillIdentifiers(data: Record<string, unknown>, key: 'always_load_skills' | 'available_skills'): string[] {
    const raw = data[key];
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new RolePullError(`unexpected response shape from server: ${key} is not a list`);
    const out: string[] = [];
    for (const entry of raw) {
        const id = isPlainObject(entry) ? entry.identifier : undefined;
        if (typeof id !== 'string' || id === '') {
            throw new RolePullError(`unexpected response shape from server: a ${key} entry has no identifier`);
        }
        if (!out.includes(id)) out.push(id);
    }
    return out;
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
    assertReplaceableDir(dest, ROLE_SIDECAR, undefined, 'role');

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
    // Skill links are top-level in the payload (not properties). available_skills also lists the
    // role's auto-discovered local skills under bare names, which are not links: keep 'x/y' only.
    const alwaysLoadSkills = skillIdentifiers(data, 'always_load_skills');
    const availableSkills = skillIdentifiers(data, 'available_skills').filter((id) => id.includes('/'));
    if (alwaysLoadSkills.length > 0) usable.always_load_skills = alwaysLoadSkills;
    if (availableSkills.length > 0) usable.available_skills = availableSkills;
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

    // Baseline of the link lists exactly as written to the frontmatter (an absent list is []).
    // role push compares against it, so an unchanged list is left out of the edit and the server
    // keeps every link, including ones this caller could not see.
    const linkBaseline = (key: 'always_load_skills' | 'available_skills'): string[] =>
        Array.isArray(usable[key]) ? (usable[key] as string[]) : [];
    files[ROLE_SIDECAR] = JSON.stringify({
        name: roleName,
        in_crew: inCrew ?? null,
        links: {
            always_load_skills: linkBaseline('always_load_skills'),
            available_skills: linkBaseline('available_skills'),
        },
        doc_id: typeof data.doc_id === 'string' ? parseInt(data.doc_id, 10) : (data.doc_id ?? null),
        head_revision_id: typeof data.head_revision_id === 'string' ? parseInt(data.head_revision_id, 10) : (data.head_revision_id ?? null),
        active_snapshot_revision_id: typeof data.active_snapshot_revision_id === 'string'
            ? parseInt(data.active_snapshot_revision_id, 10)
            : (data.active_snapshot_revision_id ?? null),
    }, null, 2) + '\n';

    writeDirAtomic(path.resolve(dest), files);

    // The server has no unmerged read, so `properties` is the effective (parent-merged) value.
    // Pushing it back would store the parent's entries on this role: make that visible.
    const parent = properties.inherits_from;
    if (typeof parent === 'string' && parent !== '') {
        process.stderr.write(chalk.yellow(
            `warn: role ${roleName} inherits from ${parent}; the pulled properties and skill links include inherited values, ` +
            `and pushing this folder back with role push will store them on ${roleName}.\n`,
        ));
    }
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

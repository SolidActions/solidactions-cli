/**
 * solidactions skill push <dir>
 *
 * Pushes a local skill folder into the crews library via the crews MCP server.
 * Idempotent upsert: create, or update on name collision.
 *
 * Supports two modes:
 *   - Single-skill: <dir>/SKILL.md exists → push that one skill.
 *   - Plugin: <dir>/skills/<name>/SKILL.md and/or <dir>/commands/<name>.md → push all.
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import yaml from 'js-yaml';
import { Config } from '../utils/config';
import { requireConfigWithWorkspace } from '../utils/api';
import { callCrewsTool } from '../utils/mcp';
import { publishSkillByName, publishSkillByDocId, emitPublishOutcome, PublishOutcome } from '../utils/skill-snapshot';
import { SKILL_SIDECAR } from './skill-pull';

export interface SkillPushOptions {
    role?: string;
    json?: boolean;
    dryRun?: boolean;
    publish?: boolean;
    force?: boolean;
}

/**
 * Protocol param names reserved by the skills/roles MCP tool actions. Frontmatter
 * keys that collide with these would silently corrupt the request once spread
 * top-level into the call arguments.
 */
export const RESERVED_PARAM_KEYS = ['action', 'identifier', 'role', 'name', 'description', 'body', 'references', 'base_version_id'];

/**
 * Throws if any frontmatter-derived property key collides with a reserved
 * protocol param name.
 */
export function assertNoReservedFrontmatterKeys(properties: Record<string, unknown>): void {
    const offending = Object.keys(properties).filter((key) => RESERVED_PARAM_KEYS.includes(key));
    if (offending.length > 0) {
        throw new Error(`SKILL.md frontmatter contains reserved key(s) that would collide with protocol params: ${offending.join(', ')}`);
    }
}

/**
 * Parse a SKILL.md file that begins with a YAML frontmatter block.
 *
 * Returns { name, description, properties, body } where:
 *   - name and description come from the frontmatter
 *   - properties is the rest of the frontmatter (excluding name and description)
 *   - body is everything after the closing --- delimiter
 *
 * Throws with a descriptive message if the file is malformed or missing
 * required fields.
 */
export function parseSkillFile(content: string): {
    name: string;
    description: string;
    properties: Record<string, unknown>;
    body: string;
} {
    if (!content.startsWith('---')) {
        throw new Error('SKILL.md must begin with a YAML frontmatter block (---).');
    }

    // Find the closing --- delimiter (must be on its own line after the opening ---)
    const afterOpen = content.slice(3);
    const closeIdx = afterOpen.indexOf('\n---');
    if (closeIdx === -1) {
        throw new Error('SKILL.md frontmatter is not closed (missing closing ---).');
    }

    const yamlBlock = afterOpen.slice(0, closeIdx);
    // Body is everything after the closing ---\n
    const body = afterOpen.slice(closeIdx + 4).replace(/^\n/, '');

    let fm: any;
    try {
        fm = yaml.load(yamlBlock);
    } catch (e: any) {
        throw new Error(`Failed to parse SKILL.md frontmatter YAML: ${e.message}`);
    }

    if (!fm || typeof fm !== 'object') {
        throw new Error('SKILL.md frontmatter is empty or not a YAML object.');
    }

    if (!fm.name || typeof fm.name !== 'string') {
        throw new Error('SKILL.md frontmatter must contain a "name" field (string).');
    }

    if (!fm.description || typeof fm.description !== 'string') {
        throw new Error('SKILL.md frontmatter must contain a "description" field (string).');
    }

    const { name, description, ...rest } = fm;

    // Remove 'type' if present — the server sets it
    const { type: _type, ...properties } = rest;

    return { name, description, properties, body };
}

/**
 * Recursively read every bundled file under a skill dir, excluding the
 * top-level SKILL.md. Returns a map of reference-key → utf8 contents.
 *
 * Keys are the file's POSIX path relative to the skill dir: top-level files
 * keep a bare-filename key (e.g. "helper.py"), and files in subfolders keep
 * their relative path (e.g. "references/member-roles.md") — matching how
 * SKILL.md cites them, so bundled reference docs land complete (#247).
 *
 * Also excludes `skill pull`'s provenance sidecar (SKILL_SIDECAR) and
 * `skill run`'s local runtime-state dir (.sa-state/) — neither is skill
 * content, and uploading them would leak local revision bookkeeping / state
 * into the remote library and agent sandboxes.
 */
export function readReferences(dir: string): Record<string, string> {
    const references: Record<string, string> = {};

    const walk = (current: string): void => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const abs = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === '.sa-state') continue; // skill run's local runtime-state dir
                walk(abs);
                continue;
            }
            if (!entry.isFile()) continue;

            // POSIX-normalised path relative to the skill dir, used as the key.
            const key = path.relative(dir, abs).split(path.sep).join('/');
            if (key === 'SKILL.md') continue; // exclude only the top-level skill file
            if (key === SKILL_SIDECAR) continue; // exclude the skill pull provenance sidecar

            references[key] = fs.readFileSync(abs, 'utf8');
        }
    };

    walk(dir);
    return references;
}

export interface SkillPayload {
    name: string;
    description: string;
    properties: Record<string, unknown>;
    body: string;
    references: Record<string, string>;
}

export interface PushResult {
    status: 'created' | 'updated' | 'would-create' | 'would-update';
    name: string;
    data: Record<string, unknown>;
}

/**
 * Read a skill directory: validates the dir exists, reads SKILL.md, parses it,
 * and reads bundled reference files. Returns the full payload for pushParsedSkill.
 *
 * Throws with a descriptive message on any filesystem or parse error.
 */
export function readSkillDir(dir: string): SkillPayload {
    const absDir = path.resolve(dir);

    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
        throw new Error(`"${dir}" is not a directory.`);
    }

    const skillMdPath = path.join(absDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
        throw new Error(`"${skillMdPath}" not found. The skill directory must contain a SKILL.md file.`);
    }

    const skillMdContent = fs.readFileSync(skillMdPath, 'utf8');
    const { name, description, properties, body } = parseSkillFile(skillMdContent);
    const references = readReferences(absDir);

    return { name, description, properties, body, references };
}

/**
 * Parse a commands/<name>.md file (plugin command format).
 *
 * Derives the skill name from the filename (kebab-case: lowercase, spaces and
 * underscores replaced with hyphens). The frontmatter must contain `description`;
 * `name`, `allowed-tools`, and `argument-hint` are not carried forward.
 *
 * Returns a SkillPayload with properties={} and references={}.
 * Throws with a descriptive message if description is missing or frontmatter malformed.
 */
export function parseCommandFile(filename: string, content: string): SkillPayload {
    // Derive name from filename (basename without extension, converted to kebab-case)
    const base = path.basename(filename, '.md');
    const name = base.toLowerCase().replace(/[\s_]+/g, '-');

    if (!content.startsWith('---')) {
        throw new Error(`${filename}: command file must begin with a YAML frontmatter block (---).`);
    }

    const afterOpen = content.slice(3);
    const closeIdx = afterOpen.indexOf('\n---');
    if (closeIdx === -1) {
        throw new Error(`${filename}: command file frontmatter is not closed (missing closing ---).`);
    }

    const yamlBlock = afterOpen.slice(0, closeIdx);
    const body = afterOpen.slice(closeIdx + 4).replace(/^\n/, '');

    let fm: any;
    try {
        fm = yaml.load(yamlBlock);
    } catch (e: any) {
        throw new Error(`${filename}: failed to parse command file frontmatter YAML: ${e.message}`);
    }

    if (!fm || typeof fm !== 'object') {
        throw new Error(`${filename}: command file frontmatter is empty or not a YAML object.`);
    }

    if (!fm.description || typeof fm.description !== 'string') {
        throw new Error(`${filename}: command file frontmatter must contain a "description" field (string).`);
    }

    return {
        name,
        description: fm.description,
        properties: {},
        body,
        references: {},
    };
}

/**
 * Core upsert: try create; on name_collision, switch to edit.
 * Returns a result object — does NOT call process.exit and does NOT print.
 * Throws on non-collision MCP errors.
 *
 * When options.dryRun is true, performs only a skills.read pre-flight and
 * returns {status:'would-create'} or {status:'would-update'} without any
 * create or edit call.
 *
 * sidecarRevision (edit path only): the pulled skill's last-known head_revision_id
 * (from the local .solidactions-skill.json sidecar), sent as base_version_id so the
 * server can detect drift. undefined = no sidecar (nothing to guard); null = sidecar
 * present but never published. Ignored when options.force is set. On a concurrent_edit
 * response, throws a message naming the remote's current_revision_id, the local base,
 * and --force as the override.
 */
export async function pushParsedSkill(
    payload: SkillPayload,
    options: SkillPushOptions,
    config: Config,
    sidecarRevision?: number | null,
): Promise<PushResult> {
    const { name, description, properties, body, references } = payload;
    assertNoReservedFrontmatterKeys(properties);
    const isRole = !!options.role;
    const tool = isRole ? 'roles' : 'skills';

    // --dry-run: pre-flight a read to detect existence; make NO create/edit calls.
    if (options.dryRun) {
        // Role-scoped skills are read via the roles tool's read_skill {role, name};
        // shared skills via the skills tool's read {identifier}. Both return
        // `skill_not_found` when absent. (read does NOT accept `identifier` on the
        // roles tool, so the action/args must branch on isRole.)
        const readArgs: Record<string, unknown> = isRole
            ? { action: 'read_skill', role: options.role, name }
            : { action: 'read', identifier: name };

        let readResult: Awaited<ReturnType<typeof callCrewsTool>>;
        try {
            readResult = await callCrewsTool(config, tool, readArgs);
        } catch (e: any) {
            throw new Error(`${e.message}`);
        }

        if (!readResult.ok) {
            const code = readResult.data?.code;
            if (code === 'skill_not_found') {
                return { status: 'would-create', name, data: {} };
            }
            // Any other error is unexpected — surface it
            const errMsg = readResult.data?.message ?? 'MCP returned an error with no message';
            throw new Error(`${code ?? 'unknown_error'}: ${errMsg}`);
        }

        // Read succeeded → skill exists → would update
        return { status: 'would-update', name, data: {} };
    }

    // Spread frontmatter extras FIRST so the fixed protocol keys always win.
    const createArgs: Record<string, unknown> = isRole
        ? { ...properties, action: 'create_skill', role: options.role, name, description, body, references }
        : { ...properties, action: 'create', name, description, body, references };

    let result: Awaited<ReturnType<typeof callCrewsTool>>;
    try {
        result = await callCrewsTool(config, tool, createArgs);
    } catch (e: any) {
        throw new Error(`${e.message}`);
    }

    // On name collision, switch to the edit path.
    if (!result.ok && result.data?.code === 'name_collision') {
        const guardBaseVersion = sidecarRevision != null && !options.force;
        const editArgs: Record<string, unknown> = isRole
            ? { ...properties, action: 'edit_skill', role: options.role, name, description, body, references, ...(guardBaseVersion ? { base_version_id: sidecarRevision } : {}) }
            : { ...properties, action: 'edit', identifier: name, description, body, references, ...(guardBaseVersion ? { base_version_id: sidecarRevision } : {}) };

        try {
            result = await callCrewsTool(config, tool, editArgs);
        } catch (e: any) {
            throw new Error(`${e.message}`);
        }

        if (!result.ok) {
            const errData = result.data;
            const errCode = errData?.code ?? 'unknown_error';
            if (errCode === 'concurrent_edit') {
                const currentRevisionId = errData?.current_revision_id;
                throw new Error(
                    `remote skill changed since your pull (their revision ${currentRevisionId}, your base ${sidecarRevision}) — re-pull to merge, or pass --force to overwrite`,
                );
            }
            const errMsg = errData?.message ?? 'MCP returned an error with no message';
            throw new Error(`${errCode}: ${errMsg}`);
        }

        return { status: 'updated', name, data: result.data ?? {} };
    }

    if (!result.ok) {
        const errData = result.data;
        const errCode = errData?.code ?? 'unknown_error';
        const errMsg = errData?.message ?? 'MCP returned an error with no message';
        throw new Error(`${errCode}: ${errMsg}`);
    }

    return { status: 'created', name, data: result.data ?? {} };
}

/**
 * Print a single skill push result line (shared between single and plugin modes).
 */
function printPushResult(result: PushResult, options: SkillPushOptions): void {
    if (options.json) {
        console.log(JSON.stringify(result.data));
        return;
    }
    const { status, name, data } = result;
    if (status === 'would-create') {
        console.log(chalk.cyan(`[dry-run] would create '${name}'`));
    } else if (status === 'would-update') {
        console.log(chalk.cyan(`[dry-run] would update '${name}'`));
    } else if (status === 'updated') {
        console.log(chalk.green(`updated skill '${name}' (version ${data.version_id ?? '?'})`));
    } else {
        const skillDocId = data.skill_doc_id ?? data.doc_id ?? data.id ?? '?';
        const refCount = Object.keys((data.reference_doc_ids as Record<string, unknown>) ?? {}).length;
        console.log(chalk.green(`created skill '${name}' (doc ${skillDocId}, ${refCount} refs)`));
    }
}

/**
 * Build the "staged, not published" warning for a successful single-skill push,
 * or null when nothing needs publishing.
 *
 * Edit path (status 'updated'): default reads return the active snapshot, so a
 * new revision is dark to agents until published — warn when the server reports
 * has_unpublished_revisions === true.
 * Create path (status 'created'): a brand-new skill has no snapshot, so reads
 * fall back to the unversioned draft (it runs, just isn't pinned) — warn on a
 * truthy snapshot_hint (null when the skill is version_mode=live).
 * Dry-run statuses never warn.
 */
export function stagedPushWarning(result: PushResult, isRole: boolean): string | null {
    const { status, name, data } = result;
    if (status === 'created') {
        if (!data.snapshot_hint) {
            return null;
        }
    } else if (status === 'updated') {
        if (data.has_unpublished_revisions !== true) {
            return null;
        }
    } else {
        return null;
    }

    const publishLine = isRole
        ? `  Publish this role-scoped skill via the MCP crews_versions take_snapshot tool.\n`
        : `  Run: solidactions skill publish ${name}\n`;
    const headline = status === 'updated'
        ? `⚠ Staged, not published. This revision won't run for agents until you publish it.\n`
        : `⚠ Not yet published. Agents read the unversioned draft until you publish to pin a version.\n`;
    return headline + publishLine;
}

/**
 * Read the local provenance sidecar (written by `skill pull`), if present.
 * Returns null when absent, or unreadable/malformed — nothing to guard against on push.
 */
function readSidecar(dir: string): Record<string, unknown> | null {
    const sidecarPath = path.join(dir, SKILL_SIDECAR);
    if (!fs.existsSync(sidecarPath)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * After a successful guarded edit or a create, refresh the local sidecar's
 * head_revision_id so the *next* push's drift check is against the version we
 * just wrote, not a stale one from the original pull. Prefers the revision id
 * carried on the response; falls back to one skills.read (or roles.read_skill
 * for --role) when the response doesn't carry one.
 *
 * On 'created' specifically, a lookup miss clears head_revision_id to null
 * rather than leaving the sidecar's old value in place: 'created' means the
 * name didn't collide, so this is either a brand-new skill or a remote
 * delete+recreate — either way the old revision id belongs to a different
 * (possibly now-deleted) document, and sending it as base_version_id on a
 * future edit would false-positive the concurrent_edit drift guard.
 *
 * Best-effort otherwise: a failed lookup on the 'updated' path just leaves
 * the sidecar as-is rather than failing the push (which already succeeded).
 */
async function refreshSidecarRevision(
    dir: string,
    sidecar: Record<string, unknown>,
    pushResult: PushResult,
    options: SkillPushOptions,
    config: Config,
): Promise<void> {
    const fromResponse = pushResult.data.head_revision_id ?? pushResult.data.version_id;
    let headRevisionId: number | null = typeof fromResponse === 'number' ? fromResponse : null;

    if (headRevisionId === null) {
        const isRole = !!options.role;
        const readArgs: Record<string, unknown> = isRole
            ? { action: 'read_skill', role: options.role, name: pushResult.name }
            : { action: 'read', identifier: pushResult.name };
        try {
            const readResult = await callCrewsTool(config, isRole ? 'roles' : 'skills', readArgs);
            if (readResult.ok && typeof readResult.data?.head_revision_id === 'number') {
                headRevisionId = readResult.data.head_revision_id;
            }
        } catch {
            // Best-effort refresh — leave the sidecar stale rather than failing the push.
        }
    }

    if (headRevisionId === null && pushResult.status !== 'created') {
        return;
    }

    const updated = { ...sidecar, head_revision_id: headRevisionId };
    fs.writeFileSync(path.join(dir, SKILL_SIDECAR), JSON.stringify(updated, null, 2) + '\n', 'utf8');
}

/**
 * Core implementation — accepts an injected config so tests can point at a
 * stub server without touching the filesystem config.
 *
 * Routes between single-skill mode (top-level SKILL.md) and plugin mode
 * (skills/ + commands/ subdirectories) based on directory structure.
 */
export async function skillPushWithConfig(
    dir: string,
    options: SkillPushOptions,
    config: Config,
): Promise<void> {
    const absDir = path.resolve(dir);

    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
        process.stderr.write(chalk.red(`error: "${dir}" is not a directory.\n`));
        process.exit(1);
    }

    if (options.publish && options.role) {
        process.stderr.write(chalk.red('error: --publish is not supported with --role yet; publish the role-scoped skill via the MCP take_snapshot tool.\n'));
        process.exit(1);
    }

    const topLevelSkillMd = path.join(absDir, 'SKILL.md');

    // -------------------------------------------------------------------------
    // Single-skill mode: <dir>/SKILL.md exists
    // -------------------------------------------------------------------------
    if (fs.existsSync(topLevelSkillMd)) {
        let payload: SkillPayload;
        try {
            payload = readSkillDir(dir);
        } catch (e: any) {
            process.stderr.write(chalk.red(`error: ${e.message}\n`));
            process.exit(1);
        }

        const sidecar = readSidecar(absDir);
        const sidecarRevision = sidecar ? ((sidecar.head_revision_id as number | null) ?? null) : undefined;

        let pushResult: PushResult;
        try {
            pushResult = await pushParsedSkill(payload, options, config, sidecarRevision);
        } catch (e: any) {
            process.stderr.write(chalk.red(`error: ${e.message}\n`));
            process.exit(1);
        }

        if (sidecar && (pushResult.status === 'updated' || pushResult.status === 'created')) {
            await refreshSidecarRevision(absDir, sidecar, pushResult, options, config);
        }

        // Optionally publish (snapshot) the just-pushed revision (single-skill mode).
        let publishOutcome: PublishOutcome | null = null;
        if (options.publish && !options.dryRun) {
            if (pushResult.status === 'created') {
                if (!pushResult.data.snapshot_hint) {
                    // Live-mode (version_mode=live) skill: no snapshot to take — already live.
                    publishOutcome = { status: 'live_mode' };
                } else {
                    const createdDocId = (pushResult.data.skill_doc_id ?? pushResult.data.doc_id ?? pushResult.data.id) as number | string;
                    publishOutcome = await publishSkillByDocId(config, createdDocId);
                }
            } else {
                publishOutcome = await publishSkillByName(config, pushResult.name);
            }
        }

        if (options.json) {
            const payload = publishOutcome ? { ...pushResult.data, publish: publishOutcome } : pushResult.data;
            console.log(JSON.stringify(payload));
            process.exit(publishOutcome?.status === 'error' ? 1 : 0);
        }

        printPushResult(pushResult, options);
        if (publishOutcome) {
            emitPublishOutcome(pushResult.name, publishOutcome, { pushed: true });
        }
        const warning = stagedPushWarning(pushResult, !!options.role);
        if (warning) {
            process.stderr.write(chalk.yellow(warning));
        }
        process.exit(0);
    }

    // -------------------------------------------------------------------------
    // Plugin mode: push skills/<name>/SKILL.md + commands/<name>.md
    // -------------------------------------------------------------------------
    if (options.publish) {
        process.stderr.write(chalk.red('error: --publish is not supported when pushing a plugin bundle (multiple skills); publish each with "solidactions skill publish <name>".\n'));
        process.exit(1);
    }

    const payloads: SkillPayload[] = [];

    // One-level glob: skills/*/SKILL.md
    const skillsDir = path.join(absDir, 'skills');
    if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
        for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const skillSubdir = path.join(skillsDir, entry.name);
            const skillMd = path.join(skillSubdir, 'SKILL.md');
            if (!fs.existsSync(skillMd)) continue;
            try {
                payloads.push(readSkillDir(skillSubdir));
            } catch (e: any) {
                process.stderr.write(chalk.red(`error: skills/${entry.name}/SKILL.md: ${e.message}\n`));
                process.exit(1);
            }
        }
    }

    // One-level glob: commands/*.md
    const commandsDir = path.join(absDir, 'commands');
    if (fs.existsSync(commandsDir) && fs.statSync(commandsDir).isDirectory()) {
        for (const entry of fs.readdirSync(commandsDir, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            if (!entry.name.endsWith('.md')) continue;
            const cmdPath = path.join(commandsDir, entry.name);
            const content = fs.readFileSync(cmdPath, 'utf8');
            try {
                payloads.push(parseCommandFile(entry.name, content));
            } catch (e: any) {
                process.stderr.write(chalk.red(`error: commands/${entry.name}: ${e.message}\n`));
                process.exit(1);
            }
        }
    }

    if (payloads.length === 0) {
        process.stderr.write(chalk.red(`error: no skills/ or commands/ under "${dir}" — nothing to push.\n`));
        process.exit(1);
    }

    // Detect duplicate names BEFORE any push
    const seen = new Map<string, number>();
    for (const p of payloads) {
        seen.set(p.name, (seen.get(p.name) ?? 0) + 1);
    }
    const conflicts = [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name);
    if (conflicts.length > 0) {
        process.stderr.write(
            chalk.red(`error: duplicate skill names detected — aborting before any push.\n`) +
            chalk.red(`  conflicts: ${conflicts.join(', ')}\n`) +
            chalk.red(`  Rename the conflicting skills/commands so all names are unique.\n`),
        );
        process.exit(1);
    }

    // Push each skill, print a summary line per item
    let createdCount = 0;
    let updatedCount = 0;
    for (const payload of payloads) {
        let pushResult: PushResult;
        try {
            pushResult = await pushParsedSkill(payload, options, config);
        } catch (e: any) {
            process.stderr.write(chalk.red(`error: ${payload.name}: ${e.message}\n`));
            process.exit(1);
        }
        printPushResult(pushResult, options);
        if (pushResult.status === 'created' || pushResult.status === 'would-create') {
            createdCount++;
        } else {
            updatedCount++;
        }
    }

    // Final tally
    if (!options.json) {
        const parts: string[] = [];
        if (options.dryRun) {
            if (createdCount > 0) parts.push(`${createdCount} would create`);
            if (updatedCount > 0) parts.push(`${updatedCount} would update`);
            console.log(chalk.cyan(`\n[dry-run] ${payloads.length} skill(s) (${parts.join(', ')})`));
        } else {
            if (createdCount > 0) parts.push(`${createdCount} created`);
            if (updatedCount > 0) parts.push(`${updatedCount} updated`);
            console.log(chalk.cyan(`\ndone: ${payloads.length} skill(s) pushed (${parts.join(', ')})`));
        }
    }
    process.exit(0);
}

/**
 * Entry point called from index.ts.
 */
export async function skillPush(dir: string, options: SkillPushOptions): Promise<void> {
    const config = await requireConfigWithWorkspace();
    await skillPushWithConfig(dir, options, config);
}

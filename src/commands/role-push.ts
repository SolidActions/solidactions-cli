/**
 * solidactions role push <dir>
 *
 * Pushes a role definition to the crews library (idempotent upsert).
 * Roles are flat peers of skills (per cli#34) — NOT nested under a role.
 *
 * The role def is a SKILL.md-shaped file (frontmatter name+description, body).
 * Roles carry NO references.
 *
 * Supports --dry-run: prints "[dry-run] would create/update '<name>'" without making any
 * create/edit call, and reports the same outcome (or the same error) the real push would.
 *
 * Which crew: --in-crew is required to CREATE a role (the server rejects a create without it
 * before it even checks for a collision). So without --in-crew the role is resolved first via
 * roles `list`: exactly one match -> edit it (in that match's crew); none -> it would be a
 * create, so ask for --in-crew; several -> ambiguous, ask for --in-crew.
 * With --in-crew: create -> on name_collision -> edit (dry-run pre-flights a read).
 * Roles use 'name' (NOT 'identifier') for read and edit.
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { Config } from '../utils/config';
import { requireConfigWithWorkspace } from '../utils/api';
import { callCrewsTool } from '../utils/mcp';
import { crewErrorHint } from '../utils/crew';
import { parseSkillFile, assertNoReservedFrontmatterKeys, shapeFrontmatterParams, noteFoldedFrontmatterKeys, ROLE_FRONTMATTER_PARAMS } from './skill-push';

export interface RolePushOptions {
    json?: boolean;
    dryRun?: boolean;
    /** Crew path containing the role. Required by the server when creating a role; disambiguates on edit/read. */
    inCrew?: string;
}

/** Print a role-push tool error (mapping crew-scoping codes to a hint) and exit 1. */
function failWithToolError(data: any, roleName: string): never {
    const code = data?.code ?? 'unknown_error';
    const hint = crewErrorHint(code, roleName, data?.message);
    if (hint) {
        process.stderr.write(chalk.red(`error: ${hint}\n`));
    } else {
        const errMsg = data?.message ?? 'MCP returned an error with no message';
        process.stderr.write(chalk.red(`error: ${code}: ${errMsg}\n`));
    }
    process.exit(1);
}

/** How a push without --in-crew resolved against the existing roles. */
type Resolved =
    | { kind: 'edit'; inCrew: string | null }
    | { kind: 'missing' }
    | { kind: 'ambiguous'; crews: Array<string | null> };

/**
 * Find the role by name via roles `list` (each entry carries `identifier`/`name` and
 * `in_crew`). `list` takes no paging parameters and returns every role, so no role can be
 * missed. Exits 1 if the list call itself fails.
 */
async function resolveExistingRole(config: Config, name: string): Promise<Resolved> {
    let list: Awaited<ReturnType<typeof callCrewsTool>>;
    try {
        list = await callCrewsTool(config, 'roles', { action: 'list' });
    } catch (e: any) {
        process.stderr.write(chalk.red(`error: ${e.message}\n`));
        process.exit(1);
    }
    if (!list.ok) {
        process.stderr.write(chalk.red(`error: could not list roles to find '${name}': ${list.data?.code ?? 'unknown_error'}: ${list.data?.message ?? 'MCP returned an error with no message'}\n`));
        process.exit(1);
    }
    const roles: Array<{ identifier?: string; name?: string; in_crew?: string | null }> = Array.isArray(list.data?.roles) ? list.data.roles : [];
    const matches = roles.filter((r) => (r.identifier ?? r.name) === name);
    if (matches.length === 0) return { kind: 'missing' };
    if (matches.length === 1) return { kind: 'edit', inCrew: matches[0].in_crew ?? null };
    return { kind: 'ambiguous', crews: matches.map((m) => m.in_crew ?? null) };
}

/** Exit 1 for a role that cannot be pushed without --in-crew (would be a create, or is ambiguous). */
function failUnresolved(resolved: Exclude<Resolved, { kind: 'edit' }>, name: string): never {
    if (resolved.kind === 'missing') {
        process.stderr.write(chalk.red(`error: role '${name}' does not exist yet; ${crewErrorHint('crew_required')}\n`));
    } else {
        const crews = resolved.crews.map((c) => c ?? '(legacy flat role)').join(', ');
        process.stderr.write(chalk.red(`error: ${crewErrorHint('ambiguous_role', name)} (found in: ${crews})\n`));
    }
    process.exit(1);
}

/**
 * Core implementation — accepts an injected config so tests can point at a
 * stub server without touching the filesystem config.
 *
 * Reads <dir>/SKILL.md (errors if missing), parses it via parseSkillFile,
 * then upserts the role via the crews 'roles' MCP tool.
 *
 * Roles carry NO references. The 'roles' tool uses 'name' for read and edit
 * (NOT 'identifier'). Dry-run pre-flight uses {action:'read', name}.
 */
export async function rolePushWithConfig(
    dir: string,
    options: RolePushOptions,
    config: Config,
): Promise<void> {
    const absDir = path.resolve(dir);

    // Verify the directory exists
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
        process.stderr.write(chalk.red(`error: "${dir}" is not a directory.\n`));
        process.exit(1);
    }

    // Read and parse SKILL.md (roles use the same SKILL.md filename convention)
    const skillMdPath = path.join(absDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
        process.stderr.write(chalk.red(`error: "${skillMdPath}" not found. The role directory must contain a SKILL.md file.\n`));
        process.exit(1);
    }

    const skillMdContent = fs.readFileSync(skillMdPath, 'utf8');
    let name: string;
    let description: string;
    let properties: Record<string, unknown>;
    let body: string;

    try {
        ({ name, description, properties, body } = parseSkillFile(skillMdContent));
        assertNoReservedFrontmatterKeys(properties);
    } catch (e: any) {
        process.stderr.write(chalk.red(`error: ${e.message}\n`));
        process.exit(1);
    }
    const frontmatterParams = shapeFrontmatterParams(properties, ROLE_FRONTMATTER_PARAMS);
    noteFoldedFrontmatterKeys(properties, ROLE_FRONTMATTER_PARAMS);
    // in_crew comes only from --in-crew (never frontmatter); sent only when given.
    const crewArgs: Record<string, unknown> = options.inCrew ? { in_crew: options.inCrew } : {};

    // Without --in-crew, find the role first: the outcome (edit / error) is decided here, for
    // the real push and --dry-run alike.
    let resolved: Resolved | null = null;
    if (!options.inCrew) {
        resolved = await resolveExistingRole(config, name);
        if (resolved.kind !== 'edit') failUnresolved(resolved, name);
    }

    // --dry-run: NO create or edit. Resolved above (no --in-crew) => would update.
    // With --in-crew, pre-flight a read to detect existence. Roles use {action:'read', name} (NOT identifier).
    if (options.dryRun) {
        if (resolved) {
            if (options.json) {
                console.log(JSON.stringify({}));
            } else {
                console.log(chalk.cyan(`[dry-run] would update '${name}'`));
            }
            process.exit(0);
        }
        let readResult: Awaited<ReturnType<typeof callCrewsTool>>;
        try {
            readResult = await callCrewsTool(config, 'roles', { action: 'read', name, ...crewArgs });
        } catch (e: any) {
            process.stderr.write(chalk.red(`error: ${e.message}\n`));
            process.exit(1);
        }

        if (!readResult.ok) {
            const code = readResult.data?.code;
            if (code === 'role_not_found') {
                if (options.json) {
                    console.log(JSON.stringify({}));
                } else {
                    console.log(chalk.cyan(`[dry-run] would create '${name}'`));
                }
                process.exit(0);
            }
            // A versioned role with no published snapshot answers read with no_snapshot:
            // the role exists (there is a doc), it just has nothing live yet -> would update.
            if (code === 'no_snapshot') {
                if (options.json) {
                    console.log(JSON.stringify({}));
                } else {
                    console.log(chalk.cyan(`[dry-run] would update '${name}'`));
                }
                process.exit(0);
            }
            // Any other error is unexpected — surface it
            failWithToolError(readResult.data, name);
        }

        // Read succeeded → role exists → would update
        if (options.json) {
            console.log(JSON.stringify({}));
        } else {
            console.log(chalk.cyan(`[dry-run] would update '${name}'`));
        }
        process.exit(0);
    }

    // Upsert. Resolved to an existing role (no --in-crew): edit it in the crew the list gave.
    // With --in-crew: try create first; on name_collision switch to edit.
    // Roles carry NO references — do not send references key.
    // Frontmatter extras are spread FIRST so the fixed protocol keys always win.
    let result: Awaited<ReturnType<typeof callCrewsTool>> | null = null;
    if (resolved?.kind !== 'edit') {
        try {
            result = await callCrewsTool(config, 'roles', {
                ...frontmatterParams,
                ...crewArgs,
                action: 'create',
                name,
                description,
                body,
            });
        } catch (e: any) {
            process.stderr.write(chalk.red(`error: ${e.message}\n`));
            process.exit(1);
        }
    }

    // Edit path: the role was resolved as existing, or the create collided.
    // Roles edit uses 'name' (NOT 'identifier').
    if (result === null || (!result.ok && result.data?.code === 'name_collision')) {
        const editCrewArgs: Record<string, unknown> = resolved?.kind === 'edit'
            ? (resolved.inCrew ? { in_crew: resolved.inCrew } : {})
            : crewArgs;
        let edited: Awaited<ReturnType<typeof callCrewsTool>>;
        try {
            edited = await callCrewsTool(config, 'roles', {
                ...frontmatterParams,
                ...editCrewArgs,
                action: 'edit',
                name,
                description,
                body,
            });
        } catch (e: any) {
            process.stderr.write(chalk.red(`error: ${e.message}\n`));
            process.exit(1);
        }

        if (!edited.ok) {
            failWithToolError(edited.data, name);
        }

        if (options.json) {
            console.log(JSON.stringify(edited.data ?? {}));
        } else {
            console.log(chalk.green(`updated role '${name}'`));
        }
        process.exit(0);
    }

    if (!result.ok) {
        failWithToolError(result.data, name);
    }

    if (options.json) {
        console.log(JSON.stringify(result.data ?? {}));
    } else {
        const data = result.data ?? {};
        const roleDocId = data.role_doc_id ?? data.doc_id ?? data.id ?? '?';
        console.log(chalk.green(`created role '${name}' (doc ${roleDocId})`));
    }
    process.exit(0);
}

/**
 * Entry point called from index.ts.
 */
export async function rolePush(dir: string, options: RolePushOptions): Promise<void> {
    const config = await requireConfigWithWorkspace();
    await rolePushWithConfig(dir, options, config);
}

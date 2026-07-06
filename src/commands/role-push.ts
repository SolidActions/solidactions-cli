/**
 * solidactions role push <dir>
 *
 * Pushes a role definition to the crews library (idempotent upsert).
 * Roles are flat peers of skills (per cli#34) — NOT nested under a role.
 *
 * The role def is a SKILL.md-shaped file (frontmatter name+description, body).
 * Roles carry NO references.
 *
 * Supports --dry-run: pre-flight a read to detect existence; prints
 * "[dry-run] would create/update '<name>'" without making any create/edit call.
 *
 * Upsert: create → on name_collision → edit.
 * Roles use 'name' (NOT 'identifier') for read and edit.
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { Config } from '../utils/config';
import { requireConfigWithWorkspace } from '../utils/api';
import { callCrewsTool } from '../utils/mcp';
import { parseSkillFile } from './skill-push';

export interface RolePushOptions {
    json?: boolean;
    dryRun?: boolean;
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
    } catch (e: any) {
        process.stderr.write(chalk.red(`error: ${e.message}\n`));
        process.exit(1);
    }

    // --dry-run: pre-flight a read to detect existence; NO create or edit.
    // Roles use {action:'read', name} (NOT identifier).
    if (options.dryRun) {
        let readResult: Awaited<ReturnType<typeof callCrewsTool>>;
        try {
            readResult = await callCrewsTool(config, 'roles', { action: 'read', name });
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
            // Any other error is unexpected — surface it
            const errMsg = readResult.data?.message ?? 'MCP returned an error with no message';
            process.stderr.write(chalk.red(`error: ${code ?? 'unknown_error'}: ${errMsg}\n`));
            process.exit(1);
        }

        // Read succeeded → role exists → would update
        if (options.json) {
            console.log(JSON.stringify({}));
        } else {
            console.log(chalk.cyan(`[dry-run] would update '${name}'`));
        }
        process.exit(0);
    }

    // Upsert: try create first; on name_collision switch to edit.
    // Roles carry NO references — do not send references key.
    let result: Awaited<ReturnType<typeof callCrewsTool>>;
    try {
        result = await callCrewsTool(config, 'roles', {
            action: 'create',
            name,
            description,
            body,
            properties,
        });
    } catch (e: any) {
        process.stderr.write(chalk.red(`error: ${e.message}\n`));
        process.exit(1);
    }

    // On name collision, switch to the edit path.
    // Roles edit uses 'name' (NOT 'identifier'), and properties → properties_patch.
    if (!result.ok && result.data?.code === 'name_collision') {
        try {
            result = await callCrewsTool(config, 'roles', {
                action: 'edit',
                name,
                description,
                body,
                properties_patch: properties,
            });
        } catch (e: any) {
            process.stderr.write(chalk.red(`error: ${e.message}\n`));
            process.exit(1);
        }

        if (!result.ok) {
            const errCode = result.data?.code ?? 'unknown_error';
            const errMsg = result.data?.message ?? 'MCP returned an error with no message';
            process.stderr.write(chalk.red(`error: ${errCode}: ${errMsg}\n`));
            process.exit(1);
        }

        if (options.json) {
            console.log(JSON.stringify(result.data ?? {}));
        } else {
            console.log(chalk.green(`updated role '${name}'`));
        }
        process.exit(0);
    }

    if (!result.ok) {
        const errCode = result.data?.code ?? 'unknown_error';
        const errMsg = result.data?.message ?? 'MCP returned an error with no message';
        process.stderr.write(chalk.red(`error: ${errCode}: ${errMsg}\n`));
        process.exit(1);
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

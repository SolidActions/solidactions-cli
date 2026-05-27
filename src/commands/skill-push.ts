/**
 * solidactions skill push <dir>
 *
 * Pushes a local skill folder into the crews library via the crews MCP server.
 * Idempotent upsert: create, or update on name collision.
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import yaml from 'js-yaml';
import { Config } from '../utils/config';
import { requireConfigWithWorkspace } from '../utils/api';
import { callCrewsTool } from '../utils/mcp';

export interface SkillPushOptions {
    role?: string;
    json?: boolean;
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
 */
export function readReferences(dir: string): Record<string, string> {
    const references: Record<string, string> = {};

    const walk = (current: string): void => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const abs = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(abs);
                continue;
            }
            if (!entry.isFile()) continue;

            // POSIX-normalised path relative to the skill dir, used as the key.
            const key = path.relative(dir, abs).split(path.sep).join('/');
            if (key === 'SKILL.md') continue; // exclude only the top-level skill file

            references[key] = fs.readFileSync(abs, 'utf8');
        }
    };

    walk(dir);
    return references;
}

/**
 * Core implementation — accepts an injected config so tests can point at a
 * stub server without touching the filesystem config.
 */
export async function skillPushWithConfig(
    dir: string,
    options: SkillPushOptions,
    config: Config,
): Promise<void> {
    const absDir = path.resolve(dir);

    // 1. Check directory exists
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
        process.stderr.write(chalk.red(`error: "${dir}" is not a directory.\n`));
        process.exit(1);
    }

    // 2. Read SKILL.md
    const skillMdPath = path.join(absDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
        process.stderr.write(chalk.red(`error: "${skillMdPath}" not found. The skill directory must contain a SKILL.md file.\n`));
        process.exit(1);
    }

    const skillMdContent = fs.readFileSync(skillMdPath, 'utf8');

    // 3. Parse frontmatter + body
    let parsed: ReturnType<typeof parseSkillFile>;
    try {
        parsed = parseSkillFile(skillMdContent);
    } catch (e: any) {
        process.stderr.write(chalk.red(`error: ${e.message}\n`));
        process.exit(1);
    }

    const { name, description, properties, body } = parsed;

    // 4. Read bundled reference files (recursively, keyed by relative path)
    const references = readReferences(absDir);

    // 5. Compose an idempotent upsert: try create; on name_collision, edit.
    const isRole = !!options.role;
    const tool = isRole ? 'roles' : 'skills';

    const createArgs: Record<string, unknown> = isRole
        ? { action: 'create_skill', role: options.role, name, description, body, properties, references }
        : { action: 'create', name, description, body, properties, references };

    let result: Awaited<ReturnType<typeof callCrewsTool>>;
    try {
        result = await callCrewsTool(config, tool, createArgs);
    } catch (e: any) {
        process.stderr.write(chalk.red(`error: MCP request failed — ${e.message}\n`));
        process.exit(1);
    }

    let didUpdate = false;

    // 6. On name collision, switch to the edit path (the upsert). properties → properties_patch.
    if (!result.ok && result.data?.code === 'name_collision') {
        const editArgs: Record<string, unknown> = isRole
            ? { action: 'edit_skill', role: options.role, name, description, body, properties_patch: properties, references }
            : { action: 'edit', identifier: name, description, body, properties_patch: properties, references };

        try {
            result = await callCrewsTool(config, tool, editArgs);
        } catch (e: any) {
            process.stderr.write(chalk.red(`error: MCP request failed — ${e.message}\n`));
            process.exit(1);
        }
        didUpdate = true;
    }

    // 7. Handle result.
    if (!result.ok) {
        const errData = result.data;
        const errCode = errData?.code ?? 'unknown_error';
        const errMsg = errData?.message ?? 'MCP returned an error with no message';
        process.stderr.write(chalk.red(`${errCode}: ${errMsg}\n`));
        process.exit(1);
    }

    if (options.json) {
        console.log(JSON.stringify(result.data));
        process.exit(0);
    }

    const data = result.data;
    if (didUpdate) {
        // edit shape: {version_id, body_blob_sha}
        console.log(chalk.green(`updated skill '${name}' (version ${data.version_id ?? '?'})`));
    } else {
        // create shape: {skill_doc_id, folder_id, reference_doc_ids}
        const skillDocId = data.skill_doc_id ?? data.doc_id ?? data.id ?? '?';
        const refCount = Object.keys(data.reference_doc_ids ?? {}).length;
        console.log(chalk.green(`created skill '${name}' (doc ${skillDocId}, ${refCount} refs)`));
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

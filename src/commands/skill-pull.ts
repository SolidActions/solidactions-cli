/**
 * solidactions skill pull <name> [dest]
 *
 * Fetches a skill from the crews library and reconstructs a local skill folder
 * (the inverse of `skill push`): writes <dest>/SKILL.md + any bundled reference
 * files under <dest>/. Default dest = ./<name>/.
 *
 * --json mode: prints the raw read result from the server and exits WITHOUT
 * writing any files. This is useful for scripting/inspection. The default
 * (no --json) writes the folder.
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import yaml from 'js-yaml';
import { Config } from '../utils/config';
import { requireConfigWithWorkspace } from '../utils/api';
import { callCrewsTool } from '../utils/mcp';

export interface SkillPullOptions {
    json?: boolean;
}

/** Filename of the provenance sidecar written alongside a pulled skill. */
export const SKILL_SIDECAR = '.solidactions-skill.json';

/**
 * Core implementation — accepts an injected config so tests can point at a
 * stub server without touching the filesystem config.
 *
 * Steps:
 *  1. Call skills.read to fetch the skill from the library.
 *  2. If --json: print the raw result, exit 0 (no file writes).
 *  3. Otherwise: reconstruct SKILL.md from the returned `properties` (which
 *     contains name, description, and any extra props), OMITTING `type` (the
 *     server sets it; stripping mirrors what parseSkillFile does on push so a
 *     push→pull→push round-trip is idempotent). Write <dest>/SKILL.md, then
 *     write each reference file under <dest>/ with a path-traversal guard.
 */
export async function skillPullWithConfig(
    name: string,
    dest: string | undefined,
    options: SkillPullOptions,
    config: Config,
): Promise<void> {
    // Call the crews MCP server for a skills.read
    let result: Awaited<ReturnType<typeof callCrewsTool>>;
    try {
        result = await callCrewsTool(config, 'skills', { action: 'read', identifier: name });
    } catch (e: any) {
        process.stderr.write(chalk.red(`error: ${e.message}\n`));
        process.exit(1);
    }

    if (!result.ok) {
        const code = result.data?.code ?? 'unknown_error';
        const message = result.data?.message ?? 'MCP returned an error with no message';
        process.stderr.write(chalk.red(`error: ${code}: ${message}\n`));
        process.exit(1);
    }

    const data = result.data as {
        identifier: string;
        doc_id: number | string;
        head_revision_id?: number;
        properties: Record<string, unknown>;
        body: string;
        reference: Record<string, string>;
    };

    // --json mode: print raw result and exit WITHOUT writing files.
    // This is intentionally non-destructive: inspect the raw server payload
    // without side-effects. File reconstruction is the default (no --json) mode.
    if (options.json) {
        console.log(JSON.stringify(data));
        process.exit(0);
    }

    // Resolve the output directory (default: ./<name>/)
    const out = dest ?? './' + name;
    const absOut = path.resolve(out);

    // Build the frontmatter object from `properties`, OMITTING `type`.
    // The server stores a `type` field but it is stripped on push (parseSkillFile
    // does `const { type: _type, ...properties } = rest`). We mirror that here
    // so that pull → push is idempotent.
    const { type: _type, name: propName, description: propDescription, ...extraProps } = data.properties;

    // Reconstruct the full frontmatter: name + description (from properties)
    // followed by all remaining extra props (minus type).
    const frontmatterObj: Record<string, unknown> = {
        name: propName,
        description: propDescription,
        ...extraProps,
    };

    // yaml.dump produces "key: value\n" lines; we wrap in ---\n...\n---\n
    const yamlBlock = yaml.dump(frontmatterObj, { lineWidth: -1 });
    const body = data.body ?? '';

    // Ensure the body starts on its own line after the closing ---
    const skillMdContent = `---\n${yamlBlock}---\n${body.startsWith('\n') ? body : '\n' + body}`;

    // Create the output directory (and parents) if needed
    fs.mkdirSync(absOut, { recursive: true });

    // Write SKILL.md
    fs.writeFileSync(path.join(absOut, 'SKILL.md'), skillMdContent, 'utf8');

    // Write reference files, guarding against path traversal
    const reference = data.reference ?? {};
    const absOutNorm = path.resolve(absOut) + path.sep;
    let writtenCount = 0;
    let skippedCount = 0;

    for (const [key, content] of Object.entries(reference)) {
        // Guard 1: reject absolute paths
        if (path.isAbsolute(key)) {
            process.stderr.write(
                chalk.yellow(`warn: skipping unsafe reference key (absolute path): ${key}\n`),
            );
            skippedCount++;
            continue;
        }

        // Guard 2: reject path traversal (any key that resolves outside absOut)
        const target = path.resolve(absOut, key);
        if (!target.startsWith(absOutNorm)) {
            process.stderr.write(
                chalk.yellow(`warn: skipping unsafe reference key (traversal): ${key}\n`),
            );
            skippedCount++;
            continue;
        }

        // Safe: create parent dirs and write the file
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, 'utf8');
        writtenCount++;
    }

    // Write the provenance sidecar so downstream commands (e.g. `skill push`)
    // can detect drift against the revision this pull was taken from.
    const sidecar = {
        identifier: data.identifier,
        doc_id: typeof data.doc_id === 'string' ? parseInt(data.doc_id, 10) : data.doc_id,
        head_revision_id: data.head_revision_id ?? null,
        role: null as string | null,
    };
    fs.writeFileSync(path.join(absOut, SKILL_SIDECAR), JSON.stringify(sidecar, null, 2) + '\n', 'utf8');

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

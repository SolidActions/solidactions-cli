/**
 * solidactions skill list
 *
 * Lists skills in the crews library.
 */

import chalk from 'chalk';
import { Config } from '../utils/config';
import { requireConfigWithWorkspace } from '../utils/api';
import { callCrewsTool } from '../utils/mcp';

export interface SkillListOptions {
    json?: boolean;
    limit?: number;
}

/**
 * Core implementation — accepts an injected config so tests can point at a
 * stub server without touching the filesystem config.
 */
export async function skillListWithConfig(options: SkillListOptions, config: Config): Promise<void> {
    const args: Record<string, unknown> = { action: 'list' };
    if (options.limit !== undefined) {
        args.limit = options.limit;
    }

    let result: Awaited<ReturnType<typeof callCrewsTool>>;
    try {
        result = await callCrewsTool(config, 'skills', args);
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

    const skills: Array<{ doc_id: string; name: string; description: string; catalog_advertised: boolean }> =
        result.data?.skills ?? [];

    if (options.json) {
        console.log(JSON.stringify(result.data));
        process.exit(0);
    }

    if (skills.length === 0) {
        console.log(chalk.gray('No skills found.'));
        process.exit(0);
    }

    for (const skill of skills) {
        const advertisedMarker = skill.catalog_advertised ? chalk.gray(' (advertised)') : '';
        console.log(`${chalk.green(skill.name)} — ${chalk.gray(skill.description)}${advertisedMarker}`);
    }

    process.exit(0);
}

/**
 * Entry point called from index.ts.
 */
export async function skillList(options: SkillListOptions): Promise<void> {
    const config = await requireConfigWithWorkspace();
    await skillListWithConfig(options, config);
}

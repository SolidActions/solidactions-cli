/**
 * solidactions skill delete <name>
 *
 * Deletes a skill from the crews library. Admin only.
 */

import chalk from 'chalk';
import { Config } from '../utils/config';
import { requireConfigWithWorkspace } from '../utils/api';
import { callCrewsTool } from '../utils/mcp';

export interface SkillDeleteOptions {
    json?: boolean;
}

/**
 * Core implementation — accepts an injected config so tests can point at a
 * stub server without touching the filesystem config.
 */
export async function skillDeleteWithConfig(name: string, options: SkillDeleteOptions, config: Config): Promise<void> {
    let result: Awaited<ReturnType<typeof callCrewsTool>>;
    try {
        result = await callCrewsTool(config, 'skills', { action: 'delete', identifier: name });
    } catch (e: any) {
        process.stderr.write(chalk.red(`error: ${e.message}\n`));
        process.exit(1);
    }

    if (!result.ok) {
        const code = result.data?.code ?? 'unknown_error';
        const message = result.data?.message ?? 'MCP returned an error with no message';

        if (code === 'permission_denied') {
            process.stderr.write(chalk.red(`error: permission denied — deleting a skill requires Admin access.\n`));
        } else {
            process.stderr.write(chalk.red(`error: ${code}: ${message}\n`));
        }
        process.exit(1);
    }

    if (options.json) {
        console.log(JSON.stringify(result.data));
        process.exit(0);
    }

    const deleteToken: string = result.data?.delete_token ?? '';
    console.log(chalk.green(`deleted skill '${name}'`) + (deleteToken ? chalk.gray(` (token: ${deleteToken})`) : ''));

    process.exit(0);
}

/**
 * Entry point called from index.ts.
 */
export async function skillDelete(name: string, options: SkillDeleteOptions): Promise<void> {
    const config = await requireConfigWithWorkspace();
    await skillDeleteWithConfig(name, options, config);
}

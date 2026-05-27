/**
 * solidactions skill view <name>
 *
 * Shows the full details of a single skill from the crews library.
 */

import chalk from 'chalk';
import { Config } from '../utils/config';
import { requireConfigWithWorkspace } from '../utils/api';
import { callCrewsTool } from '../utils/mcp';

export interface SkillViewOptions {
    json?: boolean;
}

/**
 * Core implementation — accepts an injected config so tests can point at a
 * stub server without touching the filesystem config.
 */
export async function skillViewWithConfig(name: string, options: SkillViewOptions, config: Config): Promise<void> {
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

    if (options.json) {
        console.log(JSON.stringify(result.data));
        process.exit(0);
    }

    const data = result.data ?? {};
    const identifier: string = data.identifier ?? name;
    const description: string = data.properties?.description ?? '';
    const body: string = data.body ?? '';

    console.log(chalk.green(identifier));
    if (description) {
        console.log(chalk.gray(description));
    }
    if (body) {
        console.log('');
        console.log(body);
    }

    process.exit(0);
}

/**
 * Entry point called from index.ts.
 */
export async function skillView(name: string, options: SkillViewOptions): Promise<void> {
    const config = await requireConfigWithWorkspace();
    await skillViewWithConfig(name, options, config);
}

/**
 * solidactions skill publish <name>
 *
 * Publishes (snapshots) a skill so its latest pushed revision goes live for
 * agents. Shared-library by default; --role [--in-crew] targets a role-scoped skill.
 */

import chalk from 'chalk';
import { Config } from '../utils/config';
import { requireConfigWithWorkspace } from '../utils/api';
import { publishSkillByName, emitPublishOutcome } from '../utils/skill-snapshot';

export interface SkillPublishOptions {
    json?: boolean;
    role?: string;
    inCrew?: string;
}

/** Core implementation — accepts an injected config for tests. */
export async function skillPublishWithConfig(name: string, options: SkillPublishOptions, config: Config): Promise<void> {
    if (options.inCrew && !options.role) {
        process.stderr.write(chalk.red('error: --in-crew requires --role.\n'));
        process.exit(1);
    }
    const outcome = await publishSkillByName(config, name, { role: options.role, inCrew: options.inCrew });
    emitPublishOutcome(name, outcome, { json: options.json, role: options.role });
}

/** Entry point called from index.ts. */
export async function skillPublish(name: string, options: SkillPublishOptions): Promise<void> {
    const config = await requireConfigWithWorkspace();
    await skillPublishWithConfig(name, options, config);
}

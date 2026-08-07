/**
 * solidactions skill publish <name>
 *
 * Publishes (snapshots) a shared skill so its latest pushed revision goes live
 * for agents.
 */

import { Config } from '../utils/config';
import { requireConfigWithWorkspace } from '../utils/api';
import { publishSkillByName, emitPublishOutcome } from '../utils/skill-snapshot';

export interface SkillPublishOptions {
    json?: boolean;
}

/** Core implementation — accepts an injected config for tests. */
export async function skillPublishWithConfig(name: string, options: SkillPublishOptions, config: Config): Promise<void> {
    const outcome = await publishSkillByName(config, name);
    emitPublishOutcome(name, outcome, { json: options.json });
}

/** Entry point called from index.ts. */
export async function skillPublish(name: string, options: SkillPublishOptions): Promise<void> {
    const config = await requireConfigWithWorkspace();
    await skillPublishWithConfig(name, options, config);
}

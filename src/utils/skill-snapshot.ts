/**
 * Publish (snapshot) helpers for crews skills.
 *
 * Composes two existing MCP actions: crews_skills.read resolves a skill name to
 * its doc_id and reports whether the current revision is unpublished, and
 * crews_versions.take_snapshot promotes that revision to all agents.
 */

import chalk from 'chalk';
import { Config } from './config';
import { callCrewsTool } from './mcp';

export type PublishOutcome =
    | { status: 'published'; snapshotId: number | string }
    | { status: 'already_published' }
    | { status: 'live_mode' }
    | { status: 'error'; code: string; message: string };

/** Snapshot a skill by its doc_id (crews_versions.take_snapshot). */
export async function publishSkillByDocId(config: Config, docId: number | string): Promise<PublishOutcome> {
    let result: Awaited<ReturnType<typeof callCrewsTool>>;
    try {
        result = await callCrewsTool(config, 'crews_versions', { action: 'take_snapshot', doc_id: docId });
    } catch (e: any) {
        return { status: 'error', code: 'mcp_request_failed', message: e.message };
    }
    if (!result.ok) {
        return { status: 'error', code: result.data?.code ?? 'unknown_error', message: result.data?.message ?? 'take_snapshot returned an error with no message' };
    }
    return { status: 'published', snapshotId: result.data.snapshot_id };
}

/**
 * Resolve a skill name to its doc_id, then publish — short-circuiting when the
 * current revision is already live (no take_snapshot call). Detection uses the
 * read response, NOT the take_snapshot error code (the server maps both
 * "nothing to snapshot" and "live-mode" to the same not_snapshotable code).
 */
export async function publishSkillByName(config: Config, name: string): Promise<PublishOutcome> {
    let read: Awaited<ReturnType<typeof callCrewsTool>>;
    try {
        read = await callCrewsTool(config, 'skills', { action: 'read', identifier: name });
    } catch (e: any) {
        return { status: 'error', code: 'mcp_request_failed', message: e.message };
    }
    if (!read.ok) {
        return { status: 'error', code: read.data?.code ?? 'unknown_error', message: read.data?.message ?? 'read returned an error with no message' };
    }

    const data = read.data;
    // Metadata absent entirely → live-mode doc (edits are already live).
    if (data.has_unpublished_revisions === undefined) {
        return { status: 'live_mode' };
    }
    // HEAD already snapshotted → nothing to publish.
    if (data.has_unpublished_revisions === false) {
        return { status: 'already_published' };
    }
    return publishSkillByDocId(config, data.doc_id);
}

/**
 * Print a PublishOutcome and exit. `opts.pushed` tailors error copy for the
 * `skill push --publish` case (push succeeded, publish failed). `opts.json`
 * prints the raw outcome as JSON instead of human text.
 */
export function emitPublishOutcome(name: string, outcome: PublishOutcome, opts: { pushed?: boolean; json?: boolean } = {}): void {
    if (opts.json) {
        console.log(JSON.stringify(outcome));
        process.exit(outcome.status === 'error' ? 1 : 0);
    }
    switch (outcome.status) {
        case 'published':
            console.log(chalk.green(`✔ published '${name}' — now live for agents`));
            process.exit(0);
        case 'already_published':
            console.log(chalk.green('already published — nothing to do'));
            process.exit(0);
        case 'live_mode':
            console.log(chalk.green('live-mode skill — edits are already live, nothing to publish'));
            process.exit(0);
        case 'error': {
            const prefix = opts.pushed ? 'pushed, but publish failed — ' : '';
            process.stderr.write(chalk.red(`${prefix}${outcome.code}: ${outcome.message}\n`));
            if (opts.pushed) {
                process.stderr.write(chalk.yellow(`  The skill was pushed. Retry: solidactions skill publish ${name}\n`));
            }
            process.exit(1);
        }
    }
}

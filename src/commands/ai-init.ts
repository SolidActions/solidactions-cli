import fs from 'fs';
import chalk from 'chalk';
import prompts from 'prompts';
import fsExtra from 'fs-extra';
import path from 'path';
import { fetchRawFile } from '../utils/github';
import { upsertMarkerSection } from '../utils/markers';
import { AiHelperTarget, skillTargetDir, installSkills, fetchAiHelperContent } from '../utils/skills';

interface AiInitOptions {
    claude?: boolean;
    agents?: boolean;
}

export const NON_TTY_DEFAULT_NOTICE =
    'No --claude/--agents given and non-interactive — defaulting to CLAUDE.md; pass --agents for Codex/Cursor/Gemini.';

/**
 * Resolve which AI-helper file (CLAUDE.md vs AGENTS.md) to target, WITHOUT
 * touching the filesystem or network. Callers that also scaffold template
 * files (e.g. `init`) must call this BEFORE writing anything, so a shell
 * that can't answer the interactive prompt never leaves a half-scaffolded
 * project — see the `init` half-scaffold bug this closes.
 */
export async function resolveAiHelperTarget(options: AiInitOptions = {}): Promise<AiHelperTarget> {
    if (options.claude && options.agents) {
        console.error(chalk.red('Please specify only one of --claude or --agents'));
        process.exit(1);
    }

    if (options.claude) {
        return 'CLAUDE.md';
    }
    if (options.agents) {
        return 'AGENTS.md';
    }

    if (process.stdin.isTTY) {
        const response = await prompts({
            type: 'select',
            name: 'file',
            message: 'Which AI helper file?',
            choices: [
                { title: 'CLAUDE.md (Claude Code)', value: 'CLAUDE.md' },
                { title: 'AGENTS.md (Codex, Cursor, Gemini, etc.)', value: 'AGENTS.md' },
            ],
        });

        if (!response.file) {
            console.log(chalk.yellow('Cancelled.'));
            process.exit(0);
        }

        return response.file as AiHelperTarget;
    }

    // Non-TTY (CI, pipes, an AI agent's non-interactive shell) with no flag:
    // never block on an unanswerable prompt — default instead.
    console.log(chalk.yellow(NON_TTY_DEFAULT_NOTICE));
    return 'CLAUDE.md';
}

export async function aiInit(options: AiInitOptions = {}, resolvedTarget?: AiHelperTarget) {
    try {
        const targetFile: AiHelperTarget = resolvedTarget ?? await resolveAiHelperTarget(options);

        console.log(chalk.blue('Fetching AI helper content...'));

        // Fetch slim helper content for the chosen target.
        const aiContent = await fetchAiHelperContent(targetFile);

        // Fetch SDK reference (always).
        const sdkContent = await fetchRawFile('SolidActions', 'solidactions-ts-sdk', 'docs/sdk-reference.md');

        // Save SDK reference to .solidactions/sdk-reference.md.
        fsExtra.ensureDirSync('.solidactions');
        fs.writeFileSync('.solidactions/sdk-reference.md', sdkContent, 'utf8');
        console.log(chalk.green('✓ SDK reference saved to .solidactions/sdk-reference.md'));

        // Always install skills — no prompt. The user chose `ai init <target>`,
        // so they want AI tooling set up.
        const targetDir = skillTargetDir(targetFile);
        console.log(chalk.blue(`Installing SolidActions skills to ${path.relative(process.cwd(), targetDir)}/ ...`));
        const { written } = await installSkills(targetDir);
        for (const f of written) {
            console.log(chalk.green(`✓ ${path.relative(process.cwd(), f)}`));
        }

        // Upsert the AI helper marker section.
        upsertMarkerSection(targetFile, 'SolidActions', aiContent);

        console.log(chalk.green(`✓ AI helper installed to ${targetFile}`));
        console.log(
            chalk.gray(
                '  Existing files may still contain a separate "SolidActions SDK Reference" marker block from older CLI versions. That content is now redundant and can be deleted manually.',
            ),
        );
    } catch (error: any) {
        if (error.message?.includes('rate limit')) {
            console.error(chalk.red(error.message));
        } else if (error.message?.includes('not found')) {
            console.error(chalk.red(error.message));
        } else if (error.message?.includes('Failed to fetch')) {
            console.error(chalk.red('Network error: Could not reach GitHub. Check your internet connection.'));
        } else {
            console.error(chalk.red('Error:'), error.message);
        }
        process.exit(1);
    }
}

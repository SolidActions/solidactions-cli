import fs from 'fs';
import chalk from 'chalk';
import prompts from 'prompts';
import fsExtra from 'fs-extra';
import path from 'path';
import { fetchRawFile } from '../utils/github';
import { upsertMarkerSection } from '../utils/markers';
import { detectSkillTargets, installSkills, fetchClaudeMdContent } from '../utils/skills';

interface AiInitOptions {
    claude?: boolean;
    agents?: boolean;
    skills?: boolean;  // commander auto-negates --no-skills into skills: false
}

export async function aiInit(options: AiInitOptions = {}) {
    try {
        // Determine target file
        let targetFile: string;

        if (options.claude && options.agents) {
            console.error(chalk.red('Please specify only one of --claude or --agents'));
            process.exit(1);
        }

        if (options.claude) {
            targetFile = 'CLAUDE.md';
        } else if (options.agents) {
            targetFile = 'AGENTS.md';
        } else {
            const response = await prompts({
                type: 'select',
                name: 'file',
                message: 'Which AI helper file?',
                choices: [
                    { title: 'CLAUDE.md', value: 'CLAUDE.md' },
                    { title: 'AGENTS.md', value: 'AGENTS.md' },
                ],
            });

            if (!response.file) {
                console.log(chalk.yellow('Cancelled.'));
                process.exit(0);
            }

            targetFile = response.file;
        }

        // Decide whether to install skills (default true; --no-skills opts out)
        const installSkillsEnabled = options.skills !== false;

        // Determine skill targets if installing.
        // Skills are Claude Code-specific (.claude/skills/) and not meaningful for other AI tools.
        let skillTargets: string[] = [];
        if (installSkillsEnabled && targetFile === 'CLAUDE.md') {
            skillTargets = detectSkillTargets();
            if (skillTargets.length === 0) {
                const resp = await prompts({
                    type: 'confirm',
                    name: 'create',
                    message: 'No `.claude/` directory found. Create `.claude/skills/` for SolidActions skills?',
                    initial: true,
                });
                if (resp.create === undefined) {
                    // User cancelled (Ctrl+C) — treat as abort, not decline
                    console.log(chalk.yellow('Cancelled.'));
                    process.exit(0);
                } else if (resp.create) {
                    skillTargets = [path.join(process.cwd(), '.claude', 'skills')];
                } else {
                    console.log(chalk.yellow('Skipping skill install. Run with --no-skills to silence this prompt.'));
                }
            }
        }

        console.log(chalk.blue('Fetching AI helper content...'));

        // Fetch CLAUDE.md content (slim pointer if skills installed, else full)
        const aiContent = await fetchClaudeMdContent(skillTargets.length > 0);

        // Fetch SDK reference (always)
        const sdkContent = await fetchRawFile('SolidActions', 'solidactions-ts-sdk', 'docs/sdk-reference.md');

        // Save SDK reference to .solidactions/sdk-reference.md
        fsExtra.ensureDirSync('.solidactions');
        fs.writeFileSync('.solidactions/sdk-reference.md', sdkContent, 'utf8');
        console.log(chalk.green('✓ SDK reference saved to .solidactions/sdk-reference.md'));

        // Install skills if enabled and targets exist
        if (skillTargets.length > 0) {
            console.log(chalk.blue('Installing SolidActions skills...'));
            const { written } = await installSkills(skillTargets);
            for (const f of written) {
                console.log(chalk.green(`✓ ${path.relative(process.cwd(), f)}`));
            }
        }

        // Upsert main AI helper section
        upsertMarkerSection(targetFile, 'SolidActions', aiContent);

        // Upsert SDK reference pointer section
        const sdkReferenceNote = `## SolidActions SDK Reference

The full SDK API reference is available at \`.solidactions/sdk-reference.md\`. Refer to it for detailed function signatures, error classes, retry configuration, and advanced patterns like forking, streaming, and signal URLs.`;

        upsertMarkerSection(targetFile, 'SolidActions SDK Reference', sdkReferenceNote);

        console.log(chalk.green(`✓ AI helper installed to ${targetFile}`));
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

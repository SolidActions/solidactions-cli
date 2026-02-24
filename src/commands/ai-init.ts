import fs from 'fs';
import chalk from 'chalk';
import prompts from 'prompts';
import fsExtra from 'fs-extra';
import { fetchRawFile } from '../utils/github';
import { upsertMarkerSection } from '../utils/markers';

interface AiInitOptions {
    claude?: boolean;
    agents?: boolean;
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

        console.log(chalk.blue('Fetching AI helper content...'));

        // Fetch AI helper content from examples repo
        const aiContent = await fetchRawFile('SolidActions', 'solidactions-examples', 'CLAUDE.md');

        // Fetch SDK reference
        const sdkContent = await fetchRawFile('SolidActions', 'solidactions-ts-sdk', 'docs/sdk-reference.md');

        // Save SDK reference to .solidactions/sdk-reference.md
        fsExtra.ensureDirSync('.solidactions');
        fs.writeFileSync('.solidactions/sdk-reference.md', sdkContent, 'utf8');
        console.log(chalk.green('✓ SDK reference saved to .solidactions/sdk-reference.md'));

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

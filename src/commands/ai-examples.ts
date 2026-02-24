import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import prompts from 'prompts';
import fsExtra from 'fs-extra';
import { fetchRawFile, listRepoContents } from '../utils/github';
import { findAiHelperFile, upsertMarkerSection } from '../utils/markers';

interface AiExamplesOptions {
    all?: boolean;
    overwrite?: boolean;
}

async function downloadDirectory(owner: string, repo: string, remotePath: string, localPath: string): Promise<void> {
    const contents = await listRepoContents(owner, repo, remotePath);
    fsExtra.ensureDirSync(localPath);

    for (const item of contents) {
        const localItemPath = path.join(localPath, item.name);

        if (item.type === 'file') {
            const content = await fetchRawFile(owner, repo, `${remotePath}/${item.name}`);
            fs.writeFileSync(localItemPath, content, 'utf8');
        } else if (item.type === 'dir') {
            await downloadDirectory(owner, repo, `${remotePath}/${item.name}`, localItemPath);
        }
    }
}

export async function aiExamples(names: string[], options: AiExamplesOptions = {}) {
    try {
        console.log(chalk.blue('Discovering available examples...'));

        // Discover available examples
        const repoContents = await listRepoContents('SolidActions', 'solidactions-examples');
        const availableExamples = repoContents.filter(
            (item) => item.type === 'dir' && !item.name.startsWith('.')
        );

        if (availableExamples.length === 0) {
            console.log(chalk.yellow('No examples found in the repository.'));
            process.exit(0);
        }

        // Determine which to clone
        let selected: string[];

        if (options.all) {
            selected = availableExamples.map((e) => e.name);
        } else if (names.length > 0) {
            const availableNames = availableExamples.map((e) => e.name);
            for (const name of names) {
                if (!availableNames.includes(name)) {
                    console.error(chalk.red(`Example "${name}" not found. Available: ${availableNames.join(', ')}`));
                    process.exit(1);
                }
            }
            selected = names;
        } else {
            const response = await prompts({
                type: 'multiselect',
                name: 'selected',
                message: 'Select examples to install',
                choices: availableExamples.map((e) => ({ title: e.name, value: e.name })),
            });

            if (!response.selected || response.selected.length === 0) {
                console.log(chalk.yellow('No examples selected.'));
                process.exit(0);
            }

            selected = response.selected;
        }

        // Clone each selected example
        const examplesDir = '.solidactions/examples';
        let installedCount = 0;

        for (const name of selected) {
            const localDir = path.join(examplesDir, name);

            if (fs.existsSync(localDir) && !options.overwrite) {
                console.log(chalk.yellow(`Example "${name}" already exists. Use --overwrite to replace.`));
                continue;
            }

            if (fs.existsSync(localDir) && options.overwrite) {
                fsExtra.removeSync(localDir);
            }

            console.log(chalk.gray(`Downloading ${name}...`));
            await downloadDirectory('SolidActions', 'solidactions-examples', name, localDir);
            console.log(chalk.green(`✓ Installed example: ${name}`));
            installedCount++;
        }

        // Detect AI helper file and upsert examples reference
        const aiHelperFile = findAiHelperFile();
        if (!aiHelperFile) {
            console.log(chalk.yellow('No AI helper file found. Run "solidactions ai:init" first to create one.'));
        } else {
            // List ALL installed examples (existing + newly installed)
            const allInstalled: string[] = [];
            if (fs.existsSync(examplesDir)) {
                const dirs = fs.readdirSync(examplesDir, { withFileTypes: true });
                for (const dir of dirs) {
                    if (dir.isDirectory()) {
                        allInstalled.push(dir.name);
                    }
                }
            }

            const examplesList = allInstalled.map((name) => `- ${name}`).join('\n');
            const examplesNote = `## SolidActions Examples

Example workflows are available in \`.solidactions/examples/\`. Use these as reference patterns when writing SolidActions workflows.

Installed examples:
${examplesList}

When writing workflows, check these examples for patterns covering steps, sleep, signals, child workflows, retries, events, messaging, parallel execution, scheduling, OAuth, streaming, and webhooks.`;

            upsertMarkerSection(aiHelperFile, 'SolidActions Examples', examplesNote);
        }

        console.log(chalk.green(`✓ Installed ${installedCount} example(s) to .solidactions/examples/`));
    } catch (error: any) {
        if (error.message?.includes('rate limit')) {
            console.error(chalk.red(error.message));
        } else if (error.message?.includes('not found')) {
            console.error(chalk.red(error.message));
        } else if (error.message?.includes('Failed to')) {
            console.error(chalk.red('Network error: Could not reach GitHub. Check your internet connection.'));
        } else {
            console.error(chalk.red('Error:'), error.message);
        }
        process.exit(1);
    }
}

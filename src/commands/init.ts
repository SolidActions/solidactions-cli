import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import fsExtra from 'fs-extra';
import { fetchRawFile } from '../utils/github';
import { EXAMPLES_REF } from '../utils/examples-ref';
import { aiInit, resolveAiHelperTarget } from './ai-init';
import type { AiHelperTarget } from '../utils/skills';

interface InitOptions {
    skills?: boolean;  // commander inverts --no-skills into skills: false
    claude?: boolean;
    agents?: boolean;
}

const EXAMPLES_OWNER = 'SolidActions';
const EXAMPLES_REPO = 'solidactions-examples';
const TEMPLATE_PREFIX = 'templates/minimal';

// Tuples of [remote-path-suffix-under-template-prefix, local-path-relative-to-target].
export const TEMPLATE_FILES: Array<[string, string]> = [
    ['package.json', 'package.json'],
    ['package-lock.json', 'package-lock.json'],
    ['tsconfig.json', 'tsconfig.json'],
    ['solidactions.yaml', 'solidactions.yaml'],
    ['.env.example', '.env.example'],
    ['src/hello.ts', 'src/hello.ts'],
];

function firstNonDotEntry(target: string): string | null {
    if (!fs.existsSync(target)) return null;
    const entries = fs.readdirSync(target);
    for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        return entry;
    }
    return null;
}

export async function init(directory: string | undefined, options: InitOptions = {}) {
    try {
        const cwd = process.cwd();
        const installSkills = options.skills !== false;  // default true

        const targetDir = directory ? path.resolve(cwd, directory) : cwd;
        const projectName = path.basename(targetDir);

        if (directory) {
            fsExtra.ensureDirSync(targetDir);
        }

        const offender = firstNonDotEntry(targetDir);
        if (offender) {
            console.error(chalk.red(`Target directory "${targetDir}" is not empty (contains "${offender}").`));
            console.error(chalk.gray('Run in a fresh directory, or use `solidactions ai init` to add AI tooling to an existing project.'));
            process.exit(1);
        }

        // Validate flags BEFORE any network fetch/write — previously this check
        // lived only inside aiInit(), which runs after the template files are
        // already fetched and written.
        if (installSkills && options.claude && options.agents) {
            console.error(chalk.red('Please specify only one of --claude or --agents'));
            process.exit(1);
        }

        // Resolve the AI-helper target (CLAUDE.md vs AGENTS.md) UP FRONT, before
        // writing any template file. Previously this decision was made inside
        // aiInit(), AFTER the scaffold was already written — in a non-TTY shell
        // with no --claude/--agents flag, the resulting unanswerable prompt left
        // a half-scaffolded project (no CLAUDE.md/AGENTS.md, no .claude/skills/).
        let aiHelperTarget: AiHelperTarget | undefined;
        if (installSkills) {
            aiHelperTarget = await resolveAiHelperTarget({ claude: options.claude, agents: options.agents });
        }

        console.log(chalk.blue(`Scaffolding "${projectName}" in ${targetDir}...`));

        for (const [remoteSuffix, localSuffix] of TEMPLATE_FILES) {
            const remotePath = `${TEMPLATE_PREFIX}/${remoteSuffix}`;
            // Pinned to EXAMPLES_REF: unpinned, this loop scaffolded whatever
            // was on the examples repo's default branch — including the
            // @solidactions/sdk version the new project declares (#86).
            let content = await fetchRawFile(EXAMPLES_OWNER, EXAMPLES_REPO, remotePath, EXAMPLES_REF);
            content = content.replace(/__PROJECT_NAME__/g, projectName);

            const outPath = path.join(targetDir, localSuffix);
            fsExtra.ensureDirSync(path.dirname(outPath));
            fs.writeFileSync(outPath, content, 'utf8');
            console.log(chalk.green(`✓ ${path.relative(cwd, outPath)}`));
        }

        if (installSkills) {
            console.log('');
            process.chdir(targetDir);
            await aiInit({ claude: options.claude, agents: options.agents }, aiHelperTarget);
        }

        console.log('');
        console.log(chalk.green(`✓ Project "${projectName}" scaffolded.`));
        console.log('');
        console.log(chalk.blue('Next steps:'));
        if (directory) {
            console.log(chalk.gray(`  cd ${directory}`));
        }
        console.log(chalk.gray('  npm install'));
        console.log(chalk.gray(`  solidactions project deploy ${projectName} -e production`));
        console.log(chalk.gray(`  # If your workflow uses a webhook, retrieve its auto-generated secret`));
        console.log(chalk.gray(`  # and set that value in your sender (e.g. Telegram secret_token):`));
        console.log(chalk.gray(`  solidactions webhook secret ${projectName} -e production`));
    } catch (err: any) {
        if (err.message?.includes('rate limit')) {
            console.error(chalk.red(err.message));
        } else if (err.message?.includes('not found')) {
            console.error(chalk.red(err.message));
        } else if (err.message?.includes('Failed to fetch')) {
            console.error(chalk.red('Network error: Could not reach GitHub to fetch the template. Check your internet connection.'));
        } else {
            console.error(chalk.red('Error:'), err.message);
        }
        process.exit(1);
    }
}

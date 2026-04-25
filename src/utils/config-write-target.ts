import fs from 'fs';
import path from 'path';
import readline from 'readline';
import chalk from 'chalk';
import { getGlobalConfigPath, getLocalConfigPath } from './config';

export type WriteTarget = 'local' | 'global';

/**
 * Decide whether a write should target the local or global config file,
 * mirroring the contract used by `login`:
 *  - --local / --global mutually exclusive (errors if both set).
 *  - If exactly one is set, use it.
 *  - Else if TTY, prompt.
 *  - Else error and exit.
 */
export async function decideWriteTarget(
    options: { local?: boolean; global?: boolean },
    promptLabel = 'Save config locally (./.solidactions) or globally (~/.solidactions)? [global] ',
): Promise<WriteTarget> {
    if (options.local && options.global) {
        console.error(chalk.red('Error: --local and --global are mutually exclusive.'));
        process.exit(1);
    }
    if (options.local) return 'local';
    if (options.global) return 'global';

    if (process.stdin.isTTY) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
            while (true) {
                const answer = await new Promise<string>((resolve) => rl.question(chalk.blue(promptLabel), resolve));
                const normalized = answer.trim().toLowerCase();
                if (normalized === '' || normalized === 'global' || normalized === 'g') return 'global';
                if (normalized === 'local' || normalized === 'l') return 'local';
                console.log(chalk.yellow("Please answer 'local' or 'global' (or press Enter for global)."));
            }
        } finally {
            rl.close();
        }
    }
    console.error(chalk.red('Refusing to write config non-interactively. Pass --local or --global.'));
    process.exit(1);
}

export function pathForTarget(target: WriteTarget): string {
    return target === 'local' ? getLocalConfigPath() : getGlobalConfigPath();
}

/**
 * Ensure `.solidactions/` is in the target directory's `.gitignore`.
 * Idempotent. Skips silently if pattern is already covered.
 */
export async function ensureGitignoreCovers(targetDir: string, auto: boolean): Promise<void> {
    const gitignorePath = path.join(targetDir, '.gitignore');
    const patternToAdd = '.solidactions/';

    let existing = '';
    if (fs.existsSync(gitignorePath)) {
        existing = fs.readFileSync(gitignorePath, 'utf-8');
        const lines = existing.split('\n').map((l) => l.trim());
        const isCovered = lines.some((line) => {
            const normalized = line
                .replace(/^\*\*\//, '')
                .replace(/^\//, '')
                .replace(/\/(\*\*|\*)?$/, '');
            return normalized === '.solidactions';
        });
        if (isCovered) return;
    }

    let shouldAdd = auto;
    if (!shouldAdd && process.stdin.isTTY) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        let answer: string;
        try {
            answer = await new Promise<string>((resolve) => {
                rl.question(
                    chalk.yellow(`Local config directory may contain secrets. Add \`.solidactions/\` to ${gitignorePath}? [Y/n] `),
                    resolve,
                );
            });
        } finally {
            rl.close();
        }
        shouldAdd = !(answer.trim().toLowerCase().startsWith('n'));
    }

    if (!shouldAdd) {
        console.log(chalk.yellow(`Skipping .gitignore update. Remember: ${path.join(targetDir, '.solidactions', 'config.json')} may contain your API key.`));
        return;
    }

    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    try {
        fs.writeFileSync(gitignorePath, `${existing}${prefix}${patternToAdd}\n`);
        console.log(chalk.green(`Added \`${patternToAdd}\` to ${gitignorePath}.`));
    } catch (err: any) {
        console.log(chalk.yellow(`Could not update ${gitignorePath}: ${err.message}. Add \`.solidactions/\` to it manually.`));
    }
}

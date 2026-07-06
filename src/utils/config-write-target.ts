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
    refusalMessage = 'Refusing to write config non-interactively. Pass --local or --global.',
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
    console.error(chalk.red(refusalMessage));
    process.exit(1);
}

export function pathForTarget(target: WriteTarget): string {
    return target === 'local' ? getLocalConfigPath() : getGlobalConfigPath();
}

/**
 * Notify (and, on a TTY, confirm) that an existing config file is about to be
 * overwritten. A backup will be written to `backupPath` regardless of mode —
 * this always says so. Non-interactive callers (CI, agents) proceed
 * automatically so they never wedge; an interactive TTY additionally asks a
 * y/N confirm (default N).
 */
export async function confirmOverwrite(existingPath: string, backupPath: string): Promise<boolean> {
    const notice = `Existing config at ${existingPath} will be overwritten (backup will be saved to ${backupPath}).`;

    if (!process.stdin.isTTY) {
        console.log(chalk.yellow(notice));
        return true;
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await new Promise<string>((resolve) => rl.question(chalk.yellow(`${notice} Continue? [y/N] `), resolve));
        return answer.trim().toLowerCase().startsWith('y');
    } finally {
        rl.close();
    }
}

/**
 * Ensure `.solidactions/` is in the target directory's `.gitignore`.
 * Idempotent. Skips silently if pattern is already covered.
 */
/** Walk up from startDir looking for a `.git` directory. Stops at filesystem root. */
function findGitRoot(startDir: string): string | null {
    let dir = path.resolve(startDir);
    while (true) {
        if (fs.existsSync(path.join(dir, '.git'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

export async function ensureGitignoreCovers(targetDir: string, auto: boolean): Promise<void> {
    // Not in a git repo — a .gitignore entry protects nothing here; skip silently.
    if (!findGitRoot(targetDir)) return;

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

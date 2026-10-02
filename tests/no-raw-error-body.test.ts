/**
 * Static guard (cli#156): no command prints a raw API error body, and none
 * prints the old context-free 401 text. A debug-mode server puts a whole stack
 * trace in the body, so the only allowed prints go through formatApiFailure /
 * formatValidationError / authFailedLine.
 *
 * The matcher flags only a BARE top-level `error.response.data` argument of a
 * console call (or a JSON.stringify of it), so the wrapped helper calls pass.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const COMMANDS_DIR = path.resolve(__dirname, '../src/commands');

const RAW_BODY_PATTERNS: RegExp[] = [
    // a console call whose first argument is closed and whose next top-level argument is the body
    /\)\s*,\s*error\.response\.data(\?\.message \?\? error\.response\.data)?\s*\)\s*;/,
    // a console call whose first argument is the body itself
    /console\.\w+\(\s*error\.response\.data\b/,
    /JSON\.stringify\(error\.response\.data/,
    // the old 401 text that names no host
    /Authentication failed\. Run/,
];

export function flagsRawErrorBody(line: string): boolean {
    return RAW_BODY_PATTERNS.some((pattern) => pattern.test(line));
}

describe('flagsRawErrorBody matcher', () => {
    it.each([
        'console.error(chalk.red(formatApiFailure(error.response.status, error.response.data)));',
        'console.error(chalk.red(formatValidationError(error.response.data)));',
        'return formatValidationError(error.response.data);',
    ])('accepts the prescribed one-line form: %s', (line) => {
        expect(flagsRawErrorBody(line)).toBe(false);
    });

    it.each([
        'console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);',
        'console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data?.message ?? error.response.data);',
        'console.error(error.response.status, JSON.stringify(error.response.data, null, 2));',
        'console.error(chalk.red(\'Authentication failed. Run "solidactions login --global" to re-configure.\'));',
    ])('flags a raw body or the old 401 text: %s', (line) => {
        expect(flagsRawErrorBody(line)).toBe(true);
    });
});

describe('command sources', () => {
    it('print no raw API error body and no host-less 401 text', () => {
        const offenders: string[] = [];
        for (const file of fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.ts'))) {
            const lines = fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf8').split('\n');
            lines.forEach((line, index) => {
                if (flagsRawErrorBody(line)) {
                    offenders.push(`src/commands/${file}:${index + 1}: ${line.trim()}`);
                }
            });
        }

        expect(offenders).toEqual([]);
    });
});

/**
 * No connection command reaches `console.` directly (cli#219, final review 3 I8).
 *
 * Fail closed: the connection commands write output ONLY through out()/err()
 * in src/utils/output.ts, which always applies plainText. So this sweep does
 * no argument parsing at all: it reads every `src/commands/connection-*.ts`
 * file and fails on any occurrence of the bare word `console` (whatever
 * member access follows, however spaced: `console.log(x)`,
 * `console .error (x)`, a newline between `console` and `.log`) or of
 * `process.stdout` / `process.stderr` with any spacing. A regex that names
 * the objects cannot be bypassed by reformatting the call.
 *
 * Deliberately comment-blind: even a comment naming `console` fails the
 * sweep, and an unrelated identifier such as `consoled` passes (word
 * boundary). Both are documented choices, not gaps.
 *
 * Test-double policy: the guard reads real source files on disk; no
 * mock/spy/stub libraries.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

interface BannedOutputRef {
    line: number;
    text: string;
}

const BANNED_PATTERNS = [/\bconsole\b/g, /\bprocess\s*\.\s*(stdout|stderr)\b/g];

/** Every direct process-output reference in `source`, with 1-based lines. */
export function findBannedOutputRefs(source: string): BannedOutputRef[] {
    const refs: BannedOutputRef[] = [];
    for (const pattern of BANNED_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(source)) !== null) {
            refs.push({
                line: source.slice(0, match.index).split('\n').length,
                text: match[0],
            });
        }
    }
    return refs.sort((a, b) => a.line - b.line);
}

describe('findBannedOutputRefs (fixtures)', () => {
    it('flags a plain console.log call', () => {
        expect(findBannedOutputRefs('console.log(x);')).toEqual([{ line: 1, text: 'console' }]);
    });

    it('flags whitespace between console and the member access', () => {
        expect(findBannedOutputRefs('console .error (x);')).toEqual([{ line: 1, text: 'console' }]);
    });

    it('flags a newline between console and the member access', () => {
        expect(findBannedOutputRefs('console\n  .log(x);')).toEqual([{ line: 1, text: 'console' }]);
    });

    it('flags a spaced process.stderr.write call', () => {
        expect(findBannedOutputRefs('process.stderr .write(x);')).toEqual([{ line: 1, text: 'process.stderr' }]);
    });

    it('flags a newline inside a process.stdout access', () => {
        expect(findBannedOutputRefs('process\n.stdout.write(x);')).toEqual([{ line: 1, text: 'process\n.stdout' }]);
    });

    it('passes an unrelated identifier containing console', () => {
        expect(findBannedOutputRefs('consoled.log(x);')).toEqual([]);
    });

    it('flags the word console even inside a comment, by design', () => {
        expect(findBannedOutputRefs('// console.log(x);\nok();\n')).toEqual([{ line: 1, text: 'console' }]);
    });

    it('reports the line of an offending reference', () => {
        expect(findBannedOutputRefs('ok();\nconsole.log(raw);\n')).toEqual([{ line: 2, text: 'console' }]);
    });
});

function connectionCommandFiles(): Array<{ file: string; source: string }> {
    const dir = path.resolve(__dirname, '../src/commands');
    return fs
        .readdirSync(dir)
        .filter((entry) => entry.startsWith('connection-') && entry.endsWith('.ts'))
        .sort()
        .map((file) => ({ file, source: fs.readFileSync(path.join(dir, file), 'utf8') }));
}

describe('every connection-command print goes through out()/err()', () => {
    it('has no console reference in src/commands/connection-*.ts', () => {
        const findings: string[] = [];

        for (const { file, source } of connectionCommandFiles()) {
            for (const ref of findBannedOutputRefs(source)) {
                if (ref.text === 'console') {
                    findings.push(`${file}:${ref.line}  ${ref.text}`);
                }
            }
        }

        expect(findings).toEqual([]);
    });

    it('has no process.stdout or process.stderr reference in src/commands/connection-*.ts', () => {
        const findings: string[] = [];

        for (const { file, source } of connectionCommandFiles()) {
            for (const ref of findBannedOutputRefs(source)) {
                if (ref.text !== 'console') {
                    findings.push(`${file}:${ref.line}  ${ref.text}`);
                }
            }
        }

        expect(findings).toEqual([]);
    });
});

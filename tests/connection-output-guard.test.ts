/**
 * Every string the connection commands print passes through plainText (cli#219,
 * final review 2 I7 family sweep).
 *
 * `connection list` printed HTTP and network failures without stripping
 * terminal control bytes while connect and wait already stripped theirs, and
 * reviewing each print site by hand is what let the two list emitters slip
 * through. So this guard reads every `src/commands/connection-*.ts` file and
 * fails on any `console.error`/`console.log`/`console.warn`/`console.info`/
 * `console.debug`/`console.table` argument that is neither wrapped in
 * `plainText(...)`, `fail(...)` or `authFailedLine(...)` (possibly inside
 * `chalk.<colour>(...)`) nor one single literal string with no interpolation
 * and no concatenation. A companion row fails on any `process.stdout.write(`
 * or `process.stderr.write(`, which would bypass the guard silently.
 *
 * Modeled on tests/host-display-guard.test.ts: a small scanner plus fixture rows.
 *
 * Test-double policy: the guard parses real source files on disk; no
 * mock/spy/stub libraries.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

interface ConsoleFinding {
    line: number;
    arg: string;
}

/** Index just past a quoted ('...', "...") string starting at `pos`. */
function skipQuoted(source: string, pos: number): number {
    const quote = source[pos];
    let i = pos + 1;
    while (i < source.length && source[i] !== quote) {
        i += source[i] === '\\' ? 2 : 1;
    }
    return i + 1;
}

/** Index just past a template literal starting at `pos`, handling nested `${...}`. */
function skipTemplate(source: string, pos: number): number {
    let i = pos + 1;
    while (i < source.length && source[i] !== '`') {
        if (source[i] === '\\') {
            i += 2;
            continue;
        }
        if (source[i] === '$' && source[i + 1] === '{') {
            i = skipBalanced(source, i + 1, '{', '}');
            continue;
        }
        i += 1;
    }
    return i + 1;
}

/** Index just past the bracket matching the opener at `pos`. */
function skipBalanced(source: string, pos: number, open: string, close: string): number {
    let depth = 0;
    let i = pos;
    while (i < source.length) {
        const ch = source[i];
        if (ch === '/' && source[i + 1] === '/') {
            const newline = source.indexOf('\n', i);
            i = newline === -1 ? source.length : newline;
            continue;
        }
        if (ch === '/' && source[i + 1] === '*') {
            const end = source.indexOf('*/', i + 2);
            i = end === -1 ? source.length : end + 2;
            continue;
        }
        if (ch === "'" || ch === '"') {
            i = skipQuoted(source, i);
            continue;
        }
        if (ch === '`') {
            i = skipTemplate(source, i);
            continue;
        }
        if (ch === open) depth += 1;
        if (ch === close) {
            depth -= 1;
            if (depth === 0) return i + 1;
        }
        i += 1;
    }
    return i;
}

/** Splits a call's argument text at top-level commas. */
function splitArgs(argsText: string): string[] {
    const args: string[] = [];
    let depth = 0;
    let start = 0;
    let i = 0;
    while (i < argsText.length) {
        const ch = argsText[i];
        if (ch === "'" || ch === '"') {
            i = skipQuoted(argsText, i);
            continue;
        }
        if (ch === '`') {
            i = skipTemplate(argsText, i);
            continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') depth += 1;
        if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
        if (ch === ',' && depth === 0) {
            args.push(argsText.slice(start, i));
            start = i + 1;
        }
        i += 1;
    }
    args.push(argsText.slice(start));
    return args;
}

/** True when `expr` is a `name(...)` call closed by its final character. */
function isCallTo(expr: string, names: string[]): boolean {
    const match = new RegExp(`^(${names.join('|')})\\(`).exec(expr);
    if (!match) return false;
    return skipBalanced(expr, match[0].length - 1, '(', ')') === expr.length;
}

/**
 * True for one single-quoted, double-quoted, or interpolation-free template
 * literal and nothing else. A literal joined to more expression with a
 * top-level `+` (e.g. `'x' + error.message`) is concatenation, not a bare
 * literal, and must be wrapped like any other expression.
 */
function isBareLiteral(expr: string): boolean {
    if (expr.startsWith("'") || expr.startsWith('"')) {
        return skipQuoted(expr, 0) === expr.length;
    }
    if (expr.startsWith('`')) {
        return skipTemplate(expr, 0) === expr.length && !/(?<!\\)\$\{/.test(expr.slice(1, -1));
    }
    return false;
}

/** True when a console argument is wrapped in an allowed sanitizer or is a bare literal. */
function isCleanArg(arg: string): boolean {
    let expr = arg.trim();
    for (;;) {
        const chalk = /^chalk\.[A-Za-z]+\(/.exec(expr);
        if (!chalk || skipBalanced(expr, chalk[0].length - 1, '(', ')') !== expr.length) break;
        expr = expr.slice(chalk[0].length, -1).trim();
    }
    return isBareLiteral(expr) || isCallTo(expr, ['plainText', 'fail', 'authFailedLine']);
}

export function findRawConsoleArgs(source: string): ConsoleFinding[] {
    const findings: ConsoleFinding[] = [];
    let i = 0;
    while (i < source.length) {
        const ch = source[i];
        if (ch === '/' && source[i + 1] === '/') {
            const newline = source.indexOf('\n', i);
            i = newline === -1 ? source.length : newline;
            continue;
        }
        if (ch === '/' && source[i + 1] === '*') {
            const end = source.indexOf('*/', i + 2);
            i = end === -1 ? source.length : end + 2;
            continue;
        }
        if (ch === "'" || ch === '"') {
            i = skipQuoted(source, i);
            continue;
        }
        if (ch === '`') {
            i = skipTemplate(source, i);
            continue;
        }
        const call = /^console\.(error|log|warn|info|debug|table)\(/.exec(source.slice(i, i + 24));
        if (call) {
            const line = source.slice(0, i).split('\n').length;
            const open = i + call[0].length - 1;
            const end = skipBalanced(source, open, '(', ')');
            for (const arg of splitArgs(source.slice(open + 1, end - 1))) {
                const trimmed = arg.trim();
                if (trimmed !== '' && !isCleanArg(trimmed)) {
                    findings.push({ line, arg: trimmed.replace(/\s+/g, ' ') });
                }
            }
            i = end;
            continue;
        }
        i += 1;
    }
    return findings;
}

describe('findRawConsoleArgs (fixtures)', () => {
    it('flags a raw formatApiFailure inside chalk', () => {
        expect(findRawConsoleArgs('console.error(chalk.red(formatApiFailure(s, d)));')).toEqual([
            { line: 1, arg: 'chalk.red(formatApiFailure(s, d))' },
        ]);
    });

    it('flags a raw template interpolating error.message', () => {
        expect(findRawConsoleArgs('console.error(`Connection failed: ${error.message}`);')).toEqual([
            { line: 1, arg: '`Connection failed: ${error.message}`' },
        ]);
    });

    it('flags an unwrapped second argument beside a clean first one', () => {
        expect(findRawConsoleArgs("console.error(chalk.red('Connection failed:'), error.message);")).toEqual([
            { line: 1, arg: 'error.message' },
        ]);
    });

    it('flags a quoted literal concatenated with a value', () => {
        expect(findRawConsoleArgs("console.log('x' + error.message + 'y');")).toEqual([
            { line: 1, arg: "'x' + error.message + 'y'" },
        ]);
    });

    it('flags a template literal concatenated with a value', () => {
        expect(findRawConsoleArgs('console.log(`a` + error.message + `b`);')).toEqual([
            { line: 1, arg: '`a` + error.message + `b`' },
        ]);
    });

    it('flags console.info with an unwrapped value', () => {
        expect(findRawConsoleArgs('console.info(link.name);')).toEqual([{ line: 1, arg: 'link.name' }]);
    });

    it('passes the wrapped forms', () => {
        expect(findRawConsoleArgs('console.error(chalk.red(plainText(formatApiFailure(s, d))));')).toEqual([]);
        expect(findRawConsoleArgs('console.error(chalk.red(plainText(`Connection failed: ${error.message}`)));')).toEqual([]);
        expect(findRawConsoleArgs('console.error(chalk.red(authFailedLine(config.host)));')).toEqual([]);
    });

    it('passes a literal string with no interpolation', () => {
        expect(findRawConsoleArgs("console.log('Bindings: none.');")).toEqual([]);
    });

    it('passes a wrapped template', () => {
        expect(findRawConsoleArgs('console.log(plainText(`  ${waitCommandLine(plainText(id))}`));')).toEqual([]);
    });

    it('reports the line of an offending call', () => {
        expect(findRawConsoleArgs('ok();\nconsole.log(raw);\n')).toEqual([{ line: 2, arg: 'raw' }]);
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

describe('every connection-command print passes through plainText', () => {
    it('has no raw console argument in src/commands/connection-*.ts', () => {
        const findings: string[] = [];

        for (const { file, source } of connectionCommandFiles()) {
            for (const finding of findRawConsoleArgs(source)) {
                findings.push(`${file}:${finding.line}  ${finding.arg}`);
            }
        }

        expect(findings).toEqual([]);
    });

    it('has no process.stdout.write or process.stderr.write in src/commands/connection-*.ts', () => {
        const offenders: string[] = [];

        for (const { file, source } of connectionCommandFiles()) {
            source.split('\n').forEach((lineText, index) => {
                if (lineText.includes('process.stdout.write(') || lineText.includes('process.stderr.write(')) {
                    offenders.push(`${file}:${index + 1}  ${lineText.trim()}`);
                }
            });
        }

        expect(offenders).toEqual([]);
    });
});

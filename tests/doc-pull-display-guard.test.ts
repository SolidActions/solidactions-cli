/**
 * Static guard over src/commands/doc-pull.ts (cli#189): every interpolation in
 * a printed template must be wrapped in `shown(…)` (server-derived text), be a
 * numeric id/count, a ternary of string literals, or an allowlisted name with
 * a stated reason. Reads the source as text; never executes it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const PULL_SOURCE = path.resolve(__dirname, '../src/commands/doc-pull.ts');

const PRINT_MARKERS = [
    'process.stderr.write(',
    'process.stdout.write(',
    'console.log(',
    'console.error(',
    'warnings.push(',
    'pendingWarnings.push(',
    ' warning: ',
];

/**
 * Names that may appear bare in a printed template, each with why it holds no
 * server or filesystem text. Add an entry only for such a value.
 */
const ALLOWED: Record<string, string> = {
    noun: 'string literal chosen from two',
    state: 'string literal',
    where: 'built from shown() parts in refuseLink',
    warning: 'built from shown() parts where it is pushed',
    DOCS_MANIFEST: 'constant file name',
    'download.status': 'HTTP status code from axios, a number, never server text',
    'error.pid': 'a process id, a number',
    tail: 'built from .length counts and string literals where it is assigned (the stopped-write lines)',
    updated: 'built from .length counts and a string literal where it is assigned (the manifest-not-changed lines)',
    line: 'a pendingWarnings entry, built from shown() parts where it is pushed',
    lost: 'built from shown() parts',
};

interface Interpolation {
    line: number;
    expr: string;
}

/** `${…}` expressions on one line, found with balanced-brace, quote-aware scanning. */
function extractInterpolations(line: string, lineNumber: number): Interpolation[] {
    const out: Interpolation[] = [];
    let i = 0;
    while (i < line.length) {
        const start = line.indexOf('${', i);
        if (start === -1) {
            return out;
        }
        let depth = 1;
        let j = start + 2;
        let quote: string | null = null;
        while (j < line.length && depth > 0) {
            const ch = line[j];
            if (quote !== null) {
                if (ch === '\\') {
                    j += 2;
                    continue;
                }
                if (ch === quote) {
                    quote = null;
                }
                j += 1;
                continue;
            }
            if (ch === "'" || ch === '"' || ch === '`') {
                quote = ch;
            } else if (ch === '{') {
                depth += 1;
            } else if (ch === '}') {
                depth -= 1;
            }
            j += 1;
        }
        if (depth === 0) {
            out.push({ line: lineNumber, expr: line.slice(start + 2, j - 1) });
        }
        i = j;
    }
    return out;
}

/** Split on the first depth-0 `?` and the last depth-0 `:` after it (quote-aware). */
function ternaryBranches(expr: string): [string, string] | null {
    let quote: string | null = null;
    let depth = 0;
    let question = -1;
    for (let i = 0; i < expr.length; i++) {
        const ch = expr[i];
        if (quote !== null) {
            if (ch === '\\') {
                i += 1;
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            quote = ch;
        } else if (ch === '(') {
            depth += 1;
        } else if (ch === ')') {
            depth -= 1;
        } else if (ch === '?' && depth === 0 && question === -1) {
            question = i;
        }
    }
    if (question === -1) {
        return null;
    }
    const rest = expr.slice(question + 1);
    quote = null;
    depth = 0;
    let colon = -1;
    for (let i = 0; i < rest.length; i++) {
        const ch = rest[i];
        if (quote !== null) {
            if (ch === '\\') {
                i += 1;
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            quote = ch;
        } else if (ch === '(') {
            depth += 1;
        } else if (ch === ')') {
            depth -= 1;
        } else if (ch === ':' && depth === 0) {
            colon = i;
        }
    }
    if (colon === -1) {
        return null;
    }
    return [rest.slice(0, colon).trim(), rest.slice(colon + 1).trim()];
}

function isStringLiteral(text: string): boolean {
    return (/^'[^']*'$/.test(text) || /^"[^"]*"$/.test(text));
}

/** True when the whole trimmed expression is one balanced `shown(...)` call. */
function isShownCall(expr: string): boolean {
    if (!expr.startsWith('shown(') || !expr.endsWith(')')) {
        return false;
    }
    let depth = 0;
    let quote: string | null = null;
    for (let i = 0; i < expr.length; i++) {
        const ch = expr[i];
        if (quote !== null) {
            if (ch === '\\') {
                i += 1;
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            quote = ch;
        } else if (ch === '(') {
            depth += 1;
        } else if (ch === ')') {
            depth -= 1;
            if (depth === 0) {
                return i === expr.length - 1;
            }
        }
    }
    return false;
}

/** A plain property chain ending in `.id` or `.length` (optional chaining allowed). */
const PLAIN_ID_CHAIN = /^[A-Za-z_$][\w$]*(\??\.[A-Za-z_$][\w$]*)*\.(id|length)$/;

function isAllowed(expr: string): boolean {
    const trimmed = expr.trim();
    if (isShownCall(trimmed)) {
        return true;
    }
    if (PLAIN_ID_CHAIN.test(trimmed)) {
        return true;
    }
    const branches = ternaryBranches(trimmed);
    if (branches !== null && isStringLiteral(branches[0]) && isStringLiteral(branches[1])) {
        return true;
    }
    return Object.hasOwn(ALLOWED, trimmed);
}

/** `line: expr` for every non-allowed interpolation on lines that print. */
function checkSource(source: string): string[] {
    const findings: string[] = [];
    source.split('\n').forEach((line, index) => {
        if (!PRINT_MARKERS.some((marker) => line.includes(marker))) {
            return;
        }
        for (const { line: lineNumber, expr } of extractInterpolations(line, index + 1)) {
            if (!isAllowed(expr)) {
                findings.push(`${lineNumber}: ${expr.trim()}`);
            }
        }
    });
    return findings;
}

describe('doc-pull display guard', () => {
    it('reports a bare title interpolation', () => {
        expect(checkSource('process.stderr.write(`x ${doc.title}`);')).toEqual(['1: doc.title']);
    });

    it('reports a shown() call with trailing content', () => {
        expect(checkSource('process.stderr.write(`x ${shown(a) + b}`);')).toEqual(['1: shown(a) + b']);
    });

    it('reports a call result ending in .id', () => {
        expect(checkSource('process.stderr.write(`x ${f(x).id}`);')).toEqual(['1: f(x).id']);
    });

    it('accepts a whole shown() call and a plain .id chain', () => {
        expect(checkSource('process.stderr.write(`x ${shown(doc.title)} and ${p.doc.id}`);')).toEqual([]);
    });

    it('reports a bare interpolation in a deferred warning pushed onto pendingWarnings', () => {
        expect(checkSource('pendingWarnings.push(`! x ${doc.title}`);')).toEqual(['1: doc.title']);
        expect(checkSource('pendingWarnings.push(`! x ${shown(doc.title)} and ${p.doc.id}`);')).toEqual([]);
    });

    it('inspects every pendingWarnings.push producer in doc-pull.ts: dropping any one shown() is reported', () => {
        const lines = fs.readFileSync(PULL_SOURCE, 'utf8').split('\n');
        const producers = lines.flatMap((line, index) => (line.includes('pendingWarnings.push(') ? [index] : []));
        expect(producers.length).toBeGreaterThan(0);
        for (const index of producers) {
            const unwrapped = lines.slice();
            unwrapped[index] = unwrapped[index].replace(/\$\{shown\(([^()]*)\)\}/, '${$1}');
            expect(unwrapped[index]).not.toBe(lines[index]);
            expect(checkSource(unwrapped.join('\n')).map((finding) => Number(finding.split(':')[0]))).toContain(index + 1);
        }
    });

    it('every printed interpolation in doc-pull.ts is shown(), numeric, a literal ternary, or allowlisted', () => {
        expect(checkSource(fs.readFileSync(PULL_SOURCE, 'utf8'))).toEqual([]);
    });
});

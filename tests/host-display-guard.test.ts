/**
 * One host display, structurally guarded (cli#163, wave cli-safety Task 2).
 *
 * A host in a configuration may carry userinfo (`http://user:pass@host`), so
 * every host the CLI PRINTS must go through `displayHost`. Reviewing each print
 * site by hand missed `whoami`, the mutation banner and the debug dump in turn,
 * so this guard reads every `src/**` file and fails on any template
 * interpolation that names a host and is neither sanitised nor a request URL.
 *
 * PM ruling 11: each `${...}` interpolation is judged on its own, never the line
 * as a whole, so a line that sanitises one host and prints another is a finding.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { displayHost } from '../src/utils/host-display';

interface TemplateLiteral {
    start: number;
    end: number;
    quasis: string[];
    exprs: Array<{ start: number; end: number }>;
}

/** Finds every template literal in `src`, including ones nested inside `${...}`. */
function collectTemplates(src: string): TemplateLiteral[] {
    const found: TemplateLiteral[] = [];

    function skipLineComment(pos: number): number {
        const newline = src.indexOf('\n', pos);
        return newline === -1 ? src.length : newline;
    }

    function skipBlockComment(pos: number): number {
        const close = src.indexOf('*/', pos + 2);
        return close === -1 ? src.length : close + 2;
    }

    function skipQuoted(pos: number): number {
        const quote = src[pos];
        let i = pos + 1;
        while (i < src.length && src[i] !== quote) {
            i += src[i] === '\\' ? 2 : 1;
        }
        return i + 1;
    }

    function skipRegex(pos: number): number {
        let i = pos + 1;
        let inClass = false;
        while (i < src.length) {
            const ch = src[i];
            if (ch === '\\') {
                i += 2;
                continue;
            }
            if (ch === '[') inClass = true;
            else if (ch === ']') inClass = false;
            else if (ch === '/' && !inClass) return i + 1;
            i += 1;
        }
        return i;
    }

    // Scans code from `pos`; when `inInterpolation`, returns the index of the `}` closing it.
    function scanCode(pos: number, inInterpolation: boolean): number {
        let depth = 0;
        let previous = '';
        while (pos < src.length) {
            const ch = src[pos];
            if (ch === '/' && src[pos + 1] === '/') {
                pos = skipLineComment(pos);
                continue;
            }
            if (ch === '/' && src[pos + 1] === '*') {
                pos = skipBlockComment(pos);
                continue;
            }
            if (ch === "'" || ch === '"') {
                pos = skipQuoted(pos);
                previous = ch;
                continue;
            }
            if (ch === '`') {
                pos = scanTemplate(pos);
                previous = '`';
                continue;
            }
            if (ch === '/' && (previous === '' || '(,=:[!&|?{};+-*%<>~^'.includes(previous))) {
                pos = skipRegex(pos);
                previous = '/';
                continue;
            }
            if (inInterpolation) {
                if (ch === '{') depth += 1;
                if (ch === '}') {
                    if (depth === 0) return pos;
                    depth -= 1;
                }
            }
            if (!/\s/.test(ch)) previous = ch;
            pos += 1;
        }
        return pos;
    }

    // `pos` is the opening backtick; returns the index just after the closing one.
    function scanTemplate(pos: number): number {
        const template: TemplateLiteral = { start: pos, end: pos, quasis: [], exprs: [] };
        let i = pos + 1;
        let text = '';
        while (i < src.length && src[i] !== '`') {
            if (src[i] === '\\') {
                text += src.slice(i, i + 2);
                i += 2;
                continue;
            }
            if (src[i] === '$' && src[i + 1] === '{') {
                template.quasis.push(text);
                text = '';
                const exprStart = i + 2;
                const exprEnd = scanCode(exprStart, true);
                template.exprs.push({ start: exprStart, end: exprEnd });
                i = exprEnd + 1;
                continue;
            }
            text += src[i];
            i += 1;
        }
        template.quasis.push(text);
        template.end = i + 1;
        found.push(template);
        return i + 1;
    }

    scanCode(0, false);
    return found;
}

/** Removes every balanced `displayHost(...)` call from an expression. */
function withoutDisplayHostCalls(expr: string): string {
    let out = expr;
    for (let at = out.indexOf('displayHost('); at !== -1; at = out.indexOf('displayHost(')) {
        let depth = 0;
        let end = at + 'displayHost'.length;
        for (; end < out.length; end += 1) {
            if (out[end] === '(') depth += 1;
            if (out[end] === ')') {
                depth -= 1;
                if (depth === 0) break;
            }
        }
        out = out.slice(0, at) + out.slice(end + 1);
    }
    return out;
}

/** Quoted string contents never name a host value, only the code around them does. */
function withoutStringLiterals(expr: string): string {
    return expr.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
}

const HOST_EXPRESSION = /([Hh]ost|keyHome)/;
const REQUEST_URL_START = /^\/(api\/|oauth\/|mcp)/;
const REQUEST_CALL_BEFORE_TEMPLATE = /(axios\.\w+\(|fetch\(|new URL\(|projectStatusUrl\()$/;

export function findRawHostInterpolations(
    source: string,
    allowlist: Array<{ expr: string }> = [],
): Array<{ line: number; expr: string }> {
    const findings: Array<{ line: number; expr: string }> = [];
    const allowed = new Set(allowlist.map((entry) => entry.expr));

    const templates = collectTemplates(source);
    for (const template of templates) {
        const startsRequest = REQUEST_CALL_BEFORE_TEMPLATE.test(source.slice(0, template.start).trimEnd());
        template.exprs.forEach((range, index) => {
            let text = source.slice(range.start, range.end);
            // Templates nested in this expression are judged on their own.
            for (const inner of templates) {
                if (inner.start > range.start && inner.end <= range.end && inner !== template) {
                    text = text.replace(source.slice(inner.start, inner.end), '``');
                }
            }
            const expr = text.replace(/\s+/g, ' ').trim();
            const naming = withoutStringLiterals(withoutDisplayHostCalls(expr));
            if (!HOST_EXPRESSION.test(naming)) return;
            if (startsRequest && REQUEST_URL_START.test(template.quasis[index + 1])) return;
            if (allowed.has(expr)) return;
            findings.push({ line: source.slice(0, range.start).split('\n').length, expr });
        });
    }

    return findings;
}

/**
 * Interpolations that name a host but are not a printed host. Each entry is the
 * exact expression, in one file, with the reason it is safe.
 */
const ALLOWLIST: Array<{ file: string; expr: string; reason: string }> = [
    { file: 'src/utils/mcp.ts', expr: 'parsed.host', reason: 'URL.host is host:port only, never userinfo' },
    { file: 'src/utils/mcp.ts', expr: 'config.host', reason: 'builds the request URL handed to new URL(), not printed' },
    { file: 'src/utils/source-provenance.ts', expr: 'host', reason: 'a git remote host, not a SolidActions host' },
    { file: 'src/commands/deploy.ts', expr: 'host', reason: 'projectStatusUrl builds a request URL and returns it, not printed' },
    { file: 'src/commands/project-logs.ts', expr: 'host', reason: 'builds the request URL for the build-log call, not printed' },
    { file: 'src/commands/state.ts', expr: 'config.host', reason: 'the base of the request URLs of the state calls, not printed' },
    { file: 'src/commands/dev.ts', expr: 'config.host', reason: 'the request URL of the variable-mappings call, not printed' },
    { file: 'src/commands/skill-run.ts', expr: 'opts.config.host', reason: 'SOLIDACTIONS_API_URL for the child process, which needs the real host' },
    { file: 'src/commands/doc-upload.ts', expr: 'authFailedLine(config.host)', reason: 'authFailedLine applies displayHost' },
    { file: 'src/commands/doc-upload.ts', expr: 'config.host', reason: 'the request URL of the media upload, assigned before the call, not printed' },
    { file: 'src/commands/deploy.ts', expr: 'projectStatusUrl(config.host, projectSlug)', reason: 'the request URL of the status poll, not printed' },
    { file: 'src/utils/database-data-plane.ts', expr: 'config.host', reason: 'the request URL passed to the injected post function, not printed' },
    { file: 'src/index.ts', expr: 'fmt(resolved.sources.host)', reason: 'a config source label, not a host value' },
    { file: 'src/commands/login.ts', expr: 'fmt(sources.host)', reason: 'a config source label, not a host value' },
    { file: 'src/utils/config.ts', expr: "describeSource(conflict.hostSource, 'SOLIDACTIONS_HOST')", reason: 'a config source label, not a host value' },
    { file: 'src/utils/config.ts', expr: 'hostFrom', reason: 'a config source label, not a host value' },
];

function listSourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return listSourceFiles(full);
        return entry.name.endsWith('.ts') ? [full] : [];
    });
}

describe('findRawHostInterpolations (fixtures)', () => {
    it('flags a printed template that merely looks like a URL', () => {
        const findings = findRawHostInterpolations('console.error(`Cannot reach ${host}/api/v1`);');

        expect(findings).toEqual([{ line: 1, expr: 'host' }]);
    });

    it('flags the raw host on a line that also sanitises another one', () => {
        const findings = findRawHostInterpolations('console.log(`${displayHost(host)} and ${config.host}`);');

        expect(findings).toEqual([{ line: 1, expr: 'config.host' }]);
    });

    it('flags a raw host with a method chain, as whoami printed it', () => {
        const findings = findRawHostInterpolations('console.log(`  Host: ${config.host.padEnd(50)}`);');

        expect(findings).toEqual([{ line: 1, expr: 'config.host.padEnd(50)' }]);
    });

    it('flags a request-shaped template that is only assigned, not sent', () => {
        const findings = findRawHostInterpolations('const shown = `${config.host}/api/v1/x`;');

        expect(findings).toEqual([{ line: 1, expr: 'config.host' }]);
    });

    it('does not flag the host that starts an axios request URL', () => {
        const findings = findRawHostInterpolations('await axios.get(`${config.host}/api/v1/x`);');

        expect(findings).toEqual([]);
    });

    it('does not flag a request URL on the line after the call opens', () => {
        const findings = findRawHostInterpolations('await axios.post(\n    `${config.host}/api/v1/projects`,\n    body,\n);');

        expect(findings).toEqual([]);
    });

    it('does not flag a displayHost call, even chained', () => {
        expect(findRawHostInterpolations('console.log(`on ${displayHost(config.host)}`);')).toEqual([]);
        expect(findRawHostInterpolations('console.log(`${displayHost(config.host).padEnd(50)}`);')).toEqual([]);
    });

    it('does not flag the word host inside a quoted string in an expression', () => {
        expect(findRawHostInterpolations("console.log(`${ok ? 'host ok' : 'no'}`);")).toEqual([]);
    });

    it('does not flag an allowlisted expression', () => {
        const findings = findRawHostInterpolations('x(`${parsed.host}`);', [{ expr: 'parsed.host' }]);

        expect(findings).toEqual([]);
    });

    it('reports the line of an interpolation inside a multi-line template', () => {
        const findings = findRawHostInterpolations('x(`a\nb ${config.host}\nc`);');

        expect(findings).toEqual([{ line: 2, expr: 'config.host' }]);
    });
});

describe('every host the CLI prints goes through displayHost', () => {
    it('has no raw host interpolation in src/ outside the allowlist', () => {
        const root = path.resolve(__dirname, '..');
        const findings: string[] = [];

        for (const file of listSourceFiles(path.join(root, 'src'))) {
            const relative = path.relative(root, file).split(path.sep).join('/');
            const allowlist = ALLOWLIST.filter((entry) => entry.file === relative);
            for (const finding of findRawHostInterpolations(fs.readFileSync(file, 'utf8'), allowlist)) {
                findings.push(`${relative}:${finding.line}  \${${finding.expr}}`);
            }
        }

        expect(findings).toEqual([]);
    });

    it('allowlists only live entries, each with a reason', () => {
        const root = path.resolve(__dirname, '..');

        for (const entry of ALLOWLIST) {
            expect(fs.existsSync(path.join(root, entry.file)), entry.file).toBe(true);
            expect(entry.reason.length, `${entry.file} ${entry.expr}`).toBeGreaterThan(10);
            expect(fs.readFileSync(path.join(root, entry.file), 'utf8'), `${entry.file} ${entry.expr}`).toContain(entry.expr);
        }
    });
});

describe('displayHost', () => {
    it('strips userinfo from a host', () => {
        expect(displayHost('http://u:p@localhost:8007')).toBe('http://localhost:8007');
    });

    it('leaves a host without userinfo unchanged', () => {
        expect(displayHost('http://localhost:8007')).toBe('http://localhost:8007');
    });

    it('shows a value that is not a URL as configured', () => {
        expect(displayHost('not a url')).toBe('not a url');
    });
});

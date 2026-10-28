/**
 * I8 module rows (cli#219, final review 3): out()/err() in
 * src/utils/output.ts always strip control bytes with plainText, and an
 * optional style runs AFTER stripping so plainText never eats the style's
 * own escape codes.
 *
 * Each row spawns a tiny node script against the BUILT dist/utils/output.js
 * so the real console runs, then asserts the captured stdout/stderr. The
 * payload travels as base64 argv so ESC bytes need no shell quoting.
 *
 * Test-double policy: a real node process, the real built module, the real
 * chalk; no mock/spy/stub libraries.
 */
import { spawnSync } from 'child_process';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const OUTPUT_JS = path.resolve(__dirname, '../dist/utils/output.js');
const CHALK_JS = require.resolve('chalk');

interface OutputCall {
    fn: 'out' | 'err';
    text: string;
    style?: 'red';
}

interface OutputResult {
    stdout: string;
    stderr: string;
    status: number | null;
}

/** Runs the calls in a fresh node process with the real console. */
function runOutputCalls(calls: OutputCall[], extraEnv: NodeJS.ProcessEnv = {}): OutputResult {
    const script = [
        'const mod = require(process.argv[1]);',
        'const chalk = require(process.argv[2]);',
        'const calls = JSON.parse(Buffer.from(process.argv[3], "base64").toString("utf8"));',
        'for (const c of calls) {',
        '  const style = c.style === "red" ? chalk.red : undefined;',
        '  (c.fn === "out" ? mod.out : mod.err)(c.text, style);',
        '}',
    ].join('\n');
    const payload = Buffer.from(JSON.stringify(calls), 'utf8').toString('base64');
    const result = spawnSync(process.execPath, ['-e', script, OUTPUT_JS, CHALK_JS, payload], {
        cwd: path.resolve(__dirname, '..'),
        env: { PATH: process.env.PATH ?? '', ...extraEnv },
        encoding: 'utf8',
    });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

const ESC = '\x1b';

describe('out()/err() strip control bytes', () => {
    it('prints a message with ESC, BEL and C1 bytes with none of them, keeping the visible text', () => {
        const outResult = runOutputCalls([{ fn: 'out', text: `a${ESC}[31mX\x07b\x85c\x9bd` }]);
        expect(outResult.status).toBe(0);
        expect(outResult.stdout).toBe('a[31mXbcd\n');
        expect(outResult.stderr).toBe('');

        const errResult = runOutputCalls([{ fn: 'err', text: `a${ESC}[31mX\x07b\x85c\x9bd` }]);
        expect(errResult.status).toBe(0);
        expect(errResult.stdout).toBe('');
        expect(errResult.stderr).toBe('a[31mXbcd\n');
    });

    it('prints the escape-parity template with a literal backslash and no ESC', () => {
        const msg = `v${ESC}X`;
        const text = `prefix \\${msg}`;
        const result = runOutputCalls([{ fn: 'out', text }]);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('prefix \\vX\n');
        expect(result.stdout).toContain('\\');
        expect(result.stdout).not.toContain(ESC);
    });

    it('strips a template expression and a nested value', () => {
        const nested = `x${ESC}Y`;
        const text = `a ${String(nested)}`;
        const result = runOutputCalls([{ fn: 'err', text }]);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('a xY\n');
    });

    it('applies a red style after stripping: chalk colour kept, inner ESC stripped', () => {
        const result = runOutputCalls([{ fn: 'err', text: `x${ESC}y`, style: 'red' }], { FORCE_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe(`${ESC}[31mxy${ESC}[39m\n`);
    });

    it('prints plain text with no style and no colour', () => {
        const result = runOutputCalls([{ fn: 'out', text: 'plain' }]);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('plain\n');
        expect(result.stdout).not.toContain(ESC);
        expect(result.stderr).toBe('');
    });
});

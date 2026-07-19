/**
 * Issues #74 and #75: --help text gaps surfaced by the device-auth cleanroom
 * gate.
 *   #74 — `workspace set --help` must document --local/--global and the
 *          default behavior when neither is passed.
 *   #75 — `login --help` must note that SOLIDACTIONS_API_KEY takes precedence
 *          and makes the (device) login flow unnecessary.
 *
 * Test-double policy: spawns the real built CLI binary (dist/index.js) and
 * asserts on rendered --help output — the same approach as
 * tests/dev-help-env-example.test.ts and tests/flag-consistency.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import { describe, expect, it } from 'vitest';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

function help(args: string[]): string {
    const result = childProcess.spawnSync(process.execPath, [CLI_BINARY, ...args, '--help'], {
        encoding: 'utf8',
        timeout: 15_000,
    });
    return result.stdout;
}

describe('device-auth follow-up --help docs', () => {
    it('CLI is built', () => {
        expect(fs.existsSync(CLI_BINARY)).toBe(true);
    });

    it('#74 workspace set --help documents --local/--global and the default', () => {
        const out = help(['workspace', 'set']);
        expect(out).toContain('--local');
        expect(out).toContain('--global');
        // Commander wraps long lines; match across whitespace/newlines.
        expect(out).toMatch(/mutually\s+exclusive/);
        expect(out).toMatch(/default:\s+global/);
        expect(out).toMatch(/non-interactive/);
    });

    it('#75 login --help documents SOLIDACTIONS_API_KEY precedence', () => {
        const out = help(['login']);
        expect(out).toContain('SOLIDACTIONS_API_KEY');
        expect(out).toMatch(/takes\s+precedence/);
        // Makes the (device) login flow unnecessary.
        expect(out).toMatch(/login --device/);
    });
});

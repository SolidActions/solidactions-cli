/**
 * Issue #994: `--host` and `--dev` on `solidactions login` are internal-only
 * (used by dev/staging/e2e tooling). AI agents were reading
 * `solidactions login --help`, seeing them advertised, and wrongly concluding
 * they must pass `--host` — mis-pointing sessions at the wrong host.
 *
 * Both flags must keep WORKING (see tests/flag-consistency.test.ts and
 * tests/login-host-hint.test.ts for behavior coverage). `--dev` stays out of
 * `--help`; `--host` is listed again since cli#124 (PM ruling 21): the
 * credential-pair refusal tells the user to run `login --local --host <url>`,
 * so `login --help` must document it.
 *
 * Test-double policy: spawns the real built CLI binary (dist/index.js) and
 * asserts on rendered --help output — same approach as
 * tests/help-device-auth-followups.test.ts.
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

describe('login --help hides the internal-only --dev flag (#994) and lists --host (cli#124)', () => {
    it('CLI is built', () => {
        expect(fs.existsSync(CLI_BINARY)).toBe(true);
    });

    it('advertises --host <url>, the documented way to log in to a folder\'s own server (cli#124, PM ruling 21)', () => {
        const out = help(['login']);
        expect(out).toContain('--host <url>');
    });

    it('does not advertise --dev as an option (distinct from the legitimate --device flag)', () => {
        const out = help(['login']);
        // --dev is a prefix of --device, so a naive `.toContain('--dev')` would
        // false-positive against the (legitimate, still-advertised) --device
        // flag. \b requires a non-word boundary right after "--dev", which
        // "--device" does not have (v/i are both word chars), so this
        // correctly distinguishes the two.
        expect(out).not.toMatch(/--dev\b/);
        // Sanity check the word-boundary assertion actually discriminates:
        // --device itself must still be present and documented.
        expect(out).toContain('--device');
    });
});

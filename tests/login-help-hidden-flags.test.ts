/**
 * Issue #994: `--host` and `--dev` on `solidactions login` are internal-only
 * (used by dev/staging/e2e tooling). AI agents were reading
 * `solidactions login --help`, seeing them advertised, and wrongly concluding
 * they must pass `--host` — mis-pointing sessions at the wrong host.
 *
 * Both flags must keep WORKING (see tests/flag-consistency.test.ts and
 * tests/login-host-hint.test.ts for behavior coverage) but must stop
 * appearing in `--help` output.
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

describe('login --help hides internal-only --host/--dev flags (#994)', () => {
    it('CLI is built', () => {
        expect(fs.existsSync(CLI_BINARY)).toBe(true);
    });

    it('does not advertise --host as an option', () => {
        const out = help(['login']);
        // Word-boundary-safe: --host has no other flag it could be a prefix of
        // in this command, but match precisely regardless.
        expect(out).not.toMatch(/--host\b/);
    });

    it('does not advertise --dev as an option (a prefix of the hidden --device)', () => {
        const out = help(['login']);
        // \b requires a non-word boundary right after "--dev", so this would
        // also catch a "--device" line: neither hidden flag may show.
        expect(out).not.toMatch(/--dev\b/);
        expect(out).not.toContain('--device');
    });
});

describe('login --help for the browser-first sign-in (cli#275)', () => {
    it('describes the browser sign-in and offers --api-key', () => {
        const out = help(['login']);
        expect(out).toMatch(/Sign in to SolidActions \(opens your\s+browser; use --api-key for an API key\)/);
        expect(out).toContain('--api-key [key]');
        expect(out).toContain('masked prompt');
    });

    it('says a key on the command line stays in shell history and names the two safer ways', () => {
        const out = help(['login']);
        expect(out).toMatch(/stays\s+in\s+your\s+shell\s+history/);
        expect(out).toContain('--stdin');
        expect(out).toMatch(/--stdin\s+or\s+the\s+SOLIDACTIONS_API_KEY\s+environment\s+variable/);
    });

    it('hides the old positional key and --device (both still work, see tests/login-env-host.test.ts)', () => {
        const out = help(['login']);
        expect(out).not.toContain('[api-key]');
        expect(out).not.toMatch(/^Arguments:/m);
        expect(out).not.toContain('--device');
        expect(out).toMatch(/^Usage: solidactions login \[options\]$/m);
    });
});

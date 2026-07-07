/**
 * `dev --help`'s --env example listed dev before production
 * ("e.g. dev, staging, production"), which read as an endorsement of the
 * (Pro+-gated) dev environment as the default choice. Free-plan tenants only
 * have production, so the example order is now production-first
 * ("e.g. production, staging, dev") to match every other command's ordering.
 *
 * Test-double policy: spawns the real built CLI binary (dist/index.js) —
 * matches the pattern in tests/flag-consistency.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import { describe, expect, it } from 'vitest';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

describe('dev --help — --env example order', () => {
    it('CLI is built', () => {
        expect(fs.existsSync(CLI_BINARY)).toBe(true);
    });

    it('lists the example as "e.g. production, staging, dev"', () => {
        const result = childProcess.spawnSync(process.execPath, [CLI_BINARY, 'dev', '--help'], {
            encoding: 'utf8',
            timeout: 15_000,
        });

        // Commander wraps long option descriptions onto a continuation line at
        // the terminal width, so match across whitespace/newlines rather than
        // requiring the literal substring on one line.
        expect(result.stdout).toMatch(/e\.g\.\s+production,\s+staging,\s+dev/);
        expect(result.stdout).not.toMatch(/e\.g\.\s+dev,\s+staging,\s+production/);
    });
});

/**
 * #31: pins the Commander registration of `env delete --env` at the CLI level.
 *
 * The behavioral tests in env-delete-env.test.ts call envDelete() with a
 * pre-built options object, so removing the `-e, --env` option registration in
 * src/index.ts would NOT fail them. This spawns the real built CLI binary and
 * asserts the flag appears in `env delete --help`, so the flag's existence is
 * pinned to the actual command wiring.
 *
 * Test-double policy: spawns the real built CLI binary (dist/index.js) —
 * matches the pattern in tests/dev-help-env-example.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import { describe, expect, it } from 'vitest';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

describe('env delete --help — --env flag registration (#31)', () => {
    it('CLI is built', () => {
        expect(fs.existsSync(CLI_BINARY)).toBe(true);
    });

    it('registers the -e, --env flag on env delete', () => {
        const result = childProcess.spawnSync(process.execPath, [CLI_BINARY, 'env', 'delete', '--help'], {
            encoding: 'utf8',
            timeout: 15_000,
        });

        expect(result.stdout).toMatch(/-e,\s+--env/);
    });
});

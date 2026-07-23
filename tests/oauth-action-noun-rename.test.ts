/**
 * Boundary pin for the BREAKING `oauth-actions` -> `oauth-action` rename plus
 * the `show` -> `view` verb migration (#84).
 *
 * ADR 0001 decision (2) mandates singular top-level nouns and decision (6)
 * makes `view` the canonical "show one" verb. `oauth-actions show` violated
 * both and was migrated with NO deprecation alias for either the old noun or
 * the old verb. These assertions are the automated pin for that contract —
 * without them, a well-meaning "restore backward compatibility" alias could
 * reintroduce either old form silently.
 *
 * Note the word "oauth-actions" legitimately survives elsewhere in the CLI: the
 * `/api/v1/oauth-actions` REST paths, the `oauth_actions` JSON response key,
 * and the bundled `solidactions-oauth-actions` skill filename. So the
 * no-plural assertion anchors on the help output's command column, not on a
 * whole-source grep.
 *
 * Test-double policy: spawns the real built CLI binary (dist/index.js) — no
 * mock/spy/stub libraries. Matches tests/doc-noun-rename.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import { describe, expect, it } from 'vitest';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

function runCli(args: string[]): childProcess.SpawnSyncReturns<string> {
    return childProcess.spawnSync(process.execPath, [CLI_BINARY, ...args], {
        encoding: 'utf8',
        timeout: 15_000,
    });
}

describe('oauth-action noun + view verb rename (ADR 0001 decisions 2 and 6)', () => {
    it('CLI is built', () => {
        expect(fs.existsSync(CLI_BINARY)).toBe(true);
    });

    it('top-level --help lists `oauth-action` as a command', () => {
        const result = runCli(['--help']);

        // Command column: leading indent, the noun, then padding before the
        // description. `oauth-actions` would not match (next char is `s`).
        expect(result.stdout).toMatch(/^\s+oauth-action\s+\S/m);
    });

    it('top-level --help does NOT list `oauth-actions` as a command', () => {
        const result = runCli(['--help']);

        expect(result.stdout).not.toMatch(/^\s+oauth-actions\s/m);
    });

    it('`oauth-action --help` renders search/list/view/platforms', () => {
        const result = runCli(['oauth-action', '--help']);

        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/^\s+search\s/m);
        expect(result.stdout).toMatch(/^\s+list\s/m);
        expect(result.stdout).toMatch(/^\s+view\s/m);
        expect(result.stdout).toMatch(/^\s+platforms\s/m);
    });

    it('`oauth-action --help` does NOT list a `show` subcommand', () => {
        const result = runCli(['oauth-action', '--help']);

        expect(result.stdout).not.toMatch(/^\s+show\s/m);
    });

    // The no-alias half of the breaking change: the old noun must genuinely not
    // exist, not be a hidden passthrough. Commander's "did you mean" hint is a
    // suggestion on an unknown command, not a working alias.
    it('`oauth-actions list` fails as an unknown command (no noun alias)', () => {
        const result = runCli(['oauth-actions', 'list', 'gmail']);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/unknown command 'oauth-actions'/);
    });

    it('`oauth-actions show` fails as an unknown command (old noun AND old verb)', () => {
        const result = runCli(['oauth-actions', 'show', 'gmail', 'some-action-id']);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/unknown command 'oauth-actions'/);
    });

    // The verb half, isolated: even under the NEW noun, `show` is gone.
    it('`oauth-action show` fails as an unknown subcommand (no verb alias)', () => {
        const result = runCli(['oauth-action', 'show', 'gmail', 'some-action-id']);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/unknown command 'show'/);
    });
});

/**
 * Positive half: the assertions above prove the OLD forms are gone, which a
 * broken build would also satisfy — "unknown command" is what you get when a
 * command fails to register at all. These prove the NEW form actually parses
 * and dispatches.
 *
 * Each case asserts on Commander's rendered usage line, which echoes the full
 * resolved command path (`solidactions oauth-action view`). That string only
 * appears if the parser walked the new noun *and* the new verb — so a
 * dispatch regression fails here, not just in scripts/smoke.sh.
 *
 * Option text is asserted on flag names only. Descriptions wrap at the
 * terminal width (`--var <NAME>`'s "(default: YOUR_CONNECTION)" splits across
 * two lines), so matching prose would be brittle.
 */
describe('oauth-action subcommands positively parse and dispatch', () => {
    it('`oauth-action view --help` exits 0 with the view usage line and its options', () => {
        const result = runCli(['oauth-action', 'view', '--help']);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Usage: solidactions oauth-action view [options] <platform> <action-id>');
        expect(result.stdout).toContain('--json');
        expect(result.stdout).toContain('--var <NAME>');
        expect(result.stdout).toContain('--legacy-env');
    });

    it('`oauth-action list --help` exits 0 with the list usage line and its options', () => {
        const result = runCli(['oauth-action', 'list', '--help']);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Usage: solidactions oauth-action list [options] <platform>');
        expect(result.stdout).toContain('--limit <n>');
        expect(result.stdout).toContain('--json');
    });

    it('`oauth-action search --help` exits 0 with the search usage line and its options', () => {
        const result = runCli(['oauth-action', 'search', '--help']);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Usage: solidactions oauth-action search [options] <platform> [query]');
        expect(result.stdout).toContain('--method <method>');
        expect(result.stdout).toContain('--limit <n>');
        expect(result.stdout).toContain('--json');
    });

    it('`oauth-action platforms --help` exits 0 with the platforms usage line', () => {
        const result = runCli(['oauth-action', 'platforms', '--help']);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Usage: solidactions oauth-action platforms [options]');
        expect(result.stdout).toContain('--json');
    });

    /**
     * Dispatch proof that does not go through --help (which Commander handles
     * before argument validation) and needs no network or credentials: reaching
     * `view`'s OWN argument parser produces a missing-argument error. Contrast
     * with `oauth-action show`, which dies earlier at "unknown command 'show'".
     */
    it('`oauth-action view` with no args reaches view\'s argument parser', () => {
        const result = runCli(['oauth-action', 'view']);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/missing required argument 'platform'/);
        expect(result.stderr).not.toMatch(/unknown command/);
    });
});

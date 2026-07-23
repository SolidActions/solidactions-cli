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

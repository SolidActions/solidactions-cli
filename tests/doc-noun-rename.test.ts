/**
 * Boundary pin for the BREAKING `docs` -> `doc` rename (#63, PR #81).
 *
 * ADR 0001 decision (2) mandates singular top-level nouns. `docs` was the last
 * plural one and was renamed with NO deprecation alias. These assertions are
 * the automated pin for that contract — without them, a well-meaning "restore
 * backward compatibility" alias could reintroduce the plural noun silently.
 *
 * Note the top-level help line is `doc   Manage docs in SA-Docs` — the word
 * "docs" legitimately appears in the *description*, and elsewhere in the CLI as
 * the OAuth ability, the SA-Docs product name, and the docs_* API surface. So
 * the no-plural assertion anchors on the command column, not the whole output.
 *
 * Test-double policy: spawns the real built CLI binary (dist/index.js) — no
 * mock/spy/stub libraries. Matches the pattern in
 * tests/dev-help-env-example.test.ts and tests/flag-consistency.test.ts.
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

describe('doc noun rename (ADR 0001 singular nouns)', () => {
    it('CLI is built', () => {
        expect(fs.existsSync(CLI_BINARY)).toBe(true);
    });

    it('top-level --help lists `doc` as a command', () => {
        const result = runCli(['--help']);

        // Command column: leading indent, the noun, then padding before the
        // description. `docs` would not match (the char after `doc` is `s`).
        expect(result.stdout).toMatch(/^\s+doc\s+\S/m);
    });

    it('top-level --help does NOT list `docs` as a command', () => {
        const result = runCli(['--help']);

        expect(result.stdout).not.toMatch(/^\s+docs\s/m);
    });

    it('`doc --help` renders the push/pull/upload subcommands', () => {
        const result = runCli(['doc', '--help']);

        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/^\s+push\s/m);
        expect(result.stdout).toMatch(/^\s+pull\s/m);
        expect(result.stdout).toMatch(/^\s+upload\s/m);
    });

    // The no-alias half of the breaking change: `docs` must genuinely not exist,
    // not be a hidden passthrough. Commander's "did you mean" hint is a
    // suggestion on an unknown command, not a working alias.
    it('`docs push` fails as an unknown command (no deprecation alias)', () => {
        const result = runCli(['docs', 'push', 'x']);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/unknown command 'docs'/);
    });
});

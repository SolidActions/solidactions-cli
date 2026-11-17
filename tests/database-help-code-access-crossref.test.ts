/**
 * #140 — `database --help` must point ACROSS commands.
 *
 * The observed failure: an AI agent explored `database --help` in isolation,
 * never discovered `dev --env`, concluded direct database access was
 * impossible, and fell back to an import-only workflow. So the database help
 * has to name the run-time path (map → dev --env) and say plainly what
 * `import` is actually for.
 *
 * It must also be ACCURATE: `env map` maps GLOBAL VARIABLES and has no
 * --database flag, so the help must name the solidactions.yaml `database:`
 * declaration instead — sending an agent to a nonexistent flag would reproduce
 * exactly the dead end this test exists to prevent.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

function databaseHelp(): string {
    const result = childProcess.spawnSync(
        process.execPath,
        [CLI_BINARY, 'database', '--help'],
        { encoding: 'utf8', timeout: 15_000 },
    );
    expect(result.status).toBe(0);
    return result.stdout;
}

describe('database --help — cross-reference to the run-time access path', () => {
    it('CLI is built', () => {
        expect(fs.existsSync(CLI_BINARY)).toBe(true);
    });

    it('points at `dev --env` for using a database from code', () => {
        const help = databaseHelp();
        expect(help).toContain('solidactions dev <your-workflow-file> --env <env>');
        // `project deploy`, never the nonexistent top-level `solidactions deploy`.
        expect(help).toContain('solidactions project deploy <project> <path>');
        expect(help).not.toMatch(/\bsolidactions deploy\b/);
        expect(help).toMatch(/resolves your platform variables AND every mapped database's\s+credentials/);
    });

    it('names the real mapping surface — the solidactions.yaml declaration, not a nonexistent `env map --database`', () => {
        const help = databaseHelp();
        expect(help).toContain('solidactions.yaml');
        expect(help).toMatch(/database: "<database name>"/);
        expect(help).not.toMatch(/env map .*--database/);
    });

    it('states that the credentials are short-lived and never written to a file', () => {
        const help = databaseHelp();
        expect(help).toMatch(/short-lived, held in memory, never written\s+to a file/);
    });

    it('clarifies that `import` is bulk data loading only', () => {
        const help = databaseHelp();
        expect(help).toMatch(/'database import' is for BULK DATA LOADING only/);
        expect(help).toMatch(/not how code reads or writes a database at run time/);
    });

    it('names the shape the variable actually arrives as in a workflow', () => {
        // The SDK hands the workflow a DatabaseVar object, not a JSON string —
        // help that said "JSON" would send an agent to write a JSON.parse that
        // throws on an object.
        const help = databaseHelp();
        // Commander wraps `database --help` at 80 columns on a pipe, so the
        // shape may span two lines (`token,` and `readOnly}` land apart);
        // match across the wrap.
        expect(help).toMatch(/\{name, url, token,\s+readOnly\}/);
        expect(help).toContain('createDatabaseClient()');
    });

    it('names the DuckDB database file kind and how a workflow opens it', () => {
        const help = databaseHelp();
        expect(help).toContain('duckdb_file');
        expect(help).toContain('openAnalytics');
        // Commander wraps `database --help` at 80 columns on a pipe, so a
        // multi-word phrase may span two lines; match across the wrap.
        expect(help).toMatch(/@solidactions\/sdk\s+0\.11\.0\s+or\s+newer/);
        expect(help).toMatch(/database\s+pull/);
    });

    it('points delete and undelete at database list --include-deleted', () => {
        const help = databaseHelp();
        // Commander wraps the subcommand descriptions at 80 columns on a
        // pipe (`database list` and `--include-deleted` land on separate
        // lines), so match each entry across the wrap. Anchor on the command
        // columns: '  delete [options]' (two leading spaces) does not match
        // inside '  undelete [options]'.
        const deleteEntry = help.slice(help.indexOf('  delete [options]'), help.indexOf('  undelete [options]'));
        expect(deleteEntry).toMatch(/database list\s+--include-deleted/);
        const undeleteEntry = help.slice(help.indexOf('  undelete [options]'), help.indexOf('  schema [options]'));
        expect(undeleteEntry).toMatch(/database list\s+--include-deleted/);
    });
});

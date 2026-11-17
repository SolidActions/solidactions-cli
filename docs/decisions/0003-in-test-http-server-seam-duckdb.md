# 3. Accepted test seams for the DuckDB database file command tests

- **Status:** Accepted
- **Date:** 2026-11-17
- **Issue:** [SolidActions/solidactions-cli#245](https://github.com/SolidActions/solidactions-cli/issues/245) (wave cli-duckdb: cli#244, cli#245, cli#246)
- **Ruling:** the PM (`chief`), mail 8bcb94b4-b8b2-48e6-80c7-208090a35493 (2026-11-17), extending the app repo's `docs/decisions.md` #2721 decision 12 (the in-test HTTP server that answers as the app is an accepted seam for that wave, by call site) to this wave, by call site.

## Context

The CLI's `database query`, `schema`, `list` and `create` rows for `duckdb_file` databases are tested against a hand-written server, and the lifecycle `list` rows against an injected-`post` harness. The shop's rule on test doubles is that a double needs a recorded ruling. The app repo's ruling (#2721) covered one wave only, so this wave's rows needed their own.

## Decision

These call sites are accepted, and only these:

1. **An in-test HTTP server** (`serve`, `scenario` and `database` in `tests/database-duckdb-file.test.ts`, and the new query, schema, list, create and kind-mismatch rows of this wave built on them), and the built-binary `database list --json` row at `tests/database-lifecycle-commands.test.ts` ("keeps built JSON stdout byte-pure while an outdated-CLI nudge is active"), which builds its own in-test server and seeds a temp `HOME` with an `agent-update-check.json` (`latestVersion` 9.8.7, a fresh `checkedAt`) in place of the npm registry's latest-version answer, edited by this wave (the row's expected stdout; its server, fixture and seeded cache predate the wave). The CLI sends real HTTP over a real socket to a server in the test that answers as the app does. Conditions, as in #2721:
   - real sockets and real files;
   - the routes, fields and error codes are copied from the frozen contract (the app's `HandleDuckdbCliOperation` and `HandleCliDatabaseOperation::list`, quoted in `docs/superpowers/plans/2026-11-16-cli-duckdb.md`), never invented; the lifecycle row's `list` fixture predates the wave.
2. **An injected-`post` harness** (`harness()` in `tests/database-lifecycle-commands.test.ts`: a `post` that returns canned `responseData` and records its calls, plus `vi.fn` doubles for `confirm` and `importDatabase`, and `isTTY: true`, which the two `list` rows never read). It has no socket. It is accepted for the pre-existing rows that this wave edited, namely the two `list` rows with the `includeDeleted` halves. Its real-socket twin is the `list` rows in `tests/database-duckdb-file.test.ts` (hide by default, `--include-deleted`, kind filter), which pin the same behavior over a real socket. New behavior rows go on call site 1, not on this harness.

The real-route proof for both is the wave's verify live smoke on a flag-on stack (`database query`, `database schema`, `database list` before and after a delete, and the `connect` refusal), recorded with commands and output on the wave's cards.

A later wave that adds rows on either harness needs its own entry, or an extension of this one that names its call sites.

- **Not seams (output sinks and environment isolation):** the captured-output sinks (`output()` in `tests/database-duckdb-file.test.ts`, its no-op `{ stdout: () => undefined }` and `{ stderr: () => undefined }` sinks, and the `stdout` and `stderr` array sinks inside `harness()`) and the environment isolation of the new `database query --help` row (`makeTmpEnv()` in `tests/database-duckdb-file.test.ts`, which points `HOME` at a temp directory and clears the `SOLIDACTIONS_*` variables) are not doubles in the sense of this entry. The commands take their output streams as an injected parameter (`io.stdout`, `io.stderr`), and these sinks only record or drop what the command itself writes; the isolation only keeps the real environment out of the test. They stand in for no call to the app and for no remote answer, so no call site needs to name them. (The seeded update-check cache in call site 1 is different: it replaces a remote answer, so it is named.)

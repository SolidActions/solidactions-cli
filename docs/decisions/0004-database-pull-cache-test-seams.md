# 4. Accepted test seams for the cached database pull tests

- **Status:** Accepted
- **Date:** 2026-11-18
- **Issue:** [SolidActions/solidactions-cli#262](https://github.com/SolidActions/solidactions-cli/issues/262) (wave cli-db-pull)
- **Ruling:** the PM (`chief`), mail 425132c2-0560-4e53-a1fa-b299c22e722c (2026-11-18), on the call sites proposed in `docs/superpowers/plans/2026-11-18-cli-db-pull.md` ("ADR 0004"). Wording amendment to call site 4 by the wave's manager (Task 4 card, same call site, same file).
- **Follows:** `docs/decisions/0003-in-test-http-server-seam-duckdb.md`.

## Context

`database pull` now syncs into a hidden per-database cache replica, snapshots it with `VACUUM INTO`, checks the snapshot with `PRAGMA quick_check` and copies it into the user's file (plan D1-D9). Every snapshot step runs the real local `@libsql/client` (plan D9). A real libSQL sync needs a real server, which the unit suite does not have; the shop's rule on test doubles is that a double needs a recorded ruling. This entry records the stand-ins that remain.

## Decision

These call sites are accepted, and only these (1, 2, 3, 3a, 3b, 3c, 4):

1. **The fake sync client** inside the `loadClient` stand-in of `tests/database-pull-cache.test.ts` and `tests/database-writable-pull-cache.test.ts`: for a `createClient` config with a `syncUrl`, an object whose `sync()` writes a REAL SQLite file at the config's `url` (through the real local `@libsql/client`) holding the scenario's rows and writes the replica companion files Task 1 measured (`-client_wal_index`, `-shm`, `-wal`), and whose `close()` records. For a config without a `syncUrl` the harness returns the REAL `createClient` (so `VACUUM INTO`, `quick_check` and the open check run for real). Conditions: the real behaviour of a warm sync against a real server is proven by Task 1's probe (CI log, and the one local run), not by this fake.
2. **The injected `post`** answering `show` and `access` in those two files, copied from the existing harness shape in `tests/database-pull-command.test.ts` (`pullHarness`) and `tests/database-writable-pull-command.test.ts`, with the access `url` host set per scenario. Conditions: routes, fields and error codes unchanged from the existing harness.
3. **Injected clock and process facts** (`now`, `sleep`, `pid`, `hostname`, `processAlive`) in `tests/database-replica-cache.test.ts` and the two files above: they replace the wall clock and the OS process table, not a remote answer. Conditions: the two-process rows use real processes and real files, no injection.
   - 3a. **Injected prompt answers:** `confirm` as a `vi.fn` returning true (Task 4 row 7, and the writable harness Task 5 copies, `tests/database-writable-pull-command.test.ts:194`): it replaces the human at a terminal prompt, not a remote answer; the row asserts it is called exactly once.
   - 3b. **The recording wrapper** around the REAL local client in Task 4 row 11: a pass-through that records the statements it forwards and changes none of them, none of their results and no error. It is a recorder, not a double of behaviour.
   - 3c. **Injected terminal facts** in Task 5's harness (copied from `tests/database-writable-pull-command.test.ts:65-90, :194-195`): the `input` line source, `abortSignal` and `isTTY`: they replace the terminal and the Ctrl-C signal, not a remote answer.
4. **The edited dispatch rows** in `tests/database-file-command-actions.test.ts` that dispatch `pull` through the existing stand-in handlers: the existing row (`dispatches pull name, optional destination, and pull options`), with `cache` added to its expected options, and the new `--no-cache` row (`dispatches pull with cache disabled when --no-cache is passed`), which asserts `expect.objectContaining({ cache: false })`. The file's pre-existing `vi.mock` partial with `importOriginal` is unchanged by this wave and is out of this entry's scope.

The real-socket proof is the wave's verify live smoke and the probe against a real libsql-server (CI and the one local run).

A later wave that adds rows on any of these call sites needs its own entry, or an extension of this one that names its call sites.

- **Not seams (as in 0003):** the captured stdout/stderr sinks and the temp-directory environment isolation. The commands take their output streams as an injected parameter (`io.stdout`, `io.stderr`), and these sinks only record what the command itself writes; the isolation only keeps the real environment (and the real home directory's cache) out of the test. They stand in for no call to the app and for no remote answer.

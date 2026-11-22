# Big database imports finish by themselves Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sa-subagent-driven-development to implement this plan task-by-task (the wave's build step). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `solidactions database import` of a big dump (113 MB, `F32_BLOB(1536)` vector columns) finishes in one run: a batch that times out is split and retried when that is safe, the per-batch limit is 300 s and can be raised with `--timeout`, and vector sources use smaller batches.

**Architecture:** A new pure module `src/utils/database-import-batching.ts` owns the batching policy (batch caps, the vector-schema detector, the "safe to repeat" classifier that works from schema facts, the lock-error classifier, the `--timeout` parser). `src/utils/database-sql-import-runner.ts` uses it: on a deadline error from a batch it drops the (already closed) client, lowers the batch cap to half of the failed batch and re-plans from the same statement, so repeated halving down to one statement falls out of the existing loop and every completed sub-batch is checkpointed as today. A statement is safe to repeat only when it is `CREATE ... IF NOT EXISTS`, or an `INSERT OR REPLACE`/`OR IGNORE`/`REPLACE` into a table known to have a PRIMARY KEY or UNIQUE constraint and no trigger (known from the source's own CREATE statements, else from one read of the target's `sqlite_master` through the client before the first retry). A timed-out batch with any other statement is never retried; the run stops with a clear message and the usual resume line. After a timeout the retry can meet a lock error (the timed-out transaction may still be running on the server); that is retried at the same batch size with a short backoff bounded by the per-batch limit. `src/commands/database.ts` and `src/index.ts` carry the `--timeout` option.

**Tech Stack:** TypeScript, commander, `@libsql/client` (reached only through the existing injected `loadClient`), vitest (CI only; nothing runs locally).

**Spec:** none (no design file; the design is this plan's Architecture plus the Design rulings below). The cause analysis is on `cli#267` and `SolidActions/solidactions-app#2314`.

**Issues:** `cli#267` ("Database import: a batch that times out is never retried; big vector imports stop every few MB"), sanctioned by Peter's approval 2026-11-22 recorded in the issue body ("Peter approved the fix 2026-11-22") and the wave's approval ask `task-startthefixsobig-d724`. The issue has no comments (read with `gh api --paginate repos/SolidActions/solidactions-cli/issues/267/comments`; `scripts/issue` does not exist in the CLI repo). The wave card is `task-wavebigdatabase-4215`; the plan card is `task-planbigimports-14f3`. **Revision 2 (2026-11-22):** the PM adjudicated plan review `task-planreviewcli-c41e` (REQUEST CHANGES on a302fee) in six rulings, a comment on `task-planbigimports-14f3`; they are binding and applied below (D1 keyed-table rule, D7 lock retry, D6 settled from code, Task 2 rows B, J, K, Task 3 row H on fake timers). Provenance of the ruling text: PM comment `db002579-f67b-445f-9312-a9cd43197fdd` on that card. No open PR touches any file of this plan (`gh pr list --state open` was empty at plan time).

## Global Constraints

- **The ask, verbatim (cli#267 body, the Fix paragraph):** "Fix (CLI): (1) on timeout, retry the same batch split in half, repeat down to one group; (2) a longer import batch limit (300 s) and a --timeout option; (3) smaller batches when vector columns are present. Caveat: a timed-out batch may still have committed, so the retry must be safe: INSERT OR REPLACE is; for plain INSERT the runner checks the checkpoint/row before retrying or stops with a clear message."
- **"Done when" (verbatim):** "the same kind of import finishes in one run without manual resumes, with a test that makes a batch time out and proves the split-and-retry, and a CLI release." The release is the PM's, after merge; this wave ships the code, the test and the README line.
- **Premises, each quoted from this tree (verified 2026-11-22):**
  - Batch caps and limit: `const MAX_BATCH_GROUPS = 100;` and `const MAX_BATCH_BYTES = 512 * 1024;` (`src/utils/database-sql-import-runner.ts:25-26`); `export const DEFAULT_DATABASE_DATA_PLANE_TIMEOUT_MS = 120_000;` (`src/utils/database-data-plane.ts:107`).
  - The batch call and its no-retry catch: `await runDatabaseClientOperationWithDeadline(() => client!.executeMultiple!(batchSql(batch.groups)), closeCurrentClient, dependencies.dataPlaneTimeoutMs ?? DEFAULT_DATABASE_DATA_PLANE_TIMEOUT_MS,);` then `if (error instanceof DatabaseOperationError) throw error;` (`src/utils/database-sql-import-runner.ts:555-561`). On the deadline the helper calls the `onTimeout` hook (here `closeCurrentClient`, which closes the client) and rejects with the private class `DatabaseDeadlineElapsed` (code `upstream_unavailable`, message `Database operation timed out.`) (`src/utils/database-data-plane.ts:184-188`, `:221-228`). So **after a timeout the client is already closed and must not be reused**; the loop mints a new one when `client` is `undefined` (`:544-551`).
  - The batch is one transaction: `batchSql` is `PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE; <groups>; COMMIT; PRAGMA foreign_keys=ON;` (`:425-433`), sent by `executeMultiple` as one pipelined HTTP request (`node_modules/@libsql/client/lib-esm/http.js:166-178`: "Pipeline all operations, so `hrana.HttpClient` can open the stream, execute the sequence and close the stream in a single HTTP request."). A timed-out batch may have committed, may still be running on the server, or may be rolled back: the CLI cannot tell. Whether a retry's `BEGIN IMMEDIATE` waits for the still-running old transaction or answers `SQLITE_BUSY` at once is **not known**, and the design no longer depends on it: D7 retries a lock error at the same size with a bounded backoff, and the write-lock ordering argument is in "Destructive paths". Task 4 only confirms which one happens. The libsql error class carries `code` (`node_modules/@libsql/core/lib-esm/api.js:2-14`: `code;` and `message = \`${code}: ${message}\``).
  - `DatabaseClient.execute(statement)` exists and returns `{ columns, rows }` (`src/utils/database-data-plane.ts:68-85`); the import runner has never called it. The test harness's `execute` throws `'import must use executeMultiple'` (`tests/database-import-command.test.ts:105-107`); Task 2 gives the harness a `catalog` hook for it.
  - The checkpoint check ties `nextStatement` to a deterministic partition: `deterministicBatchCount` walks `nextBatch` with the fixed caps and `validateCheckpoint` requires `checkpoint.lastCompletedBatch !== expectedBatchCount` to be false (`src/utils/database-sql-import-runner.ts:134-149`, `:165-177`). Split batches break that partition, so Task 2 relaxes the check (Design ruling D3).
  - Existing pins of that check: `tests/database-import-command.test.ts:1099-1131` (two rows: "batch count exceeds the deterministic boundary count" and "statement position is not a deterministic batch boundary"); both rows are rewritten in Task 2.
  - Existing pin of the timeout path: `closes a stalled atomic batch at the per-verb deadline and does not publish progress` sets `test.dependencies.dataPlaneTimeoutMs = 10` and expects `rejects.toMatchObject({ code: 'upstream_unavailable' })`, `test.closed` equal to `[1]`, no checkpoint and empty stdout (`tests/database-import-command.test.ts:299-314`). That statement is a single plain `CREATE TABLE` group, so it must still stop at once with no retry.
  - `resolveDependencies` always fills `dataPlaneTimeoutMs` with 120 s (`src/commands/database.ts:272`), and the import call sites pass `dataPlaneTimeoutMs: io.dataPlaneTimeoutMs` (`:1479` for `create --from`, `:1634` for `import`). The runner therefore gets a new, separate dependency `batchTimeoutMs`, filled from the **raw** `dependencies.dataPlaneTimeoutMs` (still the test hook) and never from `io`.
  - The parser's group shape is pinned by `toEqual` in `tests/database-sql-import-parser.test.ts:95`, so **no field is added to `DatabaseSqlImportGroup`**; replay safety is classified from `group.sql`.
  - An existing `--timeout <duration>` option takes `30s`, `15m`, `1h` (`src/index.ts:1089`, parser `/^(\d+)([smh]?)$/` at `src/commands/connection-wait.ts:21`). `database import --timeout` uses the same form. `tests/readme-contract.test.ts:80-116` pins README phrases for the database section; Task 3 only adds text and keeps every pinned phrase.
  - `database import` is registered at `src/index.ts:451-459`; the command is `databaseImportWithConfig` (`src/commands/database.ts:1595-1637`); `create --from` runs the same runner (`:1457-1480`).
- **Design rulings (mine, recorded here; each with its cost if wrong):**
  - **D1 (PM ruling 1-2, option a): a timed-out batch is retried only when every statement in it is safe to repeat**, i.e. its final state is the same whether it ran once or twice. Safe: `CREATE TABLE|INDEX|VIEW|TRIGGER IF NOT EXISTS` (optional `UNIQUE`/`TEMP`/`TEMPORARY`/`VIRTUAL`); and `INSERT OR REPLACE INTO`, `REPLACE INTO`, `INSERT OR IGNORE INTO` **only when the target table is known to have a PRIMARY KEY or UNIQUE constraint (a column or table constraint, or a non-partial `CREATE UNIQUE INDEX`) and is not known to have any trigger**. Reason (SQLite semantics, verified by the PM): `OR REPLACE`/`OR IGNORE` act only on a uniqueness conflict, so on a keyless table a replay inserts the rows a second time. Unknown table = not safe. Anything else (plain `INSERT`, plain `CREATE`, `UPDATE`, `DELETE`, `DROP`, unknown) is not safe. **Triggers:** a replay of an `INSERT` re-fires an `AFTER INSERT` trigger (an audit row written twice), so a table with a trigger counts as not safe; triggers are known from the source's own `CREATE TRIGGER` statements and from the target schema read (D8), and the README limits line says a table with triggers is not retried. **Documented limits (README line, no code):** a statement that omits its key columns (a keyed table with a NULL or defaulted key) is not detected; a batch whose own rows conflict with each other on a different unique key could end in a different state when replayed (dump files do not do this). Cost if wrong: a dump that times out and is not recognised as safe needs a manual resume (today's behaviour, with a clear message); a recognised-safe replay is a no-op by SQLite semantics.
  - **D2: halving re-plans instead of recursing.** On a timeout of a batch of `size` statements (safe to repeat, `size >= 2`) the runner sets `cap = floor(size / 2)`, drops the dead client and loops: the next iteration mints a fresh client and plans the batch from the same `nextStatement` with the lower cap. The cap never grows back inside a run (a slow table stays slow, and each timeout costs the full limit). One statement that times out stops the run. Cost if wrong: a source that was only slow in one region stays on small batches for the rest of the run (slower, correct).
  - **D3: the checkpoint check is relaxed to what is still true.** A checkpoint is valid when its database and source digest match, `nextStatement` is an integer from 0 to `groups.length`, `completedSourceBytes` equals that statement boundary's byte offset, and `lastCompletedBatch` is an integer with `0 <= lastCompletedBatch <= nextStatement` and `lastCompletedBatch >= 1` when `nextStatement > 0` (it is a count of completed batch calls and is no longer derivable from the source). Cost if wrong: a hand-edited checkpoint with a plausible but wrong batch count is accepted; the byte offset still ties it to the source, and the count is only displayed.
  - **D4: vector sources get a cap of 20 statements (`VECTOR_MAX_BATCH_GROUPS`) instead of 100.** A source "has vector columns" when any `CREATE` statement group contains `F32_BLOB(`/`F64_BLOB(`/`F16_BLOB(`/`F8_BLOB(`/`F1BIT_BLOB(`, `FLOAT32(`/`FLOAT64(` or `libsql_vector_idx`. The byte cap (512 KiB) is unchanged. 20 is a judgment, not a measurement (a 1536-float row dumps to about 12 KB of hex, so 512 KiB already holds roughly 40 rows); the halving of D2 corrects a wrong guess at the cost of one timeout. **PM ruling 5, cost noted instead of adopted:** a source that has no `CREATE` for a vector table but inserts into an existing vector table of the target is not detected up front, because detecting it needs a schema read before the first batch (a new round trip for every import, and a harness change for every existing row). Such a run starts at the 100 cap and the first timeout halves it (D2): the cost is one timeout (at most the per-batch limit). The README limits line says so. Cost if wrong otherwise: still slow on a bigger-dimension table, no data risk.
  - **D5: the per-batch limit for import is 300 s (`DEFAULT_IMPORT_BATCH_TIMEOUT_MS`) and `--timeout <duration>` overrides it** (`30s`, `15m`, `1h`; a bare number is seconds; 1 s to 24 h, because Node's `setTimeout` overflows above 2^31 ms). The shared 120 s data-plane default is unchanged for every other command. `create --from` gets the 300 s default (no flag there). Cost if wrong: none; other commands are untouched.
  - **D6 (PM ruling 3, settled from the code): renewal window and token lifetime are not changed.** The runner renews a credential `RENEWAL_WINDOW_MS = 30_000` before it expires (`src/utils/database-sql-import-runner.ts:27`) and checks that at the top of every loop iteration (`deadlineNow >= deadline.renewalAt`, `:539-546`); the token is checked when the HTTP request starts (PM ruling, ground-checked against `@libsql/client` 0.17.4 `http.js`: the whole batch is one request), so a batch that started before the renewal point is not cut off by the token mid-request. After any timeout or lock error the retry always mints a fresh token (D2, D7). A batch that is rejected for an expired credential fails as "credential expired; the batch outcome is unknown" with the resume line (existing, safe). The dev-stack read of `expires_in_seconds` in Task 4 is confirmation only; nothing in the build depends on it. Disposition: no change, no filing.
  - **D7 (PM ruling 1): a lock error after a timeout retries the same batch size with a short backoff.** After a deadline timeout that the runner chose to retry, the old transaction may still hold the write lock. A retry that fails with a lock error (`LibsqlError.code` `SQLITE_BUSY*` or `SQLITE_LOCKED*`, or a message matching `/database (?:table )?is locked/i`; `isLockError`) is retried at the same batch size, never halved: close the client (fire and forget), mint a fresh one, wait `min(1000 * 2^attempt, 10_000, remaining)` ms where `remaining = batchTimeoutMs - waitedMs`, repeat. When `remaining` is 0 the run stops with a clear message and the usual resume line. The attempt counter and `waitedMs` reset when a batch completes, and a lock error that does **not** follow a timeout is not retried (it is the existing generic failure). The wait is an injected `sleep` dependency so tests never wait. Cost if wrong: a lock that never clears costs one per-batch limit of waiting, then the same stop as today.
  - **D8 (PM ruling 2): the target schema is read once, only when needed.** When the source's own statements do not settle whether every `INSERT OR REPLACE/IGNORE` table in the retried batch is keyed and trigger-free (the table is not created by a `CREATE TABLE` earlier in the source, or was created `IF NOT EXISTS`), the runner reads the target catalog once, on the fresh client, before the first retry: `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','index','trigger')`, under the per-batch deadline, and caches the facts for the rest of the run. Target facts override source facts for a table both know. A read that fails or stalls stops the run with a clear message (the safe direction). Cost if wrong: one extra small query after the first timeout, never on a healthy run.
- **Invariants (must never happen), every route to each, and the sweep:**
  - **I1: a retry never silently doubles or loses a row.** Routes: (a) a timed-out batch holding a plain `INSERT`/`CREATE`/`UPDATE`/`DELETE` is retried; (b) a retried batch starts at a different statement than the one that failed, skipping or repeating statements; (c) a checkpoint is written for a batch that did not complete; (d) the halving cap makes a later batch overlap an earlier one; (e) a keyless or triggered table is treated as safe and a replay doubles its rows or fires its trigger twice; (f) a lock-error retry halves the batch or skips a statement. Sweep (Task 2, rows A, B, J, K): across a run with several timeouts, the statements of the **successful** executions, concatenated, equal the source's statements exactly once each, in order; the stalled executions always begin at the statement the next execution also begins with; a table-driven row (B) feeds every unsafe statement shape, a keyless `INSERT OR REPLACE` target, and a triggered target (rows B and J) through a stalled batch and expects exactly one execution; row K proves every lock retry runs the same statements at the same size.
  - **I2: a stalled client is never reused.** Route: the loop reuses `client` after the deadline hook closed it. Sweep (Task 2 rows A and K): every retried execution runs on a client number higher than the stalled one.
  - **I3: no credential or path leaks into the new messages.** The existing `expectNoSecrets` helper is applied to every new failure message (Task 2 rows B, C, D, J, K).
  - **I4: progress before the failing point is kept.** Route: a retry loop that throws away the checkpoint of completed sub-batches. Sweep (Task 2 row D): a run whose Nth statement never completes leaves a checkpoint at the last completed statement and the resume line.

## Review Focus

1. A timed-out batch that **did commit** on the server, then retried (an `INSERT OR REPLACE` dump into a keyed table with a vector index): the second apply is a no-op, the run continues. Pinned by Task 2 row A (replay is judged safe by classification, not proved by a database; the live smoke in Task 4 proves it on a real stack). A retry that meets **a lock held by the timed-out transaction** waits and retries the same size (row K).
2. A source with **plain `INSERT`**, a **keyless table's `INSERT OR REPLACE`**, or a **trigger on the target**, and a timeout: stops at once with a message that names `--timeout`, "not safe to repeat" and the batch's line range, never retried (Task 2 rows B and J).
3. **`--timeout 0`, `--timeout abc`, `--timeout 1.5`, `--timeout 25h`, a negative number**: refused before native load or mint with `invalid_timeout` (Task 1 parser rows, Task 3 command row).
4. A **resume** from a checkpoint written by a run that had split batches (statement position 50, batch count 3): accepted; a count above the statement position or a byte offset that does not match the boundary: refused (Task 2 row F).
5. A **source with a single huge statement** that times out: stops with "cannot be split further" and names `--timeout` (Task 2 row C).

---

### Destructive paths

This wave writes to a user's live database through the existing batch transaction and the existing checkpoint file; it adds no new file writes, deletes or overwrites (the checkpoint code is untouched except the relaxed validation in D3, which only reads). The one data-safety question is "a retry repeats statements": I1 and D1 cover it (retry only when repeating is harmless). **Write-lock ordering argument (PM ruling 1):** every batch begins `BEGIN IMMEDIATE`, which takes the database's one write lock, so two batches of this run can never interleave their writes: a retry's batch either waits for the old transaction (then runs after it) or gets a lock error (D7: wait and retry, never run). Whichever of the old and the new transaction commits first, the other then runs on top of it, and the replay-safe statements (D1) leave the same final state when repeated. The old transaction can also commit after the retry: still harmless for the same reason. Statements that are not safe to repeat never reach a retry. The failure-boundary table: a batch stalls (outcome unknown): retried only if safe to repeat, a lock error on the retry waits and retries at the same size, a lock that outlasts the per-batch limit stops the run with the resume line; the old transaction may still commit later: harmless for statements safe to repeat, and for others the run has stopped before any retry; the process dies mid-retry: the checkpoint still names the last completed statement, resume is the existing path; checkpoint write fails after a committed sub-batch: existing behaviour (no resume line, `suppressResume`). A forward-only design (stop on the first timeout and print the resume line, as today) cannot meet the issue, which asks for one-run completion of big imports.

## Task 1: Batching policy module and the deadline helper (cli#267)

**Depends on:** none. This task freezes the contract Tasks 2 and 3 consume.

**Files (file scope, the only paths this task may touch):**
- Create: `src/utils/database-import-batching.ts`
- Modify: `src/utils/database-sql-import.ts` (only: put `export` before `function sqlWithoutLeadingComments`, line 346)
- Modify: `src/utils/database-data-plane.ts` (only: add `isDatabaseDeadlineElapsed` after the `DatabaseDeadlineElapsed` class, line 188)
- Create: `tests/database-import-batching.test.ts`

Grep of the callers and doubles of what changes (pasted at plan time): `grep -rn "sqlWithoutLeadingComments" src tests` finds only `src/utils/database-sql-import.ts` (definition and two internal uses); `grep -rn "DatabaseDeadlineElapsed" src tests` finds only `src/utils/database-data-plane.ts`. Neither is mocked anywhere.

**Interfaces (frozen: Tasks 2 and 3 quote these exactly):**
- Produces, in `src/utils/database-data-plane.ts`:
  ```ts
  export function isDatabaseDeadlineElapsed(error: unknown): boolean {
      return error instanceof DatabaseDeadlineElapsed;
  }
  ```
- Produces, in `src/utils/database-sql-import.ts`: `export function sqlWithoutLeadingComments(sql: string): string` (existing function, now exported).
- Produces, in `src/utils/database-import-batching.ts`:
  ```ts
  import { DatabaseOperationError } from './database-data-plane';
  import { DatabaseSqlImportGroup, sqlWithoutLeadingComments } from './database-sql-import';

  export const MAX_BATCH_GROUPS = 100;
  export const VECTOR_MAX_BATCH_GROUPS = 20;
  export const MAX_BATCH_BYTES = 512 * 1024;
  export const DEFAULT_IMPORT_BATCH_TIMEOUT_MS = 300_000;
  export const MAX_IMPORT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
  export const LOCK_BACKOFF_BASE_MS = 1000;
  export const LOCK_BACKOFF_MAX_MS = 10_000;
  /** The one catalog query the runner sends (D8). Rows are [type, name, tbl_name, sql]. */
  export const SCHEMA_CATALOG_SQL = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','index','trigger')";

  export interface ImportBatch {
      groups: DatabaseSqlImportGroup[];
      nextStatement: number;
  }

  /** What is known about one table: it has a PRIMARY KEY or UNIQUE constraint / non-partial unique index, and whether any trigger is on it. */
  export interface TableFacts { keyed: boolean; triggered: boolean }
  /** Key: the table name lower-cased and unquoted (a `main.` prefix dropped). */
  export type SchemaFacts = Map<string, TableFacts>;

  export interface ReplayVerdict {
      /** safe: every statement is safe to repeat. unsafe: at least one is definitely not. unknown: none is definitely unsafe, but a table's keys are not known. */
      status: 'safe' | 'unsafe' | 'unknown';
      /** The first statement that is definitely not safe (status unsafe). */
      firstUnsafe?: DatabaseSqlImportGroup;
      /** Names (as written in the source) of the tables whose keys are not known (status unknown). */
      unknownTables: string[];
  }

  /** The same batching rule the runner used (group cap and byte cap), with the group cap as a parameter. */
  export function nextBatch(groups: DatabaseSqlImportGroup[], start: number, maxGroups: number): ImportBatch;

  /** True when any CREATE statement group of the source declares a vector column or index. */
  export function sourceHasVectorColumns(groups: DatabaseSqlImportGroup[]): boolean;

  /** Facts from CREATE TABLE / CREATE [UNIQUE] INDEX / CREATE TRIGGER statements (source groups' `sql`, or the catalog's `sql` column). Other statements are ignored. */
  export function schemaFactsFromSql(statements: Iterable<string>): SchemaFacts;

  /** `override`'s tables replace `base`'s; a table is `triggered` when either side says so. Returns a new map. */
  export function mergeSchemaFacts(base: SchemaFacts, override: SchemaFacts): SchemaFacts;

  /** Judge whether the whole batch can be run twice with the same final state (D1). */
  export function replayVerdict(groups: DatabaseSqlImportGroup[], facts: SchemaFacts): ReplayVerdict;

  /** A libsql lock error: code SQLITE_BUSY* / SQLITE_LOCKED*, or a message matching /database (?:table )?is locked/i. */
  export function isLockError(error: unknown): boolean;

  /** The wait before lock retry number `attempt` (0-based): min(LOCK_BACKOFF_BASE_MS * 2 ** attempt, LOCK_BACKOFF_MAX_MS, remainingMs); 0 when remainingMs <= 0. */
  export function lockBackoffMs(attempt: number, remainingMs: number): number;

  /** `30s`, `15m`, `1h` or a bare number of seconds, 1 s to 24 h; anything else throws DatabaseOperationError('invalid_timeout', ...). */
  export function parseImportTimeoutMs(value: string): number;
  ```
- `nextBatch` body is today's `nextBatch` (`src/utils/database-sql-import-runner.ts:410-423`) with `MAX_BATCH_GROUPS` replaced by `maxGroups`:
  ```ts
  export function nextBatch(groups: DatabaseSqlImportGroup[], start: number, maxGroups: number): ImportBatch {
      const selected: DatabaseSqlImportGroup[] = [];
      let bytes = 0;
      let index = start;
      while (index < groups.length && selected.length < maxGroups) {
          const groupBytes = Buffer.byteLength(groups[index].sql, 'utf8');
          if (selected.length > 0 && bytes + groupBytes > MAX_BATCH_BYTES) break;
          selected.push(groups[index]);
          bytes += groupBytes;
          index += 1;
          if (groupBytes > MAX_BATCH_BYTES) break;
      }
      return { groups: selected, nextStatement: index };
  }
  ```
- `schemaFactsFromSql`: for each statement, strip leading comments with `sqlWithoutLeadingComments`, then (case-insensitive, first 256 characters for the head, the whole text for the body):
  - `CREATE [TEMP|TEMPORARY] TABLE [IF NOT EXISTS] <name>`: record `keyed` when the statement with string literals (`'...'`) and quoted identifiers (`"..."`, backticks, `[...]`) blanked out still matches `/\bPRIMARY\s+KEY\b|\bUNIQUE\b/i`; a table created with no match is `keyed: false` (a known keyless table).
  - `CREATE UNIQUE INDEX [IF NOT EXISTS] <index> ON <table> (...)`: sets the table `keyed: true`, unless the statement has a `WHERE` clause (a partial index covers only some rows, so it does not count).
  - `CREATE [TEMP] TRIGGER [IF NOT EXISTS] <name> ... ON <table>`: sets the table `triggered: true` (first `ON` after the head).
  - A table first seen only through an index or trigger starts as `{ keyed: false, triggered: false }` and is updated; a later `CREATE TABLE` for the same name replaces `keyed` but keeps `triggered`.
  - Names are normalised as the interface says; identifiers may be `"x"`, `` `x` ``, `[x]`, `'x'` or bare, optionally `main.`-prefixed.
- `replayVerdict`: for each group (leading comments stripped): `CREATE ... IF NOT EXISTS` for `TABLE|INDEX|VIEW|TRIGGER` (optional `UNIQUE`/`TEMP`/`TEMPORARY`/`VIRTUAL`) is safe; `INSERT OR REPLACE INTO <t>`, `INSERT OR IGNORE INTO <t>`, `REPLACE INTO <t>` look `<t>` up in `facts`: missing = the group is unknown (its name goes to `unknownTables`); `keyed && !triggered` = safe; anything else = unsafe. Every other statement is unsafe. `status` is `unsafe` when any group is unsafe (the first one is `firstUnsafe`, and an unknown table does not matter then), else `unknown` when any table is unknown, else `safe`.
- `isLockError`: true when `error.code` is a string starting `SQLITE_BUSY` or `SQLITE_LOCKED` (upper-cased), or `error.message` matches `/database (?:table )?is locked/i`.
- `parseImportTimeoutMs`: `/^(\d+)([smh]?)$/` on the trimmed value (seconds when the unit is empty), multiply to ms; no match, a result under 1000 or over `MAX_IMPORT_TIMEOUT_MS` throws `new DatabaseOperationError('invalid_timeout', '--timeout must look like 30s, 15m or 1h (1 second to 24 hours), got "<value>".')` (the value is a user-typed duration, never a secret).
- `sourceHasVectorColumns`: for each group whose first 200 characters match `/\bCREATE\b/i`, test the whole `group.sql` against `/\bF(?:32|64|16|8|1BIT)_BLOB\s*\(|\bFLOAT(?:32|64)\s*\(|libsql_vector_idx/i`; return true on the first hit. (The 200-character prefilter keeps a 113 MB source of `INSERT` groups cheap.)

- [ ] **Step 1: Write the failing tests** in `tests/database-import-batching.test.ts`. A `group(sql)` helper builds `{ sql, startByte: 0, endByte: sql.length, startLine: 1, endLine: 1 }`. Rows:
  - `nextBatch`: 250 one-byte groups with `maxGroups` 100 from 0 gives `nextStatement` 100; from 100 with `maxGroups` 20 gives 120; a group list whose bytes pass 512 KiB stops before the group that would cross it; one group over 512 KiB is returned alone (`nextStatement` start + 1).
  - `schemaFactsFromSql` (key: facts map entries): `CREATE TABLE t (id INTEGER PRIMARY KEY, v);` gives `t` keyed; `CREATE TABLE "T" (a, b, UNIQUE (a));` gives `t` keyed; `CREATE TABLE t (a, b);` gives `t` `{keyed:false}`; `CREATE TABLE t (a TEXT DEFAULT 'primary key');` and `CREATE TABLE t ("unique" TEXT);` give keyless (blanked literals and quoted identifiers); `CREATE UNIQUE INDEX i ON t(a);` gives `t` keyed; `CREATE UNIQUE INDEX i ON t(a) WHERE a > 0;` does not; `CREATE INDEX i ON t(a);` does not; `CREATE TRIGGER tr AFTER INSERT ON "main"."t" BEGIN SELECT 1; END;` gives `t` triggered; `CREATE TABLE IF NOT EXISTS [x] (id PRIMARY KEY)` gives `x` keyed; a table, then its trigger, then a re-`CREATE TABLE` keeps `triggered`.
  - `mergeSchemaFacts`: the override's `keyed` wins, `triggered` is OR-ed, tables only on one side are kept.
  - `replayVerdict` **safe** (facts `t` keyed): `INSERT OR REPLACE INTO "t" VALUES (1);`, `insert or ignore into t values (1);`, `REPLACE INTO t VALUES (1);`, `-- c\nINSERT OR REPLACE INTO t VALUES (1);`, `/* c */ CREATE TABLE IF NOT EXISTS u (id);`, `CREATE UNIQUE INDEX IF NOT EXISTS i ON t(id);`. **unsafe** (`firstUnsafe` is that group): `INSERT INTO t VALUES (1);`, `CREATE TABLE t (id);`, `CREATE INDEX i ON t(id);`, `UPDATE t SET a = 1;`, `DELETE FROM t;`, `DROP TABLE t;`, `INSERT INTO t SELECT 1 WHERE 'INSERT OR REPLACE INTO' IS NOT NULL;`; and `INSERT OR REPLACE INTO k VALUES (1);` with `k` keyless `{keyed:false}`; and with `t` `{keyed:true, triggered:true}`. **unknown**: `INSERT OR REPLACE INTO nope VALUES (1);` with empty facts (`unknownTables` `['nope']`); a mixed batch `[unknown insert, DELETE]` is `unsafe` (unsafe wins), `[unknown insert, safe insert]` is `unknown`.
  - `sourceHasVectorColumns` true: `CREATE TABLE docs (id INTEGER, embedding F32_BLOB(1536));`, `CREATE INDEX docs_idx ON docs (libsql_vector_idx(embedding));`, `CREATE TABLE v (e FLOAT32(4));`; false: a source of only `INSERT INTO t VALUES ('F32_BLOB(3)');`, `CREATE TABLE plain (id INTEGER, b BLOB);`.
  - `isLockError`: true for `Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' })`, `code` `SQLITE_BUSY_SNAPSHOT`, `code` `SQLITE_LOCKED`, `new Error('database table is locked')`, `new Error('SERVER_ERROR: database is locked')`; false for `new Error('x')`, `{ code: 'SQLITE_CONSTRAINT' }`, `null`, a string.
  - `lockBackoffMs`: `(0, 300000)` 1000, `(1, 300000)` 2000, `(3, 300000)` 8000, `(4, 300000)` 10000, `(9, 300000)` 10000, `(0, 10)` 10, `(2, 0)` 0, `(2, -5)` 0.
  - `parseImportTimeoutMs`: `'30s'` 30000, `'15m'` 900000, `'1h'` 3600000, `'90'` 90000, `' 2m '` 120000, `'24h'` 86400000; each of `''`, `'0'`, `'0s'`, `'abc'`, `'1.5'`, `'-3'`, `'25h'`, `'10x'` throws with `code` `invalid_timeout`.
  - `isDatabaseDeadlineElapsed`: true for the error a `runDatabaseClientOperationWithDeadline(() => new Promise(() => undefined), undefined, 5)` rejects with; false for `new Error('x')` and for `new DatabaseOperationError('upstream_unavailable', 'Database operation timed out.')` built by hand.
- [ ] **Step 2: Expected RED (no local run):** every row fails on the base because `src/utils/database-import-batching.ts` and the two exports do not exist (the import of the module throws). The per-task reviewer checks each row against the test code.
- [ ] **Step 3: Implement** the three source edits exactly as the Interfaces block says.
- [ ] **Step 4: Static checks (these run no test):** `npx prettier --check` on the four paths (if the repo has no prettier config, skip and say so), `npx eslint` on the changed files if the repo has an eslint config, and `npm run build` (type check). Paste the outputs.
- [ ] **Step 5: Report (do not commit):** list every changed path, separating test paths from source paths, with the expected-RED table.

## Task 2: Runner split-and-retry, lock retry, keyed-table rule, vector cap, relaxed checkpoint check, and the `batchTimeoutMs`/`sleep` wiring (cli#267)

**Depends on:** Task 1 (committed first).

**Files (file scope, the only paths this task may touch):**
- Modify: `src/utils/database-sql-import-runner.ts`
- Modify: `src/commands/database.ts` (only: the `DatabaseCommandDependencies` interface at line 182 gains `sleep?: (ms: number) => Promise<void>;`, and the two `runPreparedDatabaseImport(...)` option objects, `create --from` near line 1467-1480 and `databaseImportWithConfig` near line 1625-1636, gain two properties each; nothing else)
- Modify: `tests/database-import-command.test.ts` (the existing stalled-batch row stays as is; the two checkpoint rows at lines 1099-1131 are rewritten; the `importHarness` gains the `catalog`, `sleep` hooks below; new rows added)

Grep of the callers and doubles (paste the real output in the report): `grep -rn "runPreparedDatabaseImport\|DatabaseImportRunnerDependencies" src tests` (expected: the runner, `src/commands/database.ts` at the two call sites, and `tests/database-import-command.test.ts` through `databaseImportWithConfig`); `grep -rn "dataPlaneTimeoutMs" tests/database-import-command.test.ts` (expected: line 306 only); `grep -rn "DatabaseCommandDependencies" src tests` (every implementer of the interface keeps compiling because `sleep` is optional).

**Interfaces:**
- Consumes (Task 1, quoted from the frozen block): `MAX_BATCH_GROUPS`, `VECTOR_MAX_BATCH_GROUPS`, `DEFAULT_IMPORT_BATCH_TIMEOUT_MS`, `SCHEMA_CATALOG_SQL`, `ImportBatch`, `SchemaFacts`, `nextBatch(groups, start, maxGroups)`, `sourceHasVectorColumns(groups)`, `schemaFactsFromSql(statements)`, `mergeSchemaFacts(base, override)`, `replayVerdict(groups, facts)`, `isLockError(error)`, `lockBackoffMs(attempt, remainingMs)` from `./database-import-batching`; `isDatabaseDeadlineElapsed(error)` from `./database-data-plane`.
- Produces: `DatabaseImportRunnerDependencies` gains `batchTimeoutMs?: number` (milliseconds; the runner reads `dependencies.batchTimeoutMs ?? DEFAULT_IMPORT_BATCH_TIMEOUT_MS`) and `sleep?: (ms: number) => Promise<void>` (default `(ms) => new Promise((resolve) => setTimeout(resolve, ms))`). Task 3 fills `batchTimeoutMs` from `--timeout`.

**Runner changes (exact):**
1. Delete the local `MAX_BATCH_GROUPS`, `MAX_BATCH_BYTES`, `ImportBatch` and `nextBatch` (they move to the batching module); import them from there. `RENEWAL_WINDOW_MS` and `CHECKPOINT_VERSION` stay.
2. Delete `deterministicBatchCount`. In `validateCheckpoint`, replace the `expectedBatchCount` condition with Design ruling D3:
   ```ts
   || typeof checkpoint.lastCompletedBatch !== 'number'
   || !Number.isInteger(checkpoint.lastCompletedBatch)
   || checkpoint.lastCompletedBatch < (nextStatement === 0 ? 0 : 1)
   || checkpoint.lastCompletedBatch > nextStatement
   ```
   (keep the `typeof nextStatement !== 'number'`, `expectedBoundary === null` and `completedSourceBytes !== expectedBoundary` conditions; `checkpoint.lastCompletedBatch > nextStatement` is evaluated after the `typeof nextStatement` check, reorder so TypeScript narrows).
3. In `runPreparedDatabaseImport`, before the loop:
   ```ts
   const batchTimeoutMs = dependencies.batchTimeoutMs ?? DEFAULT_IMPORT_BATCH_TIMEOUT_MS;
   const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
   let batchCap = sourceHasVectorColumns(prepared.groups) ? VECTOR_MAX_BATCH_GROUPS : MAX_BATCH_GROUPS;
   let retryingAfterTimeout = false;   // set by a retried timeout, cleared when a batch completes
   let lockAttempts = 0;
   let lockWaitedMs = 0;
   let catalogFacts: SchemaFacts | undefined;   // read at most once (D8)
   ```
   Inside the loop, plan with `nextBatch(prepared.groups, nextStatement, batchCap)` and run it with `batchTimeoutMs` in place of `dependencies.dataPlaneTimeoutMs ?? DEFAULT_DATABASE_DATA_PLANE_TIMEOUT_MS`. In the `catch (error)` of the batch call, **before** `if (error instanceof DatabaseOperationError) throw error;`, add two branches. Each branch's `closeCurrentClient`, `client`, `clientClosePromise`, `deadline` are the existing locals; a stalled or failed client is closed fire-and-forget (a wedged stream must not stop the retry) and is never reused.
   ```ts
   const batchFrom = batch.groups[0].startLine;
   const batchTo = batch.groups[batch.groups.length - 1].endLine;
   const dropClient = () => {
       void closeCurrentClient().catch(() => undefined);
       client = undefined;
       clientClosePromise = undefined;
       deadline = undefined;
   };

   // D7: a lock error that follows a retried timeout: same batch, same size, bounded backoff.
   if (retryingAfterTimeout && isLockError(error)) {
       const delay = lockBackoffMs(lockAttempts, batchTimeoutMs - lockWaitedMs);
       if (delay <= 0) {
           throw new DatabaseOperationError(
               'upstream_unavailable',
               `The database stayed locked for ${Math.round(batchTimeoutMs / 1000)}s after a batch timed out (lines ${batchFrom}-${batchTo}); the timed-out transaction may still be running. Wait and resume, or raise the per-batch limit with --timeout.`,
           );
       }
       lockAttempts += 1;
       lockWaitedMs += delay;
       dropClient();
       dependencies.stdout(`The database is still locked by the timed-out batch; retrying the same ${batch.groups.length} statements in ${Math.round(delay / 100) / 10}s.`);
       await sleep(delay);
       continue;
   }

   // D1, D2, D8: a deadline timeout.
   if (isDatabaseDeadlineElapsed(error)) {
       const size = batch.groups.length;
       const seconds = Math.round(batchTimeoutMs / 1000);
       const sourceFacts = schemaFactsFromSql(prepared.groups.slice(0, batch.nextStatement).map((group) => group.sql));
       let verdict = replayVerdict(batch.groups, catalogFacts ? mergeSchemaFacts(sourceFacts, catalogFacts) : sourceFacts);
       if (size >= 2 && verdict.status === 'unknown') {
           // D8: one read of the target catalog, on a fresh client, under the per-batch deadline.
           dropClient();
           const acquired = await acquireClient(prepared, config, dependencies);
           client = acquired.client;
           deadline = acquired.deadline;
           let rows: Array<ArrayLike<unknown>>;
           try {
               rows = (await runDatabaseClientOperationWithDeadline(
                   () => client!.execute(SCHEMA_CATALOG_SQL),
                   closeCurrentClient,
                   batchTimeoutMs,
               )).rows;
           } catch {
               throw new DatabaseOperationError(
                   'upstream_unavailable',
                   `A batch of ${size} statements (lines ${batchFrom}-${batchTo}) did not finish within ${seconds}s, and the target schema could not be read to check whether repeating it is safe, so it was not retried. Raise the per-batch limit with --timeout (for example --timeout 15m).`,
               );
           }
           catalogFacts = schemaFactsFromSql(rows.map((row) => String(row[3] ?? '')));
           verdict = replayVerdict(batch.groups, mergeSchemaFacts(sourceFacts, catalogFacts));
       }
       if (size >= 2 && verdict.status === 'safe') {
           if (!keepFreshClient) dropClient();   // the catalog read's fresh client is not stalled: keep it
           batchCap = Math.max(1, Math.floor(size / 2));
           retryingAfterTimeout = true;
           lockAttempts = 0;
           lockWaitedMs = 0;
           dependencies.stdout(
               `A batch of ${size} statements did not finish within ${seconds}s; retrying from the same statement in batches of up to ${batchCap}.`,
           );
           continue;
       }
       // not retried: the stop messages (next block) go here, inside this same branch
   }
   ```
   `keepFreshClient` is a `let keepFreshClient = false;` declared at the top of the timeout branch and set to `true` right after the catalog read's `acquireClient` (so a retry after a catalog read runs on that same fresh client, never the stalled one; in every other path the stalled client is dropped here). The stop messages, placed at the marked spot, for a batch that is not retried (`verdict.status` is `unsafe` or still `unknown`, or `size === 1`):
   ```ts
   const reason = size === 1
       ? `A single statement (lines ${batchFrom}-${batchTo}, ${Buffer.byteLength(batch.groups[0].sql, 'utf8')} bytes) did not finish within ${seconds}s and cannot be split further.`
       : `A batch of ${size} statements (lines ${batchFrom}-${batchTo}) did not finish within ${seconds}s and may or may not have committed. ${verdict.status === 'unsafe' && verdict.firstUnsafe ? `The statement at lines ${verdict.firstUnsafe.startLine}-${verdict.firstUnsafe.endLine} is not safe to repeat (a plain INSERT or CREATE, an UPDATE or DELETE, or an INSERT OR REPLACE/IGNORE into a table without a primary key or unique constraint, or with a trigger)` : `The target tables ${verdict.unknownTables.join(', ')} are not known to have a primary key or unique constraint, so repeating the batch is not safe`}, so it was not retried; if the table has no unique key, check it before resuming.`;
   throw new DatabaseOperationError(
       'upstream_unavailable',
       `Database operation timed out. ${reason} Raise the per-batch limit with --timeout (for example --timeout 15m).`,
   );
   ```
   (`unknownTables` after the catalog read still non-empty means the table is not in the target either, for example created later by the source: not safe.) After the batch call succeeds, add `retryingAfterTimeout = false; lockAttempts = 0; lockWaitedMs = 0;` next to `completedBatches += 1`. Everything else in the loop (the checkpoint publish, progress line) is unchanged. `DEFAULT_DATABASE_DATA_PLANE_TIMEOUT_MS` stays imported for `closeClient`.
   *The developer may restructure the two branches for clarity as long as every behaviour in D1, D2, D7, D8 and the rows below holds; the code above is the specification, not a paste.*
4. `src/commands/database.ts`: add `sleep?: (ms: number) => Promise<void>;` to `DatabaseCommandDependencies`, and add `batchTimeoutMs: dependencies.dataPlaneTimeoutMs,` and `sleep: dependencies.sleep,` to the two option objects (`dependencies` is the raw argument, not `io`; in the `create --from` function use that function's own raw `dependencies` parameter; read the surrounding code to name it).

**Test harness additions (in `tests/database-import-command.test.ts`, `importHarness`):** `HarnessOptions` gains `catalog?: (sql: string) => unknown[][] | Promise<unknown[][]>` and `sleep?: (ms: number) => Promise<void>`. The fake client's `execute` becomes `async (sql) => { catalogReads.push({ client, sql: String(sql) }); if (!options.catalog) throw new Error('import must use executeMultiple'); return { columns: ['type', 'name', 'tbl_name', 'sql'], rows: await options.catalog(String(sql)) }; }`; the harness returns `catalogReads`, and `dependencies.sleep` is `async (ms) => { sleeps.push(ms); await options.sleep?.(ms); }` with `sleeps` returned too (so no real wait ever happens). Every existing row keeps its behaviour (no `catalog` means `execute` still throws).

**Tests (all in `tests/database-import-command.test.ts`, using the local `importHarness`, `sourceFile`, `checkpointFiles`, `accessPosts`, `expectNoSecrets`; stalled = the harness `options.execute` returns `new Promise(() => undefined)`; the harness's `test.dependencies.dataPlaneTimeoutMs = 10` is the timeout hook, which the command forwards as `batchTimeoutMs`; each new row sets a `1_000` ms vitest timeout like the existing stalled row). `KEYED` below is the source's first statement `CREATE TABLE t (id INTEGER PRIMARY KEY);`:**
- [ ] **Row A: split-and-retry finishes the import.** `KEYED` plus 39 statements `INSERT OR REPLACE INTO t VALUES (${i});` (i 1..39), 40 groups. `execute` stalls when `sql.split('INSERT OR REPLACE').length - 1 > 10`. Expect the run resolves; the group counts per execution are `[40, 20, 10, 10, 10, 10]` (count `INSERT`/`CREATE` groups, not lines); `accessPosts(test)` has 3 entries; the executions' client numbers are `[1, 2, 3, 3, 3, 3]` (I2: a retried execution never reuses a stalled client); `test.closed` is `[1, 2, 3]`; `test.catalogReads` is empty (the source settled every table); `test.stdout` contains exactly two lines that match `/did not finish within .*s; retrying from the same statement in batches of up to (20|10)/`; the checkpoint file is removed. **I1 sweep:** collect the `VALUES (n)` numbers of the executions that did not stall (the last four) and expect them, with the `CREATE`, to equal the source in order, each once; the first statement of every execution that follows a stalled one equals the first statement of the stalled one.
- [ ] **Row B: statements that are not safe to repeat are never retried (I1).** `it.each` over sources (each three statements, `execute` always stalls): `INSERT INTO t VALUES (1);` x3; `CREATE TABLE t (id);` x3; `UPDATE t SET a = 1;` x3; `DELETE FROM t;` x3; `DROP TABLE t;` x3; **a keyless table**: `CREATE TABLE t (a);` then two `INSERT OR REPLACE INTO t VALUES (1);`; **an `INSERT OR IGNORE` into a keyless table**: the same with `OR IGNORE`. Expect `rejects.toMatchObject({ code: 'upstream_unavailable' })`, exactly one execution, `test.catalogReads` empty (the source settled it), message contains `not safe to repeat`, `--timeout` and `lines 1-3`, and passes `expectNoSecrets`.
- [ ] **Row C: a single statement that times out stops the run.** `KEYED` is not needed: one `INSERT OR REPLACE INTO t VALUES (1);`, always stalls: one execution, no catalog read (size 1 stops before any read), message contains `cannot be split further` and `--timeout`.
- [ ] **Row D: progress before the failing statement is kept (I4).** `KEYED` plus 39 `INSERT OR REPLACE` statements (the `VALUES (n)` numbering as in row A); `execute` stalls whenever the SQL contains `VALUES (7)`. The halving runs 40 (stall), 20 (stall), 10 (stall), 5 (statements 0-4 pass; 5-9 stall), 2 (statements 5-6 pass; 7-8 stall), 1 (statement 7 stalls). Expect rejection with code `upstream_unavailable` and a message containing `cannot be split further`; the checkpoint file exists with `nextStatement` 7, `lastCompletedBatch` 2 and `completedSourceBytes` equal to the byte offset of the end of statement 6 in the source; the error message contains the exact `Resume with:` line (the test file's `resumeLine` helper) for that checkpoint. The last execution holds exactly one statement.
- [ ] **Row E: vector sources use the smaller cap.** `it.each`: a source `CREATE TABLE d (id INTEGER, e F32_BLOB(4));` + 45 `INSERT INTO d VALUES (${i}, X'00');` has group counts per execution `[20, 20, 6]`; the same 46 groups with `CREATE TABLE d (id INTEGER, e BLOB);` have `[46]`. The `libsql_vector_idx` index form also gives `[20, 20, 6]`.
- [ ] **Row F: the relaxed checkpoint check (D3).** Rewrite the existing `it.each` at lines 1099-1131 into: rejected rows `lastCompletedBatch 101 with nextStatement 100` (label "batch count exceeds the statement position") and `lastCompletedBatch 1, nextStatement 50, completedSourceBytes one byte off` (label "source bytes do not match the statement boundary"); and a new accepted row: 101 statements, a checkpoint with `lastCompletedBatch 3`, `nextStatement 50`, the exact byte offset, resumed with `{ yes: true, resume: checkpoint }`: resolves, the first execution holds `VALUES (50)` and not `VALUES (49)`, the checkpoint is removed. The rejected rows keep the existing assertions (`native:load` not seen, `posts` equal `[showPost('Analytics')]`, no executions).
- [ ] **Row G: `batchTimeoutMs` default and wiring.** The existing stalled-batch row (line 299) must still pass unchanged (it goes through the raw `dataPlaneTimeoutMs` hook). One new row calls `runPreparedDatabaseImport` through `databaseImportWithConfig` with no `dataPlaneTimeoutMs` set and a fast `execute`, and expects success (the 300 s default does not break a normal import).
- [ ] **Row J: the target schema is read once when the source does not settle the table (D8).** A source of 40 `INSERT OR REPLACE INTO t VALUES (${i});` with no `CREATE`, `execute` stalls when more than 10 inserts are in the SQL. (1) `catalog` returns `[['table','t','t','CREATE TABLE t (id INTEGER PRIMARY KEY)']]`: the run resolves, `test.catalogReads` has exactly one entry with `sql` equal to `SCHEMA_CATALOG_SQL` and a client number higher than the stalled client's, and the later executions run on that same client (I2), group counts `[40, 20, 10, 10, 10, 10]`. (2) `catalog` returns `[['table','t','t','CREATE TABLE t (a)']]` (keyless): rejects with `not safe to repeat`, one batch execution plus one catalog read. (3) `catalog` returns the keyed table plus `['trigger','tr','t','CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END']`: rejects with `not safe to repeat`. (4) `catalog` returns `[]` (the table is not known anywhere): rejects with `are not known to have a primary key`, message names `t`. (5) `catalog` throws: rejects with `could not be read`, one batch execution, and the message passes `expectNoSecrets`. (6) Two stalls in one run (a second timeout later in the source): `test.catalogReads` still has one entry (the facts are cached).
- [ ] **Row K: a lock error after a timeout waits and retries the same size (D7, I1, I2).** `KEYED` plus 39 `INSERT OR REPLACE` statements, 40 groups; `test.dependencies.dataPlaneTimeoutMs = 10` (so the stall is quick and the lock budget `batchTimeoutMs` is 10 ms; the backoff growth is pinned by the Task 1 `lockBackoffMs` rows). `execute` is scripted: call 1 stalls; call 2 throws `Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' })`; the rest succeed. Expect the run resolves; group counts `[40, 20, 20, 20]` (the halve to 20 happens once; the BUSY retry runs the same 20 statements at the same size: assert the SQL of executions 2 and 3 is identical); `test.sleeps` equals `[10]`; client numbers: execution 1 < 2 < 3 and 3 equals 4 (a fresh client per attempt, never a stalled or failed one, and no extra mint when nothing failed); `test.stdout` has one line matching `/still locked by the timed-out batch/`. Variants: (b) the same source, `execute` stalls once then **always** throws BUSY: executions `[stall, BUSY, BUSY]`, `test.sleeps` equals `[10]` (the second BUSY finds no budget left), rejects with `upstream_unavailable`, message contains `stayed locked`, `lines 1-40` and `--timeout`, passes `expectNoSecrets`, and contains no `Resume with:` (no checkpoint exists yet; row D pins the line); (c) a BUSY with **no** earlier timeout: rejects with `A database import batch failed.`, exactly one execution, `test.sleeps` empty.
- [ ] **Step 2: Expected RED (no local run, the per-task reviewer checks each against the test code):** A fails on the base because the first stall throws `upstream_unavailable` after one execution (executions length 1, not 6); B passes on the base for "one execution" but fails on the `not safe to repeat`, `--timeout` and `lines 1-3` assertions; C fails on the message; D fails on the message (base: generic `Database operation timed out.`) and on `nextStatement` 7 (base: no halving, checkpoint at 0 and no checkpoint file); E fails on the group counts (`[46]` on the base for the vector source); F's accepted row fails on the base (`deterministicBatchCount` returns null for position 50) and the rewritten rejected rows fail only on the new labels (they pass on both sides; say so); G passes on both sides (regression guard); J(1) fails on the base (one execution, no retry), J(2)-(5) fail on the message assertions (and J(5) on `catalogReads` length), J(6) on the retry; K(a) fails on the base (the stall rejects after one execution), K(b) on the execution count and `sleeps`, K(c) passes on both sides (regression guard that a BUSY outside a retry is not retried; say so).
- [ ] **Step 3: Implement** the runner changes, the interface line and the two call-site edits exactly as above, and the harness additions.
- [ ] **Step 4: Static checks:** prettier and eslint on the changed files if configured, `npm run build`. Paste the outputs.
- [ ] **Step 5: Report (do not commit):** every changed path (source and test separately), the grep outputs, the expected-RED table, and `git diff --stat` for the task's paths. **If the diff passes about 1000 formatted lines (the tests are the bulk), split the test rows J and K into Task 2b on the same card thread and ask the manager; do not silently exceed.**

## Task 3: The `--timeout` option, help and README (cli#267)

**Depends on:** Task 2 (committed first; this task edits `src/commands/database.ts` and the same test file).

**Files (file scope, the only paths this task may touch):**
- Modify: `src/index.ts` (the `database import` registration at lines 451-459, and the `'database import' is for BULK DATA LOADING only` help paragraph near line 315 if a sentence fits there)
- Modify: `src/commands/database.ts` (`DatabaseImportOptions` at line 175-178 and `databaseImportWithConfig` at line 1595-1637)
- Modify: `README.md` (the database section: add the example line beside the existing `solidactions database import analytics backup.sql --yes` examples at lines 114-115, plus one short paragraph and one limits line in the same section)
- Modify: `tests/database-import-command.test.ts`
- Modify: `tests/readme-contract.test.ts` (add the new example line and phrase to the database contract; keep every existing phrase)

Grep (paste real output): `grep -rn "'--resume'\|options.resume\|DatabaseImportOptions" src tests` and `grep -rln "database import" README.md src tests`.

**Interfaces:**
- Consumes (Task 1/2, frozen): `parseImportTimeoutMs(value: string): number` from `../utils/database-import-batching`; `DatabaseImportRunnerDependencies.batchTimeoutMs?: number`.
- Produces: `DatabaseImportOptions` gains `timeout?: string`; `.option('--timeout <duration>', 'Per-batch time limit, e.g. 30s, 15m, 1h (default 5m). A batch that times out is retried in smaller halves when its statements are safe to repeat (INSERT OR REPLACE, INSERT OR IGNORE, CREATE ... IF NOT EXISTS)')` on `database import`.

**Behaviour (exact):**
1. In `databaseImportWithConfig`, parse before anything else, i.e. before `refuseIfAnalytical` (which mints a `show`): `const batchTimeoutMs = options.timeout !== undefined ? parseImportTimeoutMs(options.timeout) : dependencies.dataPlaneTimeoutMs;` and pass `batchTimeoutMs` in the runner dependency object, replacing the Task 2 `batchTimeoutMs` line (the `sleep` line stays). An invalid value throws `invalid_timeout` before any native load or mint, so `posts` is empty (the show guard has not run either; assert `posts` equal `[]`).
2. `src/index.ts`: add the option; the command description stays; add to the `database import` help (`addHelpText('after', ...)` on that command, matching how `database push` does it at `src/index.ts:462-470`) four sentences: the default per-batch limit is 5 minutes; a timed-out batch of statements that are safe to repeat (`INSERT OR REPLACE`/`OR IGNORE` into a table with a primary key or unique constraint and no trigger, `CREATE ... IF NOT EXISTS`) is retried in smaller batches, otherwise the run stops with the usual resume line; vector columns make the batches smaller; a lock held by the timed-out batch is waited for.
3. `README.md`: one example `solidactions database import analytics big.sql --timeout 15m --yes`, one paragraph with the same four sentences, and one **limits** line (D1, D4): a table with a trigger, a statement that omits its key columns, or a plain `INSERT` dump is not retried; a source that only inserts into an existing vector table starts on the full batch size and the first timeout halves it. Keep every phrase `tests/readme-contract.test.ts` pins.
4. `tests/readme-contract.test.ts`: add `--timeout` to the options loop (line 99) and the example command to the pinned examples.

**Tests (in `tests/database-import-command.test.ts`):**
- [ ] **Registration:** extend the row at line 282: `command.options.find((option) => option.long === '--timeout')` is defined and `required` true.
- [ ] **Row H: `--timeout` is honoured (fake timers, PM ruling 6: no real 1 s waits).** `vi.useFakeTimers()` in the row (restore with `vi.useRealTimers()` in a `finally`), then `const run = databaseImportWithConfig('Analytics', source, { yes: true, timeout: '1s' }, CONFIG, test.dependencies)` with a stalled `execute` (one `INSERT INTO t VALUES (1);`) and `dataPlaneTimeoutMs` **unset**; attach `const settled = expect(run).rejects.toMatchObject({ code: 'upstream_unavailable' })`, then `await vi.advanceTimersByTimeAsync(999)` and assert the promise has not settled (a flag set in a `.finally`), then `await vi.advanceTimersByTimeAsync(1)`, `await settled`, and the message contains `within 1s`. A second row with both `timeout: '1s'` and `dataPlaneTimeoutMs = 60_000` still stops at 1 s (the flag wins), the same way. Both rows run in milliseconds of real time.
- [ ] **Row I: invalid values are refused first.** `it.each(['0', '0s', 'abc', '1.5', '-3', '25h', ''])` rejects with `invalid_timeout`, `test.events` has no `native:load`, `test.posts` equals `[]`, no executions.
- [ ] **Step 2: Expected RED:** H fails on the base (the option is ignored: the stall waits for the 300 s default and the vitest timeout fires, or `within 1s` is absent); I fails on the base (`timeout` is ignored, the import runs); the registration row fails (no `--timeout` option); the README contract rows fail until the README is edited.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Static checks:** prettier and eslint on the changed files if configured, `npm run build`.
- [ ] **Step 5: Report (do not commit):** every changed path, the grep outputs, the expected-RED table.

## Task 4: Verify-time probes (manager, not a developer card; no files)

Run at the verify step on the free app slot's dev stack (role overrides: CLI built from the branch, `scripts/local-dev up` there, nothing checked out, bring it down after), not now. These **confirm**; the build does not depend on any of them (PM rulings 1 and 3):
- [ ] A real import of a vector dump (a few thousand `INSERT OR REPLACE` rows into an `F32_BLOB(1536)` table with a `PRIMARY KEY` and a `libsql_vector_idx` index; generated by a throwaway script in the SDD workspace, never committed) with `--timeout 1s` to force real timeouts. Records: whether the retry's `BEGIN IMMEDIATE` waits or answers a lock error (the D7 path), whether the run then finishes in one invocation, and the final row count equals the source's (no doubles, no losses).
- [ ] The write token's `expires_in_seconds` from the dev stack (confirms D6).
- [ ] A plain-`INSERT` dump, and a keyless-table `INSERT OR REPLACE` dump, each with `--timeout 1s`: each stops once with the "not safe to repeat" message and a resume line.
If the first probe stops on every retry for a reason D7 does not cover, the wave's Done-when is not met: stop and mail the PM with the evidence.

## Self-Review

1. **Spec coverage:** the issue's (1) split-and-retry: D1, D2, D7, D8, Task 2 rows A-D, J, K; (2) 300 s limit and `--timeout`: D5, Task 2 row G, Task 3; (3) smaller vector batches: D4, Task 2 row E; the INSERT caveat: D1 and rows B and J; "a test that makes a batch time out and proves the split-and-retry": row A; the release: the PM's. The six PM rulings: 1 = D7, row K, Destructive paths; 2 = D1, D8, rows B and J (option a, triggers named in D1); 3 = D6; 4 = the stop messages name the batch line range and the first unsafe statement's lines (row B asserts `lines 1-3`); 5 = D4 (cost noted instead of adopted, because it needs a schema read before the first batch); 6 = Task 3 row H on fake timers.
2. **Placeholders:** none; Task 4 is a manager probe with named measurements. The runner code in Task 2 is a specification with one marked restructure licence.
3. **Type consistency:** `nextBatch(groups, start, maxGroups)`, `sourceHasVectorColumns`, `schemaFactsFromSql`, `mergeSchemaFacts`, `replayVerdict`, `isLockError`, `lockBackoffMs`, `SCHEMA_CATALOG_SQL`, `parseImportTimeoutMs`, `isDatabaseDeadlineElapsed`, `batchTimeoutMs`, `sleep` are named identically in the Interfaces blocks of Tasks 1, 2 and 3.
4. **Review Focus:** each of the five lines has a row (1: rows A and K plus the smoke; 2: rows B and J; 3: Task 1 parser rows and row I; 4: row F; 5: row C).
5. **File scope:** Task 2 and Task 3 both edit `src/commands/database.ts` and `tests/database-import-command.test.ts`; they run serially (Task 3 depends on Task 2). Task 1 touches `src/utils/database-sql-import.ts` and `src/utils/database-data-plane.ts` with one-line additions only. Task 2's `database.ts` edit is the optional `sleep` interface member and four option properties.
6. **Premises:** every premise above cites file:line and quotes it; the unmeasured one (wait-or-lock on retry) no longer decides the design (D7) and has a named confirmation probe in Task 4.
7. **Parallelism:** none worth taking: three small serial tasks (Task 1 freezes the contract, Tasks 2 and 3 share a test file). Task 2 carries the most diff (runner, harness, rows A-K); its report measures it and splits rows J and K into a 2b card if it passes about 1000 lines.
8. **Midpoint row:** none: midpoint at half (after Task 2, the runner; Task 3 does not wait for any verdict).

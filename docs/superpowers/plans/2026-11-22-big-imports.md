# Big database imports finish by themselves Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sa-subagent-driven-development to implement this plan task-by-task (the wave's build step). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `solidactions database import` of a big dump (113 MB, `F32_BLOB(1536)` vector columns) finishes in one run: a batch that times out is split and retried when that is safe, the per-batch limit is 300 s and can be raised with `--timeout`, and vector sources use smaller batches.

**Architecture:** A new pure module `src/utils/database-import-batching.ts` owns the batching policy (batch caps, the vector-schema detector, the "safe to repeat" classifier, the `--timeout` parser). `src/utils/database-sql-import-runner.ts` uses it: on a deadline error from a batch it drops the (already closed) client, lowers the batch cap to half of the failed batch and re-plans from the same statement, so repeated halving down to one statement falls out of the existing loop and every completed sub-batch is checkpointed as today. A timed-out batch that holds a statement that is not safe to repeat is never retried; the run stops with a clear message and the usual resume line. `src/commands/database.ts` and `src/index.ts` carry the `--timeout` option.

**Tech Stack:** TypeScript, commander, `@libsql/client` (reached only through the existing injected `loadClient`), vitest (CI only; nothing runs locally).

**Spec:** none (no design file; the design is this plan's Architecture plus the Design rulings below). The cause analysis is on `cli#267` and `SolidActions/solidactions-app#2314`.

**Issues:** `cli#267` ("Database import: a batch that times out is never retried; big vector imports stop every few MB"), sanctioned by Peter's approval 2026-11-22 recorded in the issue body ("Peter approved the fix 2026-11-22") and the wave's approval ask `task-startthefixsobig-d724`. The issue has no comments (read with `gh api --paginate repos/SolidActions/solidactions-cli/issues/267/comments`; `scripts/issue` does not exist in the CLI repo). The wave card is `task-wavebigdatabase-4215`; the plan card is `task-planbigimports-9955`. No open PR touches any file of this plan (`gh pr list --state open` was empty at plan time).

## Global Constraints

- **The ask, verbatim (cli#267 body, the Fix paragraph):** "Fix (CLI): (1) on timeout, retry the same batch split in half, repeat down to one group; (2) a longer import batch limit (300 s) and a --timeout option; (3) smaller batches when vector columns are present. Caveat: a timed-out batch may still have committed, so the retry must be safe: INSERT OR REPLACE is; for plain INSERT the runner checks the checkpoint/row before retrying or stops with a clear message."
- **"Done when" (verbatim):** "the same kind of import finishes in one run without manual resumes, with a test that makes a batch time out and proves the split-and-retry, and a CLI release." The release is the PM's, after merge; this wave ships the code, the test and the README line.
- **Premises, each quoted from this tree (verified 2026-11-22):**
  - Batch caps and limit: `const MAX_BATCH_GROUPS = 100;` and `const MAX_BATCH_BYTES = 512 * 1024;` (`src/utils/database-sql-import-runner.ts:25-26`); `export const DEFAULT_DATABASE_DATA_PLANE_TIMEOUT_MS = 120_000;` (`src/utils/database-data-plane.ts:107`).
  - The batch call and its no-retry catch: `await runDatabaseClientOperationWithDeadline(() => client!.executeMultiple!(batchSql(batch.groups)), closeCurrentClient, dependencies.dataPlaneTimeoutMs ?? DEFAULT_DATABASE_DATA_PLANE_TIMEOUT_MS,);` then `if (error instanceof DatabaseOperationError) throw error;` (`src/utils/database-sql-import-runner.ts:555-561`). On the deadline the helper calls the `onTimeout` hook (here `closeCurrentClient`, which closes the client) and rejects with the private class `DatabaseDeadlineElapsed` (code `upstream_unavailable`, message `Database operation timed out.`) (`src/utils/database-data-plane.ts:184-188`, `:221-228`). So **after a timeout the client is already closed and must not be reused**; the loop mints a new one when `client` is `undefined` (`:544-551`).
  - The batch is one transaction: `batchSql` is `PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE; <groups>; COMMIT; PRAGMA foreign_keys=ON;` (`:425-433`). A timed-out batch may have committed, may still be running on the server, or may be rolled back: the CLI cannot tell. **UNMEASURED:** whether a retry's `BEGIN IMMEDIATE` waits for a still-running old transaction or answers `SQLITE_BUSY` at once. The design is safe either way (a BUSY is an ordinary failed batch: the run stops and prints the resume line); Task 4's verify probe measures it.
  - The checkpoint check ties `nextStatement` to a deterministic partition: `deterministicBatchCount` walks `nextBatch` with the fixed caps and `validateCheckpoint` requires `checkpoint.lastCompletedBatch !== expectedBatchCount` to be false (`src/utils/database-sql-import-runner.ts:134-149`, `:165-177`). Split batches break that partition, so Task 2 relaxes the check (Design ruling D3).
  - Existing pins of that check: `tests/database-import-command.test.ts:1099-1131` (two rows: "batch count exceeds the deterministic boundary count" and "statement position is not a deterministic batch boundary"); both rows are rewritten in Task 2.
  - Existing pin of the timeout path: `closes a stalled atomic batch at the per-verb deadline and does not publish progress` sets `test.dependencies.dataPlaneTimeoutMs = 10` and expects `rejects.toMatchObject({ code: 'upstream_unavailable' })`, `test.closed` equal to `[1]`, no checkpoint and empty stdout (`tests/database-import-command.test.ts:299-314`). That statement is a single plain `CREATE TABLE` group, so it must still stop at once with no retry.
  - `resolveDependencies` always fills `dataPlaneTimeoutMs` with 120 s (`src/commands/database.ts:272`), and the import call sites pass `dataPlaneTimeoutMs: io.dataPlaneTimeoutMs` (`:1479` for `create --from`, `:1634` for `import`). The runner therefore gets a new, separate dependency `batchTimeoutMs`, filled from the **raw** `dependencies.dataPlaneTimeoutMs` (still the test hook) and never from `io`.
  - The parser's group shape is pinned by `toEqual` in `tests/database-sql-import-parser.test.ts:95`, so **no field is added to `DatabaseSqlImportGroup`**; replay safety is classified from `group.sql`.
  - An existing `--timeout <duration>` option takes `30s`, `15m`, `1h` (`src/index.ts:1089`, parser `/^(\d+)([smh]?)$/` at `src/commands/connection-wait.ts:21`). `database import --timeout` uses the same form. `tests/readme-contract.test.ts:80-116` pins README phrases for the database section; Task 3 only adds text and keeps every pinned phrase.
  - `database import` is registered at `src/index.ts:451-459`; the command is `databaseImportWithConfig` (`src/commands/database.ts:1595-1637`); `create --from` runs the same runner (`:1457-1480`).
- **Design rulings (mine, recorded here; each with its cost if wrong):**
  - **D1: a timed-out batch is retried only when every statement in it is safe to repeat**, i.e. its final state is the same whether it ran once or twice: `INSERT OR REPLACE INTO`, `REPLACE INTO`, `INSERT OR IGNORE INTO`, and `CREATE TABLE|INDEX|VIEW|TRIGGER IF NOT EXISTS` (with optional `UNIQUE`/`TEMP`/`TEMPORARY`/`VIRTUAL`). Anything else (plain `INSERT`, plain `CREATE`, `UPDATE`, `DELETE`, `DROP`, unknown) is not safe. This is the issue's own caveat, taking its "or stops with a clear message" branch for plain `INSERT` (no row-probing: the runner cannot know the table's key, and a wrong guess would double rows). Cost if wrong: a plain-`INSERT` dump that times out still needs a manual resume (today's behaviour, now with a clear message); nothing is ever silently doubled.
  - **D2: halving re-plans instead of recursing.** On a timeout of a batch of `size` statements (safe to repeat, `size >= 2`) the runner sets `cap = floor(size / 2)`, drops the dead client and loops: the next iteration mints a fresh client and plans the batch from the same `nextStatement` with the lower cap. The cap never grows back inside a run (a slow table stays slow, and each timeout costs the full limit). One statement that times out stops the run. Cost if wrong: a source that was only slow in one region stays on small batches for the rest of the run (slower, correct).
  - **D3: the checkpoint check is relaxed to what is still true.** A checkpoint is valid when its database and source digest match, `nextStatement` is an integer from 0 to `groups.length`, `completedSourceBytes` equals that statement boundary's byte offset, and `lastCompletedBatch` is an integer with `0 <= lastCompletedBatch <= nextStatement` and `lastCompletedBatch >= 1` when `nextStatement > 0` (it is a count of completed batch calls and is no longer derivable from the source). Cost if wrong: a hand-edited checkpoint with a plausible but wrong batch count is accepted; the byte offset still ties it to the source, and the count is only displayed.
  - **D4: vector sources get a cap of 20 statements (`VECTOR_MAX_BATCH_GROUPS`) instead of 100.** A source "has vector columns" when any `CREATE` statement group contains `F32_BLOB(`/`F64_BLOB(`/`F16_BLOB(`/`F8_BLOB(`/`F1BIT_BLOB(`, `FLOAT32(`/`FLOAT64(` or `libsql_vector_idx`. The byte cap (512 KiB) is unchanged. 20 is a judgment, not a measurement (a 1536-float row dumps to about 12 KB of hex, so 512 KiB already holds roughly 40 rows); the halving of D2 corrects a wrong guess at the cost of one timeout. Cost if wrong: still slow on a bigger-dimension table, no data risk.
  - **D5: the per-batch limit for import is 300 s (`DEFAULT_IMPORT_BATCH_TIMEOUT_MS`) and `--timeout <duration>` overrides it** (`30s`, `15m`, `1h`; a bare number is seconds; 1 s to 24 h, because Node's `setTimeout` overflows above 2^31 ms). The shared 120 s data-plane default is unchanged for every other command. `create --from` gets the 300 s default (no flag there). Cost if wrong: none; other commands are untouched.
  - **D6: renewal window and token lifetime are not changed** (Scope ladder: a pre-existing hazard). The runner renews a credential `RENEWAL_WINDOW_MS = 30_000` before it expires (`src/utils/database-sql-import-runner.ts:27`), so a batch started just before that moment can outlive its token even at 120 s today, and 300 s widens the window. After any timeout the retry always mints a fresh token. A batch that outlives its token fails as "credential expired; the batch outcome is unknown" with the resume line (existing, safe). **UNMEASURED:** the write token's real lifetime on production; the verify smoke reads `expires_in_seconds` from the dev stack. Disposition at build end: fixed in Task 2 only if the smoke shows a lifetime under 600 s, otherwise FILED.
- **Invariants (must never happen), every route to each, and the sweep:**
  - **I1: a retry never silently doubles or loses a row.** Routes: (a) a timed-out batch holding a plain `INSERT`/`CREATE`/`UPDATE`/`DELETE` is retried; (b) a retried batch starts at a different statement than the one that failed, skipping or repeating statements; (c) a checkpoint is written for a batch that did not complete; (d) the halving cap makes a later batch overlap an earlier one. Sweep (Task 2, rows A, B, C): across a run with several timeouts, the statements of the **successful** executions, concatenated, equal the source's statements exactly once each, in order; the stalled executions always begin at the statement the next execution also begins with; a table-driven row feeds every unsafe statement shape through a stalled batch and expects exactly one execution.
  - **I2: a stalled client is never reused.** Route: the loop reuses `client` after the deadline hook closed it. Sweep (Task 2 row A): every retried execution runs on a client number higher than the stalled one.
  - **I3: no credential or path leaks into the new messages.** The existing `expectNoSecrets` helper is applied to every new failure message (Task 2 rows C, D).
  - **I4: progress before the failing point is kept.** Route: a retry loop that throws away the checkpoint of completed sub-batches. Sweep (Task 2 row E): a run whose Nth statement never completes leaves a checkpoint at the last completed statement and the resume line.

## Review Focus

1. A timed-out batch that **did commit** on the server, then retried (an `INSERT OR REPLACE` dump into a table with a vector index): the second apply is a no-op, the run continues. Pinned by Task 2 row B (replay of the same statements is asserted idempotent by classification, not by a database; the live smoke in Task 4 proves it on a real stack).
2. A source with **plain `INSERT`** and a timeout: stops at once with a message that names `--timeout` and "not safe to repeat", never retried (Task 2 row C).
3. **`--timeout 0`, `--timeout abc`, `--timeout 1.5`, `--timeout 25h`, a negative number**: refused before native load or mint with `invalid_timeout` (Task 1 parser rows, Task 3 command row).
4. A **resume** from a checkpoint written by a run that had split batches (statement position 50, batch count 3): accepted; a count above the statement position or a byte offset that does not match the boundary: refused (Task 2 row F).
5. A **source with a single huge statement** that times out: stops with "cannot be split further" and names `--timeout` (Task 2 row D).

---

### Destructive paths

This wave writes to a user's live database through the existing batch transaction and the existing checkpoint file; it adds no new file writes, deletes or overwrites (the checkpoint code is untouched except the relaxed validation in D3, which only reads). The one data-safety question is "a retry repeats statements": I1 and D1 cover it (retry only when repeating is harmless). The failure-boundary table: a batch stalls (outcome unknown): retried only if safe to repeat; the old transaction may still commit later: harmless for statements safe to repeat, and for others the run has stopped before any retry; the process dies mid-retry: the checkpoint still names the last completed statement, resume is the existing path; checkpoint write fails after a committed sub-batch: existing behaviour (no resume line, `suppressResume`). A forward-only design (stop on the first timeout and print the resume line, as today) cannot meet the issue, which asks for one-run completion of big imports.

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

  export interface ImportBatch {
      groups: DatabaseSqlImportGroup[];
      nextStatement: number;
  }

  /** The same batching rule the runner used (group cap and byte cap), with the group cap as a parameter. */
  export function nextBatch(groups: DatabaseSqlImportGroup[], start: number, maxGroups: number): ImportBatch;

  /** True when any CREATE statement group of the source declares a vector column or index. */
  export function sourceHasVectorColumns(groups: DatabaseSqlImportGroup[]): boolean;

  /** True when running this statement twice leaves the same final state as running it once. */
  export function isReplaySafeGroup(group: DatabaseSqlImportGroup): boolean;

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
- `isReplaySafeGroup`: strip leading comments with `sqlWithoutLeadingComments`, take the first 256 characters, and match, case-insensitively, any of
  `/^INSERT\s+OR\s+(?:REPLACE|IGNORE)\s+INTO\b/`, `/^REPLACE\s+INTO\b/`,
  `/^CREATE\s+(?:UNIQUE\s+|TEMP\s+|TEMPORARY\s+|VIRTUAL\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\s+IF\s+NOT\s+EXISTS\b/`.
- `sourceHasVectorColumns`: for each group whose first 200 characters match `/\bCREATE\b/i`, test the whole `group.sql` against `/\bF(?:32|64|16|8|1BIT)_BLOB\s*\(|\bFLOAT(?:32|64)\s*\(|libsql_vector_idx/i`; return true on the first hit. (The 200-character prefilter keeps a 113 MB source of `INSERT` groups cheap.)
- `parseImportTimeoutMs`: `/^(\d+)([smh]?)$/` on the trimmed value (seconds when the unit is empty), multiply to ms; no match, a result under 1000 or over `MAX_IMPORT_TIMEOUT_MS` throws `new DatabaseOperationError('invalid_timeout', '--timeout must look like 30s, 15m or 1h (1 second to 24 hours), got "<value>".')` (the value is a user-typed duration, never a secret).

- [ ] **Step 1: Write the failing tests** in `tests/database-import-batching.test.ts`. A `group(sql)` helper builds `{ sql, startByte: 0, endByte: sql.length, startLine: 1, endLine: 1 }`. Rows:
  - `nextBatch`: 250 one-byte groups with `maxGroups` 100 from 0 gives `nextStatement` 100; from 100 with `maxGroups` 20 gives 120; a group list whose bytes pass 512 KiB stops before the group that would cross it; one group over 512 KiB is returned alone (`nextStatement` start + 1).
  - `isReplaySafeGroup` true: `INSERT OR REPLACE INTO "t" VALUES (1);`, `insert or ignore into t values (1);`, `REPLACE INTO t VALUES (1);`, `-- c\nINSERT OR REPLACE INTO t VALUES (1);`, `/* c */ CREATE TABLE IF NOT EXISTS t (id);`, `CREATE UNIQUE INDEX IF NOT EXISTS i ON t(id);`. False: `INSERT INTO t VALUES (1);`, `CREATE TABLE t (id);`, `CREATE INDEX i ON t(id);`, `UPDATE t SET a = 1;`, `DELETE FROM t;`, `DROP TABLE t;`, `INSERT INTO t SELECT 1 WHERE 'INSERT OR REPLACE INTO' IS NOT NULL;`.
  - `sourceHasVectorColumns` true: `CREATE TABLE docs (id INTEGER, embedding F32_BLOB(1536));`, `CREATE INDEX docs_idx ON docs (libsql_vector_idx(embedding));`, `CREATE TABLE v (e FLOAT32(4));`; false: a source of only `INSERT INTO t VALUES ('F32_BLOB(3)');`, `CREATE TABLE plain (id INTEGER, b BLOB);`.
  - `parseImportTimeoutMs`: `'30s'` 30000, `'15m'` 900000, `'1h'` 3600000, `'90'` 90000, `' 2m '` 120000, `'24h'` 86400000; each of `''`, `'0'`, `'0s'`, `'abc'`, `'1.5'`, `'-3'`, `'25h'`, `'10x'` throws with `code` `invalid_timeout`.
  - `isDatabaseDeadlineElapsed`: true for the error a `runDatabaseClientOperationWithDeadline(() => new Promise(() => undefined), undefined, 5)` rejects with; false for `new Error('x')` and for `new DatabaseOperationError('upstream_unavailable', 'Database operation timed out.')` built by hand.
- [ ] **Step 2: Expected RED (no local run):** every row fails on the base because `src/utils/database-import-batching.ts` and the two exports do not exist (the import of the module throws). The per-task reviewer checks each row against the test code.
- [ ] **Step 3: Implement** the three source edits exactly as the Interfaces block says.
- [ ] **Step 4: Static checks (these run no test):** `npx prettier --check` on the four paths (if the repo has no prettier config, skip and say so), `npx eslint` on the changed files if the repo has an eslint config, and `npm run build` (type check). Paste the outputs.
- [ ] **Step 5: Report (do not commit):** list every changed path, separating test paths from source paths, with the expected-RED table.

## Task 2: Runner split-and-retry, vector cap, relaxed checkpoint check, and the `batchTimeoutMs` wiring (cli#267)

**Depends on:** Task 1 (committed first).

**Files (file scope, the only paths this task may touch):**
- Modify: `src/utils/database-sql-import-runner.ts`
- Modify: `src/commands/database.ts` (only the two `runPreparedDatabaseImport(...)` option objects: `create --from` near line 1467-1480 and `databaseImportWithConfig` near line 1625-1636; add one property each, nothing else)
- Modify: `tests/database-import-command.test.ts` (the existing stalled-batch row stays as is; the two checkpoint rows at lines 1099-1131 are rewritten; new rows added)

Grep of the callers and doubles (paste the real output in the report): `grep -rn "runPreparedDatabaseImport\|DatabaseImportRunnerDependencies" src tests` (expected: the runner, `src/commands/database.ts` at the two call sites, and `tests/database-import-command.test.ts` through `databaseImportWithConfig`); `grep -rn "dataPlaneTimeoutMs" tests/database-import-command.test.ts` (expected: line 306 only).

**Interfaces:**
- Consumes (Task 1, quoted from the frozen block): `MAX_BATCH_GROUPS`, `VECTOR_MAX_BATCH_GROUPS`, `DEFAULT_IMPORT_BATCH_TIMEOUT_MS`, `nextBatch(groups, start, maxGroups): ImportBatch`, `sourceHasVectorColumns(groups): boolean`, `isReplaySafeGroup(group): boolean` from `./database-import-batching`; `isDatabaseDeadlineElapsed(error): boolean` from `./database-data-plane`.
- Produces: `DatabaseImportRunnerDependencies` gains `batchTimeoutMs?: number` (milliseconds; the runner reads `dependencies.batchTimeoutMs ?? DEFAULT_IMPORT_BATCH_TIMEOUT_MS`). Task 3 fills it from `--timeout`.

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
   let batchCap = sourceHasVectorColumns(prepared.groups) ? VECTOR_MAX_BATCH_GROUPS : MAX_BATCH_GROUPS;
   ```
   Inside the loop, plan with `nextBatch(prepared.groups, nextStatement, batchCap)` and run it with `batchTimeoutMs` in place of `dependencies.dataPlaneTimeoutMs ?? DEFAULT_DATABASE_DATA_PLANE_TIMEOUT_MS`. In the `catch (error)` of the batch call, **before** `if (error instanceof DatabaseOperationError) throw error;`, add:
   ```ts
   if (isDatabaseDeadlineElapsed(error)) {
       const size = batch.groups.length;
       const seconds = Math.round(batchTimeoutMs / 1000);
       if (size >= 2 && batch.groups.every(isReplaySafeGroup)) {
           // The deadline hook already closed this client: never reuse it. Its
           // close is fire-and-forget here (a wedged stream must not stop the retry).
           void closeCurrentClient().catch(() => undefined);
           client = undefined;
           clientClosePromise = undefined;
           deadline = undefined;
           batchCap = Math.max(1, Math.floor(size / 2));
           dependencies.stdout(
               `A batch of ${size} statements did not finish within ${seconds}s; retrying from the same statement in batches of up to ${batchCap}.`,
           );
           continue;
       }
       const reason = size === 1
           ? `A single statement (lines ${batch.groups[0].startLine}-${batch.groups[0].endLine}, ${Buffer.byteLength(batch.groups[0].sql, 'utf8')} bytes) did not finish within ${seconds}s and cannot be split further.`
           : `A batch of ${size} statements did not finish within ${seconds}s and may or may not have committed. It holds statements that are not safe to repeat (a plain INSERT or CREATE), so it was not retried; if the table has no unique key, check it before resuming.`;
       throw new DatabaseOperationError(
           'upstream_unavailable',
           `Database operation timed out. ${reason} Raise the per-batch limit with --timeout (for example --timeout 15m).`,
       );
   }
   ```
   Everything else in the loop (the checkpoint publish, `completedBatches += 1`, progress line) is unchanged. `DEFAULT_DATABASE_DATA_PLANE_TIMEOUT_MS` stays imported for `closeClient`.
4. `src/commands/database.ts`: add `batchTimeoutMs: dependencies.dataPlaneTimeoutMs,` to the two option objects (`dependencies` is the raw argument, not `io`; in the `create --from` function use that function's own raw `dependencies` parameter; read the surrounding code to name it).

**Tests (all in `tests/database-import-command.test.ts`, using the local `importHarness`, `sourceFile`, `checkpointFiles`, `accessPosts`, `expectNoSecrets`; stalled = `execute` returns `new Promise(() => undefined)`; the harness's `test.dependencies.dataPlaneTimeoutMs = 10` is the timeout hook, which the command now forwards as `batchTimeoutMs`; each new row sets a `1_000` ms vitest timeout like the existing stalled row):**
- [ ] **Row A: split-and-retry finishes the import.** 40 statements `INSERT OR REPLACE INTO t VALUES (${i});` (i 0..39). `execute` stalls when `sql.split('INSERT OR REPLACE').length - 1 > 10`. Expect the run resolves; the group counts per execution are `[40, 20, 10, 10, 10, 10]`; `accessPosts(test)` has 3 entries; the executions' client numbers are `[1, 2, 3, 3, 3, 3]` (I2: a retried execution never reuses a stalled client); `test.closed` is `[1, 2, 3]`; `test.stdout` contains exactly two lines that match `/did not finish within .*s; retrying from the same statement in batches of up to (20|10)/`; the checkpoint file is removed. **I1 sweep:** collect the `VALUES (n)` numbers of the executions that did not stall (the last four) and expect them to equal 0..39 in order, each once; the first statement of every execution that follows a stalled one equals the first statement of the stalled one.
- [ ] **Row B: a plain `INSERT` batch is never retried (I1).** `it.each` over the statement shapes `INSERT INTO t VALUES (1);`, `CREATE TABLE t (id);`, `UPDATE t SET a = 1;`, `DELETE FROM t;`, `DROP TABLE t;`: a source of three copies of that statement with `execute` that always stalls. Expect `rejects.toMatchObject({ code: 'upstream_unavailable' })`, exactly one execution, message contains `not safe to repeat` and `--timeout`, and `expectNoSecrets`.
- [ ] **Row C: a single statement that times out stops the run.** One `INSERT OR REPLACE INTO t VALUES (1);`, always stalls: one execution, message contains `cannot be split further` and `--timeout`.
- [ ] **Row D: progress before the failing statement is kept (I4).** 40 `INSERT OR REPLACE` statements; `execute` stalls whenever the SQL contains `VALUES (7)`. The halving runs 40 (stall), 20 (stall), 10 (stall), 5 (statements 0-4 pass; 5-9 stall), 2 (statements 5-6 pass; 7-8 stall), 1 (statement 7 stalls). Expect rejection with code `upstream_unavailable` and a message containing `cannot be split further`; the checkpoint file exists with `nextStatement` 7, `lastCompletedBatch` 2 and `completedSourceBytes` equal to the byte offset of the end of statement 6 in the source; the error message contains the exact `Resume with:` line (the test file's `resumeLine` helper) for that checkpoint. The last execution holds exactly one statement.
- [ ] **Row E: vector sources use the smaller cap.** `it.each`: a source `CREATE TABLE d (id INTEGER, e F32_BLOB(4));` + 45 `INSERT INTO d VALUES (${i}, X'00');` has group counts per execution `[20, 20, 6]`; the same 46 groups with `CREATE TABLE d (id INTEGER, e BLOB);` have `[46]`. The `libsql_vector_idx` index form also gives `[20, 20, 6]`.
- [ ] **Row F: the relaxed checkpoint check (D3).** Rewrite the existing `it.each` at lines 1099-1131 into: rejected rows `lastCompletedBatch 101 with nextStatement 100` (label "batch count exceeds the statement position") and `lastCompletedBatch 1, nextStatement 50, completedSourceBytes one byte off` (label "source bytes do not match the statement boundary"); and a new accepted row: 101 statements, a checkpoint with `lastCompletedBatch 3`, `nextStatement 50`, the exact byte offset, resumed with `{ yes: true, resume: checkpoint }`: resolves, the first execution holds `VALUES (50)` and not `VALUES (49)`, the checkpoint is removed. The rejected rows keep the existing assertions (`native:load` not seen, `posts` equal `[showPost('Analytics')]`, no executions).
- [ ] **Row G: `batchTimeoutMs` default and wiring.** The existing stalled-batch row (line 299) must still pass unchanged (it goes through the raw `dataPlaneTimeoutMs` hook). One new row calls `runPreparedDatabaseImport` through `databaseImportWithConfig` with no `dataPlaneTimeoutMs` set and a fast `execute`, and expects success (the 300 s default does not break a normal import).
- [ ] **Step 2: Expected RED (no local run, the per-task reviewer checks each against the test code):** A fails on the base because the first stall throws `upstream_unavailable` after one execution (executions length 1, not 6); B passes on the base for "one execution" but fails on the `not safe to repeat` and `--timeout` message assertions; C fails on the message; D fails on the message (base: generic `Database operation timed out.`) and on `nextStatement` 7 (base: no halving, checkpoint at 0 and no checkpoint file); E fails on the group counts (`[46]` on the base for the vector source); F's accepted row fails on the base (`deterministicBatchCount` returns null for position 50) and the rewritten rejected rows fail only on the new labels (they pass on both sides; say so); G passes on both sides (regression guard).
- [ ] **Step 3: Implement** the runner changes and the two call-site lines exactly as above.
- [ ] **Step 4: Static checks:** prettier and eslint on the changed files if configured, `npm run build`. Paste the outputs.
- [ ] **Step 5: Report (do not commit):** every changed path (source and test separately), the grep outputs, the expected-RED table, and `git diff --stat` for the task's paths.

## Task 3: The `--timeout` option, help and README (cli#267)

**Depends on:** Task 2 (committed first; this task edits `src/commands/database.ts` and the same test file).

**Files (file scope, the only paths this task may touch):**
- Modify: `src/index.ts` (the `database import` registration at lines 451-459, and the `'database import' is for BULK DATA LOADING only` help paragraph near line 315 if a sentence fits there)
- Modify: `src/commands/database.ts` (`DatabaseImportOptions` at line 175-178 and `databaseImportWithConfig` at line 1595-1637)
- Modify: `README.md` (the database section: add the example line beside the existing `solidactions database import analytics backup.sql --yes` examples at lines 114-115, plus one short paragraph in the same section)
- Modify: `tests/database-import-command.test.ts`
- Modify: `tests/readme-contract.test.ts` (add the new example line and phrase to the database contract; keep every existing phrase)

Grep (paste real output): `grep -rn "'--resume'\|options.resume\|DatabaseImportOptions" src tests` and `grep -rln "database import" README.md src tests`.

**Interfaces:**
- Consumes (Task 1/2, frozen): `parseImportTimeoutMs(value: string): number` from `../utils/database-import-batching`; `DatabaseImportRunnerDependencies.batchTimeoutMs?: number`.
- Produces: `DatabaseImportOptions` gains `timeout?: string`; `.option('--timeout <duration>', 'Per-batch time limit, e.g. 30s, 15m, 1h (default 5m). A batch that times out is retried in smaller halves when its statements are safe to repeat (INSERT OR REPLACE, INSERT OR IGNORE, CREATE ... IF NOT EXISTS)')` on `database import`.

**Behaviour (exact):**
1. In `databaseImportWithConfig`, parse before anything else, i.e. before `refuseIfAnalytical` (which mints a `show`): `const batchTimeoutMs = options.timeout !== undefined ? parseImportTimeoutMs(options.timeout) : dependencies.dataPlaneTimeoutMs;` and pass `batchTimeoutMs` in the runner dependency object, replacing the Task 2 line. An invalid value throws `invalid_timeout` before any native load or mint, so `posts` is empty (the show guard has not run either; assert `posts` equal `[]`).
2. `src/index.ts`: add the option; the command description stays; add to the `database import` help (`addHelpText('after', ...)` on that command, matching how `database push` does it at `src/index.ts:462-470`) three sentences: the default per-batch limit is 5 minutes; a timed-out batch of statements that are safe to repeat is retried in smaller batches, otherwise the run stops with the usual resume line; vector columns make the batches smaller.
3. `README.md`: one example `solidactions database import analytics big.sql --timeout 15m --yes` and one paragraph with the same three sentences. Keep every phrase `tests/readme-contract.test.ts` pins.
4. `tests/readme-contract.test.ts`: add `--timeout` to the options loop (line 99) and the example command to the pinned examples.

**Tests (in `tests/database-import-command.test.ts`):**
- [ ] **Registration:** extend the row at line 282: `command.options.find((option) => option.long === '--timeout')` is defined and `required` true.
- [ ] **Row H: `--timeout` is honoured.** `databaseImportWithConfig('Analytics', source, { yes: true, timeout: '1s' }, CONFIG, test.dependencies)` with a stalled `execute` and `dataPlaneTimeoutMs` **unset**: rejects with `upstream_unavailable` and a message containing `within 1s`, after about one second (vitest timeout 5_000). A second row with both `timeout: '1s'` and `dataPlaneTimeoutMs = 60_000` still stops at 1 s (the flag wins).
- [ ] **Row I: invalid values are refused first.** `it.each(['0', '0s', 'abc', '1.5', '-3', '25h', ''])` rejects with `invalid_timeout`, `test.events` has no `native:load`, `test.posts` equals `[]`, no executions.
- [ ] **Step 2: Expected RED:** H fails on the base (the option is ignored: the stall waits for the 300 s default and the vitest timeout fires, or `within 1s` is absent); I fails on the base (`timeout` is ignored, the import runs); the registration row fails (no `--timeout` option); the README contract rows fail until the README is edited.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Static checks:** prettier and eslint on the changed files if configured, `npm run build`.
- [ ] **Step 5: Report (do not commit):** every changed path, the grep outputs, the expected-RED table.

## Task 4: Verify-time probes (manager, not a developer card; no files)

Run at the verify step on the free app slot's dev stack (role overrides: CLI built from the branch, `scripts/local-dev up` there, nothing checked out, bring it down after), not now:
- [ ] A real import of a vector dump (a few thousand `INSERT OR REPLACE` rows into an `F32_BLOB(1536)` table with a `libsql_vector_idx` index; generated by a throwaway script in the SDD workspace, never committed) with `--timeout 1s` to force real timeouts. Records: whether the retry's `BEGIN IMMEDIATE` waits or answers BUSY (UNMEASURED premise), whether the run then finishes in one invocation, and the final row count equals the source's (no doubles, no losses).
- [ ] The write token's `expires_in_seconds` from the dev stack, for D6.
- [ ] A plain-`INSERT` dump with `--timeout 1s`: stops once with the "not safe to repeat" message and a resume line.
If the first probe shows a BUSY on every retry, the wave's Done-when is not met: stop and mail the PM with the evidence (the design then needs a bounded wait before the retry, a design ruling).

## Self-Review

1. **Spec coverage:** the issue's (1) split-and-retry: D1, D2, Task 2 rows A-D; (2) 300 s limit and `--timeout`: D5, Task 2 row G, Task 3; (3) smaller vector batches: D4, Task 2 row E; the INSERT caveat: D1 and row B; "a test that makes a batch time out and proves the split-and-retry": row A; the release: the PM's.
2. **Placeholders:** none; Task 4 is a manager probe with named measurements.
3. **Type consistency:** `nextBatch(groups, start, maxGroups)`, `sourceHasVectorColumns`, `isReplaySafeGroup`, `parseImportTimeoutMs`, `isDatabaseDeadlineElapsed`, `batchTimeoutMs` are named identically in the Interfaces blocks of Tasks 1, 2 and 3.
4. **Review Focus:** each of the five lines has a row (1: row A plus the smoke; 2: row B; 3: Task 1 parser rows and row I; 4: row F; 5: row C).
5. **File scope:** Task 2 and Task 3 both edit `src/commands/database.ts` and `tests/database-import-command.test.ts`; they run serially (Task 3 depends on Task 2). Task 1 touches `src/utils/database-sql-import.ts` and `src/utils/database-data-plane.ts` with one-line additions only.
6. **Premises:** every premise above cites file:line and quotes it; the two UNMEASURED ones (BUSY-or-wait on retry, token lifetime) have a named probe in Task 4 and a safe default.
7. **Parallelism:** none worth taking: three small serial tasks (the wave is normal size; Task 1 freezes the contract, Tasks 2 and 3 share a test file).
8. **Midpoint row:** none: midpoint at half (after Task 2, the runner; Task 3 does not wait for any verdict).

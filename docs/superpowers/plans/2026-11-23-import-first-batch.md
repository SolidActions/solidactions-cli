# An import into an empty database retries its first batch too Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sa-subagent-driven-development to implement this plan task-by-task (the wave's build step). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-contained dump (`CREATE TABLE IF NOT EXISTS ...` plus `INSERT OR REPLACE`) imported into an empty database whose first batch times out is halved and retried like any later batch, and every stop message says what state the table is in and whether anything was checkpointed.

**Architecture:** `src/utils/database-import-batching.ts` (pure) gains one function, `batchCreatedFacts`, that gives the verdict the keyed/trigger facts of tables the timed-out batch itself creates with `CREATE TABLE IF NOT EXISTS`, but only for tables the target catalog does not have (so the replay will create them with the source's shape). `replayVerdict` also reports why a table is unsafe. `src/utils/database-sql-import-runner.ts` merges those facts after the catalog read, words the stop messages by table state, and appends a "nothing was checkpointed" sentence to its timeout and lock stops when no checkpoint exists. `README.md` gets the matching limits text.

**Tech Stack:** TypeScript, vitest (CI only; nothing runs locally).

**Spec:** none (no design file; the design is this plan's Architecture plus the Design rulings below). The cause analysis is on `cli#274`; the parent design is `docs/superpowers/plans/2026-11-22-big-imports.md` (D1, D8, PM ruling 7).

**Issues:** `cli#274` ("database import: a first batch that creates its own table IF NOT EXISTS is not retried; clearer unknown-table message and first-batch hint"), sanctioned by Peter's approval 2026-11-23, ask `task-approvewave-77b4`, quoted on the issue (comment `https://github.com/SolidActions/solidactions-cli/issues/274#issuecomment-7112006639`): "Approve (tier normal)". The issue has that one comment (read with `gh api --paginate repos/SolidActions/solidactions-cli/issues/274/comments`; `scripts/issue` does not exist in the CLI repo). Wave card `task-wave20261123-047d`; plan card `task-planimportfirst-13c9` (sent back once by plan-check: review `task-planreviewwave-a6c0`, REQUEST CHANGES 0705bde; this revision answers its Important 1 and 2 and Minor 3, 4, 5 and adds route (e) and rows H, I below; the second plan-check round, adjudicated by the PM on card `task-planimportfirst-e778`, is answered by: Task 2 row B and the three-argument call in Task 2 Step 2, the filtered `walked` list in Task 1 Step 2, the A-I / A-H row ranges, and the third-argument note after Task 1's table). No open PR touches any file of this plan (`gh pr list --state open --json number,files` was empty at plan time).

## Global Constraints

- **The ask, verbatim (cli#274 body, "Proposed change"):**
  1. "When the catalog read shows the table does NOT exist in the target, the batch's own `CREATE TABLE IF NOT EXISTS` will create it with the source's shape on the replay, so the source's keyed fact may apply and the batch can be halved and retried."
  2. "Name the table's state in the stop message (\"not in the target yet\" vs \"in the target without a primary key\") instead of \"not known to have a primary key\" for a table the source declares with one."
  3. "When nothing has checkpointed yet, say so (\"nothing was committed that the tool can resume from; rerun the whole import with a longer --timeout\") instead of printing no resume line."
  4. "README limits line: add \"a first batch that creates its own table with IF NOT EXISTS is not retried\" until the change above lands."
- **Premises, each quoted from this tree (verified 2026-11-23):**
  - Source `IF NOT EXISTS` gives no fact today: `if (skip.ifNotExists && origin === 'source') return;` in `walkCreateTable` (`src/utils/database-import-batching.ts:214`) and the same line in `walkCreateIndex` (`:235`); a catalog walk takes them as written.
  - The runner builds facts from the groups before the failed batch only: `const sourceFacts = schemaFactsFromSql(prepared.groups.slice(0, batch.nextStatement).map((group) => group.sql), 'source');` (`src/utils/database-sql-import-runner.ts:578`; `batch.nextStatement` is the end of the failed batch, so the batch's own groups are walked too, and, as an `IF NOT EXISTS` source create, give nothing).
  - The catalog read happens only when `size >= 2 && verdict.status === 'unknown'` (`:580`), and after it `verdict = replayVerdict(batch.groups, mergeSchemaFacts(sourceFacts, catalogFacts))` (`:602`). `unknown` therefore reaches the stop message only for a table that neither the source nor the catalog settles.
  - A table that is in the catalog but not in the source facts is not a gap: `mergeSchemaFacts` lets the catalog win (`:354`, "`override`'s tables replace `base`'s").
  - The stop message to rewrite is the template string at `:617` ("`The target tables ${verdict.unknownTables.join(', ')} are not known to have a primary key or unique constraint, so repeating the batch is not safe`" and "`is not safe to repeat (a plain INSERT or CREATE, an UPDATE or DELETE, or an INSERT OR REPLACE/IGNORE into a table without a primary key or unique constraint, or with a trigger)`").
  - The resume guidance is appended only `checkpointPublished && !suppressResume && !policyRefusal` (`:700`), with `let checkpointPublished = prepared.checkpoint !== null;` (`:509`): a first-batch failure of a fresh run prints no resume line.
  - Callers of what changes (`grep -rn "replayVerdict\|mergeSchemaFacts\|ReplayVerdict\|unknownTables\|firstUnsafe" src tests`): `src/utils/database-sql-import-runner.ts:579,602,617` and `tests/database-import-batching.test.ts` only. `tests/database-import-command.test.ts` pins messages by `toContain`: `'not safe to repeat'` (lines 626, 677, 815, 845, 935, 964), `'cannot be split further'` (652, 709), `'stayed locked'` (1059), and `'The target tables t are not known to have a primary key'` (872: **this one is rewritten in Task 2**).
  - `tests/database-import-batching.test.ts` pins `replayVerdict` results with `toEqual` (lines 307-345: `{ status: 'unsafe', firstUnsafe, unknownTables: [] }` for a plain write, a keyless table and a triggered table). Adding the new field to the keyless and triggered results changes those two rows; Task 1 updates them.
  - `tests/readme-contract.test.ts:80-116` pins README phrases for the database section, including `'solidactions database import analytics big.sql --timeout 15m --yes'`; Task 3 only edits the limits paragraph and keeps every pinned phrase.
  - The test harness: `importHarness(root, { execute, catalog, sleep })` with `test.dependencies.dataPlaneTimeoutMs = 10` makes a stalled `executeMultiple` time out; `catalog` answers `[type, name, tbl_name, sql]` rows; `report(caught, test)` joins the error and stdout; `expectNoSecrets` (`tests/database-import-command.test.ts:74-188`, `:288`, `:296`).
- **Design rulings (mine; each with its cost if wrong):**
  - **D1: a table the catalog lacks and the batch itself creates with `CREATE TABLE IF NOT EXISTS` takes the batch's own facts.** Reason: the batch is replayed whole, in order, so on the replay the `CREATE TABLE IF NOT EXISTS` either creates the table with the source's shape (the first run never committed, or is still running) or is a no-op because the first run committed (and then the catalog would have had the table, unless the old transaction commits between the catalog read and the replay, in which case the table has exactly the source's shape too, since the same statement created it). Either way the table's key and triggers are the batch's own `CREATE TABLE`, `CREATE [UNIQUE] INDEX` and `CREATE TRIGGER` statements, walked "as written" (the `'catalog'` origin). A table that **is** in the catalog is judged by the catalog exactly as today (PM ruling 7 stands: an existing table's shape wins). The batch's own facts count only for a table the same batch creates with `CREATE TABLE IF NOT EXISTS`; an index or trigger on a table the batch does not create gives nothing. A batch `CREATE UNIQUE INDEX IF NOT EXISTS <name>` counts only when the target catalog holds no object (table, index or trigger) called `<name>` (otherwise the replayed statement is a no-op and the new table is keyless); a table name the batch creates, drops or renames more than once is not returned (unknown, so never retried). Cost if wrong: a table that appears in the target between the catalog read and the replay with a *different* shape (another writer, within seconds) would be judged by the source's shape; the replayed `INSERT OR REPLACE` could then double rows in a keyless table. That needs a second writer creating the same-named table in that window; judged negligible and stated in the README limits.
  - **D2: the stop message names the table's state.** For `unknown` (neither source, nor batch, nor catalog knows the table): "`The table(s) X are not in the target database yet and this batch does not create them`". For `unsafe` because of a known table: "`the statement at lines A-B writes into table X, which has no primary key or unique constraint (in the target, or as this batch creates it)`" or "`... which has a trigger`". For `unsafe` because of the statement's shape (plain INSERT/CREATE/UPDATE/DELETE/DROP/ALTER): the existing wording, unchanged. The ask's literal phrase "in the target without a primary key" is widened to "has no primary key or unique constraint (in the target, or as this batch creates it)" because a batch-created keyless table (Task 1 row H) is not in the target yet. Cost if wrong: wording only.
  - **D3: the first-batch hint goes on every timeout or lock stop while `checkpointPublished` is false, and says to check before rerunning.** The issue's wording ("rerun the whole import with a longer --timeout") would double the rows of a plain-`INSERT` dump whose first batch committed, so the sentence is: "`Nothing was checkpointed yet, so there is no resume line; the first batch may or may not have committed. Check its tables, then rerun the whole import with a longer --timeout (for example --timeout 15m).`" It is not added to a policy refusal or a credential failure (nothing to say about --timeout there). Cost if wrong: wording only; the check-first clause is the safe direction.
  - **D4: item 4 of the ask is applied as the accurate README text, not as the sentence the issue quotes.** The issue says to add "a first batch that creates its own table with IF NOT EXISTS is not retried" *until the change lands*; this wave is that change, so the README states instead that such a batch is retried when the table is not yet in the target, and that a first batch with a plain `CREATE TABLE` still stops. Cost if wrong: none.
- **Invariants (must never happen), every route to each, and the sweep:**
  - **I1: a retry never doubles or fires twice a row.** Routes: (a) the batch's own facts are applied to a table that is in the catalog (D1 forbids it); (b) a trigger the batch creates on the table is ignored; (c) a table the batch does not create gets facts from the batch; (d) a keyless `CREATE TABLE IF NOT EXISTS` is judged keyed; (e) a batch `CREATE UNIQUE INDEX IF NOT EXISTS <name>` is counted although the target already holds an object of that name, so the replayed statement is a no-op and the new table stays keyless (plan-check Important 1); (f) a table the batch creates or drops more than once is judged by a later statement while SQLite keeps the first (plan-check Minor 3). Sweep: Task 1 rows B-E, H, I feed each route through `batchCreatedFacts` and `replayVerdict`; Task 2 rows B, C, D, E, H run them through a stalled first batch and expect exactly one execution (never retried) except the safe case.
  - **I2: no credential, token or path leaks into the new messages.** `expectNoSecrets` on every new message (Task 2 rows A-F and H).
  - **I3: a first-batch stop never prints a resume line that does not exist, and a later-batch stop never loses its resume line.** Sweep: Task 2 rows F and G.
- **Static checks only; no test runs on this box.** After each task the developer runs `npm run build` (tsc) and nothing else; the tests run in the PR's CI (`check.yml`). Expected-RED tables replace local RED runs (Speed rules).
- **Secret-bearing host paths this plan's code reads:** none (the import reads the source file the user names and `.solidactions/imports/`, both already covered by the parent wave; no new reads).

**Verify data:** the live smoke runs the CLI built from the branch against a free app slot's stack (`sa-dev-<slot>`, never production). (a) Create an empty database and import `smoke.sql` (`CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, v TEXT);` then 120 `INSERT OR REPLACE INTO docs VALUES (n, 'x');`): it must still finish in one run. (b) The new stop text on a forced failure: `--timeout 1s` against one very large single `INSERT OR REPLACE` statement (a 20 MB hex blob) that cannot finish in 1 s must stop with "cannot be split further" and the "Nothing was checkpointed yet" sentence. (c) The issue's own case, replayed for real (plan-check Important 2; cli#274 forced it with `--timeout 1s`): `docs` vector file as in the issue (`CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, ...)`, `CREATE INDEX IF NOT EXISTS ...`, 30 `INSERT OR REPLACE`), empty database, `--timeout 1s`. Record three things in the smoke file: the run finishes in one invocation (or, if the server answers inside 1 s on this stack and nothing stalls, say so and rerun with a tighter or heavier file until a first batch really times out; an unforced run is not a pass for (c)); the final row count equals the source's (no doubles); and whether the retry met the lock (parent D7: the "still locked" line). The harness rows (Task 2 row A) prove the decision logic in CI; (c) proves the late commit on a real server. The cleanroom is the qa seat driving the same stack cold with goals only; credentials file `/home/mercer/crewops/qa-cleanroom/creds-import-first-batch`.

## Review Focus

1. The issue's own case: first batch = `CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, ...)` + `CREATE INDEX IF NOT EXISTS` + upserts, empty database, first batch stalls: halved and retried to completion, no checkpoint left (Task 2 row A).
2. The same file imported into a database where `docs` **already exists without a primary key**: never retried, and the message says "which has no primary key or unique constraint" (Task 2 row B). The shape of an existing table is never overridden by the source.
3. A batch whose `CREATE TABLE IF NOT EXISTS` has no key, or whose own `CREATE TRIGGER IF NOT EXISTS` is on the table: never retried (Task 1 rows C and D, Task 2 row C).
4. An upsert into a table that the batch does **not** create and the target lacks: stop with "not in the target database yet" (Task 2 row D).
5. A stall in a **later** batch keeps its resume line and gets no "nothing was checkpointed" sentence; a stall in the first batch gets the sentence and no resume line (Task 2 rows F and G).

---

### Destructive paths

None. The wave adds no file write, move or delete and no new statement the runner sends: it only changes which timed-out batches are judged safe to repeat (D1) and the wording of stop messages. The data-safety question, "a retry repeats statements", is the parent wave's I1; this wave widens the set of retried batches by exactly one shape (a batch whose upsert tables the batch creates with `CREATE TABLE IF NOT EXISTS` and the target lacks), and I1 above is the guard for it. Failure-boundary table: the first batch stalls and had not committed: replay creates the table and inserts, same final state; it had committed: the catalog has the table, judged by the catalog as today; it commits late, after the catalog read: the replayed creates are no-ops and the upserts are idempotent into a table of the source's shape (D1); the catalog read fails: stop with the existing message, now with the D3 sentence when nothing is checkpointed. A forward-only design (stop and say what to rerun) is what the issue calls the current cost; the issue asks for the retry.

## Task 1: Batch-created facts and the unsafe reason (cli#274)

**Depends on:** none. This task freezes the contract Task 2 consumes.

**Files (file scope, the only paths this task may touch):**
- Modify: `src/utils/database-import-batching.ts`
- Modify: `tests/database-import-batching.test.ts`

Not yours, never touch: `src/utils/database-sql-import-runner.ts`, `tests/database-import-command.test.ts` (Task 2), `README.md` (Task 3).

**Interfaces (frozen: Task 2 quotes these exactly):**
- Produces, in `src/utils/database-import-batching.ts`:
  ```ts
  /** Why a known table makes a statement unsafe to repeat. */
  export interface UnsafeTable { name: string; reason: 'no-key' | 'trigger' }

  export interface ReplayVerdict {
      status: 'safe' | 'unsafe' | 'unknown';
      firstUnsafe?: DatabaseSqlImportGroup;
      /** Set only when firstUnsafe is an upsert into a table the facts know: the table as written in the statement and why it is unsafe ('trigger' wins over 'no-key' when both hold). */
      unsafeTable?: UnsafeTable;
      unknownTables: string[];
  }

  /**
   * The facts the batch's own CREATE TABLE IF NOT EXISTS statements will give a table the target does not have yet.
   * Walks `groups` in order with the 'catalog' origin (statements taken as written), then returns only the tables that
   * (a) the batch itself creates, exactly once, with CREATE TABLE IF NOT EXISTS (a name created, dropped or renamed more than once in the batch is not returned) and (b) are NOT keys of `catalogFacts`.
   * A table in `catalogFacts` is never returned (the target's shape wins). An index or trigger on a table the batch does not create gives nothing.
   * `catalogObjectNames` is every `name` (second column) of the catalog read, lower-cased: a batch CREATE UNIQUE INDEX IF NOT EXISTS whose name is in it is a no-op on the replay, so it is left out of the walk.
   */
  export function batchCreatedFacts(groups: DatabaseSqlImportGroup[], catalogFacts: SchemaFacts, catalogObjectNames: ReadonlySet<string>): SchemaFacts;
  ```
- The runner will call: `mergeSchemaFacts(mergeSchemaFacts(sourceFacts, catalogFacts), batchCreatedFacts(batch.groups, catalogFacts, catalogObjectNames))`, with `catalogObjectNames = new Set(rows.map((row) => String(row[1] ?? '').toLowerCase()))` built by the runner from the same catalog rows.
- Unchanged: `schemaFactsFromSql`, `mergeSchemaFacts`, every other export. `replayVerdict`'s `unsafeTable` is set from `upsertTarget` returning unsafe for a table `facts.get(key)` found (keyless, or triggered); it is absent for a statement-shape unsafe and for an upsert target whose name cannot be read.

- [ ] **Step 1: Write the failing tests** in `tests/database-import-batching.test.ts` (a new `describe` block `batchCreatedFacts and the unsafe reason`, plus the two pinned rows changed). Use the file's existing `group(sql)` helper.

  Expected-RED table (the reviewer checks each row against the test code; nothing runs locally):

  | Row | Test | Assertion that must fail on the base | Why |
  |---|---|---|---|
  | A | `CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, v)` + `CREATE INDEX IF NOT EXISTS i ON docs(v)`, empty catalog facts | `batchCreatedFacts(groups, new Map(), new Set()).get('docs')` equals `{ keyed: true, triggered: false }` | the function does not exist |
  | B | same groups, but `catalogFacts` = `new Map([['docs', { keyed: false, triggered: false }]])` | result has no `docs` key (`.size === 0`) | an existing table's shape wins (I1 route a) |
  | C | `CREATE TABLE IF NOT EXISTS k (a, b)` and, separately, `CREATE TABLE IF NOT EXISTS k (a); CREATE UNIQUE INDEX IF NOT EXISTS ki ON k(a)` | first: `{ keyed: false, triggered: false }`; second: `{ keyed: true, triggered: false }` | the keyless case must stay unsafe, the unique index counts (I1 route d) |
  | D | `CREATE TABLE IF NOT EXISTS t (id PRIMARY KEY)` + `CREATE TRIGGER IF NOT EXISTS tr AFTER INSERT ON t BEGIN SELECT 1; END;` | `.get('t')` equals `{ keyed: true, triggered: true }`, and `replayVerdict([group('INSERT OR REPLACE INTO t VALUES (1);')], merged)` has `status: 'unsafe'` with `unsafeTable` `{ name: 't', reason: 'trigger' }` | a trigger the batch creates must make the replay unsafe (I1 route b) |
  | E | an index/trigger on `u` with no `CREATE TABLE` for `u` in the groups, and a plain `CREATE TABLE p (id PRIMARY KEY)` (not IF NOT EXISTS) | result has neither `u` nor `p` | only IF NOT EXISTS tables the batch creates count (I1 route c) |
  | F | `replayVerdict` of `INSERT OR REPLACE INTO k VALUES (1);` with `k` facts `{ keyed: false, triggered: false }` | `unsafeTable` equals `{ name: 'k', reason: 'no-key' }` | the field does not exist |
  | H | `CREATE TABLE IF NOT EXISTS k (a); CREATE UNIQUE INDEX IF NOT EXISTS ki ON k(a)`, empty `catalogFacts`, `catalogObjectNames` = `new Set(['ki'])` (an index `ki` the target holds on another table) | `.get('k')` equals `{ keyed: false, triggered: false }`; with an empty name set the same groups give `{ keyed: true, triggered: false }` | the replayed index is a no-op, the new table stays keyless (I1 route e; plan-check Important 1) |
  | I | `CREATE TABLE IF NOT EXISTS k (a); CREATE TABLE IF NOT EXISTS k (id PRIMARY KEY)`; and, separately, `CREATE TABLE IF NOT EXISTS m (id PRIMARY KEY); DROP TABLE m`; empty catalog | `batchCreatedFacts(...)` has no `k` key in the first case and no `m` key in the second (`.size === 0`) | SQLite keeps the first create; a later statement must not decide (I1 route f; plan-check Minor 3) |
  | G | the two pinned rows at `tests/database-import-batching.test.ts:327-345` (keyless and triggered) | their `toEqual` gains `unsafeTable: { name: 'k', reason: 'no-key' }` and `{ name: 't', reason: 'trigger' }`; the plain-write rows (`:307-320`) keep no `unsafeTable` | existing rows updated, not weakened |

  Third argument: Task 1 rows A-G and I pass `new Set()` as `catalogObjectNames` (row A's `new Map()` is the `catalogFacts`; rows B-G and I pass the `catalogFacts` their row names); only row H passes a non-empty set (`new Set(['ki'])`), plus its empty-set variant.

- [ ] **Step 2: Implement** `batchCreatedFacts` and the `unsafeTable` field in `src/utils/database-import-batching.ts`.
  - `batchCreatedFacts`: first drop from the walked statements every `CREATE UNIQUE INDEX IF NOT EXISTS <name> ...` whose lower-cased name is in `catalogObjectNames`. Then collect the keys of tables created by `CREATE TABLE IF NOT EXISTS` in `groups`, counting how many times each name is created, dropped or renamed (a name seen more than once, or dropped or renamed at all, is excluded; tokenize each group; reuse `skipIfNotExists`, `qualifiedName`, the `TEMP`/`VIRTUAL` handling of `walkCreate` so a `CREATE TEMP TABLE IF NOT EXISTS` is **not** counted: temp tables are never a target-table fact), compute `schemaFactsFromSql(walked.map((g) => g.sql), 'catalog')` where `walked` is the groups left after that filter (never `groups` itself: the filtered-out index statements must not reach the walk), and return a new map holding only entries whose key is in the created set and not in `catalogFacts`.
  - `upsertTarget` returns `{ status: 'unsafe', table: name.raw, reason }` for a found table (`reason` is `'trigger'` when `found.triggered`, else `'no-key'`); `groupSafety`'s plain `{ status: 'unsafe' }` stays for shape-unsafe statements; `replayVerdict` copies `table`/`reason` of the first unsafe group into `unsafeTable`.

- [ ] **Step 3: Static check.** Run `npm run build` (tsc). Nothing else runs locally.

- [ ] **Step 4: Report (do not commit).** List the test paths and the source path separately, with the expected-RED table above filled in with what you wrote.

## Task 2: The runner uses them, names the table's state, hints on a first-batch stop (cli#274)

**Depends on:** Task 1 committed (it consumes the frozen contract above).

**Files (file scope, the only paths this task may touch):**
- Modify: `src/utils/database-sql-import-runner.ts` (the timeout branch, lines 560-620, and nothing else)
- Modify: `tests/database-import-command.test.ts`

Not yours, never touch: `src/utils/database-import-batching.ts`, `tests/database-import-batching.test.ts` (Task 1), `README.md` (Task 3).

**Interfaces:**
- Consumes (Task 1, frozen): `batchCreatedFacts(groups, catalogFacts, catalogObjectNames): SchemaFacts`; `ReplayVerdict.unsafeTable?: { name: string; reason: 'no-key' | 'trigger' }`; `mergeSchemaFacts(base, override)`.
- Produces: no new export. New message texts (D2, D3), quoted exactly:
  - unknown: `The table(s) ${verdict.unknownTables.join(', ')} are not in the target database yet and this batch does not create them, so repeating the batch is not safe`
  - unsafe, known table, `no-key`: `The statement at lines A-B writes into table ${name}, which has no primary key or unique constraint (in the target, or as this batch creates it), so it is not safe to repeat`
  - unsafe, known table, `trigger`: `The statement at lines A-B writes into table ${name}, which has a trigger, so it is not safe to repeat`
  - unsafe, shape: the existing sentence, unchanged.
  - the D3 sentence, appended after the existing final `Raise the per-batch limit with --timeout (for example --timeout 15m).` of **every** stop in the timeout branch and the lock-exhausted stop, only when `!checkpointPublished`: ` Nothing was checkpointed yet, so there is no resume line; the first batch may or may not have committed. Check its tables, then rerun the whole import with a longer --timeout (for example --timeout 15m).`

- [ ] **Step 1: Write the failing tests** in `tests/database-import-command.test.ts`, in the `describe` that holds the existing timeout rows (near `names the table when it is not known anywhere`, line 850). Each stalls `executeMultiple` as the neighbouring rows do (`execute: async ({ sql }) => { if (<count> > 10) await new Promise(() => undefined); }`, `test.dependencies.dataPlaneTimeoutMs = 10`).

  Expected-RED table (checked against the test code; nothing runs locally):

  | Row | Test (source / catalog) | Assertion that must fail on the base | Why |
  |---|---|---|---|
  | A | the issue's case: `CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, v TEXT);`, `CREATE INDEX IF NOT EXISTS docs_v ON docs(v);`, then 30 `INSERT OR REPLACE INTO docs VALUES (n, 'x');` (32 groups, so a first batch of 32); catalog `[]`; stall when a batch holds more than 10 upserts | the import resolves, `test.executions.map(groupCount)` shows 32 then smaller batches down to a completing size (copy the arithmetic style of the neighbouring halving row at lines 780-785: first execution 32 groups, then 16 ... until one completes), the first **completing** execution contains the two CREATE statements, `test.catalogReads` has length 1, `checkpointFiles(root)` is `[]` | on the base the run stops "not known to have a primary key" after one execution |
  | B | same source; catalog `[['table','docs','docs','CREATE TABLE docs (id, v)']]` | rejects `upstream_unavailable`; `executions` length 1; message contains `table docs, which has no primary key or unique constraint` (the target's own keyless `docs` wins over the source's keyed shape) and `not safe to repeat` | base prints the generic text |
  | C | source `CREATE TABLE IF NOT EXISTS t (id PRIMARY KEY);` + `CREATE TRIGGER IF NOT EXISTS tr AFTER INSERT ON t BEGIN SELECT 1; END;` + 30 upserts into `t`; catalog `[]` | rejects; `executions` length 1; message contains `table t, which has a trigger` | I1 route b through the runner |
  | D | source `CREATE TABLE IF NOT EXISTS a (id PRIMARY KEY);` + upserts into `a` and 20 upserts into `b` (never created); catalog `[]` | rejects; `executions` length 1; message contains `The table(s) b are not in the target database yet and this batch does not create them` and not `are not known to have` | base wording; and the one-table-created-one-not case |
  | H | `CREATE TABLE IF NOT EXISTS k (a);` + `CREATE UNIQUE INDEX IF NOT EXISTS ki ON k(a);` + 30 `INSERT OR REPLACE INTO k VALUES (n);`; catalog `[['index','ki','other','CREATE UNIQUE INDEX ki ON other(x)']]` | rejects; `executions` length 1; message contains `table k, which has no primary key or unique constraint` (the batch's own `k` is judged keyless because the index name is taken), and never retried | a unique index whose name the target holds must not make `k` keyed (I1 route e); proves the runner passes `catalogObjectNames` |
  | E | rewritten existing row at line 872 (`names the table when it is not known anywhere`) | `toContain('The table(s) t are not in the target database yet and this batch does not create them')` replaces the old `'The target tables t are not known to have a primary key'` | wording changed (D2) |
  | F | first-batch hint: the existing stalled single plain `CREATE TABLE` row (starting at `tests/database-import-command.test.ts:324`) plus a new row with a 40-statement plain-`INSERT` first batch that stalls | message contains the whole D3 sentence, quoted exactly as in the Interfaces block above (` Nothing was checkpointed yet, so there is no resume line; the first batch may or may not have committed. Check its tables, then rerun the whole import with a longer --timeout (for example --timeout 15m).`), not fragments of it; `expectNoSecrets` | base prints neither |
  | G | a **second-batch** stall: 150 `INSERT OR REPLACE INTO t` after `CREATE TABLE t (id PRIMARY KEY)` split by the 100-group cap, the first batch completes, the second stalls on an unsafe shape (add one plain `UPDATE` in it) | message contains the resume line (use the file's `resumeLine(...)` helper) and does **not** contain `Nothing was checkpointed yet` | I3: a later stop keeps its resume line and gets no first-batch sentence (this row is green on the base for the resume line and RED only for the absence of a sentence that does not exist yet, so it guards the regression) |

- [ ] **Step 2: Implement** in `src/utils/database-sql-import-runner.ts` (timeout branch only):
  - after the catalog read: `verdict = replayVerdict(batch.groups, mergeSchemaFacts(mergeSchemaFacts(sourceFacts, catalogFacts), batchCreatedFacts(batch.groups, catalogFacts, catalogObjectNames)));` (the three-argument call exactly as in Task 1's Interfaces, with `catalogObjectNames` built just before it from the same catalog rows)
  - build the stop reason from the verdict as in the Interfaces block (D2); the `size === 1` reason is unchanged;
  - compute `const firstBatchHint = checkpointPublished ? '' : <the D3 sentence>` once in the timeout branch and append it to: the size-1 stop, the multi-statement stop, the "target schema could not be read" stop, and (in the lock branch) the "stayed locked" stop. Do not add it anywhere else (policy refusals, credential failures, the generic batch failure).
  - add `batchCreatedFacts` to the import list from `./database-import-batching`, and build `catalogObjectNames` from the catalog rows (second column, lower-cased) next to `catalogFacts`.
  - Do not change the retry loop, the catalog query or the checkpoint code.

- [ ] **Step 3: Static check.** Run `npm run build` (tsc). Nothing else runs locally.

- [ ] **Step 4: Report (do not commit).** Test path and source path separately, with the expected-RED table filled in, and `git diff --stat` for your paths (cap about 1000 diff lines).

## Task 3: README limits text (cli#274)

**Depends on:** none (text only; it describes Tasks 1-2, which land in the same PR).

**Files (file scope, the only paths this task may touch):**
- Modify: `README.md` (the `database import` paragraph and the `Limits:` paragraph under "## Database CLI", currently lines 218-239; nothing else)

Not yours, never touch: every `src/` and `tests/` path.

**Interfaces:** none. Keep every phrase `tests/readme-contract.test.ts:80-116` pins (`--timeout`, `solidactions database import analytics big.sql --timeout 15m --yes`, `fetches only what changed`, and the rest of that list).

- [ ] **Step 1: Edit** the Limits paragraph. Replace the clause "or a batch that contains a plain `CREATE` (a dump's first batch, which holds its `CREATE TABLE` statements), `DROP`, or `ALTER` is never retried either" with a version that says: a batch that contains a plain `CREATE`, `DROP` or `ALTER` is never retried; a dump's first batch that creates its own tables with `CREATE TABLE IF NOT EXISTS` **is** retried when the table is not in the target yet and the statements after it are `INSERT OR REPLACE` into a table that has a primary key or unique constraint and no trigger (an existing table of the same name is judged by the target's own shape). Add one sentence: when nothing has been checkpointed yet (the first batch stopped), the message says there is no resume line, that the first batch may have committed, and to check its tables and rerun the whole import with a longer `--timeout`. Add one sentence to the limits: a table of the same name created by another writer in the seconds between the check and the retry is not detected. No other README edit.

- [ ] **Step 2: Static check.** None needed beyond reading the paragraph back; do not run tests.

- [ ] **Step 3: Report (do not commit).** The path, and the three sentences you changed or added, quoted.

---

## Wave notes for the manager (not for developers)

- Order: Tasks 1 and 3 in parallel (disjoint scopes); Task 2 after Task 1 is committed. Final review: routed to the reviewer pool per the PM's current routing (plan-check Minor 5: not Sol-only; I confirm the seat with the PM before creating the card). The plan is `big: true` because the change widens a data-safety retry rule.
- Review routing: per-task reviews to dev-sonnet; if dev-sonnet authored a task, route its review elsewhere.
- Pre-flight before each final review (Shop rules 2026-10-05): every task committed; the named tests exist (Task 1 rows A-I, Task 2 rows A-H) and pass in `check.yml` on the exact head; `npm run build` clean; no TODO.
- No digest entry, no filed follow-up is planned; a reviewer FILE finding goes down the scope ladder.

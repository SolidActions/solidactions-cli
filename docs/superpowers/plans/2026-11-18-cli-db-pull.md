# CLI database pull: fetch only changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sa-subagent-driven-development to implement this plan task-by-task (the wave's build step). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `solidactions database pull` downloads only what changed since the last pull of the same database (a hidden per-database cache replica), never makes the user's file a live replica, and its help text, README and a run-time warning steer people away from pulling per run, per test or per preview.

**Architecture:** One new helper module (`src/utils/database-replica-cache.ts`) owns the cache directory, its lock, its metadata, the server identity (record id, creation time and sync origin) and the "skip the cache" rules; it knows nothing about libSQL. `src/commands/database.ts` gains a cached read-only path and a cached writable path: the libSQL client syncs into the cache replica (warm = incremental); the CLI then runs `VACUUM INTO` with the real local client inside the locked cache directory, checks the result with `PRAGMA quick_check`, copies the bytes into the still-open reserved sibling temp and publishes it with the existing rename. The existing uncached path stays as it is (two D8 exceptions) and is used for `--no-cache`, for a busy or skipped cache, and as the fallback whenever the cache misbehaves. Help text and the workflow-run warning live in a second small module so a docs-only task can run in parallel.

**Tech Stack:** TypeScript, `@libsql/client` 0.17.4 (native `libsql` 0.5.29, Rust libsql 0.9.30), commander, vitest (CI only), Node ESM probe script run by `check.yml` against a real libsql-server service.

**Spec:** none (no design file; the design is this plan's Architecture plus the Design rulings below). The app half is `SolidActions/solidactions-app#2840` (read only, meter and alarms and docs).

**Issues:** `cli#262` ("database pull: fetch only changes (hidden cache replica) and steer users away from pulling per run"), sanctioned by Peter's go 2026-11-17 recorded on the issue ("Companion to the app issue for the 2026-11-17 database-pull incident (Peter's go 2026-11-17, Fable review accepted)") and the wave's approval ask `task-startdatabase-064f`. Its only comment is the manager's relay of the PM's docs-scope ruling (read with `gh api --paginate repos/SolidActions/solidactions-cli/issues/262/comments`; `scripts/issue` does not exist in the CLI repo). The wave card is `task-waveclidatabase-fda7`; the plan card is `task-planclidbpull-12eb`.


## Global Constraints

- **The ask, verbatim (cli#262 body):**
  1. "**Incremental pull:** today `databasePullWithConfig` (src/commands/database.ts:2261) and `databaseWritablePullWithConfig` (:1929) build a fresh temp replica every time (`syncUrl` at :2347 / :2019), so every pull, and every retry, is a full download. Keep a hidden cache replica (with its sync metadata) per database and copy it to the user's file after `sync()`; never make the user's file a live replica. Fall back to a full pull when the cache is missing or corrupt, or the server copy was replaced. Skip the cache for databases that are rewritten often. First verify whether a retry really restarts from zero."
  2. "**Help text:** `database pull` help says to query directly in workflows and functions, pull only for local analysis, and reuse one copy; warn when pull runs inside a workflow run."
  (Line numbers in the quote are the issue's; on this tree the functions are `databasePullWithConfig` at `src/commands/database.ts:2375` and `databaseWritablePullWithConfig` at `:2043`.)
- **PM ruling on docs scope (chief, mail 1f778898-b38e-4ce2-a927-e9dd19f639b1, 2026-11-18), verbatim:** "Ruling for cli#262: besides pull --help, the CLI README's database pull section carries the same guidance (query directly in workflows/functions, pull only for local analysis, reuse one copy, never per test or preview). The app wave covers workflows_guide." Mapping: `DATABASE_PULL_HELP` (Task 3) carries all four points for `--help`; the README paragraph (Task 3) carries the same four; no other surface (the workflows guide is the app wave's).
- **PM plan-check rulings (chief, mail 49ba2fe2-e0b9-42cd-a95a-c7de8ffc333a, 2026-11-18), verbatim:** "(1) Yes: run the Task 1 probe once on this box against a throwaway libsql-server container; remove the container after, no keys involved. (2) No cuts: keep --no-cache (escape hatch) and Task 5 (writable pull is also a full download today)."
- **Plan review (task-planreviewclidb-5b20, REQUEST CHANGES at 511d38a, adjudicated by the chief, comment 33233073: "ALL accepted"; full text `/tmp/review-task-planreviewclidb-5b20.md`).** This revision answers its findings: 1 (server copy swapped under the same record: the sync origin is part of the cache identity; Task 2, Task 4), 2 (the probe runs the real sequence cold, snapshot, change, warm, snapshot, compares content, and measures the replica's real companion files and failure modes; Task 1), 3 (`PRAGMA quick_check` on the snapshot; Task 4), 4 (atomic stale-lock reclaim, hostname in the lock, real two-process rows; Task 2), 5 (the overwrite question is asked once; D8 amended; Task 4), 6 (real local `@libsql/client` for every snapshot step; the remaining stand-ins get a CLI ADR 0004, Task 4, text below, pending the PM's ruling), 7 (host-side byte measurement at verify, or an honest "not measured"; Verify data), 8 (writable fallback without replay, and the warm writable open rule; Task 5). Minors: 9 (Task 4 names the two built-binary tests), 10 (Task 2 row reworded), 11 (raw TCP proxy, cumulative failure point; Task 1), 12 (adopted: `VACUUM INTO` writes inside the locked cache directory and the bytes are copied into the still-open reservation, so there is no unlink-then-create by path; Task 2, Task 4), 14 (a deterministic warm failure wipes and returns to the uncached path, it does not consume an attempt; Task 4), 15 (see Scope ladder). Minor 13 is FILE (see Scope ladder).
- **MEASURED 2026-11-18 (gate G1; the manager's one PM-approved local run of Task 1's probe against two libsql-server containers of the CI image, log `.superpowers/sdd/2026-11-18-cli-db-pull/probe-local-run2.log`; the same probe runs in CI):**
  - The CLI's call (`createClient({ url, syncUrl, intMode: 'string' })`, no `offline`) uses the OLDER embedded-replica module. Companion files beside the replica: `replica.db-client_wal_index`, `replica.db-shm`, `replica.db-wal`. There is NO `-info` file.
  - Cold sync downloaded 3,120,314 bytes; after one insert, ten updates and ten deletes on the server, a WARM sync on the same path (after the CLI's own local open and `VACUUM INTO`) downloaded 38,183 bytes. Warm pulls are incremental.
  - The snapshot after the warm sync held exactly the server's rows (digest equal), after inserts, updates and deletes.
  - Failure modes of a warm sync: companion files removed -> throws (`Can not sync a database without a wal_index`); `replica.db` truncated to half -> throws (`database disk image is malformed`); `replica.db` zeroed -> throws (`file is not a database`); the same cache path against a DIFFERENT server -> succeeds with the correct rows (the older replicator re-synced it); the design does not rely on that, the sync origin is part of the identity (D3).
  - **A retry after a half-way failure restarts from zero** (3,186,365 bytes downloaded of a 3,120,314-byte database): the issue's "first verify" is answered YES; the existing uncached path's retry is a full download too, so a failed-then-retried pull costs up to two full downloads today.
  - **Ruling (manager, from the measurement): Task 4 does NOT add `-info` to `pullSidecars`, and its row 16 is dropped**; the premise it rested on (a `-info` metadata file) is false for this client. The test stand-in writes the measured companion names (`-client_wal_index`, `-shm`, `-wal`). Cost if wrong: none; no `-info` exists.
- **Premises, each quoted from this tree (verified 2026-11-18) or marked UNMEASURED (the UNMEASURED ones are answered by the MEASURED block above):**
  - A new temp replica per pull: the default `tempPath` is `path.join(path.dirname(target), '.' + path.basename(target) + '.solidactions-' + randomUUID() + '.tmp')` (written there as a template literal) (`src/commands/database.ts:242-245`). Every pull syncs into a never-seen path, so every pull is a full download.
  - A retry inside one pull reuses the same temp path: the loop at `src/commands/database.ts:2432` (`for (let attempt = 0; attempt < PULL_ATTEMPTS; attempt += 1)`, `PULL_ATTEMPTS = 3` at `:849`) calls `createClient({ url: pathToFileURL(temp).href, syncUrl: access.url, authToken: access.token, intMode: 'string' })` (`:2458-2463`) with the same `temp` each attempt, and the failed attempt keeps its partial file (`if (replicaStat?.isFile()) ownsTemp = true;` at `:2512`; test `hands the exclusive reservation to native creation once, then preserves the partial replica for retry`, `tests/database-pull-command.test.ts:524`). Whether the native client resumes from that partial file or starts from zero is UNMEASURED; Task 1 measures it (the issue's "first verify"). The design does not depend on the answer.
  - **UNMEASURED: which replica mode the CLI's call really uses, and so which companion files and failure modes it has.** The pull passes no `offline` option (`:2458-2463`; the writable call passes `offline: false`, `:2131-2138`). The native binary carries two replication modules: the offline-sync module (strings `-info`, `db file exists but metadata file does not`, `server returned a lower generation than what we have`) and the older embedded-replica module (`client_wal_index`, `LogIncompatible`, `NeedSnapshot`; `strings` on `node_modules/@libsql/linux-x64-gnu/index.node`, libsql 0.9.30). The CLI's existing sidecar list names `-client_wal_index` (`return [temp-wal, temp-shm, temp-journal, temp-client_wal_index]`, each a template literal on `temp`, `src/commands/database.ts:997-999`), which points at the older module. Nothing in this plan cites a failure string as fact: Task 1 prints the real companion names and records what a warm sync does when its metadata is missing, its file is truncated, or its server is a different database; Task 4's test stand-in writes the names Task 1 measured.
  - `finalizeReplica` cannot publish a `VACUUM INTO` snapshot: `validateCheckpointResult` throws when `checkpointed < log` and `checkpointInteger` rejects negatives (`src/commands/database.ts:1049-1076`), and `PRAGMA wal_checkpoint(TRUNCATE)` on a non-WAL file answers `0, -1, -1`. The snapshot path therefore has its own `publishSnapshot`, it does not call `finalizeReplica`.
  - The libSQL client type: `interface DatabaseClient { execute; executeMultiple?; sync?: () => Promise<unknown>; close; ... }` (`src/utils/database-data-plane.ts:79-85`). `sync()` of `@libsql/client` returns `{ frames_synced, duration_ms }` (`node_modules/@libsql/client/lib-cjs/sqlite3.js:195-199`); the CLI ignores the value today and keeps ignoring it.
  - A workflow run's env carries `SOLIDACTIONS_RUN_ID` and `STEPS_TRIGGER_ID` (`solidactions-app/app/Services/RuntimeEnvBuilder.php:70-72`: `'STEPS_TRIGGER_ID' => (string) $trigger->id, 'SOLIDACTIONS_RUN_ID' => $trigger->run_uuid,`). A developer's shell never sets them. The warning keys on either.
  - The record `database pull` already fetches (`requestDatabaseRecord` at `src/commands/database.ts:2387`) has optional `id` and `created_at` (`stableDatabaseRecord`, `:306-362`). They do NOT change when the app swaps the physical database under the record (review finding 1: app `RetireService::compact()`/`retire()`/`restore()` and `BulkLoadPromotionService` write a new `hostname` and keep `id` and `created_at`, i.e. after a compaction, a restore, or a `database push`/import). The access answer's `url` is `'libsql://'.$database->hostname` and carries no token (app `WorkspaceDatabaseUrlBuilder.php:14`, `HandleCliDatabaseOperation.php:610`, as the reviewer quoted them): its host is the cache's server identity.
  - Existing tests that exercise pull never pass a cache root to `databasePullWithConfig`, so the cache is off in them (D1). The two built-binary tests that go through `databasePull` (`tests/workspace-guard-write-exact.test.ts:129-170`, `tests/root-version-flag.test.ts:97-117`) get the default root, which lands under their temp `HOME` (`<tmpHOME>/.solidactions/cache/database-replicas`) when their server answers a libSQL `show`; nothing real is touched and no edit is needed.
- **Design rulings (mine, recorded here; each with its cost if wrong):**
  - **D1: the cache root is a dependency that is `undefined` by default inside `databasePullWithConfig`, and only the public wrapper `databasePull` fills it with the real default (`~/.solidactions/cache/database-replicas`).** Cost if wrong: an existing in-process test would write into a real home directory in CI; this ordering makes that impossible.
  - **D2: cache key** = first 32 hex chars of `sha256(JSON.stringify([host, workspaceId, databaseName]))`; layout `<root>/<key>/{lock,lock.reclaim,meta.json,snapshot.tmp,data/}`; the libSQL replica is `<root>/<key>/data/replica.db` and everything libSQL creates lives only under `data/` (the module never names its companions; "wipe" removes `data/` whole). Cost if wrong: a collision shares a replica between two databases; 128 bits makes that negligible.
  - **D3: "replaced server copy" and "rewritten often" are decided from identity, deterministically.** The cache stores `databaseId`, `createdAt` and `syncOrigin` (the lower-cased host of the access answer's `url`, `syncOriginOf`). Before any warm `sync()`, if any stored value and its offered value are both non-null and differ, the copy was replaced: wipe `data/`, record a replacement timestamp. 3 replacements inside 7 days switch the cache off for that database for 7 days (`skipUntil`). Cost if wrong: a database replaced less often than that keeps a cache that is wiped each time (a normal full pull, no harm); a database replaced faster than the threshold costs two wasted cold fills.
  - **D4: lock rules.** The lock stores `{ pid, host, nonce, at }`. A lock whose `host` equals this machine's hostname and whose pid is alive is never stolen; same host and dead pid is stale; another host's lock is live until its mtime is older than 1 hour; an unreadable lock is stale only when older than 1 hour. A stale lock is reclaimed under a second exclusive file, `lock.reclaim` (`wx`): the winner re-reads the lock, checks it is still the one it judged stale (same nonce), removes it and creates its own with `wx`; every loser answers `busy`; a `lock.reclaim` older than 60 s is removed by the next acquirer. The pull that cannot lock runs uncached and says so on stderr. Cost if wrong: one pull skips the cache (slow, never wrong).
  - **D5: the cache is an optimisation and can never fail a pull the uncached path would pass (invariant I3).** Every cache problem (cannot create the directory, read-only home, corrupt `meta.json`, snapshot or `quick_check` failure, a replica whose sync fails deterministically while warm) wipes the cache if it can and runs the existing uncached path, once.
  - **D6: `--no-cache` is added (commander `--no-cache`, option `cache: false`)** as the user's off switch: it neither reads nor writes the cache. PM-ruled keep ("escape hatch", mail 49ba2fe2). There is no cache-clear command; the help text names the directory.
  - **D7: no size cap.** A pull holds up to three copies for a moment (cache, snapshot, the reserved temp) and two afterwards (cache, the user's file); the help text says "roughly the database's size on disk". `--no-cache` avoids it. Cost if wrong: a very large database fills a disk; FILE'd below.
  - **D8: the cached read-only path is a new function; the existing uncached body is not edited, with exactly one exception:** its first statement (`if (!await confirmFileOverwrite(target, options, io)) return;`, `:2413`) is removed because the wrapper now asks the overwrite question once before either path runs (review finding 5); `pullSidecars` stays as is (measured, no `-info`). Cost if wrong: about 60 duplicated lines; benefit: the existing pull tests cannot regress.
  - **D9: every snapshot step uses the real local `@libsql/client` (no `syncUrl`), in code and in tests.** Test stand-ins exist only for the sync client and the control-plane answers (ADR 0004 below). Cost if wrong: none; a fake snapshot would prove nothing.
- **Invariants (must never happen), every route to each, and the sweep:**
  - **I1: the user's file is never a live replica.** It is never opened with a `syncUrl`; it is the reserved temp holding the bytes of a `VACUUM INTO` product (a standalone single file), or on the uncached path today's checkpointed replica; no replica companion is beside it after a successful pull. Routes: cached read-only, cached writable, uncached (unchanged). Sweep: Task 4's `no pull path leaves a companion file beside the target` lists the destination directory after every scenario in Tasks 4 and 5 and expects exactly the target file (plus pre-existing unrelated files).
  - **I2: a stale copy is never published after a failed sync.** The bytes published come only from a replica whose `sync()` succeeded in this invocation. Routes: warm sync fails then retries fail; warm sync fails deterministically, the cache is wiped and the uncached path fails too; a stalled sync hits the data-plane deadline. Sweep: Task 4's `a failed warm sync never publishes the previous file`.
  - **I3: the cache never fails a pull the uncached path would pass** (D5). Routes: unwritable root, `data` replaced by a symlink, corrupt `meta.json`, live lock, `VACUUM INTO` throws, `quick_check` is not `ok`, a damaged replica, a swapped server. The writable path's rule is Task 5 Behaviour 4. Sweep: Task 4's `cache faults fall back to the uncached path` table.
  - **I4: no credential is ever written into the cache directory or its `meta.json`.** Sweep: Task 2's `meta.json has exactly the documented keys`, and Task 4's and Task 5's greps of every file under the cache root for the access-token and PAT sentinels.
  - **I5: two pulls never hold one cache's lock at once, and a cache directory is never touched without its lock** (D4). Sweep: Task 2's two-process rows.
  - **I6: a replaced server copy never contributes to a published file.** A warm `sync()` is attempted only when the stored identity matches the offered identity (D3). Sweep: Task 2 identity rows, Task 4 `a swapped server wipes the cache`.

### Destructive paths (this wave writes and deletes files)

| Operation | What it removes or replaces | Proof the run owns it | Final-type recheck / no-clobber | Tests |
|---|---|---|---|---|
| Wipe the cache (`data/` removal) | `<root>/<key>/data` and everything under it | The path is built by the module from the hashed key; the module holds that key's lock; `lstat(data)` must be a real directory (not a symlink) or the wipe refuses and the cache is skipped | n/a (cache-owned) | Task 2: symlinked `data` is refused and its target survives; a sibling key directory survives |
| Lock create / reclaim / remove | `<root>/<key>/lock`, `<root>/<key>/lock.reclaim` | `wx` create; reclaim only under `lock.reclaim` after re-reading the same stale nonce; removed only when the stored `nonce` equals this run's | A lock written by another run is never unlinked while live | Task 2: foreign nonce survives `release()`; two real processes; two real processes reclaiming one dead lock; another-host lock |
| `meta.json` write | `<root>/<key>/meta.json` | Written under the lock to `meta.json.<nonce>.tmp` then `rename` | Atomic replace of a cache-owned file | Task 2: after `markSynced` the directory holds exactly `lock`, `meta.json`, `data` |
| Snapshot file | `<root>/<key>/snapshot.tmp` (`VACUUM INTO` output) | Inside the locked cache directory; removed at acquire (a crash leftover) and at release; `VACUUM INTO` refuses an existing non-empty path | Never the user's path | Task 2: a stale `snapshot.tmp` is removed at acquire |
| Bytes into the reserved temp | the sibling temp reserved by `reserveDestinationTemp` (`wx`, mode 0600) | Existing: the run created it; it stays open (no unlink-then-create by path); the snapshot bytes are written through that open handle | After the copy: `assertNoSymlinkComponents(temp)`, `lstat` is a regular file with the handle's `dev`/`ino`, size equals the snapshot's; no `-wal`/`-shm`/`-journal`/`-info`/`-client_wal_index` beside it | Task 4: temp replaced by a symlink after the copy is refused and nothing is published; the VACUUM statement's path is under the cache directory |
| Publish | the user's target | Unchanged: the one `confirmFileOverwrite` (`--yes` or confirmation) then `rename(temp, target)` after `assertNoSymlinkComponents(target)` | Unchanged | Existing tests plus Task 4 |
| Failure cleanup | the run's own temp and sidecars | Existing `ownsTemp` / `ownsSidecars` flags | Existing | Existing plus Task 4 |

Failure boundaries (disk and metadata state after each):

| Boundary | State after |
|---|---|
| Cache cannot be created / locked | nothing written (or only the empty root); uncached path runs |
| Identity mismatch before sync | `data/` wiped, replacement recorded, cold fill |
| `sync()` fails (all attempts, transient or credential) | cache `data/` kept (a resumable partial or a warm replica), `meta.json` not updated, target untouched, error as today |
| Warm sync fails with a non-transient error | `data/` wiped, lock released, temp removed, the uncached path runs (its own 3 attempts) |
| Replica or snapshot `quick_check` fails, or `VACUUM INTO` fails | `data/` wiped, `snapshot.tmp` removed, temp removed, uncached path runs |
| Publish (`rename`) fails | temp removed (existing), cache stays warm and correct (identity was written at acquire; only `lastSyncedAt` is not updated because `markSynced` runs after the rename), target untouched |
| Interrupted (Ctrl-C) mid-sync | lock removed by the `finally`; a hard kill leaves the lock, reclaimed next time (D4); the partial `data/` is handled by the next sync's own error (wipe, uncached) |
| Interrupted during recovery (wipe) | `data/` half removed; next acquire finds no `replica.db` or an inconsistent one; sync error = wipe, uncached |

A forward-only design (stop at the first error, keep what was written) cannot meet the issue because the issue requires falling back to a full pull when the cache is corrupt or the server copy was replaced; the fallback is wipe-then-uncached, which only ever deletes cache-owned data.

Secret-bearing host paths this plan's code reads: none (the cache root is under the user's home and holds no credential; I4).

Verify data: smoke and cleanroom run the CLI built from the branch against a free app slot's stack (`sa-dev-<slot>`, never the main checkout's, role override). `HOME` is set to a scratch directory so the real `~/.solidactions/cache` is never touched and the cache is inspectable. Seed with the CLI: `solidactions database create pullcache --json`, `solidactions database exec pullcache "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)" --yes --json`, then an insert of about 20000 rows (`INSERT ... SELECT` from a recursive CTE) so a full download is visibly larger than a delta. Smoke cases: cold pull; second pull after one remote `INSERT`, one `UPDATE` and one `DELETE` shows exactly the server's rows; `--no-cache`; truncate `replica.db` in the cache then pull (still correct); `database push` a changed file (or delete and recreate the database under the same name) then pull (no old rows: this is the swapped-server case); hold the lock with a live pid then pull (stderr note, correct file, ONE overwrite prompt in a terminal); `HOME` read-only (still correct); `SOLIDACTIONS_RUN_ID=x` set (warning printed). **Byte measurement (review finding 7):** the dev stack provisions databases on the real database host and the CLI syncs straight to it (`access.url` is `libsql://<hostname>`), so the stack has no sync route to read. The real measurement is the host's per-database usage before and after a cold and then a warm pull, read through the app's usage poll that app#2840 meters (`TursoPlatformClient::usage`, `app/Domains/Databases/Services/TursoPlatformClient.php:472` per the review; it aggregates with a delay, wait for it). If the slot cannot read that meter, the smoke result says `host bytes: not measured` and the evidence for "warm pulls fetch only changes" is Task 1's probe numbers (CI log and the one local run), plainly labelled as measured against the CI image and not the host; the manager mails the PM at verify in that case.

## Review Focus

1. **Stale data**: a warm pull after remote inserts, updates and deletes must show exactly the server's current rows, never the previous pull's (Task 1 digest equality after the real sequence, Task 4 `warm pull reflects remote changes through the snapshot` on real SQLite files).
2. **Two pulls of one database at once** (two terminals, a watch script, two containers sharing a home): the second must not corrupt the first's cache or file; it runs uncached and says so (Task 2 two-process rows, Task 4 `a live lock makes the pull uncached` with one overwrite prompt).
3. **A damaged cache** (truncated `replica.db`, missing metadata file, garbage `meta.json`, an empty directory): still a correct file, slower (Task 1 information rows, Task 4 fault table with a real damaged SQLite file, `quick_check`).
4. **A database whose server copy is swapped under the same record** (compaction, restore, `database push`, delete and recreate): no old rows, and after 3 replacements in 7 days the cache switches itself off (Task 2 identity and skip rows, Task 4 `a swapped server wipes the cache`).
5. **A home directory that is read-only, full or on a different drive** (CI containers, `HOME=/nonexistent`): the pull still works uncached and never prints a cache error (Task 2 `unavailable`, Task 4 fault table).

## Scope ladder (dispositions of what the review found beyond the plan)

- Review minor 13 (no eviction: caches of renamed or deleted databases stay forever; up to three copies for a moment): **FILE** at build end as a `cli` issue (`gh issue create`; `scripts/issue` does not exist in this repo), number into `deferred`.
- Review minor 15 (Peter's docs list also names the "agent skill" and "site docs"): cli#262's recorded docs scope is CLI help and README here and `workflows_guide` in the app wave (PM ruling above). The manager mails the PM to confirm an owner for the agent skill and the site docs; neither is in this wave's tasks.
- Review minor 12 (snapshot TOCTOU) is ADOPTED in the design, not filed. The uncached path's own unlink-then-native-create pattern is existing behaviour and stays (FILE'd with minor 13 if the reviewer still wants it).

## ADR 0004 (proposed; needs the PM's ruling before Task 4 is dispatched)

File: `docs/decisions/0004-database-pull-cache-test-seams.md` (Task 4 creates it with the text below once the PM's mail ruling is in hand; the ruling's mail id goes in its header). It follows `docs/decisions/0003-in-test-http-server-seam-duckdb.md`. Accepted call sites, and only these (1, 2, 3, 3a, 3b, 3c, 4):
1. **The fake sync client** inside the `loadClient` stand-in of `tests/database-pull-cache.test.ts` and `tests/database-writable-pull-cache.test.ts`: for a `createClient` config with a `syncUrl`, an object whose `sync()` writes a REAL SQLite file at the config's `url` (through the real local `@libsql/client`) holding the scenario's rows and writes the replica companion files Task 1 measured, and whose `close()` records. For a config without a `syncUrl` the harness returns the REAL `createClient` (so `VACUUM INTO`, `quick_check` and the open check run for real). Conditions: the real behaviour of a warm sync against a real server is proven by Task 1's probe (CI log, and the one local run), not by this fake.
2. **The injected `post`** answering `show` and `access` in those two files, copied from the existing harness shape in `tests/database-pull-command.test.ts` (`pullHarness`) and `tests/database-writable-pull-command.test.ts`, with the access `url` host set per scenario. Conditions: routes, fields and error codes unchanged from the existing harness.
3. **Injected clock and process facts** (`now`, `sleep`, `pid`, `hostname`, `processAlive`) in `tests/database-replica-cache.test.ts` and the two files above: they replace the wall clock and the OS process table, not a remote answer. Conditions: the two-process rows use real processes and real files, no injection.
   3a. **Injected prompt answers:** `confirm` as a `vi.fn` returning true (Task 4 row 7, and the writable harness Task 5 copies, `tests/database-writable-pull-command.test.ts:194`): it replaces the human at a terminal prompt, not a remote answer; the row asserts it is called exactly once.
   3b. **The recording wrapper** around the REAL local client in Task 4 row 11: a pass-through that records the statements it forwards and changes none of them, none of their results and no error. It is a recorder, not a double of behaviour.
   3c. **Injected terminal facts** in Task 5's harness (copied from `tests/database-writable-pull-command.test.ts:65-90, :194-195`): the `input` line source, `abortSignal` and `isTTY`: they replace the terminal and the Ctrl-C signal, not a remote answer.
4. **The edited dispatch row** in `tests/database-file-command-actions.test.ts` (existing stand-in handlers; the edit only adds `cache` to the expected options).
Not seams (as in 0003): the captured stdout/stderr sinks and the temp-directory environment isolation. The real-socket proof is the wave's verify live smoke and the probe against a real libsql-server (CI and the one local run).

---

## Open PRs touching these files

`gh pr list --repo SolidActions/solidactions-cli --state open` printed nothing at plan time (2026-11-18): no merge-order question. Callers and test doubles of the changed symbols (`grep -rlE "databasePull|databasePullWithConfig|pullSidecars|DatabasePullOptions|tempPath" src tests scripts`): `src/commands/database.ts`, `src/index.ts`, `src/utils/secure-write.ts` (unrelated `tempPath` word), `tests/database-duckdb-file.test.ts`, `tests/database-dump-command.test.ts`, `tests/database-file-command-actions.test.ts`, `tests/database-pull-command.test.ts`, `tests/database-sqlite-only-guards.test.ts`, `tests/database-writable-pull-command.test.ts`, `tests/secure-write.test.ts`.

## Task graph and file scopes

| Task | Issue | Depends on | Files (exclusive) |
|---|---|---|---|
| 1 | cli#262 (first verify) | none | `scripts/probe-database-replica-cache.mjs`, `.github/workflows/check.yml`, `tests/database-replica-cache-probe.test.ts`, `tests/database-native-ci-contract.test.ts` |
| 2 | cli#262 | none | `src/utils/database-replica-cache.ts`, `tests/database-replica-cache.test.ts` |
| 3 | cli#262 | none | `src/utils/database-pull-guidance.ts`, `src/index.ts`, `README.md`, `tests/database-pull-guidance.test.ts`, `tests/database-file-command-actions.test.ts`, `tests/readme-contract.test.ts` |
| 4 | cli#262 | 1, 2, 3, G1 | `src/commands/database.ts`, `tests/database-pull-cache.test.ts`, `docs/decisions/0004-database-pull-cache-test-seams.md` |
| 5 | cli#262 | 4 | `src/commands/database.ts`, `tests/database-writable-pull-cache.test.ts` |

Tasks 1, 2 and 3 run in parallel (disjoint scopes, no shared interface beyond the frozen contracts (Task 2 for the cache module, "Frozen contract: guidance" before Task 3)). Tasks 4 and 5 share `src/commands/database.ts` and are serial. Each task stays under about 1000 formatted diff lines (estimates: 1: 250, 2: 450, 3: 200, 4: 600, 5: 350).

**Local checks for every task (no test runs on this box):** `npm run build` (runs `tsc`) is the type check; the repo has no eslint or prettier config, so "format" means following the surrounding file's 4-space style. Tests run in the PR's `check.yml` only. Each developer hand-back has the expected-RED table (test, the assertion that fails on the base, why).


**Gate G1 (before Task 4 is dispatched):** Task 1 committed; the manager's one local probe run done and its numbers on the wave card (PM-approved, mail 49ba2fe2); the PM's ruling on ADR 0004 in hand. A red hard assertion in that run stops the wave at the build card.

### Task 1: Real-server probe: the real pull sequence, content equality, failure modes, retry (cli#262, "first verify")

**Depends on:** none. **Serves:** the issue's "First verify whether a retry really restarts from zero" and every UNMEASURED premise above (warm `sync()` is incremental after the CLI's own local open and `VACUUM INTO`; a snapshot holds the same content as the server; the replica's real companion files; what a warm sync does with missing metadata, a truncated file, or a different server).

**Files (file scope; the only paths this task may touch):**
- Create: `scripts/probe-database-replica-cache.mjs`
- Create: `tests/database-replica-cache-probe.test.ts`
- Modify: `.github/workflows/check.yml` (job `database-client-remote-sync`: add a second service `database2` (same image and digest as the first, port `8081:8080`), add one step after the existing `node scripts/probe-database-client-sync.mjs` step; lines 38-66)
- Modify: `tests/database-native-ci-contract.test.ts` (the `database-client-remote-sync` job test, lines 60-72: add one `toContain`, and one expectation that the job has two services with the same image)

Not yours, never touch: every file of Tasks 2-5 above.

**Interfaces:**
- Consumes: the libsql-server services the job starts at `http://127.0.0.1:8080` and (new) `http://127.0.0.1:8081`; the same `import('@libsql/client')` the existing probe uses; `scripts/probe-database-client-sync.mjs` as the style model.
- Produces: `export async function runReplicaCacheProbe({ createClient, remoteUrl, secondRemoteUrl, directory })` (real clients only; throws when a hard assertion fails; returns `{ coldBytes, warmBytes, companions, information }`); `export function assertWarmCheaper(coldBytes, warmBytes)` (throws unless `warmBytes * 4 < coldBytes`); `export function describeCompanions(names)` (sorted names that start with `replica.db`, minus `replica.db`); `export function digestRows(rows)` (sha256 hex over `JSON.stringify` of an array of `[id, pad]` pairs in order); `export function classifyOutcome(error, matched)` (returns `throws: <first 80 chars of the message>`, `succeeds-correct` or `succeeds-WRONG`).

The probe uses `createClient({ url: <file URL>, syncUrl: <proxy URL>, intMode: 'string' })` for the replica EXACTLY as `databasePullWithConfig` does (no `offline`, no `readYourWrites`; `src/commands/database.ts:2458-2463`), so what it measures is the mode the CLI really runs.

- [ ] **Step 1: Write the failing test** `tests/database-replica-cache-probe.test.ts` in the style of `tests/database-remote-sync-probe.test.ts` (load the module by `pathToFileURL`). Pure-function rows only (no fake client sequence: a fake would need an ADR and would prove nothing about the server):
  - `assertWarmCheaper(1_000_000, 200_000)` does not throw; `(1_000_000, 300_000)` throws (message contains `warm sync`); `(0, 0)` throws.
  - `describeCompanions(['replica.db', 'replica.db-wal', 'replica.db-info', 'other'])` equals `['replica.db-info', 'replica.db-wal']`.
  - `digestRows([[1, 'a'], [2, 'b']])` is a 64-hex string, equal for equal input, different when a value or the order changes.
  - `classifyOutcome(new Error('x'.repeat(200)), false)` starts with `throws: ` and is at most 88 characters; `classifyOutcome(undefined, true)` is `succeeds-correct`; `classifyOutcome(undefined, false)` is `succeeds-WRONG`.
- [ ] **Step 2: Record the expected failure** (the module does not exist). Expected: import error. No local test run; the expected-RED row goes in the hand-back.
- [ ] **Step 3: Implement `scripts/probe-database-replica-cache.mjs`.** Steps inside `runReplicaCacheProbe`:
  1. Start a counting **raw TCP proxy** with `node:net` to the remote's host and port (protocol-agnostic: it pipes bytes both ways, counts bytes sent toward the client, and `armFailure(n)` destroys both sockets when the cumulative bytes counted since arming reach `n`; `resetCounter()`). The replica's `syncUrl` is the proxy's `http://127.0.0.1:<port>`.
  2. Seed the remote directly (no proxy): table `replica_probe (id INTEGER PRIMARY KEY, pad TEXT NOT NULL)`, cleared, 3000 rows with `pad` = `'row-' + id + '-' + 'x'.repeat(1000)`, in one batch.
  3. **Cold:** replica at `<directory>/cache/data/replica.db`; `sync()`, close; `coldBytes`; reset the counter; `companions = describeCompanions(readdir(<directory>/cache/data))`; print `replica companions: <names>`.
  4. **Snapshot 1** (the CLI's real step): a local client (no `syncUrl`) on the replica, `VACUUM INTO '<directory>/cache/snapshot.tmp'` (a `'` in the path doubled), close; local client on the snapshot, `PRAGMA quick_check` must be a single row `ok`, read `SELECT id, pad FROM replica_probe ORDER BY id`, close; `digestRows(snapshotRows)` must equal `digestRows(remoteRows)` read directly. Assert `readdir(<directory>/cache)` shows the snapshot file and no companion of it.
  5. **Change and warm, in the real order (after the local open and VACUUM):** remotely insert 1 row, update 10 rows (`pad` replaced), delete 10 rows; NEW client on the SAME replica path, `sync()`, close; `warmBytes`; `assertWarmCheaper(coldBytes, warmBytes)`; **Snapshot 2** as step 4 and the digest must equal the remote's digest again (inserts, updates and deletes all visible).
  6. **Information rows** (printed as `information: <name>: <outcome>`, never asserted; each on a fresh copy of the replica directory taken after step 5, with another remote insert first so a warm sync has something to fetch): (a) delete every companion file `describeCompanions` found except `-wal` and `-shm`, then warm sync, then snapshot digest compared to the remote's, outcome via `classifyOutcome`; (b) truncate `replica.db` to half its size, same; (c) overwrite `replica.db` with 4 KB of zero bytes, same; (d) **different server on the same cache path:** when `secondRemoteUrl` is given, seed it with different rows and sync the step-5 replica path against it through a second proxy, then compare to the SECOND server's digest (this is the in-place-swap case of review finding 1; the answer is recorded, the CLI does not rely on it because the sync origin is part of the cache identity); (e) **retry after a half-way failure:** a fresh path, `armFailure(Math.floor(coldBytes / 2))`, `sync()` expected to throw (record `failed`), then the same path again with a new client: print `retry after a half-way failure downloaded <n> of <coldBytes> bytes (restarts from zero: <n >= coldBytes * 0.9>)`; digest must equal the remote's or the row prints `succeeds-WRONG`.
  7. The direct runner at the bottom (same guard as the existing probe) makes a temp directory, `await import('@libsql/client')`, reads `SOLIDACTIONS_DATABASE_SYNC_URL` (default `http://127.0.0.1:8080`) and optional `SOLIDACTIONS_DATABASE_SYNC_URL_2`, calls the function, prints `Replica cache probe passed.`, removes the directory in `finally`.
- [ ] **Step 4: Wire CI.** In `.github/workflows/check.yml` add the `database2` service and, directly after the existing `- run: node scripts/probe-database-client-sync.mjs` step with its `env` block, a step `- run: node scripts/probe-database-replica-cache.mjs` with `env: SOLIDACTIONS_DATABASE_SYNC_URL: http://127.0.0.1:8080` and `SOLIDACTIONS_DATABASE_SYNC_URL_2: http://127.0.0.1:8081`; the existing "Wait for the database service" step also waits for 8081. In `tests/database-native-ci-contract.test.ts` add `expect(commands).toContain('node scripts/probe-database-replica-cache.mjs');` and an expectation that `Object.values(remoteSyncJob.services ?? {})` has length 2 and both images equal `REMOTE_SYNC_IMAGE`.
- [ ] **Step 5: Static checks:** `npm run build`; `node --check scripts/probe-database-replica-cache.mjs` (allowed, it runs no test).
- [ ] **Step 6: Report (do not commit).** List every changed path; expected-RED rows (the pure-function rows fail on the base because the module is missing); and say plainly that the real-server behaviour (bytes, companions, digests, information rows) is read from the PR's `check.yml` log, job `Database client remote sync`. **Manager follow-up (PM-approved, mail 49ba2fe2):** after Task 1 is committed the manager runs the script ONCE on this box against two throwaway libsql-server containers of the CI image on ports 8080 and 8081 (`docker run -d --rm`), reads the output, removes both containers, and records the measured companion names, the retry answer and the information rows on the wave card and in the Task 4 brief. A red hard assertion there (warm not cheaper, or a digest mismatch) means the incremental premise is false: stop, mail the PM, do not dispatch Task 4.

The manager commits with `git add -- <paths>` then `git commit -m "test(probe): real-server replica cache probe (#262)" -- <paths>`.

---

### Task 2: The replica cache module (cli#262)

**Depends on:** none. **Serves:** the cache directory, lock, metadata, identity and skip rules.

**Files (file scope):**
- Create: `src/utils/database-replica-cache.ts`
- Create: `tests/database-replica-cache.test.ts`

Not yours, never touch: `src/commands/database.ts` and every file of Tasks 1, 3, 4, 5.

**Interfaces:**
- Consumes: Node `fs.promises`, `os`, `path`, `crypto` only. No import from `src/commands/`.
- Produces: exactly the frozen contract below (copy it verbatim into the file as the exported surface; implementation detail follows).

### Frozen contract (quoted verbatim by Tasks 2, 4, 5)

`src/utils/database-replica-cache.ts` (Task 2 owns; Tasks 4 and 5 consume):

```ts
import fs from 'fs';

export const REPLICA_CACHE_REPLACEMENT_LIMIT = 3;
export const REPLICA_CACHE_REPLACEMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const REPLICA_CACHE_SKIP_MS = 7 * 24 * 60 * 60 * 1000;
export const REPLICA_CACHE_STALE_LOCK_MS = 60 * 60 * 1000;
export const REPLICA_CACHE_STALE_RECLAIM_MS = 60 * 1000;

export interface ReplicaCacheIdentity {
    host: string;
    workspaceId: string;
    name: string;
    /** `row.id` of the database record, or null when the record has none. */
    databaseId: string | null;
    /** `row.created_at` of the database record, or null when the record has none. */
    createdAt: string | null;
    /** `syncOriginOf(access.url)`, or null when it cannot be read. */
    syncOrigin: string | null;
}

export interface ReplicaCache {
    /** `<root>/<key>/data/replica.db`; the only path the libSQL sync client is given. `data/` exists. */
    readonly replicaPath: string;
    /** `<root>/<key>/snapshot.tmp`; the only path `VACUUM INTO` writes. Absent at acquire. */
    readonly snapshotPath: string;
    /** True when `replicaPath` existed when the cache was acquired and the identity matched. */
    readonly warm: boolean;
    /** Remove `data/` whole and recreate it empty; after this `warm` reads false. Throws only `ReplicaCacheError`. */
    wipe(): Promise<void>;
    /** Remove `snapshot.tmp` if present. Never throws. */
    discardSnapshot(): Promise<void>;
    /** Record a successful sync and verified snapshot in `meta.json` (identity, `lastSyncedAt`). Never stores a credential. */
    markSynced(): Promise<void>;
    /** Remove `snapshot.tmp` and the lock if it is still ours. Idempotent; never throws. */
    release(): Promise<void>;
}

export type ReplicaCacheOutcome =
    | { kind: 'ready'; cache: ReplicaCache }
    | { kind: 'skipped'; reason: 'busy' | 'rewritten_often' | 'unavailable' };

export class ReplicaCacheError extends Error {}

/** `<homedir>/.solidactions/cache/database-replicas`. */
export function defaultReplicaCacheRoot(homedir?: string): string;

/** First 32 hex characters of sha256(JSON.stringify([host, workspaceId, name])). */
export function replicaCacheKey(identity: Pick<ReplicaCacheIdentity, 'host' | 'workspaceId' | 'name'>): string;

/** Lower-cased `host[:port]` of a `libsql://`, `https://` or `http://` URL; null when it cannot be read. */
export function syncOriginOf(syncUrl: unknown): string | null;

/** Never throws for a cache problem: it answers `skipped` instead. */
export function acquireReplicaCache(options: {
    root: string;
    identity: ReplicaCacheIdentity;
    now: () => number;
    filesystem?: typeof fs.promises;
    pid?: number;
    hostname?: string;
    processAlive?: (pid: number) => boolean;
}): Promise<ReplicaCacheOutcome>;
```

**Behaviour (implement exactly):**
- `defaultReplicaCacheRoot(homedir = os.homedir())` = `path.join(homedir, '.solidactions', 'cache', 'database-replicas')`. `replicaCacheKey` as the contract says. `syncOriginOf('libsql://abc-x.example.io')` is `abc-x.example.io`; `'HTTPS://H.example:8443/x'` is `h.example:8443`; `''`, `undefined`, `'not a url'` are null.
- `acquireReplicaCache` in order:
  1. `dir = path.join(root, key)`. `mkdir(root, { recursive: true, mode: 0o700 })` and `mkdir(dir, { recursive: true, mode: 0o700 })`; any error -> `skipped: 'unavailable'`. `lstat(dir)` must be a real directory, not a symlink, else `unavailable`. (The root's own ancestors may be symlinks: a home on another drive is legitimate. Only `<root>/<key>` and `data` are checked.)
  2. Take the lock (below). Busy -> `skipped: 'busy'`.
  3. Remove a leftover `snapshot.tmp`. Read `meta.json` (`{ version: 1, databaseId, createdAt, syncOrigin, lastSyncedAt, replacements: number[], skipUntil: number | null }`). Missing -> defaults. Unparseable, wrong `version`, or wrong shape -> defaults AND wipe `data/` (a corrupt meta means the replica cannot be trusted).
  4. `skipUntil > now()` -> release the lock, `skipped: 'rewritten_often'`.
  5. Identity check (D3): for each of `databaseId`, `createdAt`, `syncOrigin`, a stored value and an offered value that are both non-null and differ means replaced: wipe `data/`, push `now()` onto `replacements`, drop entries older than `REPLICA_CACHE_REPLACEMENT_WINDOW_MS`; when `replacements.length >= REPLICA_CACHE_REPLACEMENT_LIMIT` set `skipUntil = now() + REPLICA_CACHE_SKIP_MS`, write meta, release, `skipped: 'rewritten_often'`. Otherwise write the offered non-null values into meta (a stored null never counts as a change).
  6. Ensure `data/` exists as a real directory (`lstat`; a symlink or a file there -> release, `skipped: 'unavailable'`, never follow or remove it). `warm = (await lstatIfPresent(replicaPath)) is a regular file`.
  7. Any thrown error in steps 1-6 releases the lock if it was taken and answers `unavailable`. The function never throws.
- **Lock (D4):** `open(dir/lock, 'wx', 0o600)`, write `{ pid, host: hostname ?? os.hostname(), nonce: crypto.randomUUID(), at: now() }`. On `EEXIST` read it: unreadable or malformed -> stale only when its `mtime` is older than `REPLICA_CACHE_STALE_LOCK_MS`, else busy; `host` differs from ours -> stale only when `mtime` is older than `REPLICA_CACHE_STALE_LOCK_MS`, else busy; same host -> `processAlive(pid)` (default: `process.kill(pid, 0)` true unless it throws `ESRCH`; `EPERM` counts as alive) true -> busy, false -> stale. Reclaim a stale lock only like this: create `lock.reclaim` with `wx` (EEXIST -> if its mtime is older than `REPLICA_CACHE_STALE_RECLAIM_MS` remove it and answer busy this time, else busy); re-read `lock`: it must still parse to the same nonce you judged stale (or still be the same unreadable stale file); remove it; create your own with `wx` (EEXIST -> busy); always remove `lock.reclaim` in a `finally`. `release()` reads the lock and unlinks it only when its `nonce` matches ours; never throws.
- `wipe()`: `lstat(data)` must be a real directory (if missing, just create it); remove it with `fs.promises.rm(data, { recursive: true, force: true })`, then recreate it empty with mode 0700; set the in-memory `warm` to false; clear `lastSyncedAt`. A symlinked `data` -> throw `ReplicaCacheError`.
- `markSynced()`: write meta atomically (`meta.json.<nonce>.tmp` then `rename`) with the current identity and `lastSyncedAt = now()`; keep `replacements` and `skipUntil`.
- Nothing in this module reads or writes anything outside `<root>/<key>/`.

- [ ] **Step 1: Write the failing tests** in `tests/database-replica-cache.test.ts` (real files under `fs.mkdtempSync(os.tmpdir())`, roots removed in `afterEach`; inject `now`, `pid`, `hostname`, `processAlive` per ADR 0004 call site 3). Rows (each is one `it`):
  1. `key is stable, 32 hex, and differs by host, workspace and name`; `syncOriginOf parses libsql, https and http, lower-cases, keeps a port, and answers null for junk`.
  2. `cold acquire creates data/, a lock, snapshotPath absent, and reports warm=false`; after writing `data/replica.db`, release, acquire again: `warm=true`.
  3. `a live same-host lock (processAlive true) is busy and the lock file is untouched`; `a same-host dead-pid lock is reclaimed`; `another host's lock is busy while younger than 1 h and reclaimed when older` (use `fs.utimes`); `an unreadable lock younger than 1 h is busy, older than 1 h is reclaimed`.
  4. `release removes only its own lock` (overwrite the lock with a foreign nonce, release, the foreign lock survives).
  5. `a corrupt meta.json wipes data/ and starts clean`.
  6. `identity change wipes data/ and records a replacement` for each of databaseId, createdAt and syncOrigin alone (same id and createdAt, new syncOrigin: replaced; I6); `null on either side is not a change`.
  7. `the third replacement inside 7 days skips with rewritten_often for 7 days, then the cache is usable again` (advance injected `now` by 7 days + 1 ms).
  8. `a symlinked data/ is refused and its target survives`.
  9. `an unwritable root answers unavailable and never throws` (root path whose parent is a regular file).
  10. `meta.json has exactly the documented keys` (after `markSynced`: exactly `version, databaseId, createdAt, syncOrigin, lastSyncedAt, replacements, skipUntil`, and no string value in it is longer than 200 characters) (I4 guard on the module's own writes; the credential sweep is Task 4/5).
  11. `after markSynced the cache directory holds exactly lock, meta.json and data` (no `*.tmp`, I.e. the write was atomic and clean).
  12. `a stale snapshot.tmp is removed at acquire; release removes the snapshot and the lock`.
  13. **Real processes (I5; the child script imports the built module `dist/utils/database-replica-cache.js`; CI builds before vitest, `check:release` is `build && test`; do not run the test locally):** `two processes started before either acquires: exactly one is ready, the other busy` (spawn two `node` children with `process.execPath`; each waits in a poll loop for a flag file the test creates after both have signalled `started` by writing their own flag files, then calls `acquireReplicaCache` on the same root and identity and prints one JSON line; the test asserts exactly one `ready` and one `busy`); `two processes reclaiming the same dead lock: exactly one is ready` (pre-create a lock of a dead pid on the same hostname, same barrier; this row is RED against a plain "unlink the stale lock and retry `wx`" implementation, say so in the hand-back).
- [ ] **Step 2: Expected RED:** the module does not exist: every row fails at import. (No local run.)
- [ ] **Step 3: Implement** `src/utils/database-replica-cache.ts` per Behaviour. Follow the surrounding style (4 spaces, `isMissingPath`-style `ENOENT` checks; do not import from `src/commands/database.ts`).
- [ ] **Step 4: Static checks:** `npm run build`.
- [ ] **Step 5: Report (do not commit)**: changed paths; expected-RED table; the grep `grep -rn "replica-cache" src tests` shown (only your two files and nothing else).

The manager commits with `git add -- <paths>` then `git commit -m "feat(database): replica cache module (#262)" -- <paths>`.

---

### Frozen contract: guidance (quoted verbatim by Tasks 3 and 4)

`src/utils/database-pull-guidance.ts` (Task 3 owns; Task 4 consumes `isInsideWorkflowRun` and `WORKFLOW_RUN_PULL_WARNING`, Task 3's `index.ts` consumes `DATABASE_PULL_HELP`):

```ts
export const WORKFLOW_RUN_ENV_KEYS: readonly ['SOLIDACTIONS_RUN_ID', 'STEPS_TRIGGER_ID'];
export function isInsideWorkflowRun(env: NodeJS.ProcessEnv): boolean; // true when any key above is a non-empty string
export const WORKFLOW_RUN_PULL_WARNING: string;
export const DATABASE_PULL_HELP: string;
```

Exact strings (frozen; no supplier names):

- `WORKFLOW_RUN_PULL_WARNING` = `Warning: database pull is running inside a workflow run. A workflow or function can query the database directly (ctx.vars with createDatabaseClient); pulling a copy on every run downloads it again each time. Use pull only for local analysis and keep one copy.`
- `DATABASE_PULL_HELP` (printed with `addHelpText('after', ...)`, a leading newline included) =

```

Pull is for analysing a database on your own machine. Inside a workflow or a function,
query the database directly instead (ctx.vars with createDatabaseClient); never pull per
run, per test or per preview. Pull once and reuse that copy.

A pull fetches only what changed since your last pull of the same database; the first pull
downloads everything. A hidden cache for each database lives in
~/.solidactions/cache/database-replicas (delete the folder to start over) and takes
roughly the database's size on disk. Your file is always a plain read-only copy.
Use --no-cache to leave the cache out of one pull.
```

followed (in `index.ts`, unchanged text) by the existing DuckDB paragraph.

`DatabasePullOptions` (Task 4 adds the field in `src/commands/database.ts`): `cache?: boolean` (commander's `--no-cache` yields `cache: false`, and `cache: true` when the flag is absent). New `DatabaseCommandDependencies` fields (Task 4): `replicaCacheRoot?: string` (undefined = cache off, D1), `env?: NodeJS.ProcessEnv` (default `process.env`).

---

### Task 3: Help text, README, workflow-run warning text, `--no-cache` flag (cli#262, ask 2)

**Depends on:** none. **Serves:** ask 2 (help text) and the user-facing half of D6.

**Files (file scope):**
- Create: `src/utils/database-pull-guidance.ts`
- Create: `tests/database-pull-guidance.test.ts`
- Modify: `src/index.ts` (the `database pull` command, lines 411-425: add the option and the help text; add one import)
- Modify: `README.md` (the Database CLI code block, lines 100-135, plus one short paragraph after it)
- Modify: `tests/database-file-command-actions.test.ts` (the pull dispatch test, lines 39-51: the expected options gain `cache: true`)
- Modify: `tests/readme-contract.test.ts` (the Database CLI test, after line 100: two new assertions)

Not yours, never touch: `src/commands/database.ts` (Task 4 adds `cache?: boolean` to `DatabasePullOptions`; commander hands the CLI an untyped options object, so your change compiles first), every file of Tasks 1, 2, 4, 5.

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: exactly the `database-pull-guidance.ts` contract and the two exact strings above, copied verbatim; the commander option `.option('--no-cache', 'Do not read or write the local replica cache for this pull')`.

- [ ] **Step 1: Write the failing tests.**
  - `tests/database-pull-guidance.test.ts`: `isInsideWorkflowRun({})` false; `{ SOLIDACTIONS_RUN_ID: 'r' }` true; `{ STEPS_TRIGGER_ID: '7' }` true; `{ SOLIDACTIONS_RUN_ID: '' }` false; `WORKFLOW_RUN_PULL_WARNING` equals the frozen string; both strings contain none of `Turso`, `libsql`, `libSQL`, `Daytona`, `Cloudflare`, `R2` (case-insensitive, word boundary for `R2`); `DATABASE_PULL_HELP` contains `createDatabaseClient`, `--no-cache`, `~/.solidactions/cache/database-replicas`.
  - `tests/database-file-command-actions.test.ts`: the existing expectation `{ yes: true, writable: true }` becomes `{ yes: true, writable: true, cache: true }`; add a second case: `['Analytics', '--no-cache']` -> options `{ cache: false }` (commander sets `cache: true` by default for a `--no-` option; `yes`/`writable` are absent).
  - `tests/readme-contract.test.ts`: inside `documents the complete vendor-neutral database CLI and its safety model`, assert `guidance` contains `solidactions database pull analytics --no-cache`, `fetches only what changed`, `query the database directly`, `local analysis`, `reuse one copy` and `per test or per preview`.
- [ ] **Step 2: Expected RED:** the guidance module is missing; `cache: true` is absent on the base (the base option list has no `--no-cache`); the README lacks all five phrases.
- [ ] **Step 3: Implement.**
  - `src/utils/database-pull-guidance.ts` exports exactly the four names with the frozen strings (the help text as a template literal; no trailing spaces).
  - `src/index.ts`: import `DATABASE_PULL_HELP`; add `.option('--no-cache', ...)` to `database pull`; change the `addHelpText('after', ...)` argument to `` `${DATABASE_PULL_HELP}\n<the existing DuckDB paragraph, unchanged>` `` so the output is the new paragraphs, a blank line, then the unchanged DuckDB paragraph. Do not change the `.action` body.
  - `README.md`: add `solidactions database pull analytics --no-cache` under the existing `database pull analytics --writable` line, and after the code block one paragraph: `` `database pull` fetches only what changed since your last pull of the same database and keeps a hidden cache per database in `~/.solidactions/cache/database-replicas`; use `--no-cache` to skip it. Inside a workflow or function, query the database directly instead of pulling (`ctx.vars` with `createDatabaseClient`). Pull only for local analysis, keep and reuse one copy, and never pull per test or per preview. `` (The README test needs the exact words `fetches only what changed`, `query the database directly`, `local analysis`, `reuse one copy` and `per test or per preview`; PM ruling above.)
- [ ] **Step 4: Static checks:** `npm run build`; then `node dist/index.js database pull --help` is allowed (it runs no test): paste its output in the hand-back.
- [ ] **Step 5: Report (do not commit)**: changed paths, expected-RED table, the `--help` output, and this grep shown: `grep -rn "database pull" tests | grep -v "^tests/database-pull-guidance"` (so the manager sees every other test that quotes pull help).

The manager commits with `git add -- <paths>` then `git commit -m "docs(database): pull help, README, --no-cache flag (#262)" -- <paths>`.

---

---

### Task 4: Cached read-only pull, warning, one overwrite question, ADR (cli#262)

**Depends on:** Tasks 1, 2, 3 committed, the manager's one local probe run done (Task 1 Step 6) and the PM's ruling on ADR 0004 in hand. **Serves:** ask 1 (read-only path) and ask 2 (warning).

**Files (file scope):**
- Modify: `src/commands/database.ts` (new imports; `DatabasePullOptions`, `DatabaseCommandDependencies`, `ResolvedCommandDependencies` and `resolveDependencies` gain the fields below; `databasePullWithConfig` (lines 2375-2551) gets the warning call, the single overwrite confirmation and the cached branch, and loses the first statement of its uncached body (`:2413`); one new function `databaseCachedReadonlyPullWithConfig` placed directly above `databasePullWithConfig`; the public `databasePull` (lines 2899-2906) fills `replicaCacheRoot`)
- Create: `tests/database-pull-cache.test.ts`
- Create: `docs/decisions/0004-database-pull-cache-test-seams.md` (the ADR text of this plan's "ADR 0004" section, with the PM's ruling mail id in its header)

Not yours, never touch: `databaseWritablePullWithConfig` (Task 5 owns that function), `tests/database-pull-command.test.ts` and `tests/database-writable-pull-command.test.ts` (they must pass unchanged; read their harness for style), `tests/workspace-guard-write-exact.test.ts` and `tests/root-version-flag.test.ts` (they spawn the built CLI through `databasePull`; they get the default root under their temp `HOME` and need no edit), every file of Tasks 1-3 and 5.

**Interfaces:**
- Consumes: the frozen replica-cache contract (Task 2); `isInsideWorkflowRun`, `WORKFLOW_RUN_PULL_WARNING` from `database-pull-guidance.ts`; existing helpers in `database.ts` (`confirmFileOverwrite`, `reserveDestinationTemp`, `assertNoSymlinkComponents`, `lstatIfPresent`, `removeOwnedFiles`, `pullSidecars`, `anyPathExists`, `classifyPullFailure`, `loadDatabaseClientBeforeMint`, `requestDatabaseAccess`, `runDatabaseClientOperationWithDeadline`, `displayDestination`, `freshSafeFileError`, `PULL_ATTEMPTS`, `PULL_RETRY_BACKOFF_MS`, `resolveDatabaseDestination`, `safeDatabaseStem`).
- Produces (for Task 5), module-private in `database.ts` with exactly these semantics: `snapshotCacheReplica(io, createClient, cache, reservation): Promise<void>`, `publishSnapshot(io, temp, target, expected): Promise<void>`, `class ReplicaCacheFallback extends Error`, `cacheEligible(io, options): boolean`, `cacheSkipNote(reason): string | undefined`, `cacheIdentity(config, name, row, access): ReplicaCacheIdentity`, and the fields `DatabasePullOptions.cache?: boolean`, `DatabasePullOptions.skipWorkflowWarning?: boolean` (internal; no commander option), `DatabaseCommandDependencies.replicaCacheRoot?: string`, `DatabaseCommandDependencies.env?: NodeJS.ProcessEnv` (resolved: `env` defaults to `process.env`; `replicaCacheRoot` stays `string | undefined`).

**Behaviour (implement exactly):**
1. **Warning.** In `databasePullWithConfig`, after `refuseIfAnalyticalRow(...)` and before the `options.writable` branch, when `isInsideWorkflowRun(io.env)` and `options.skipWorkflowWarning !== true` call `io.stderr(WORKFLOW_RUN_PULL_WARNING)` once. The pull then proceeds. It applies to read-only and writable pulls and not to DuckDB-file pulls (they return earlier).
2. **One overwrite question (D8, review finding 5).** For the non-writable path, directly after the `options.writable` branch: `const target = resolveDatabaseDestination(...)` (moved up from the uncached body, same expression), then `if (!await confirmFileOverwrite(target, options, io)) return;`. The uncached body below uses that `target` and no longer calls `confirmFileOverwrite`. Everything before native loading (symlink refusal, `--yes`, non-interactive refusal, the prompt) behaves as today, once, whether or not the cache is used.
3. **Cache eligibility.** Cached only when `options.cache !== false` and `io.replicaCacheRoot` is a non-empty string. Otherwise the existing uncached code runs.
4. **`databaseCachedReadonlyPullWithConfig(name, target, config, io, row)`** returns `'handled'` or `'fallback'`, in order:
   1. `reserveDestinationTemp(io, target)` (keep the reservation handle OPEN until publication; no hand-off, no unlink) and the sidecar pre-check as today.
   2. **First mint before the cache** (review finding 1): `loadDatabaseClientBeforeMint(() => requestDatabaseAccess(config, name, 'read', requestDependencies(io)), { loadClient: io.loadClient })` for attempt 0; `origin = syncOriginOf(access.url)`.
   3. `acquireReplicaCache({ root, identity: { host: config.host, workspaceId: config.workspaceId, name, databaseId: row.id ?? null, createdAt: row.created_at ?? null, syncOrigin: origin }, now: io.now })`. `skipped` -> close and unlink the run's own reservation, write the stderr note (`busy`: `Another pull of this database is using the local cache; downloading a full copy instead.`; `rewritten_often`: `This database is replaced often, so its local cache is off for now; downloading a full copy.`; `unavailable`: no output) and return `'fallback'` (the uncached body mints again; one extra mint on a fallback is accepted).
   4. `ready`: the sync loop has the shape of the uncached loop with these differences only: the client `url` is `pathToFileURL(cache.replicaPath).href`; attempt 0 reuses the access from step 2, later attempts re-mint as the uncached loop does and, if a re-minted `syncOriginOf(access.url)` differs from `origin`, `await cache.wipe()` and go to the fallback below; the replica checks (`lstat` regular, no symlink) apply to `cache.replicaPath`. A `deterministic` failure while `cache.warm` was true at the start: `await cache.wipe()`, release, close and unlink the reservation, return `'fallback'` (silently; it consumes no attempt of the cached loop, the uncached path has its own `PULL_ATTEMPTS`). `credential_expiry` and `transient_transport` handling is identical to the uncached loop (backoff, one re-mint) and, when all attempts fail, release the cache, close and unlink the run's own reservation and throw the same `upstream_unavailable` error as today (I2: nothing published).
   5. Synced: close the sync client (as the loop does), then `snapshotCacheReplica(io, localCreateClient, cache, reservation)`: with the REAL local client (`createClient({ url: pathToFileURL(cache.replicaPath).href, intMode: 'string' })`, NO `syncUrl`, NO `authToken`) FIRST run `PRAGMA quick_check` on `cache.replicaPath` through that same real local client (anything but exactly one row whose first value is the string `ok` throws `ReplicaCacheFallback`; `VACUUM INTO` rebuilds indexes and the free list, so damage there never reaches the snapshot and only this check sees it: review N1); THEN run `VACUUM INTO '<cache.snapshotPath with each ' doubled>'` under `runDatabaseClientOperationWithDeadline(..., closeFn, io.dataPlaneTimeoutMs)`, close; open a second local client on `cache.snapshotPath` and run `PRAGMA quick_check`: the result must be exactly one row whose first value is the string `ok`, else throw `ReplicaCacheFallback` (review finding 3); close it. Then copy the snapshot's bytes into the STILL-OPEN reservation handle (`handle.truncate(0)`, read `cache.snapshotPath` through its own read handle in chunks, `handle.write` from position 0 in a loop that tolerates short writes, `handle.sync()`); verify `(await handle.stat()).size` equals the snapshot's size; record `expected = { dev, ino }` from `handle.stat()`; close the handle; `cache.discardSnapshot()`. Any failure here throws `ReplicaCacheFallback` (no unlink-then-create by path anywhere: review finding 12).
   6. `publishSnapshot(io, temp, target, expected)`: `assertNoSymlinkComponents(temp)`; `lstat(temp)` must be a regular file whose `dev` and `ino` equal `expected`, else throw `unsafe_destination` (`The database replica temporary path is unsafe.`); `removeOwnedFiles(pullSidecars(temp))` then `anyPathExists(pullSidecars(temp))` must be false; `chmod(temp, 0o444)`; `assertNoSymlinkComponents(target)`; `rename(temp, target)`. Then `cache.markSynced()` (only after a verified snapshot) and `io.stdout('Database replica saved to <displayDestination>.')` (identical to today).
   7. `finally`: `await cache.release()`.
   8. A `ReplicaCacheFallback` or `ReplicaCacheError` at steps 4-6 (before the `rename`): `cache.wipe()` best effort, remove the run's own temp (it is ours: `ownsTemp`) and sidecars, release, return `'fallback'`. A failure of the `rename` itself is not a fallback: it is the existing publish failure (`freshSafeFileError`), the cache stays warm. Anything else is the existing `freshSafeFileError` mapping.
5. **`databasePullWithConfig`:** `const handled = eligible ? await databaseCachedReadonlyPullWithConfig(...) : 'fallback'`; `if (handled === 'handled') return;` otherwise continue into the uncached body (so a fallback runs the old code exactly once, with its overwrite question already answered).
6. **`pullSidecars` is NOT changed** (measured: no `-info` file exists for this client; MEASURED block above).
7. **`databasePull`** (the public wrapper) passes `replicaCacheRoot: dependencies.replicaCacheRoot ?? defaultReplicaCacheRoot()` (D1). Nothing else fills it.
8. **ADR 0004** is created with the "ADR 0004" section's text.

- [ ] **Step 1: Write the failing tests** in `tests/database-pull-cache.test.ts`. Build the harness by copying the structure of `pullHarness` in `tests/database-pull-command.test.ts` (fake `post` answering `show` and `access`, real files under a temp root, `replicaCacheRoot: <temp root>/cache`, injected `now`, `sleep: async () => {}`, `env: {}`), plus the ADR 0004 call sites: `loadClient().createClient(config)` returns, for a config WITH `syncUrl`, a fake sync client whose `sync()` writes a REAL SQLite file at `fileURLToPath(config.url)` through the real `@libsql/client` (scenario rows via a mutable `serverRows` array) and also writes the measured companion file names (`-client_wal_index`, `-shm`, `-wal`), and for a config WITHOUT `syncUrl` returns the REAL `createClient` from `@libsql/client`. Read every table back through a real local client. Rows:
  1. `cold pull syncs into the cache replica, writes a standalone snapshot to the target, leaves exactly the target beside it` (I1): the sync client's `url` is under `<root>/cache/<key>/data/`; the target is a real SQLite file with the server's rows and mode `0o444`; the destination directory listing is exactly `[target basename]`.
  2. `warm pull syncs the same cache path again and a second target gets the new rows` (two sequential pulls, `serverRows` changed between): both sync `url`s are equal; second target's rows equal the second state; the first target is unchanged.
  3. `warm pull reflects remote inserts, updates and deletes` (three pulls through one cache; each target's rows equal that pull's server state) (Review Focus 1).
  4. `a failed warm sync never publishes the previous file` (I2): second pull's sync throws a `deterministic` error, the cache is wiped, the uncached path's sync throws too: the call rejects with `upstream_unavailable`, the existing target's bytes are unchanged, no temp remains.
  5. `a deterministic warm failure wipes the cache and the uncached path publishes` (the fallback's sync `url` is the sibling temp; target has the new rows; the next pull is cold-filled into an empty `data/`).
  6. `transient failures retry on the same cache path with backoff, and credential expiry re-mints exactly once` (mirror the existing two tests; every attempt's `url` is the cache path).
  7. `a live lock makes the pull uncached, says so on stderr, and asks the overwrite question once`: pre-create the lock with this process's pid and hostname; `isTTY: true`, an existing target, `confirm` a `vi.fn` returning true: `confirm` is called exactly once; the sync `url` is the sibling temp; the lock file is untouched (review finding 5).
  8. `a swapped server wipes the cache`: second `access` answer has the same `show` id and `created_at` but a different `url` host: the second sync's `data/` starts empty and `meta.json`'s replacements has one entry; three such swaps in a week then make the fourth pull uncached with the `rewritten_often` note (I6).
  9. `--no-cache (options.cache === false) never touches the cache root` (the root directory does not exist afterwards) and `no replicaCacheRoot means no cache` (dependency omitted: identical to the existing tests).
  10. `cache faults fall back to the uncached path` (table; each case ends with a correct target holding the server rows, sentinel and unrelated files intact, and no error text that mentions the cache) (I3): unwritable root (root's parent is a regular file); `data` is a symlink to an outside directory holding a sentinel file; corrupt `meta.json`; a REAL damaged replica (the cache `replica.db` overwritten with 4 KB of random bytes and the fake sync client succeeding without touching it, so `VACUUM INTO` fails); a real replica whose own `PRAGMA quick_check` is not `ok` (N1): write a table and an index through a real local client, close it, corrupt bytes of an index page in the file, and let the fake sync client succeed without touching it; the pull must fall back and publish a correct target. Build it deterministically (a page-size-aligned overwrite of a known index root page); if that cannot be made reliable, say so in the hand-back rather than faking the pragma.
  11. `the VACUUM target is inside the cache directory and the reserved temp is never unlinked` (record the statements the real client received through a thin recording wrapper around the real client, which is not a fake of behaviour: assert the `VACUUM INTO` path starts with `<root>/cache/<key>/`; assert the reserved temp's inode is the published target's inode).
  12. `a temp replaced by a symlink after the copy is refused and nothing is published` (target unchanged, an outside file untouched).
  13. `the workflow-run warning prints once for SOLIDACTIONS_RUN_ID and for STEPS_TRIGGER_ID, not for an empty env, on cached and uncached pulls, and the pull still succeeds`.
  14. `no credential reaches the cache directory` (I4: read every file under the root, assert the access-token and PAT sentinels do not occur).
  15. `no pull path leaves a companion file beside the target` (sweep: rows 1, 2, 5, 7, 9, 10 each list the destination directory and expect the pre-pull listing plus the target).
- [ ] **Step 2: Expected RED** (put each in the hand-back table): rows 1-8, 10-15 fail on the base because `replicaCacheRoot`/`env` are ignored (the sync `url` is never under `<root>/cache`, no snapshot occurs, no warning is printed, the overwrite question is asked by the uncached body); row 9 passes on the base for the trivial reason (it guards the new code from regressing the old behaviour; say so).
- [ ] **Step 3: Implement** per Behaviour. Keep the uncached body of `databasePullWithConfig` unchanged apart from the two D8 exceptions.
- [ ] **Step 4: Static checks:** `npm run build`. Then the greps shown in the report: `grep -n "pullSidecars" src/commands/database.ts`, `grep -rn "replicaCacheRoot\|DatabasePullOptions" src`, `grep -n "confirmFileOverwrite" src/commands/database.ts`.
- [ ] **Step 5: Report (do not commit)**: changed paths (source, test and ADR separately), the expected-RED table, `git diff --stat -- <your paths>` plus `wc -l tests/database-pull-cache.test.ts`, the three greps.

The manager commits with `git add -- <paths>` then `git commit -m "feat(database): pull fetches only changes through a hidden cache replica (#262)" -- <paths>`.

---

### Task 5: Cached writable pull (cli#262)

**Depends on:** Task 4 committed. **Serves:** ask 1's second function (PM-ruled: keep, mail 49ba2fe2).

**Files (file scope):**
- Modify: `src/commands/database.ts` (only `databaseWritablePullWithConfig`, lines 2043-2373, and the call to it in `databasePullWithConfig`, line 2399, to pass the record)
- Create: `tests/database-writable-pull-cache.test.ts`

Not yours, never touch: every other function in `database.ts`, `tests/database-writable-pull-command.test.ts` (must pass unchanged), every file of Tasks 1-4.

**Interfaces:**
- Consumes: Task 4's `snapshotCacheReplica`, `publishSnapshot`, `ReplicaCacheFallback`, `cacheEligible`, `cacheSkipNote`, `cacheIdentity`, the replica-cache contract and the `cache` option.
- Produces: nothing for other tasks.

**Behaviour (implement exactly):**
1. `databaseWritablePullWithConfig` gains an optional last parameter `row` (the record). When the cache is eligible (`cacheEligible`) it must know the sync origin before acquiring: mint the first write access with `loadDatabaseClientBeforeMint(..., 'write', ...)` exactly as `openAttachedClient(true)` does today, then `acquireReplicaCache` with `cacheIdentity(config, name, row, access)`. A `skipped` outcome writes `cacheSkipNote(reason)` to stderr (when defined) and continues with today's code path unchanged (the already minted access is simply not reused; one extra mint is accepted, as in Task 4).
2. With a cache the writable session's libSQL client `url` (initial and every renewal reopen in `openAttachedClient`) is `pathToFileURL(cache.replicaPath).href`. The reservation of the sibling `temp` is kept (handle open, not handed off) for publication. **The replica-path rule with a cache (review finding 8b):** at the initial open `cache.replicaPath` is either absent (cold) or a regular, non-symlink file (warm), and a warm file is NOT `unsafe_destination`; at renewal reopens it must be a regular, non-symlink file. The existing `(initial && beforeCreate !== null)` refusal and its twin apply to `temp` only when no cache is in use.
3. A failed initial `sync()` of a warm cache: `await cache.wipe()` and reopen the session cold once; a second failure is the existing `upstream_unavailable`. An identity or origin change at a renewal re-mint (`syncOriginOf(access.url)` differs from the acquired origin) ends the session as a renewal failure with the last valid state published (existing `WritableRenewalAttemptError` semantics).
4. **Publication and fallback (review finding 8a):** after `closeAttachedClient()`, `snapshotCacheReplica` then `publishSnapshot` as in Task 4 (copy into the reservation handle, quick_check, rename), then `cache.markSynced()`. If the snapshot, copy or `quick_check` fails (`ReplicaCacheFallback`): the session's writes are already on the server (`readYourWrites: true, offline: false`, `:2131-2138`), so replay nothing: wipe the cache, close and unlink the run's own reservation, write the stderr line `The live session's writes are saved. Publishing a read-only copy instead.`, and publish through the existing uncached read-only pull by calling `databasePullWithConfig(name, destination, { yes: true, cache: false, skipWorkflowWarning: true }, config, io)` (`skipWorkflowWarning` is a new internal-only boolean on `DatabasePullOptions` that Task 4 adds and Task 4's Behaviour 1 honours: when true the workflow-run warning is not printed again; commander never sets it, so no CLI flag exists; the overwrite was already confirmed once; `io` is the resolved dependency object, which satisfies `DatabaseCommandDependencies`; if the types disagree, write the narrowest cast with a comment). If that also fails, the error is the existing `upstream_unavailable`; a `sessionFailure` already recorded is still thrown after the publish, as today. The `publishAfterFailure` and `sessionFailure` semantics are otherwise unchanged (a last-valid publish still publishes, through the snapshot).
5. The lock is held for the whole session and released in the outer `finally` on every exit (normal, error, abort). Another pull meanwhile gets `busy` and runs uncached.
6. `--no-cache` and an omitted root leave the function exactly as it is today.

- [ ] **Step 1: Write the failing tests** in `tests/database-writable-pull-cache.test.ts` (the harness style of `tests/database-writable-pull-command.test.ts`; `replicaCacheRoot` set; the ADR 0004 stand-ins; real local client for every snapshot step). Rows:
  1. `writable session syncs, renews and writes through the cache replica path` (initial and renewal client `url`s equal `cache.replicaPath`; two renewals use the same path).
  2. `a warm cache opens a normal writable session` (second session over the same cache: no `unsafe_destination`, the sync `url` equals the first session's).
  3. `the published target is a standalone snapshot with no companions beside it` (I1).
  4. `a live lock makes the writable session uncached with the stderr note, and the session still works`.
  5. `a warm cache whose initial sync fails is wiped and reopened cold once`.
  6. `a snapshot failure wipes the cache, replays no input, says the writes are saved, and publishes a read-only copy` (assert the number of statements executed on the write client is unchanged and the target holds the server rows; a second row: the read-only publish also fails: `upstream_unavailable`) (I3 for writable).
  7. `abort publishes the last valid state through the snapshot and releases the lock`; `an error mid-session releases the lock` (the lock file is gone after each).
  8. `a renewal re-mint with a different sync origin ends the session and publishes the last valid state`.
  9. `no credential reaches the cache directory (write token and PAT sentinels)`.
  10. `--no-cache and an omitted root leave the existing flow` (root absent afterwards).
- [ ] **Step 2: Expected RED:** on the base the `url` is the sibling temp and no snapshot occurs (rows 1-8 fail on those assertions); row 10 passes on the base (guard; say so).
- [ ] **Step 3: Implement** per Behaviour with the smallest diff: introduce one local `const replicaPath = cache?.replicaPath ?? temp!` and use it where `temp!` is the libSQL `url` and the renewal checks; branch only at the initial-open rule, the hand-off and publication.
- [ ] **Step 4: Static checks:** `npm run build`; `grep -n "temp!" src/commands/database.ts | sed -n 1,50p` shown in the report so the manager can confirm no replica use of `temp` was missed.
- [ ] **Step 5: Report (do not commit)**: changed paths, expected-RED table, `git diff --stat -- <your paths>` and `wc -l` of the new test file.

The manager commits with `git add -- <paths>` then `git commit -m "feat(database): writable pull uses the cache replica (#262)" -- <paths>`.

---

## Self-Review

1. **Spec coverage:** incremental pull + hidden cache per database (Tasks 2, 4, 5); copy to the user's file after `sync()` and never a live replica (Task 4 snapshot + `publishSnapshot`, I1); fall back when missing/corrupt/replaced (Task 2 identity incl. sync origin, Task 4 fault table, `quick_check`, deterministic-failure wipe); skip for databases rewritten often (D3, Task 2 rows 6-7, Task 4 row 8); "first verify whether a retry restarts from zero" (Task 1 information row (e)); help text (Task 3); warning inside a workflow run (Task 3 constant, Task 4 call, test row 13); PM docs ruling (Task 3). Every issue-ask has a task. Review findings 1-8 and minors 9-12, 14, 15 are answered where the "Plan review" bullet says; 13 is FILE.
2. **Placeholder scan:** none; test rows give inputs and assertions, the developer writes the test code in the file style of the named harness. The one deliberate open item is the PM's ruling on ADR 0004 (Task 4 cannot be dispatched without it) and the companion names the manager's local probe run supplies to the Task 4 brief.
3. **Type consistency:** `ReplicaCache` (with `snapshotPath`, `discardSnapshot`), `ReplicaCacheOutcome`, `ReplicaCacheIdentity` (with `syncOrigin`), `acquireReplicaCache`, `syncOriginOf`, `isInsideWorkflowRun`, `WORKFLOW_RUN_PULL_WARNING`, `DATABASE_PULL_HELP`, `replicaCacheRoot`, `env`, `cache`, `snapshotCacheReplica`, `publishSnapshot`, `ReplicaCacheFallback`, `cacheEligible`, `cacheSkipNote`, `cacheIdentity` are spelled the same in every task. Task 5 consumes Task 4's private helpers (Task 5 depends on 4).
4. **Review Focus** lines each have an owning test (see the list above).
5. **File scope and shop rules:** each task has an exhaustive Files block (tests included), no commit/stash/worktree step, no local test `Run:` line (static checks only; tests in CI per the Speed rules), each task stands alone with its contract quoted. `src/commands/database.ts` is in Tasks 4 and 5 (serial, stated in both). `tests/database-file-command-actions.test.ts` and `tests/readme-contract.test.ts` are in Task 3 only. `tests/database-native-ci-contract.test.ts` and `.github/workflows/check.yml` are in Task 1 only. The ADR is in Task 4 only. The only `docker` use is the manager's one PM-approved probe run (Task 1 Step 6), not a test suite.
6. **Premises to probe:** (a) warm `sync()` is incremental after the CLI's own local open and VACUUM, (b) a snapshot holds the same content as the server after insert, update and delete, (c) the real companion names and replica mode, (d) what a warm sync does with missing metadata, a truncated file, or a different server, (e) retry from zero: all measured by Task 1 in the PR's `check.yml` and in the manager's one local run before Task 4 is written. The design is built so a wrong premise only makes a pull slower, never wrong: the cache identity (D3) decides replaced-server before any sync, `quick_check` and the fallback (D5) catch a damaged replica, and the lock (D4) prevents concurrent writers. A red hard assertion in the local run (warm not cheaper, a digest mismatch) stops the wave at the build card.
7. **Open decisions for the PM (mailed with this revision):** the ruling on ADR 0004's call sites; how the verify smoke may read the host's per-database usage for the byte measurement (or confirmation that "not measured" plus Task 1's numbers is acceptable); an owner for the agent skill and site-docs mentions in Peter's docs list.

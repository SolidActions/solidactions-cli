# CLI database pull: fetch only changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sa-subagent-driven-development to implement this plan task-by-task (the wave's build step). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `solidactions database pull` downloads only what changed since the last pull of the same database (a hidden per-database cache replica), never makes the user's file a live replica, and its help text, README and a run-time warning steer people away from pulling per run, per test or per preview.

**Architecture:** One new helper module (`src/utils/database-replica-cache.ts`) owns the cache directory, its lock, its metadata and the "skip the cache" rules; it knows nothing about libSQL. `src/commands/database.ts` gains a cached read-only path and a cached writable path: the libSQL client syncs into the cache replica (warm = incremental), then the CLI writes a standalone single-file snapshot of the cache into the reserved sibling temp with `VACUUM INTO` (opened through a local client with no `syncUrl`) and publishes it with the existing rename. The existing uncached path stays byte-for-byte as it is and is used for `--no-cache`, for a busy or skipped cache, and as the fallback whenever the cache misbehaves. Help text and the workflow-run warning live in a second small module so a docs-only task can run in parallel.

**Tech Stack:** TypeScript, `@libsql/client` 0.17.4 (native `libsql` 0.5.29, Rust libsql 0.9.30), commander, vitest (CI only), Node ESM probe script run by `check.yml` against a real libsql-server service.

**Spec:** none (no design file; the design is this plan's Architecture plus the Design rulings below). The app half is `SolidActions/solidactions-app#2840` (read only, meter and alarms and docs).

**Issues:** `cli#262` ("database pull: fetch only changes (hidden cache replica) and steer users away from pulling per run"), sanctioned by Peter's go 2026-11-17 recorded on the issue ("Companion to the app issue for the 2026-11-17 database-pull incident (Peter's go 2026-11-17, Fable review accepted)") and the wave's approval ask `task-startdatabase-064f`. The issue has no comments (read with `gh api --paginate repos/SolidActions/solidactions-cli/issues/262/comments`, empty; `scripts/issue` does not exist in the CLI repo). The wave card is `task-waveclidatabase-fda7`; the plan card is `task-planclidbpull-12eb`.

## Global Constraints

- **The ask, verbatim (cli#262 body):**
  1. "**Incremental pull:** today `databasePullWithConfig` (src/commands/database.ts:2261) and `databaseWritablePullWithConfig` (:1929) build a fresh temp replica every time (`syncUrl` at :2347 / :2019), so every pull, and every retry, is a full download. Keep a hidden cache replica (with its sync metadata) per database and copy it to the user's file after `sync()`; never make the user's file a live replica. Fall back to a full pull when the cache is missing or corrupt, or the server copy was replaced. Skip the cache for databases that are rewritten often. First verify whether a retry really restarts from zero."
  2. "**Help text:** `database pull` help says to query directly in workflows and functions, pull only for local analysis, and reuse one copy; warn when pull runs inside a workflow run."
  (Line numbers in the quote are the issue's; on this tree the functions are `databasePullWithConfig` at `src/commands/database.ts:2375` and `databaseWritablePullWithConfig` at `:2043`.)
- **PM ruling on docs scope (chief, mail 1f778898-b38e-4ce2-a927-e9dd19f639b1, 2026-11-18), verbatim:** "Ruling for cli#262: besides pull --help, the CLI README's database pull section carries the same guidance (query directly in workflows/functions, pull only for local analysis, reuse one copy, never per test or preview). The app wave covers workflows_guide." Mapping: `DATABASE_PULL_HELP` (Task 3) carries all four points for `--help`; the README paragraph (Task 3) carries the same four; no other surface (the workflows guide is the app wave's).
- **Premises, each quoted from this tree (verified 2026-11-18):**
  - A new temp replica per pull: the default `tempPath` is `path.join(path.dirname(target), '.' + path.basename(target) + '.solidactions-' + randomUUID() + '.tmp')` (written there as a template literal) (`src/commands/database.ts:242-245`). Every pull syncs into a never-seen path, so every pull is a full download.
  - A retry inside one pull reuses the same temp path: the loop at `src/commands/database.ts:2432` (`for (let attempt = 0; attempt < PULL_ATTEMPTS; attempt += 1)`, `PULL_ATTEMPTS = 3` at `:849`) calls `createClient({ url: pathToFileURL(temp).href, syncUrl: access.url, ... })` with the same `temp` each attempt, and the failed attempt keeps its partial file (`if (replicaStat?.isFile()) ownsTemp = true;` at `:2512`; test `hands the exclusive reservation to native creation once, then preserves the partial replica for retry`, `tests/database-pull-command.test.ts:524`). Whether the native client resumes from that partial file or starts from zero is NOT knowable from this tree; Task 1 measures it in CI (the issue's "first verify"). The design does not depend on the answer.
  - The native binary's strings name the replica's metadata file and its failure modes: `-info`, `db file exists but metadata file does not`, `metadata file exists but db file does not`, `server returned a lower generation than what we have: local=, remote=`, `syncing db file from remote server, generation=` (strings of `node_modules/@libsql/linux-x64-gnu/*.node`, libsql 0.9.30). So: the metadata file is `<replica>-info`; a missing or mismatched `-info` is an error, not a silent full resync; a replaced server copy with a lower generation is an error; a higher generation re-downloads by itself.
  - `pullSidecars` removes only four names: `return [temp-wal, temp-shm, temp-journal, temp-client_wal_index]` (each a template literal on `temp`) (`src/commands/database.ts:997-999`). `-info` is not in it, so today's uncached pull probably leaves `.<name>.solidactions-<uuid>.tmp-info` next to the user's file after every pull. Task 1 prints the real companion names in CI; Task 4 adds `-info` to `pullSidecars` either way (removing a missing file is best effort).
  - `finalizeReplica` cannot publish a `VACUUM INTO` snapshot: `validateCheckpointResult` throws when `checkpointed < log` and `checkpointInteger` rejects negatives (`src/commands/database.ts:1049-1076`), and `PRAGMA wal_checkpoint(TRUNCATE)` on a non-WAL file answers `0, -1, -1`. The snapshot path therefore has its own `publishSnapshot`, it does not call `finalizeReplica`.
  - The libSQL client type: `interface DatabaseClient { execute; executeMultiple?; sync?: () => Promise<unknown>; close; ... }` (`src/utils/database-data-plane.ts:79-85`). `sync()` of `@libsql/client` returns `{ frames_synced, duration_ms }` (`node_modules/@libsql/client/lib-cjs/sqlite3.js:195-199`); the CLI ignores the value today and keeps ignoring it.
  - A workflow run's env carries `SOLIDACTIONS_RUN_ID` and `STEPS_TRIGGER_ID` (`solidactions-app/app/Services/RuntimeEnvBuilder.php:70-72`: `'STEPS_TRIGGER_ID' => (string) $trigger->id, 'SOLIDACTIONS_RUN_ID' => $trigger->run_uuid,`). A developer's shell never sets them. The warning keys on either.
  - The DB-record row `database pull` already fetches (`requestDatabaseRecord` at `src/commands/database.ts:2387`) has optional `id` and `created_at` (`stableDatabaseRecord`, `src/commands/database.ts:306-362`); both are the cache's "was the server copy replaced" identity when present.
  - Existing tests that exercise pull never pass a cache root, so the cache is off in all of them by construction (Design ruling D1). They must stay green unchanged except the two named below.
- **Design rulings (mine, recorded here; each with its cost if wrong):**
  - **D1: the cache root is a dependency that is `undefined` by default inside `databasePullWithConfig`, and only the public wrapper `databasePull` fills it with the real default (`~/.solidactions/cache/database-replicas`).** Cost if wrong: an existing test would write into a real home directory in CI; this ordering makes that impossible.
  - **D2: cache key** = first 32 hex chars of `sha256(JSON.stringify([host, workspaceId, databaseName]))`; layout `<root>/<key>/{lock,meta.json,data/}`; the libSQL replica is `<root>/<key>/data/replica.db` and everything libSQL creates lives only under `data/` (the CLI never lists or names its companions there; "wipe" removes `data/` whole). Cost if wrong: a collision shares a replica between two databases; 128 bits makes that negligible.
  - **D3: "rewritten often" is measured, not guessed:** every time the stored identity (`databaseId`, `createdAt`) no longer matches the server row, the cache is wiped and a replacement timestamp is recorded; 3 replacements inside 7 days switch the cache off for that database for 7 days (`skipUntil` in `meta.json`). Cost if wrong: a database that is replaced less often than that keeps a cache that is wiped each time (a normal full pull, no harm); a database replaced on a faster schedule than the threshold costs two wasted cold fills.
  - **D4: a lock held by a live pid is never stolen** (the pull then runs uncached and says so on stderr); a lock whose pid is dead is reclaimed; an unreadable lock is reclaimed only when older than 1 hour. Cost if wrong: pid reuse makes one pull skip the cache (slow, never wrong).
  - **D5: the cache is an optimisation and can never fail a pull the uncached path would pass (invariant I3).** Every cache problem (cannot create the directory, read-only home, corrupt `meta.json`, snapshot error) wipes the cache if it can and runs the existing uncached path, once.
  - **D6: `--no-cache` is added (commander `--no-cache`, option `cache: false`)** as the user's off switch: it neither reads nor writes the cache. There is no cache-clear command; the help text names the directory so it can be deleted by hand. Cost if wrong: one extra flag; the issue did not ask for it, so this is the only part of the plan the PM may cut at plan-check (Task 3 and Task 4 each carry two lines for it).
  - **D7: no size cap.** The cache doubles the disk use of one database (cache plus the user's file); the help text says so. Cost if wrong: a very large database fills a disk twice as fast; `--no-cache` avoids it.
  - **D8: the cached read-only path is a new function; the existing uncached body is not edited** (except adding `-info` to `pullSidecars`). Cost if wrong: about 60 duplicated lines; benefit: the 12 existing pull tests cannot regress.
- **Invariants (must never happen), every route to each, and the sweep:**
  - **I1: the user's file is never a live replica.** It is never opened with a `syncUrl`; it is a `VACUUM INTO` product (a standalone single file) or, on the uncached path, today's checkpointed replica; its `-info` is never beside it after a successful pull. Routes: cached read-only, cached writable, uncached (unchanged). Sweep: Task 4's test `no pull path leaves a companion file next to the target` lists the destination directory after every scenario in Tasks 4 and 5 and expects exactly the target file (plus pre-existing unrelated files).
  - **I2: a stale copy is never published after a failed sync.** The bytes published come only from a replica whose `sync()` succeeded in this invocation. Routes: warm sync fails then retries fail; warm sync fails deterministically then the cold retry fails; the cold retry succeeds (publish the cold copy, fine); a stalled sync hits the data-plane deadline. Sweep: Task 4's test `a failed warm sync never publishes the previous file`.
  - **I3: the cache never fails a pull the uncached path would pass** (D5). Routes: unwritable root, `data` replaced by a symlink, corrupt `meta.json`, live lock, `VACUUM INTO` throws, `rename` of snapshot fails (that one is a real publish failure and fails as today). Sweep: Task 4's `cache faults fall back to the uncached path` table test.
  - **I4: no credential is ever written into the cache directory or its `meta.json`.** The token lives only in the client config object. Sweep: Task 2's test greps every file under a populated cache root for the sentinel token and Task 4's tests do the same after a pull.
  - **I5: a live lock is never stolen and a cache directory is never touched without its lock** (D4). Sweep: Task 2.

### Destructive paths (this wave writes and deletes files)

| Operation | What it removes or replaces | Proof the run owns it | Final-type recheck / no-clobber | Tests |
|---|---|---|---|---|
| Wipe the cache (`data/` removal) | `<root>/<key>/data` and everything under it | The path is built by the module from the hashed key; the module holds that key's lock; `lstat(data)` must be a real directory (not a symlink) or the wipe refuses and the cache is skipped | n/a (cache-owned) | Task 2: symlinked `data` is refused and its target survives; a sibling key directory survives |
| Lock create / remove | `<root>/<key>/lock` | Created with `O_EXCL` (`wx`); removed only when its stored `nonce` equals this run's | A lock written by another run is never unlinked | Task 2: foreign nonce survives `release()` |
| `meta.json` write | `<root>/<key>/meta.json` | Written under the lock to `meta.json.<nonce>.tmp` then `rename` | Atomic replace of a cache-owned file | Task 2: crash between write and rename leaves the old meta usable |
| Snapshot into the reserved temp | the sibling temp reserved by `reserveDestinationTemp` (`wx`, mode 0600) | Existing: the run created it and unlinks it at hand-off (`handoffReplicaReservation`); `VACUUM INTO` itself refuses an existing non-empty path | After the snapshot: `assertNoSymlinkComponents(temp)` and `lstat` must be a regular file; no `-wal`/`-shm`/`-journal`/`-info` beside it | Task 4: temp replaced by a symlink before the snapshot is refused and nothing is published |
| Publish | the user's target | Unchanged: `confirmFileOverwrite` (`--yes` or confirmation) then `rename(temp, target)` after `assertNoSymlinkComponents(target)` | Unchanged | Existing tests plus Task 4 |
| Failure cleanup | the run's own temp and sidecars | Existing `ownsTemp` / `ownsSidecars` flags | Existing | Existing plus Task 4 |

Failure boundaries (disk and metadata state after each):

| Boundary | State after |
|---|---|
| Cache cannot be created / locked | nothing written (or only the empty root); uncached path runs |
| `sync()` fails (all attempts) | cache `data/` kept (a resumable partial or a warm replica), `meta.json` not updated, target untouched, error as today |
| Warm sync fails with a non-transient error | `data/` wiped, one cold attempt in the same invocation; if it fails too, as the row above |
| Snapshot fails | `data/` wiped, temp removed, uncached path runs once |
| Publish (`rename`) fails | temp removed (existing), cache stays warm and correct, target untouched |
| Interrupted (Ctrl-C) mid-sync | lock removed by the `finally`; a hard kill leaves the lock with a dead pid, reclaimed next time (D4); the partial `data/` is handled by the "metadata file does not exist" error path = wipe + cold |
| Interrupted during recovery (wipe) | `data/` half removed; next acquire finds no `replica.db` or an inconsistent one; sync error = wipe + cold again |

A forward-only design (stop at the first error, keep what was written) cannot meet the issue because the issue requires falling back to a full pull when the cache is corrupt or the server copy was replaced; the fallback is wipe-then-cold, which only ever deletes cache-owned data.

Secret-bearing host paths this plan's code reads: none (the cache root is under the user's home and holds no credential; I4).

Verify data: smoke and cleanroom run the CLI built from the branch against a free app slot's stack (`sa-dev-<slot>`, never the main checkout's, role override). Seed with the CLI: `solidactions database create pullcache --json`, then `solidactions database exec pullcache "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)" --yes --json` and an insert loop of about 20000 rows (`INSERT ... SELECT` from a recursive CTE) so a full download is visibly larger than a delta. Credentials: the slot's PAT through the CLI's normal login/config (`HOME` set to a scratch directory so the real `~/.solidactions/cache` is never touched and the cache is inspectable). Smoke cases (Task list in the verify card): cold pull; second pull after one remote `INSERT` shows the new row and is much faster and the stack's server-side transfer for it is small (read the stack's request log for the sync route bytes, not the CLI); `--no-cache`; truncate `replica.db` in the cache then pull (still correct); delete and recreate the database under the same name then pull (no old rows); hold the lock with a live pid then pull (stderr note, correct file); `HOME` read-only (still correct); run the CLI with `SOLIDACTIONS_RUN_ID=x` set (warning printed). A path the dev stack cannot reach: the supplier's real sync allowance and meter (app#2840) cannot be exercised; the byte measurement uses the dev stack's own sync endpoint.

## Review Focus

1. **Stale data**: a warm pull after remote inserts, updates and deletes must show exactly the server's current rows, never the previous pull's (Task 4 test `warm pull reflects remote changes through the snapshot`, Task 1 probe row count).
2. **Two pulls of one database at once** (two terminals, or a watch script): the second must not corrupt the first's cache or file; it runs uncached and says so (Task 2 lock tests, Task 4 `a live lock makes the pull uncached`).
3. **A damaged cache** (truncated `replica.db`, missing `-info`, garbage `meta.json`, an empty directory): still a correct file, slower (Task 4 fault table).
4. **A database deleted and recreated under the same name** (a nightly rebuild): no old rows, and after 3 replacements in 7 days the cache switches itself off (Task 2 identity and skip tests, Task 4 `a replaced database wipes the cache`).
5. **A home directory that is read-only, full or on a different drive** (CI containers, `HOME=/nonexistent`): the pull still works uncached and never prints a cache error (Task 2 `unavailable`, Task 4 fault table).

## Open PRs touching these files

`gh pr list --repo SolidActions/solidactions-cli --state open` printed nothing at plan time (2026-11-18): no merge-order question. Callers and test doubles of the changed symbols (`grep -rlE "databasePull|databasePullWithConfig|pullSidecars|DatabasePullOptions|tempPath" src tests scripts`): `src/commands/database.ts`, `src/index.ts`, `src/utils/secure-write.ts` (unrelated `tempPath` word), `tests/database-duckdb-file.test.ts`, `tests/database-dump-command.test.ts`, `tests/database-file-command-actions.test.ts`, `tests/database-pull-command.test.ts`, `tests/database-sqlite-only-guards.test.ts`, `tests/database-writable-pull-command.test.ts`, `tests/secure-write.test.ts`.

## Task graph and file scopes

| Task | Issue | Depends on | Files (exclusive) |
|---|---|---|---|
| 1 | cli#262 (first verify) | none | `scripts/probe-database-replica-cache.mjs`, `.github/workflows/check.yml`, `tests/database-replica-cache-probe.test.ts`, `tests/database-native-ci-contract.test.ts` |
| 2 | cli#262 | none | `src/utils/database-replica-cache.ts`, `tests/database-replica-cache.test.ts` |
| 3 | cli#262 | none | `src/utils/database-pull-guidance.ts`, `src/index.ts`, `README.md`, `tests/database-pull-guidance.test.ts`, `tests/database-file-command-actions.test.ts`, `tests/readme-contract.test.ts` |
| 4 | cli#262 | 1, 2, 3 | `src/commands/database.ts`, `tests/database-pull-cache.test.ts` |
| 5 | cli#262 | 4 | `src/commands/database.ts`, `tests/database-writable-pull-cache.test.ts` |

Tasks 1, 2 and 3 run in parallel (disjoint scopes, no shared interface beyond the frozen contract below). Tasks 4 and 5 share `src/commands/database.ts` and are serial. Each task stays under about 1000 formatted diff lines (estimates: 1: 250, 2: 450, 3: 200, 4: 600, 5: 350).

**Local checks for every task (no test runs on this box):** `npm run build` (runs `tsc`) is the type check; the repo has no eslint or prettier config, so "format" means following the surrounding file's 4-space style. Tests run in the PR's `check.yml` only. Each developer hand-back has the expected-RED table (test, the assertion that fails on the base, why).

### Frozen contract (quoted verbatim by Tasks 2, 3, 4, 5)

`src/utils/database-replica-cache.ts` (Task 2 owns; Tasks 4 and 5 consume):

```ts
import fs from 'fs';

export const REPLICA_CACHE_REPLACEMENT_LIMIT = 3;
export const REPLICA_CACHE_REPLACEMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const REPLICA_CACHE_SKIP_MS = 7 * 24 * 60 * 60 * 1000;
export const REPLICA_CACHE_STALE_LOCK_MS = 60 * 60 * 1000;

export interface ReplicaCacheIdentity {
    host: string;
    workspaceId: string;
    name: string;
    /** `row.id` of the database record, or null when the record has none. */
    databaseId: string | null;
    /** `row.created_at` of the database record, or null when the record has none. */
    createdAt: string | null;
}

export interface ReplicaCache {
    /** `<root>/<key>/data/replica.db`; the only path the libSQL client is given. `data/` exists. */
    readonly replicaPath: string;
    /** True when `replicaPath` existed when the cache was acquired. */
    readonly warm: boolean;
    /** Remove `data/` whole and recreate it empty; after this `warm` reads false. Throws nothing the caller must handle except `ReplicaCacheError`. */
    wipe(): Promise<void>;
    /** Record a successful sync in `meta.json` (identity, `lastSyncedAt`). Never stores a credential. */
    markSynced(): Promise<void>;
    /** Remove the lock if it is still ours. Idempotent; never throws. */
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

/** Never throws for a cache problem: it answers `skipped` instead. */
export function acquireReplicaCache(options: {
    root: string;
    identity: ReplicaCacheIdentity;
    now: () => number;
    filesystem?: typeof fs.promises;
    pid?: number;
    processAlive?: (pid: number) => boolean;
}): Promise<ReplicaCacheOutcome>;
```

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

### Task 1: Real-server probe: warm sync is incremental, snapshot works, retry measured (cli#262, "first verify")

**Depends on:** none. **Serves:** the issue's "First verify whether a retry really restarts from zero" and the premises Tasks 4-5 rest on (a warm `sync()` downloads only changes; `VACUUM INTO` through a no-`syncUrl` client yields a correct standalone file; the companion file names).

**Files (file scope; the only paths this task may touch):**
- Create: `scripts/probe-database-replica-cache.mjs`
- Create: `tests/database-replica-cache-probe.test.ts`
- Modify: `.github/workflows/check.yml` (job `database-client-remote-sync`, add one step after the existing `node scripts/probe-database-client-sync.mjs` step; lines 52-66)
- Modify: `tests/database-native-ci-contract.test.ts` (the `database-client-remote-sync` job test, lines 60-72: add one `toContain`)

Not yours, never touch: every file of Tasks 2-5 above.

**Interfaces:**
- Consumes: the libsql-server service the job already starts at `http://127.0.0.1:8080` (`SOLIDACTIONS_DATABASE_SYNC_URL`); the same `import('@libsql/client')` the existing probe uses; `runRemoteSyncProbe` in `scripts/probe-database-client-sync.mjs` as the style model (exported function plus a direct-run guard at the bottom).
- Produces: `export async function runReplicaCacheProbe({ createClient, remoteUrl, directory, startProxy })` that throws on a failed assertion and returns `{ coldBytes, warmBytes, companions, snapshotRows, retry }` (pure data, printed by the direct runner); `export function assertWarmCheaper(coldBytes, warmBytes)` (throws unless `warmBytes * 4 < coldBytes`); `export function describeCompanions(names)` (returns the sorted names that start with `replica.db`, minus `replica.db` itself).

- [ ] **Step 1: Write the failing test** `tests/database-replica-cache-probe.test.ts`, in the style of `tests/database-remote-sync-probe.test.ts`: load the module by `pathToFileURL`, then
  - `assertWarmCheaper(1_000_000, 200_000)` does not throw; `assertWarmCheaper(1_000_000, 300_000)` throws (message contains `warm sync`); `assertWarmCheaper(0, 0)` throws.
  - `describeCompanions(['replica.db', 'replica.db-wal', 'replica.db-info', 'other'])` equals `['replica.db-info', 'replica.db-wal']`.
  - `runReplicaCacheProbe` with a fake `createClient` and a fake `startProxy` (`async () => ({ url, bytes: () => number, failNextAfter: (n) => void, close: async () => {} })`) runs the sequence `seed remote -> cold sync (proxy bytes) -> insert one remote row -> warm sync -> snapshot` and the fake's recorded events equal, in order, `['remote:seed', 'replica:cold-sync', 'remote:insert', 'replica:warm-sync', 'snapshot:vacuum-into', 'snapshot:count']`; the snapshot statement the fake sees is `VACUUM INTO '<directory>/snapshot.db'` (a `'` in the path doubled).
- [ ] **Step 2: Record the expected failure** (module does not exist). Expected: import error. No local run; the expected-RED row goes in your hand-back.
- [ ] **Step 3: Implement `scripts/probe-database-replica-cache.mjs`.** Steps inside `runReplicaCacheProbe`:
  1. Start a counting HTTP proxy to `remoteUrl` (`startProxy`, default implementation with `node:http`: forwards method, path, headers and body, counts response body bytes, and `failNextAfter(n)` makes the next response destroy the client socket after `n` bytes). The replica's `syncUrl` is the proxy URL.
  2. Seed the remote through a direct client (no proxy): `CREATE TABLE IF NOT EXISTS replica_probe (id INTEGER PRIMARY KEY, pad TEXT NOT NULL)`; `DELETE FROM replica_probe`; insert 3000 rows with a 1 KB `pad` each (about 3 MB), in one batch.
  3. Cold: `createClient({ url: file URL of <directory>/cache/replica.db, syncUrl: proxyUrl, intMode: 'string' })`, `await sync()`, close; `coldBytes = proxy.bytes()`; reset the counter; `companions = describeCompanions(readdir(<directory>/cache))`; print them (`console.log('replica companions: ...')`).
  4. Insert one more row remotely, then WARM: a NEW client on the SAME path, `sync()`, close; `warmBytes = proxy.bytes()`; `assertWarmCheaper(coldBytes, warmBytes)`; reopen with NO `syncUrl` and assert `SELECT count(*) FROM replica_probe` is `3001`.
  5. Snapshot: a local client on the cache replica (no `syncUrl`), `execute("VACUUM INTO '<directory>/snapshot.db'")`, close; open `snapshot.db` with a local client and assert the same count `3001`; assert `readdir(<directory>)` has `snapshot.db` and none of `snapshot.db-wal`, `snapshot.db-shm`, `snapshot.db-journal`, `snapshot.db-info`; print `PRAGMA journal_mode` of the snapshot (information only).
  6. Retry (information only, never an assertion): a fresh path `<directory>/retry/replica.db`; `proxy.failNextAfter(Math.floor(coldBytes / 2))`; `sync()` expected to throw (catch it; record `failed: true`); then the same path again with a new client: `sync()`, record `retryBytes = proxy.bytes()` and print `retry after a half-way failure downloaded <retryBytes> of <coldBytes> bytes (restarts from zero: <retryBytes >= coldBytes * 0.9>)`.
  7. The direct runner at the bottom (same guard as the existing probe) makes a temp directory, `await import('@libsql/client')`, calls the function, prints `Replica cache probe passed.`, removes the directory in `finally`.
- [ ] **Step 4: Wire CI.** In `.github/workflows/check.yml` add, directly after the existing `- run: node scripts/probe-database-client-sync.mjs` step with its `env` block, an identical step `- run: node scripts/probe-database-replica-cache.mjs` with the same `env: SOLIDACTIONS_DATABASE_SYNC_URL: http://127.0.0.1:8080`. In `tests/database-native-ci-contract.test.ts` add `expect(commands).toContain('node scripts/probe-database-replica-cache.mjs');` after the existing `toContain('node scripts/probe-database-client-sync.mjs')`.
- [ ] **Step 5: Static checks:** `npm run build`. (The probe is plain `.mjs`; `node --check scripts/probe-database-replica-cache.mjs` is allowed, it runs no test.)
- [ ] **Step 6: Report (do not commit).** List every changed path. Hand back the expected-RED table (`assertWarmCheaper` rows: fails because the export is missing on the base) and say plainly that the real-server behaviour (cold/warm bytes, companions, retry) can only be read from the PR's `check.yml` log, the job `Database client remote sync`.

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
- Produces: exactly the frozen contract above (copy it verbatim into the file as the exported surface; implementation detail below).

**Behaviour (implement exactly):**
- `defaultReplicaCacheRoot(homedir = os.homedir())` = `path.join(homedir, '.solidactions', 'cache', 'database-replicas')`.
- `replicaCacheKey` as the contract says.
- `acquireReplicaCache` in order:
  1. `dir = path.join(root, key)`. `mkdir(root, { recursive: true, mode: 0o700 })` and `mkdir(dir, { recursive: true, mode: 0o700 })`; any error -> `{ kind: 'skipped', reason: 'unavailable' }`. `lstat(dir)` must be a real directory, not a symlink, else `unavailable`. (The root's own ancestors may be symlinks: a home on another drive is legitimate. Only `<root>/<key>` and `data` are checked.)
  2. Take the lock (below). Busy -> `skipped: 'busy'`.
  3. Read `meta.json` (`{ version: 1, databaseId, createdAt, lastSyncedAt, replacements: number[], skipUntil: number | null }`). Missing -> defaults. Unparseable, wrong `version`, or wrong shape -> treat as defaults AND wipe `data/` (a corrupt meta means the replica cannot be trusted).
  4. `skipUntil > now()` -> release the lock, `skipped: 'rewritten_often'`.
  5. Identity check: when the stored `databaseId` and the offered `identity.databaseId` are both non-null and differ, or the stored `createdAt` and offered `createdAt` are both non-null and differ: wipe `data/`, push `now()` onto `replacements`, drop entries older than `REPLICA_CACHE_REPLACEMENT_WINDOW_MS`, and when `replacements.length >= REPLICA_CACHE_REPLACEMENT_LIMIT` set `skipUntil = now() + REPLICA_CACHE_SKIP_MS`, write meta, release, `skipped: 'rewritten_often'`. Otherwise write the new identity into meta (only when the stored side was null does this count as no replacement).
  6. Ensure `data/` exists as a real directory (`lstat`; a symlink or a file there -> release, `skipped: 'unavailable'`, never follow or remove it). `warm = (await lstatIfPresent(replicaPath)) is a regular file`.
  7. Any thrown error in steps 1-6 releases the lock if it was taken and answers `unavailable`. The function never throws.
- Lock: `open(dir/lock, 'wx', 0o600)`, write `{ pid, nonce, at }` (nonce = `crypto.randomUUID()`). On `EEXIST`: read it; unreadable or malformed -> reclaim only when its `mtime` is older than `REPLICA_CACHE_STALE_LOCK_MS`, else busy; readable -> `processAlive(pid)` (default: `process.kill(pid, 0)` true unless it throws `ESRCH`; `EPERM` counts as alive) true -> busy; false -> unlink and retry the `wx` once, a second `EEXIST` -> busy. `release()` reads the lock and unlinks it only when `nonce` matches ours; never throws.
- `wipe()`: `lstat(data)` must be a real directory (if missing, just create it); remove it with `fs.promises.rm(data, { recursive: true, force: true })`, then recreate it empty with mode 0700; set the in-memory `warm` to false; clear `lastSyncedAt` in meta. A symlinked `data` -> throw `ReplicaCacheError` (the caller treats it as `unavailable`).
- `markSynced()`: write meta atomically (`meta.json.<nonce>.tmp` then `rename`) with the current identity and `lastSyncedAt = now()`; keep `replacements` and `skipUntil`.
- Nothing in this module reads or writes anything outside `<root>/<key>/`.

- [ ] **Step 1: Write the failing tests** in `tests/database-replica-cache.test.ts` (real files under `fs.mkdtempSync(os.tmpdir())`, roots removed in `afterEach`; inject `now`, `pid`, `processAlive`). Rows (each is one `it`):
  1. `key is stable, 32 hex, and differs by host, workspace and name`.
  2. `cold acquire creates data/, a lock, and reports warm=false`; after writing `data/replica.db`, release, acquire again: `warm=true`.
  3. `a live lock (processAlive true) is busy and the lock file is untouched`; `a dead-pid lock is reclaimed`; `an unreadable lock younger than 1 h is busy, older than 1 h is reclaimed` (use `fs.utimes`).
  4. `release removes only its own lock` (overwrite the lock with a foreign nonce, release, the foreign lock survives).
  5. `a corrupt meta.json wipes data/ and starts clean` (garbage meta plus a `data/replica.db`: afterwards `warm=false`, file gone).
  6. `identity change wipes data/ and records a replacement`; `null on either side is not a change`.
  7. `the third replacement inside 7 days skips with rewritten_often for 7 days, then the cache is usable again` (advance injected `now` by 7 days + 1 ms).
  8. `a symlinked data/ is refused and its target survives` (create a symlink `data -> otherDir` with a file inside; acquire answers `unavailable`; the file in `otherDir` still exists).
  9. `an unwritable root answers unavailable and never throws` (root path whose parent is a regular file).
  10. `meta.json and every file under a populated root contain no credential` (write a sentinel token only into a fake client config object; after acquire, markSynced, wipe, grep every file's bytes for the sentinel: none) (I4).
  11. `markSynced writes atomically: an old meta survives a failed rename` (inject a `filesystem` whose `rename` throws once; the old `meta.json` bytes are unchanged and no `*.tmp` is left).
  12. `defaultReplicaCacheRoot ends with .solidactions/cache/database-replicas`.
- [ ] **Step 2: Expected RED:** the module does not exist: every row fails at import. (No local run.)
- [ ] **Step 3: Implement** `src/utils/database-replica-cache.ts` per Behaviour. Follow the surrounding style (4 spaces, `isMissingPath`-style `ENOENT` checks; do not import from `src/commands/database.ts`).
- [ ] **Step 4: Static checks:** `npm run build`.
- [ ] **Step 5: Report (do not commit)**: changed paths; expected-RED table; the grep `grep -rn "replica-cache" src tests` shown (only your two files and nothing else).

The manager commits with `git add -- <paths>` then `git commit -m "feat(database): replica cache module (#262)" -- <paths>`.

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
- [ ] **Step 2: Expected RED:** the guidance module is missing; `cache: true` is absent on the base (the base option list has no `--no-cache`); the README lacks both strings.
- [ ] **Step 3: Implement.**
  - `src/utils/database-pull-guidance.ts` exports exactly the four names with the frozen strings (the help text as a template literal; no trailing spaces).
  - `src/index.ts`: import `DATABASE_PULL_HELP`; add `.option('--no-cache', ...)` to `database pull`; change the `addHelpText('after', ...)` argument to `` `${DATABASE_PULL_HELP}\n<the existing DuckDB paragraph, unchanged>` `` so the output is the new paragraphs, a blank line, then the unchanged DuckDB paragraph. Do not change the `.action` body.
  - `README.md`: add `solidactions database pull analytics --no-cache` under the existing `database pull analytics --writable` line, and after the code block one paragraph: `` `database pull` fetches only what changed since your last pull of the same database and keeps a hidden cache per database in `~/.solidactions/cache/database-replicas`; use `--no-cache` to skip it. Inside a workflow or function, query the database directly instead of pulling (`ctx.vars` with `createDatabaseClient`). Pull only for local analysis, keep and reuse one copy, and never pull per test or per preview. `` (The README test needs the exact words `fetches only what changed`, `query the database directly`, `local analysis`, `reuse one copy` and `per test or per preview`; PM ruling above.)
- [ ] **Step 4: Static checks:** `npm run build`; then `node dist/index.js database pull --help` is allowed (it runs no test): paste its output in the hand-back.
- [ ] **Step 5: Report (do not commit)**: changed paths, expected-RED table, the `--help` output, and this grep shown: `grep -rn "database pull" tests | grep -v "^tests/database-pull-guidance"` (so the manager sees every other test that quotes pull help).

The manager commits with `git add -- <paths>` then `git commit -m "docs(database): pull help, README, --no-cache flag (#262)" -- <paths>`.

---

### Task 4: Cached read-only pull, warning, `-info` cleanup (cli#262)

**Depends on:** Tasks 1, 2, 3 committed. **Serves:** ask 1 (read-only path) and ask 2 (warning).

**Files (file scope):**
- Modify: `src/commands/database.ts` (new imports; `DatabasePullOptions` and `DatabaseCommandDependencies` and `ResolvedCommandDependencies` and `resolveDependencies` gain the fields below; `pullSidecars` (lines 997-999) gains `-info`; `databasePullWithConfig` (lines 2375-2551) gets the warning call and the cached branch before the existing `const target = ...` at 2402; one new function `databaseCachedReadonlyPullWithConfig` placed directly above `databasePullWithConfig`; the public `databasePull` (lines 2899-2906) fills `replicaCacheRoot`)
- Create: `tests/database-pull-cache.test.ts`

Not yours, never touch: `databaseWritablePullWithConfig` (Task 5 owns that function), `tests/database-pull-command.test.ts` and `tests/database-writable-pull-command.test.ts` (they must pass unchanged; read their harness for style), every file of Tasks 1-3 and 5.

**Interfaces:**
- Consumes: the frozen contract of `database-replica-cache.ts`; `isInsideWorkflowRun`, `WORKFLOW_RUN_PULL_WARNING` from `database-pull-guidance.ts`; existing helpers in `database.ts` (`confirmFileOverwrite`, `reserveDestinationTemp`, `handoffReplicaReservation`, `assertNoSymlinkComponents`, `lstatIfPresent`, `removeOwnedFiles`, `pullSidecars`, `anyPathExists`, `classifyPullFailure`, `loadDatabaseClientBeforeMint`, `requestDatabaseAccess`, `runDatabaseClientOperationWithDeadline`, `displayDestination`, `freshSafeFileError`, `PULL_ATTEMPTS`, `PULL_RETRY_BACKOFF_MS`).
- Produces (for Task 5): `snapshotCacheReplica(io, createClient, replicaPath, temp): Promise<void>` and `publishSnapshot(io, temp, target): Promise<void>` as module-private functions in `database.ts` with exactly these semantics, and the fields `DatabasePullOptions.cache?: boolean`, `DatabaseCommandDependencies.replicaCacheRoot?: string`, `DatabaseCommandDependencies.env?: NodeJS.ProcessEnv` (resolved: `env` defaults to `process.env`; `replicaCacheRoot` stays `string | undefined`).

**Behaviour (implement exactly):**
1. **Warning.** In `databasePullWithConfig`, directly after the version/row checks that decide this is a libSQL pull (after `refuseIfAnalyticalRow(...)`, before the `options.writable` branch), when `isInsideWorkflowRun(io.env)` call `io.stderr(WORKFLOW_RUN_PULL_WARNING)` once. The pull then proceeds (a warning, not a refusal). It applies to read-only and writable pulls and not to DuckDB-file pulls (they return before this point and have their own version model).
2. **Cache eligibility.** Cached only when `options.cache !== false` and `io.replicaCacheRoot` is a non-empty string. Otherwise the existing code runs untouched.
3. **`databaseCachedReadonlyPullWithConfig(name, destination, options, config, io, row)`** (the `row` is the record already fetched), in order:
   1. `target = resolveDatabaseDestination(...)` and `confirmFileOverwrite(...)` exactly as the uncached path (so the overwrite prompt / `--yes` rules are identical and happen BEFORE any cache work); a declined confirmation returns `'handled'` (already printed `Cancelled.`).
   2. `acquireReplicaCache({ root, identity: { host: config.host, workspaceId: config.workspaceId, name, databaseId: row.id ?? null, createdAt: row.created_at ?? null }, now: io.now })`. `skipped` -> write the one-line stderr note (`busy`: `Another pull of this database is using the local cache; downloading a full copy instead.`; `rewritten_often`: `This database is replaced often, so its local cache is off for now; downloading a full copy.`; `unavailable`: no output) and return `'fallback'`.
   3. `ready`: `reserveDestinationTemp(io, target)`; the sidecar pre-check as today. Then the sync loop, same shape as the uncached loop with these differences only: the client `url` is `pathToFileURL(cache.replicaPath).href` (not `temp`); there is NO attempt-0 reservation hand-off inside the loop (the reservation is released later, step 5); the replica checks (`lstat` regular file, no symlink) apply to `cache.replicaPath`; on a failure classified `deterministic` while `cache.warm` was true at the start of the loop and the cold retry is unused: `await cache.wipe()`, set the cold-retry flag, `continue` (it consumes an attempt; `credential_expiry` and `transient_transport` handling is identical to the uncached loop, including the backoff and the one re-mint).
   4. After the loop: not synced -> release the cache, remove the run's own temp (`ownsTemp`), throw the same `upstream_unavailable` error as today (I2: nothing published). Synced -> `await cache.markSynced()`.
   5. Snapshot: release the reservation exactly as `handoffReplicaReservation` does (close handle, unlink temp), then `snapshotCacheReplica(io, localCreateClient, cache.replicaPath, temp)`: open a local client `createClient({ url: pathToFileURL(replicaPath).href, intMode: 'string' })` (NO `syncUrl`, NO `authToken`), run `VACUUM INTO '<temp with each ' doubled>'` under `runDatabaseClientOperationWithDeadline(..., closeFn, io.dataPlaneTimeoutMs)`, close it; then open a second local client on `temp`, run `SELECT count(*) FROM sqlite_master`, close it (proves the snapshot opens); any failure -> throw a private `ReplicaCacheFallback`.
   6. `publishSnapshot(io, temp, target)`: `assertNoSymlinkComponents(temp)`; `lstat(temp)` must be a regular file, else throw `unsafe_destination` (`The database replica temporary path is unsafe.`); `removeOwnedFiles(pullSidecars(temp))` then `anyPathExists(pullSidecars(temp))` must be false; `chmod(temp, 0o444)`; `assertNoSymlinkComponents(target)`; `rename(temp, target)`. Then `io.stdout('Database replica saved to <displayDestination>.')` (identical to today).
   7. `finally`: `await cache.release()`.
   8. A `ReplicaCacheFallback` (or `ReplicaCacheError`) at steps 3-5: wipe the cache best effort, remove the run's own temp and sidecars, release, return `'fallback'`. Anything else is the existing `freshSafeFileError` mapping.
4. **`databasePullWithConfig`:** `const handled = await databaseCachedReadonlyPullWithConfig(...)`; `if (handled === 'handled') return;` otherwise continue into the unchanged uncached body (so a `'fallback'` runs the old code exactly once).
5. **`pullSidecars`** returns the old four names plus `` `${temp}-info` ``. Existing tests that assert sidecar cleanup keep passing (they only add the old four).
6. **`databasePull`** (the public wrapper) passes `replicaCacheRoot: dependencies.replicaCacheRoot ?? defaultReplicaCacheRoot()` (D1). Nothing else fills it.

- [ ] **Step 1: Write the failing tests** in `tests/database-pull-cache.test.ts`. Build a harness by copying the structure of `pullHarness` in `tests/database-pull-command.test.ts` (fake `loadClient` with `createClient`, fake `post` answering `show` and `access`, real files under a temp root, `replicaCacheRoot: <temp root>/cache`, injected `now`, `sleep: async () => {}`, `env: {}`). The fake sync client writes `fileURLToPath(config.url)` and a `-info` file beside it so companions are observable. The fake local (no `syncUrl`) client answers `VACUUM INTO '<path>'` by copying the replica bytes to that path and answers `SELECT count(*) FROM sqlite_master`. Rows:
  1. `cold pull syncs into the cache replica, snapshots into the target, leaves exactly the target beside it` (I1): the sync client's `url` is under `<root>/cache/<key>/data/`; the target holds the snapshot bytes and mode `0o444`; the destination directory listing is exactly `[target basename]`; no `-info`, `-wal`, `-shm`, `-journal` beside it.
  2. `warm pull syncs the same cache path again and a second target gets the new bytes` (two sequential pulls with a fake whose sync appends a row marker): both sync `url`s are equal; second target reflects the second state; first target unchanged.
  3. `a failed warm sync never publishes the previous file` (I2): second pull's sync throws a `deterministic` error and the cold retry throws too: the call rejects with `upstream_unavailable`, the existing target bytes are unchanged, no temp remains.
  4. `a deterministic warm failure wipes the cache and the cold retry publishes` (sync fails on the first warm attempt, `data/` is empty at the second attempt, target gets the new bytes).
  5. `transient failures retry on the same cache path with backoff and re-mint on credential expiry exactly like the uncached loop` (mirror the two existing tests: `bounds transient transport retries ...` and `remints exactly once ...`; assert attempt counts and that every attempt's `url` is the cache path).
  6. `a live lock makes the pull uncached and says so on stderr`: pre-create the lock with the test process pid (`processAlive` default true); the pull succeeds, the sync `url` is the sibling temp (the uncached path), stderr contains the `busy` sentence, and the lock file is untouched.
  7. `--no-cache (options.cache === false) never touches the cache root` (the root directory does not exist afterwards).
  8. `no replicaCacheRoot means no cache` (the dependency omitted: root absent, behaviour identical to the existing tests).
  9. `cache faults fall back to the uncached path` (table over: unwritable root (root's parent is a file), `data` is a symlink to an outside directory with a sentinel file (sentinel survives), corrupt `meta.json`, `VACUUM INTO` throws): each case pull succeeds with a correct target, the table asserts the sentinel and unrelated files survive, and no pull error mentions the cache (I3).
  10. `a replaced database wipes the cache` (second `show` answers a different `id`: the second sync's `data/` starts empty); `three replacements in a week switch the cache off and the fourth pull is uncached, silently` (use the `rewritten_often` stderr sentence).
  11. `warm pull reflects remote changes through the snapshot` (a fake that models insert, update and delete across three pulls: the three targets' marker sets equal the three server states).
  12. `a temp replaced by a symlink before the snapshot is refused and nothing is published` (target unchanged, outside file untouched).
  13. `the workflow-run warning prints once for env SOLIDACTIONS_RUN_ID and for STEPS_TRIGGER_ID, not for an empty env, on both cached and uncached pulls, and the pull still succeeds`.
  14. `no credential reaches the cache directory` (I4: grep every file under the root for the access-token sentinel and the PAT sentinel: none).
  15. `no pull path leaves a companion file beside the target` (sweep: run rows 1, 2, 4, 6, 7, 9 and assert the directory listing equals the pre-pull listing plus the target).
  16. `the uncached path now also removes <temp>-info` (a fake sync that writes `-info`, run with `replicaCacheRoot` omitted: after the pull the directory listing has no `-info`).
- [ ] **Step 2: Expected RED** (put each in the hand-back table): rows 1-15 fail on the base because `replicaCacheRoot`/`env` are ignored (the sync `url` is never under `<root>/cache`, no snapshot occurs, no warning is printed); row 16 fails because `pullSidecars` lacks `-info`; rows 7 and 8 pass on the base for the trivial reason (say so: they guard the new code from regressing the old behaviour).
- [ ] **Step 3: Implement** per Behaviour. Keep the uncached body of `databasePullWithConfig` unchanged apart from the call at its top and the `-info` sidecar.
- [ ] **Step 4: Static checks:** `npm run build`. Then the greps shown in the report: `grep -n "pullSidecars" src/commands/database.ts` (the writable path also calls it: your change there is only the shared list), `grep -rn "replicaCacheRoot\|DatabasePullOptions" src` (all readers of the new fields).
- [ ] **Step 5: Report (do not commit)**: changed paths (source and test separately), the expected-RED table, `git diff --stat -- <your paths>` plus `wc -l tests/database-pull-cache.test.ts`, the two greps.

The manager commits with `git add -- <paths>` then `git commit -m "feat(database): pull fetches only changes through a hidden cache replica (#262)" -- <paths>`.

---

### Task 5: Cached writable pull (cli#262)

**Depends on:** Task 4 committed. **Serves:** ask 1's second function. This task is separable: if the PM cuts it at plan-check, the wave still satisfies the incident path (read-only pulls); say so in the PR body if cut.

**Files (file scope):**
- Modify: `src/commands/database.ts` (only `databaseWritablePullWithConfig`, lines 2043-2373, and the call to it in `databasePullWithConfig`, line 2399)
- Create: `tests/database-writable-pull-cache.test.ts`

Not yours, never touch: every other function in `database.ts`, `tests/database-writable-pull-command.test.ts` (must pass unchanged), every file of Tasks 1-4.

**Interfaces:**
- Consumes: Task 4's `snapshotCacheReplica`, `publishSnapshot`, `ReplicaCacheFallback`, the `acquireReplicaCache` identity construction, the skip-note sentences (reuse the constants, do not copy the strings), and the `cache` option.
- Produces: nothing for other tasks.

**Behaviour (implement exactly):**
1. `databaseWritablePullWithConfig` gains an optional last parameter `row` (the record) and, when the cache is eligible (same rule as Task 4), acquires the cache before `openAttachedClient(true)`. A `skipped` outcome writes the same stderr note and continues with today's code path unchanged (no fallback function needed: the uncached writable body is simply the code that runs).
2. With a cache: the libSQL client `url` (initial and every renewal reopen in `openAttachedClient`) is `pathToFileURL(cache.replicaPath).href`; the reservation of the sibling `temp` is kept for publication and released (`handoffReplicaReservation`) right before the snapshot instead of inside `openAttachedClient(true)`; the renewal checks (`assertNoSymlinkComponents`, `lstat` regular file) apply to `cache.replicaPath`.
3. A failed `sync()` of a warm cache at `openAttachedClient(true)`: `await cache.wipe()` and retry the open once (cold); a second failure is the existing `upstream_unavailable`.
4. Publication (replaces `finalizeReplica(io, temp, target, localCreateClient!)` only when a cache is in use): `snapshotCacheReplica` then `publishSnapshot` as in Task 4, after `closeAttachedClient()`. `cache.markSynced()` after the final close. A snapshot failure with a cache in use: wipe the cache, remove the temp, and throw `upstream_unavailable` (a writable session cannot be silently re-run: its statements already executed and its input is consumed); the printed message is the existing one. The `publishAfterFailure` and `sessionFailure` semantics are unchanged (a last-valid publish still publishes, through the snapshot).
5. The lock is held for the whole session and released in the outer `finally` on every exit (normal, error, abort).
6. `--no-cache` and no `replicaCacheRoot` leave the function exactly as it is today.

- [ ] **Step 1: Write the failing tests** in `tests/database-writable-pull-cache.test.ts` (copy the harness style of `tests/database-writable-pull-command.test.ts`; `replicaCacheRoot` set). Rows:
  1. `writable session syncs, renews and writes through the cache replica path` (initial and renewal client `url`s equal `cache.replicaPath`; two renewals use the same path).
  2. `the published target is a snapshot of the cache with no companions beside it` (I1).
  3. `a live lock makes the writable session uncached with the stderr note` and the session still works.
  4. `a warm cache whose initial sync fails is wiped and reopened cold once`.
  5. `a snapshot failure wipes the cache, publishes nothing and reports upstream_unavailable without replaying input`.
  6. `abort publishes the last valid state through the snapshot and releases the lock`; `an error mid-session releases the lock` (the lock file is gone after each).
  7. `no credential reaches the cache directory (write token sentinel)`.
  8. `--no-cache and an omitted root leave the existing flow` (root absent afterwards).
- [ ] **Step 2: Expected RED:** on the base the `url` is the sibling temp and no snapshot occurs (rows 1, 2, 3, 4, 5, 6, 7 fail on those assertions); row 8 passes on the base (guard).
- [ ] **Step 3: Implement** per Behaviour with the smallest diff: introduce one local `const replicaPath = cache?.replicaPath ?? temp!` and use it where `temp!` is used for the libSQL `url` and the renewal checks; branch only at the hand-off and at publication.
- [ ] **Step 4: Static checks:** `npm run build`; `grep -n "temp!" src/commands/database.ts | sed -n 1,40p` shown in the report so the manager can confirm no replica use of `temp` was missed.
- [ ] **Step 5: Report (do not commit)**: changed paths, expected-RED table, `git diff --stat -- <your paths>` and `wc -l` of the new test file.

The manager commits with `git add -- <paths>` then `git commit -m "feat(database): writable pull uses the cache replica (#262)" -- <paths>`.

---

## Self-Review

1. **Spec coverage:** incremental pull + hidden cache per database (Tasks 2, 4, 5); copy to user's file after `sync()` and never a live replica (Task 4 `snapshotCacheReplica`/`publishSnapshot`, I1); fall back when missing/corrupt/replaced (Tasks 2 identity and meta, 4 fault table, cold retry); skip for databases rewritten often (D3, Task 2 rows 6-7, Task 4 row 10); "first verify whether a retry restarts from zero" (Task 1 step 6, information line in the CI log); help text (Task 3); warning inside a workflow run (Task 3 constant, Task 4 call, test row 13). Every issue-ask has a task.
2. **Placeholder scan:** none; the test rows give the inputs and assertions, the developer writes the test code in the file style of the named harness.
3. **Type consistency:** `ReplicaCache`, `ReplicaCacheOutcome`, `ReplicaCacheIdentity`, `acquireReplicaCache`, `isInsideWorkflowRun`, `WORKFLOW_RUN_PULL_WARNING`, `DATABASE_PULL_HELP`, `replicaCacheRoot`, `env`, `cache`, `snapshotCacheReplica`, `publishSnapshot`, `ReplicaCacheFallback` are spelled the same in every task. `ReplicaCacheFallback` is defined in Task 4 and consumed in Task 5 (Task 5 depends on 4).
4. **Review Focus** lines each have an owning test (see the list above).
5. **File scope and shop rules:** each task has an exhaustive Files block (tests included), no commit/stash/worktree step, no local test `Run:` line (static checks only, tests in CI per the Speed rules), each task stands alone with its contract quoted. `src/commands/database.ts` is in Tasks 4 and 5 (serial, stated in both). `tests/database-file-command-actions.test.ts` and `tests/readme-contract.test.ts` are in Task 3 only. `tests/database-native-ci-contract.test.ts` is in Task 1 only.
6. **Premises to probe:** (a) warm `sync()` is incremental, (b) `VACUUM INTO` through a no-`syncUrl` client on a replica yields a standalone, companion-free file, (c) real companion names, (d) retry-from-zero: all measured by Task 1 in the PR's `check.yml` (job `Database client remote sync`); the code is built so that a wrong premise only makes a pull slower, never wrong (D5, I2, I3). A red Task-1 probe on the warm-cheaper assertion would mean the incremental premise is false: stop, comment on the build card and mail the PM. The `-info` cleanup (Task 4 step 5) is unconditional and harmless. No other environment premise (pid namespace, container uid) is relied on: the lock uses `process.kill(pid, 0)` only for liveness and treats `EPERM` as alive.
7. **Open decisions for the PM at plan-check:** (i) may the manager run `scripts/probe-database-replica-cache.mjs` once on this box against a throw-away libsql-server container (the CI job's own image) after Task 1 is committed and before Task 4 is dispatched? Without a yes, the premise is first measured in PR CI (the design survives either answer). (ii) D6 `--no-cache` and Task 5 (writable) are the two cut candidates.

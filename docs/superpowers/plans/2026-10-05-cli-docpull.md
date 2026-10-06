# Wave cli-docpull Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sa-subagent-driven-development to implement this plan task-by-task (the wave's build step). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `doc pull` leaves the previous files and manifest on any in-process failure, cleans up after a killed pull, and never writes outside the destination or over a file it doesn't own, even one created after its checks. It also keeps tracking that a failed download would lose, and fails loudly on an unreadable destination or a missing terminal.

**Architecture (PM ruling 7, spec §1):**
- A new module, `src/utils/doc-pull-writes.ts`, stages every file into `<destination>/.solidactions-pull-<pid>/`.
- It renames each one into place after re-checking the target's preflight-authorized state, keeping a backup of anything replaced, and publishes the manifest last.
- On any in-process failure it restores the backups. The next pull cleans up a folder left by a killed pull.
- `report()` in `src/commands/doc-pull.ts` computes the final manifest before any write, drives the module, and runs rename cleanup and deletion propagation only after publication.

**Tech Stack:** TypeScript (Node 20+, CommonJS), commander, vitest 4 (`unit` project). Unit tests run on Linux in CI.

**Spec:** `docs/superpowers/specs/2026-10-05-cli-docpull-design.md` (cited as "spec §N"; it wins over this plan on any conflict).

**Issues:** cli#168, cli#183, cli#190, cli#188, cli#191, cli#176, cli#182 (SolidActions/solidactions-cli). Approved by Peter in CrewOps ask task-starttheclidoc-01c7 ("approved", built mainly on Muse), recorded on each issue. The commit design (PM ruling 7) is recorded on cli#168 (issuecomment-6008646035).

**Plan reviews:**
- Sol task-planreviewcli-d807 (REQUEST CHANGES d5474a7) → PM rulings 1-6 (plan card task-planclidocpull-948e);
- Sol re-check task-planrecheckcli-48d5 (REQUEST CHANGES 0a92aa3) → PM ruling 7 (plan-check card task-plancheckcli-f9a4): simplify, no journal.

Rulings 3-6 still bind (scopes, sweeps, runner-a gate, M1).

**Card rule (for the manager):** every developer card carries this plan's **Global Constraints** section verbatim and the spec path. Each task states its own expected lines.

## Global Constraints

- **Where:** the CLI wave slot `/home/mercer/projects/solid/solidactions-cli/__worktrees/wave-a`, branch `wave/2026-10-05-cli-docpull`. Work only there. Every path below is relative to that folder.
- **Spec:** `/home/mercer/projects/solid/solidactions-cli/__worktrees/wave-a/docs/superpowers/specs/2026-10-05-cli-docpull-design.md`. Read the sections your task cites.
- **File scope:** touch only the paths in your task's **Files** block. A change that needs another path is a plan defect: stop and report it.
- **Never commit, stage, stash, switch branches, reset or rebase.** Never create a worktree. The manager commits after the task review.
- **Build before tests:** run `npm run build` after every source change and before every test run (the tests spawn `dist/index.js`).
- **Filtered runs only:** run only the test files your task names (`npx vitest run --project unit tests/<file>.test.ts …`). Never the full suite, never `tests/live/`.
- **Heavy-run gate (I3):** before a run that includes `tests/doc-pull-rename-matrix.test.ts`, or more than 3 test files in one command, run both of these and paste their output into your report:
  - `/home/mercer/projects/solid/solidactions-app/scripts/ci-lock status --scope runner-a`. It must print `unlocked`; if a lease is held, wait 5 minutes and check again. Never acquire, release or force it.
  - `grep MemAvailable /proc/meminfo`. It must be at least 4 GB; otherwise wait and check again.
- **Real tests (PM ruling 14 of wave cli-trust, still binding):** new or changed command tests spawn the built binary.
  - Spawn with async `child_process.spawn` of `node dist/index.js …`, against a real in-process `http.createServer` on `127.0.0.1`.
  - Use a temp `HOME` (`makeTmpEnv`/`writeGlobal` from `tests/helpers.ts`) whose `~/.solidactions/config.json` points at that server with a plain host (`http://127.0.0.1:<port>`; a host with `user:pass@` is refused) and carries a `workspaceId`.
  - Remove `SOLIDACTIONS_HOST` / `SOLIDACTIONS_API_KEY` / `SOLIDACTIONS_WORKSPACE_ID` / `DEBUG` / `NODE_DEBUG` / `FORCE_COLOR` / `SOLIDACTIONS_TEST_HOOKS` / `SOLIDACTIONS_DOC_PULL_TEST_FAULT` from the child env unless the test sets them on purpose.
  - Assert real stdout, stderr, exit status (or the killing signal), and files on disk.
  - Never use `process.exit` / `console` / output-sink substitutions in new or changed tests. No `vi.fn` or `vi.spyOn`; never mock `axios`, `fs` or a module.
  - Module functions that work on the filesystem are tested directly against real temp directories.
  - Copy the spawn pattern and the doc-pull MCP fixtures (`list`, `bulk_read`, media routes) from `tests/doc-pull-write-safety.test.ts` and `tests/doc-pull.test.ts`.
- **An older test whose expectation this plan changes** is converted to the spawned harness (when it was in-process) and listed by name in your report, with the old and new expectation.
- **Permission and platform tests:**
  - A test that relies on `chmod` (EACCES) skips when `process.platform === 'win32'` or `process.getuid?.() === 0`, and restores modes in `finally`.
  - A test that needs a filesystem property Linux lacks (case-insensitivity, Unicode normalisation, no `O_NOFOLLOW`) detects the property at runtime and uses `it.skipIf(!property)` with the reason in the test title, e.g. `'… (needs a case-insensitive filesystem; CI unit tests run on Linux)'`. Never skip silently (spec §1.7).
- **Display:** every value printed by doc-pull.ts goes through its `shown()` helper, or is a number ending in `.length`/`.id`. `tests/doc-pull-display-guard.test.ts` enforces it and is in every doc-pull task's run. Never interpolate a host into a template literal (`tests/host-display-guard.test.ts`).
- **Evidence:** save the raw output of every test run you cite to a log in `/home/mercer/projects/solid/solidactions-cli/__worktrees/wave-a/.superpowers/sdd/2026-10-05-cli-docpull/` (`… 2>&1 | tee <log>`), and cite the log next to each count. Every run you cite must have its log saved. RED before GREEN for every behaviour change. Describe passing output accurately: name any product diagnostics it prints, and never call it "pristine" when it isn't.
- **Style:** 4-space indent, single quotes, chalk colours as the surrounding code uses them. Errors are red `error: …` lines on stderr; warnings are doc pull's yellow `! …` lines.
- **Report, never commit:** your last step lists every changed path, every older test you changed (by name) and the test commands you ran, with their pass/fail counts and log paths.

## Review Focus

1. **Every in-process failure point leaves the previous state:** each doc rename, the manifest temp, the manifest rename, a publication refusal and a rollback-restore failure. The files (bytes and inodes), the manifest and the absence of a staging folder are checked after each; a failed restore keeps the folder and names it (spec §1.5). Tasks 2 and 3 pin it.
2. **INV-B at rename time:** a file or link created or changed at a target after the checks is never replaced without `--overwrite`. With `--overwrite` it is backed up first, so a later failure restores it (spec §1.3 step 4). Tasks 2, 3 and 5 pin it.
3. **A killed pull** leaves the old manifest. The next pull cleans a leftover folder when it is safe, refuses (keeping both copies) when a target differs, and refuses when that pid is still running (spec §1.4). Tasks 2 and 3 pin it.
4. **Scripts keep working:** `doc pull … -y` with no terminal still pulls into a non-empty destination. Without `-y` it exits 1 with the line, and the terminal "no" still prints `Cancelled.` and exits 0 (spec §4). Task 1 pins it.
5. **The rename matrix and write-safety suites stay green,** with the hard-link stand-ins for case-insensitive aliases rewritten to the new semantics. The true alias cases run where the filesystem allows and are skipped with a reason on Linux (spec §1.7). Task 3 pins it.

---

### Task 1: an unreadable destination and a missing terminal fail with one line (cli#191, cli#176)

**Files (file scope — the only paths this task may touch):**
- Modify: `src/commands/doc-pull.ts` (`docPullWithConfig`'s destination checks and prompt, ~573-610 only). Tasks 3 and 4 edit other parts of this file later.
- Create: `tests/doc-pull-destination-checks.test.ts` (spawned, plus one PTY case)
- Modify: `tests/doc-pull-write-safety.test.ts` (the test "prints the prompt text naming the untracked-file refusal when the destination is not empty", ~565-570: it spawns with non-terminal stdin, I1)
- Modify: `tests/doc-pull.test.ts` (the `describe('docPullWithConfig — overwrite confirm')` test "non-empty dest without --yes: declining the prompt exits 0 and writes nothing", ~893-920, I1)

**Interfaces:**
- Consumes: `shown(value: unknown): string` (doc-pull.ts).
- Produces: nothing new.

**Spec:** §3 and §4. For a destination `<D>` (absolute, through `shown()`), the lines are exactly:
- unreadable: `error: cannot read <D>: <the fs error's message>`, e.g. `error: cannot read /tmp/x/out: EACCES: permission denied, scandir '/tmp/x/out'`
- no terminal: `error: <D> is not empty and there is no terminal to confirm the pull; pass -y to pull into it.`

- [ ] **Step 1: Write the failing tests** in `tests/doc-pull-destination-checks.test.ts`. The server's MCP `list` answers one doc and `bulk_read` returns it (fixture from `tests/doc-pull-write-safety.test.ts`). The spawned child's stdin is a pipe (not a terminal) unless stated.
  1. **Unreadable destination** (skip on win32/root): `<tmp>/out` holds `x.txt`, then `chmod 0o000`. `doc pull F <tmp>/out`: exit 1, stderr contains `error: cannot read <tmp>/out: EACCES` and no `    at ` stack line.
  2. **No terminal, non-empty destination, no `-y`:** `<tmp>/out/x.txt` exists. `doc pull F <tmp>/out`: exit 1, stderr has the exact no-terminal line, stdout has no `Continue?`, and no doc file or manifest was written.
  3. **No terminal with `-y`:** exit 0 and the doc is written.
  4. **No terminal with `--overwrite`:** exit 0 and the doc is written.
  5. **Empty destination, no `-y`:** exit 0.
  6. **A real terminal answers "no"** (PTY): skip with the reason `'(needs util-linux script for a PTY)'` when `script` is not on PATH.
     - Run `script -qec "node <abs dist/index.js> doc pull F <tmp>/out" /dev/null` with the same env, and write `n\n` to its stdin after the prompt appears in its output.
     - Expect `Cancelled.` in the output, exit 0, and no doc file written.

- [ ] **Step 2: Run them and watch them fail.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull-destination-checks.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-1-red.log`
Expected: FAIL on 1 (wording) and 2 (today: prompt, exit 0). Cases 3-6 pass.

- [ ] **Step 3: Implement** in `docPullWithConfig`. The destination block becomes:

```ts
    if (fs.existsSync(destination)) {
        let entries: string[];
        try {
            if (!fs.statSync(destination).isDirectory()) {
                process.stderr.write(chalk.red(`error: destination "${shown(destination)}" exists and is not a directory.\n`));
                process.exit(1);
            }
            entries = fs.readdirSync(destination);
        } catch (error) {
            // cli#191: one line naming the destination, never a raw scandir stack.
            process.stderr.write(chalk.red(`error: cannot read ${shown(destination)}: ${shown((error as Error).message)}\n`));
            process.exit(1);
        }
        if (entries.length > 0 && !options.yes && !options.overwrite) {
            if (process.stdin.isTTY !== true) {
                // cli#176: nobody can answer the prompt; a script must not read "Cancelled" as success.
                process.stderr.write(chalk.red(`error: ${shown(destination)} is not empty and there is no terminal to confirm the pull; pass -y to pull into it.\n`));
                process.exit(1);
            }
            console.log(chalk.yellow(`Destination "${shown(destination)}" is not empty (${entries.length} items).`));
            console.log(chalk.yellow("Pulling overwrites tracked files; local files the folder doesn't track are refused unless --overwrite."));
            const response = await prompts({ type: 'confirm', name: 'proceed', message: 'Continue?', initial: false });
            if (!response.proceed) {
                console.log(chalk.gray('Cancelled.'));
                process.exit(0);
            }
        }
    }
```

The `previousManifest` read above it (`fs.existsSync(destination) ? readManifest(destination) : null`) gets the same `try`/`catch` with the same `cannot read` line.

- [ ] **Step 4: Migrate the two older tests (I1).**
  - In `tests/doc-pull-write-safety.test.ts`, the prompt-text test (~565-570) spawned without a terminal. It now asserts the no-terminal line and exit 1. Its prompt-text coverage moves to case 6 above: assert both yellow lines appear in the PTY output there.
  - In `tests/doc-pull.test.ts`, replace the in-process "declining the prompt exits 0" test (~893-920) with a pointer comment to `tests/doc-pull-destination-checks.test.ts` case 6, which covers the same behaviour through a real terminal. Remove the test's helper usage only where nothing else in the file needs it.

- [ ] **Step 5: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull-destination-checks.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-1-green.log`
Then (run the heavy-run gate first): `npx vitest run --project unit tests/doc-pull.test.ts tests/doc-pull-write-safety.test.ts tests/doc-pull-display-guard.test.ts tests/doc-pull-display-text.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-1-neighbours.log`
Expected: PASS.

- [ ] **Step 6: Report (do not commit).** List every changed path, each older test you changed (by name, old vs new expectation), each run with its counts and log path, and anything you had to stop on.

---

### Task 2: the staging-folder commit module (cli#168, cli#188, cli#182)

**Files (file scope):**
- Create: `src/utils/doc-pull-writes.ts`
- Create: `tests/doc-pull-writes.test.ts` (direct tests against real temp directories)

**Interfaces:**
- Consumes: nothing from this wave.
- Produces (exactly these exports; Task 3 uses them):
  - `STAGING_PREFIX = '.solidactions-pull-'`
  - `class LinkOnTheWayError extends Error { readonly component: string }`
  - `class PublicationRefusedError extends Error { readonly relPath: string }`
  - `class WriteStepError extends Error { readonly relPath: string; readonly cause: unknown }`
  - `class AnotherPullRunningError extends Error { readonly pid: number }`
  - `class ForeignStagingEntryError extends Error { readonly entryName: string }`
  - `class LeftoverDiffersError extends Error { readonly folderName: string; readonly differing: string[] }`
  - `type Authorized = { kind: 'absent' } | { kind: 'sha256'; sha256: string } | { kind: 'any' }`
  - `interface PlannedWrite { relPath: string; dirRel: string; data: string | Buffer; authorized: Authorized }`
  - `interface Commit { destination: string; stagingAbs: string; manifestName: string; items: CommitItem[]; createdDirs: string[] }`
  - `interface CommitItem extends PlannedWrite { newAbs: string; targetAbs: string; backupAbs: string | null; placed: boolean }`
  - `interface Faults { failManifestTemp: boolean; failManifestRename: boolean; beforeCommit(destination: string): void; beforeRename(n: number): void; afterRename(n: number): void; beforeRestore(n: number): void }`
  - `function faultsFromEnv(env?: NodeJS.ProcessEnv): Faults`
  - `function authorizedStateOf(targetAbs: string, overwrite: boolean): Authorized`
  - `function ensureRealDirs(destination: string, dirRel: string, createdDirs: string[] | null): string`
  - `function stageAll(destination: string, manifestName: string, writes: PlannedWrite[], manifestBytes: string, faults: Faults): Commit`
  - `function commitAll(commit: Commit, faults: Faults): void`
  - `function rollbackAll(commit: Commit, faults: Faults): { restoreFailure: { relPath: string; error: unknown } | null }`
  - `function finalizeCommit(commit: Commit): { error: unknown } | null`
  - `function cleanupLeftovers(destination: string): { restored: string[]; cleaned: number }`
  - `function writeFileAtomic(dir: string, name: string, data: string | Buffer): void`

**Spec:** §1.1-1.5, §1.8, §1.9.

- [ ] **Step 1: Write the failing tests** in `tests/doc-pull-writes.test.ts`.
  - Each test makes its own `fs.mkdtempSync` root, with `dest = <root>/dest`, `M = '.solidactions-docs.json'`, `none = faultsFromEnv({})`, and `hooks(fault) = faultsFromEnv({ SOLIDACTIONS_TEST_HOOKS: '1', SOLIDACTIONS_DOC_PULL_TEST_FAULT: fault })`. It removes the root after.
  - `w(rel, data, authorized)` builds a `PlannedWrite` (`dirRel` = the rel's folder, or `''`).
  - `go(writes, faults)` = `stageAll(dest, M, writes, '{"v":2}\n', faults)` then `commitAll(c, faults)` then `finalizeCommit(c)`.
  1. **Happy path:**
     - Writes: `a.md` (`absent`) and `x/y/b.md` (`absent`).
     - Both targets hold their bytes, the manifest reads `{"v":2}\n`, and `finalizeCommit` returns `null`.
     - Nothing named `.solidactions-pull-*` remains under `dest`.
  2. **Staging touches no target:** after `stageAll`, before `commitAll`, no target exists. `<dest>/.solidactions-pull-<pid>/new/0` and `…/manifest.tmp` exist.
  3. **Replacing a tracked file:** `dest/a.md` holds `OLD`, with `authorized = authorizedStateOf(<dest>/a.md, false)` (a `sha256`). After `go`, `a.md` reads `NEW`.
  4. **Link on the way:** `ensureRealDirs(dest, 'x/y', [])` with `dest/x` a symlink to `<root>/outside` throws `LinkOnTheWayError`, whose `component` is `'x'`. Nothing is created under `<root>/outside`.
  5. **Late file, INV-B (cli#182/C2):**
     - Stage `n.md` (`absent`), then `fs.writeFileSync(<dest>/n.md, 'LATE')`.
     - `commitAll` throws `PublicationRefusedError('n.md')`. After `rollbackAll`, `n.md` reads `LATE`, and the staging folder is gone.
     - With `authorized: { kind: 'any' }`, the commit succeeds and `n.md` holds the staged bytes.
     - With `any` plus a second write whose rename fails (`hooks('fail-rename:2')`), rollback restores `n.md` to `LATE`: the late file was backed up.
  6. **Late link:** the same as case 5, but the late entry is a symlink to `<root>/outside.txt` (`OUTSIDE`).
     - With `absent`, the commit is refused, and after rollback the link is still there and `outside.txt` reads `OUTSIDE`.
     - With `any`, `n.md` becomes a regular file, and `outside.txt` still reads `OUTSIDE`.
  7. **Hard link (cli#188):** `dest/a.md` (`OLD`) is hard-linked as `<root>/other.txt`. After `go` with a `sha256` authorization, `a.md` reads `NEW`, and `other.txt` reads `OLD`.
  8. **Rollback restores the original inode:**
     - `dest/a.md` (`A1`, hard-linked as `<root>/other.txt`) and `dest/sub/b.md` (`B1`). Use `hooks('fail-rename:2')`.
     - `commitAll` throws `WriteStepError` with `relPath 'sub/b.md'`.
     - `rollbackAll` returns `{ restoreFailure: null }`: `a.md` reads `A1` with the same inode as `other.txt`, and `sub/b.md` reads `B1`.
     - The manifest is untouched, and no staging folder remains.
  9. **Manifest temp failure:** with `hooks('fail-manifest-temp')`, `stageAll` throws `WriteStepError` with `relPath M`. No staging folder remains, and no target changed.
  10. **Manifest rename failure:** with `hooks('fail-manifest-rename')`, `commitAll` throws `WriteStepError` with `relPath M` after every doc rename. `rollbackAll` restores every doc, and the old manifest bytes are unchanged.
  11. **Restore failure keeps the folder:**
      - Use one faults object for the whole run: `hooks('fail-rename:2,fail-restore:1')`.
      - It returns a `restoreFailure` naming the doc whose backup it failed to restore. The staging folder still exists, holding that backup.
      - Then `cleanupLeftovers(dest)` restores it (the target is absent or identical) and removes the folder.
  12. **Mode kept:** a target with mode `0o600` keeps `0o600` after `go`.
  13. **Leftovers** (`cleanupLeftovers`), each set up by hand under `<dest>/.solidactions-pull-999999` (assume that pid is not running; pick one with `process.kill(pid, 0)` throwing `ESRCH`):
      - no such folder → `{ restored: [], cleaned: 0 }`;
      - `backup/sub/b.md` (`B1`) with `sub/b.md` absent → restored, the folder is removed, and the result is `restored: ['sub/b.md']`;
      - a backup with identical bytes at its target → the backup is dropped and the folder is removed;
      - a backup whose target differs → throws `LeftoverDiffersError` (`differing: ['a.md']`), and the folder and both files are unchanged;
      - a folder named with the pid of a live child process (spawn `sleep 5`, and kill it after) → throws `AnotherPullRunningError` with that pid;
      - `.solidactions-pull-1` as a symlink → throws `ForeignStagingEntryError`;
      - a backup whose target folder `sub` is now a symlink to `<root>/outside` → throws `LinkOnTheWayError`, and nothing is written outside;
      - running `cleanupLeftovers` twice in a row is safe (the second returns `cleaned: 0`).
  14. **`writeFileAtomic`** writes, and replaces a symlink at its name without following it.
  15. **Faults are inert without the switch:** `faultsFromEnv({ SOLIDACTIONS_DOC_PULL_TEST_FAULT: 'fail-rename:1' })` → a commit succeeds.

- [ ] **Step 2: Run them and watch them fail** (the module is missing).
Run: `npx vitest run --project unit tests/doc-pull-writes.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-2-red.log`
Expected: FAIL (cannot resolve `../src/utils/doc-pull-writes`).

- [ ] **Step 3: Implement** `src/utils/doc-pull-writes.ts`:

```ts
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * doc pull's commit (cli#168, cli#188, cli#182; spec §1, PM ruling 7). Every file is
 * staged in <destination>/.solidactions-pull-<pid>/, then renamed into place after its
 * target is re-checked against the state the preflight authorized; whatever it replaces
 * is kept as a backup in the staging folder, and the manifest is published last. Any
 * in-process failure restores the backups. A killed pull leaves the old manifest and its
 * staging folder, which the next pull cleans up (cleanupLeftovers). A rename replaces the
 * directory entry, so a hard link's other names keep their bytes and a link at the final
 * name is replaced, not followed. Node has no openat: a directory component swapped for a
 * link between the walk and the rename is a documented residual race (spec §1.6). No
 * power-loss durability is claimed.
 */
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NEW_FILE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW;

export const STAGING_PREFIX = '.solidactions-pull-';
const STAGING_PATTERN = /^\.solidactions-pull-(\d+)$/;

export class LinkOnTheWayError extends Error {
    constructor(public readonly component: string) {
        super(`${component} is a symbolic link or not a directory`);
        this.name = 'LinkOnTheWayError';
    }
}

export class PublicationRefusedError extends Error {
    constructor(public readonly relPath: string) {
        super(`${relPath} changed after doc pull checked it`);
        this.name = 'PublicationRefusedError';
    }
}

export class WriteStepError extends Error {
    constructor(public readonly relPath: string, public readonly cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = 'WriteStepError';
    }
}

export class AnotherPullRunningError extends Error {
    constructor(public readonly pid: number) {
        super(`another doc pull (pid ${pid}) is running`);
        this.name = 'AnotherPullRunningError';
    }
}

export class ForeignStagingEntryError extends Error {
    constructor(public readonly entryName: string) {
        super(`${entryName} is not a folder doc pull created`);
        this.name = 'ForeignStagingEntryError';
    }
}

export class LeftoverDiffersError extends Error {
    constructor(public readonly folderName: string, public readonly differing: string[]) {
        super(`${differing.length} file(s) differ from their saved copies in ${folderName}`);
        this.name = 'LeftoverDiffersError';
    }
}

export type Authorized = { kind: 'absent' } | { kind: 'sha256'; sha256: string } | { kind: 'any' };

export interface PlannedWrite {
    relPath: string;
    dirRel: string;
    data: string | Buffer;
    authorized: Authorized;
}

export interface CommitItem extends PlannedWrite {
    newAbs: string;
    targetAbs: string;
    backupAbs: string | null;
    placed: boolean;
}

export interface Commit {
    destination: string;
    stagingAbs: string;
    manifestName: string;
    items: CommitItem[];
    createdDirs: string[];
}

export interface Faults {
    failManifestTemp: boolean;
    failManifestRename: boolean;
    beforeCommit(destination: string): void;
    beforeRename(n: number): void;
    afterRename(n: number): void;
    beforeRestore(n: number): void;
}

const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');
const segments = (rel: string): string[] => rel.split('/');

function ioFault(what: string): Error {
    return Object.assign(new Error(`EIO: i/o error, ${what} (test hook)`), { code: 'EIO' });
}

/**
 * Test-only injected failures (spec §1.8, sanctioned by PM ruling 7). Inert unless
 * SOLIDACTIONS_TEST_HOOKS=1. Never documented for users.
 */
export function faultsFromEnv(env: NodeJS.ProcessEnv = process.env): Faults {
    const none: Faults = {
        failManifestTemp: false,
        failManifestRename: false,
        beforeCommit: () => undefined,
        beforeRename: () => undefined,
        afterRename: () => undefined,
        beforeRestore: () => undefined,
    };
    if (env.SOLIDACTIONS_TEST_HOOKS !== '1') return none;
    const faults: Faults = { ...none };
    // A comma-separated list combines faults, e.g. "fail-rename:2,fail-restore:1".
    for (const spec of (env.SOLIDACTIONS_DOC_PULL_TEST_FAULT ?? '').split(',')) {
        const [name, arg = ''] = spec.split(/:(.*)/s);
        switch (name) {
            case 'fail-rename':
                faults.beforeRename = (n) => { if (n === Number(arg)) throw ioFault('rename'); };
                break;
            case 'fail-manifest-temp':
                faults.failManifestTemp = true;
                break;
            case 'fail-manifest-rename':
                faults.failManifestRename = true;
                break;
            case 'fail-restore':
                faults.beforeRestore = (n) => { if (n === Number(arg)) throw ioFault('restore'); };
                break;
            case 'kill-after-renames':
                faults.afterRename = (n) => { if (n === Number(arg)) process.kill(process.pid, 'SIGKILL'); };
                break;
            case 'create-before-commit':
                faults.beforeCommit = (destination) => fs.writeFileSync(path.join(destination, ...segments(arg)), 'RACE');
                break;
            case 'link-before-commit': {
                const [linkRel, linkTarget] = arg.split('>');
                faults.beforeCommit = (destination) => fs.symlinkSync(linkTarget, path.join(destination, ...segments(linkRel)));
                break;
            }
            default:
                break;
        }
    }
    return faults;
}

function lstatOrNull(abs: string): fs.Stats | null {
    try {
        return fs.lstatSync(abs);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

/** The state the preflight authorizes for a target (spec §1.3 step 2). */
export function authorizedStateOf(targetAbs: string, overwrite: boolean): Authorized {
    if (overwrite) return { kind: 'any' };
    const stat = lstatOrNull(targetAbs);
    if (stat === null) return { kind: 'absent' };
    if (!stat.isFile()) return { kind: 'absent' }; // never matches: a non-file target is refused at commit
    return { kind: 'sha256', sha256: sha256(fs.readFileSync(targetAbs)) };
}

function stillAuthorized(targetAbs: string, authorized: Authorized): boolean {
    if (authorized.kind === 'any') return true;
    const stat = lstatOrNull(targetAbs);
    if (authorized.kind === 'absent') return stat === null;
    return stat !== null && stat.isFile() && sha256(fs.readFileSync(targetAbs)) === authorized.sha256;
}

export function ensureRealDirs(destination: string, dirRel: string, createdDirs: string[] | null): string {
    const parts = dirRel === '' ? [] : segments(dirRel);
    let current = destination;
    for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i]);
        let stat = lstatOrNull(current);
        if (stat === null) {
            if (createdDirs === null) throw Object.assign(new Error(`ENOENT: no such directory, ${current}`), { code: 'ENOENT' });
            fs.mkdirSync(current);
            createdDirs.push(current);
            stat = fs.lstatSync(current);
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new LinkOnTheWayError(parts.slice(0, i + 1).join('/'));
        }
    }
    return current;
}

function writeNew(abs: string, data: string | Buffer): void {
    const fd = fs.openSync(abs, NEW_FILE_FLAGS, 0o666);
    try {
        fs.writeFileSync(fd, data);
    } finally {
        fs.closeSync(fd);
    }
}

export function stageAll(destination: string, manifestName: string, writes: PlannedWrite[], manifestBytes: string, faults: Faults): Commit {
    const stagingName = `${STAGING_PREFIX}${process.pid}`;
    const stagingAbs = path.join(destination, stagingName);
    try {
        fs.mkdirSync(stagingAbs, { mode: 0o700 });
        fs.mkdirSync(path.join(stagingAbs, 'new'));
    } catch (error) {
        throw new WriteStepError(stagingName, error);
    }
    const commit: Commit = { destination, stagingAbs, manifestName, items: [], createdDirs: [] };
    try {
        writes.forEach((write, index) => {
            const newAbs = path.join(stagingAbs, 'new', String(index));
            try {
                writeNew(newAbs, write.data);
            } catch (error) {
                throw new WriteStepError(write.relPath, error);
            }
            commit.items.push({ ...write, newAbs, targetAbs: path.join(destination, ...segments(write.relPath)), backupAbs: null, placed: false });
        });
        try {
            if (faults.failManifestTemp) throw ioFault('open manifest.tmp');
            writeNew(path.join(stagingAbs, 'manifest.tmp'), manifestBytes);
        } catch (error) {
            throw new WriteStepError(manifestName, error);
        }
    } catch (error) {
        fs.rmSync(stagingAbs, { recursive: true, force: true });
        throw error;
    }
    return commit;
}

export function commitAll(commit: Commit, faults: Faults): void {
    faults.beforeCommit(commit.destination);
    for (let i = 0; i < commit.items.length; i++) {
        const item = commit.items[i];
        try {
            ensureRealDirs(commit.destination, item.dirRel, commit.createdDirs);
        } catch (error) {
            if (error instanceof LinkOnTheWayError) throw error;
            throw new WriteStepError(item.relPath, error);
        }
        if (!stillAuthorized(item.targetAbs, item.authorized)) throw new PublicationRefusedError(item.relPath);
        try {
            const existing = lstatOrNull(item.targetAbs);
            if (existing !== null) {
                // Backed up at commit time, so a target created late under --overwrite is restorable too.
                const backupAbs = path.join(commit.stagingAbs, 'backup', ...segments(item.relPath));
                fs.mkdirSync(path.dirname(backupAbs), { recursive: true });
                if (existing.isFile()) fs.chmodSync(item.newAbs, existing.mode & 0o7777);
                fs.renameSync(item.targetAbs, backupAbs);
                item.backupAbs = backupAbs;
            }
            faults.beforeRename(i + 1);
            fs.renameSync(item.newAbs, item.targetAbs);
            item.placed = true;
        } catch (error) {
            throw new WriteStepError(item.relPath, error);
        }
        faults.afterRename(i + 1);
    }
    try {
        if (faults.failManifestRename) throw ioFault('rename manifest');
        fs.renameSync(path.join(commit.stagingAbs, 'manifest.tmp'), path.join(commit.destination, commit.manifestName));
    } catch (error) {
        throw new WriteStepError(commit.manifestName, error);
    }
}

export function rollbackAll(commit: Commit, faults: Faults): { restoreFailure: { relPath: string; error: unknown } | null } {
    let restoreFailure: { relPath: string; error: unknown } | null = null;
    let restoring = 0;
    for (const item of [...commit.items].reverse()) {
        if (item.backupAbs === null && !item.placed) continue;
        try {
            if (item.backupAbs !== null) {
                restoring += 1;
                faults.beforeRestore(restoring);
                fs.renameSync(item.backupAbs, item.targetAbs); // the original inode, links included
                item.backupAbs = null;
            } else {
                fs.unlinkSync(item.targetAbs); // this pull's new file
            }
            item.placed = false;
        } catch (error) {
            restoreFailure ??= { relPath: item.relPath, error };
        }
    }
    for (const dir of [...commit.createdDirs].reverse()) {
        try {
            fs.rmdirSync(dir);
        } catch {
            // not empty, or gone: keep it
        }
    }
    if (restoreFailure === null) fs.rmSync(commit.stagingAbs, { recursive: true, force: true });
    return { restoreFailure };
}

export function finalizeCommit(commit: Commit): { error: unknown } | null {
    try {
        fs.rmSync(commit.stagingAbs, { recursive: true, force: false });
        return null;
    } catch (error) {
        return { error };
    }
}

function pidRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/** Every leaf (file or link) under `root`, as '/'-joined paths; never follows a link. */
function walkLeaves(root: string, prefix = ''): string[] {
    const stat = lstatOrNull(root);
    if (stat === null) return [];
    const out: string[] = [];
    for (const name of fs.readdirSync(root)) {
        const abs = path.join(root, name);
        const rel = prefix === '' ? name : `${prefix}/${name}`;
        const entry = fs.lstatSync(abs);
        if (entry.isDirectory() && !entry.isSymbolicLink()) out.push(...walkLeaves(abs, rel));
        else out.push(rel);
    }
    return out;
}

function sameEntry(aAbs: string, bAbs: string): boolean {
    const a = fs.lstatSync(aAbs);
    const b = fs.lstatSync(bAbs);
    if (a.isSymbolicLink() && b.isSymbolicLink()) return fs.readlinkSync(aAbs) === fs.readlinkSync(bAbs);
    if (a.isFile() && b.isFile()) return fs.readFileSync(aAbs).equals(fs.readFileSync(bAbs));
    return false;
}

/** Clean up after a killed pull (spec §1.4). Idempotent: a second run finds nothing to do. */
export function cleanupLeftovers(destination: string): { restored: string[]; cleaned: number } {
    const restored: string[] = [];
    let cleaned = 0;
    for (const name of fs.readdirSync(destination)) {
        const match = STAGING_PATTERN.exec(name);
        if (match === null) continue;
        const folderAbs = path.join(destination, name);
        const stat = fs.lstatSync(folderAbs);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ForeignStagingEntryError(name);
        const pid = Number(match[1]);
        if (pid !== process.pid && pidRunning(pid)) throw new AnotherPullRunningError(pid);

        const backupRoot = path.join(folderAbs, 'backup');
        const differing: string[] = [];
        for (const rel of walkLeaves(backupRoot)) {
            const slash = rel.lastIndexOf('/');
            ensureRealDirs(destination, slash === -1 ? '' : rel.slice(0, slash), []);
            const backupAbs = path.join(backupRoot, ...segments(rel));
            const targetAbs = path.join(destination, ...segments(rel));
            if (lstatOrNull(targetAbs) === null) {
                fs.renameSync(backupAbs, targetAbs);
                restored.push(rel);
            } else if (sameEntry(backupAbs, targetAbs)) {
                fs.unlinkSync(backupAbs);
            } else {
                differing.push(rel);
            }
        }
        if (differing.length > 0) throw new LeftoverDiffersError(name, differing);
        fs.rmSync(folderAbs, { recursive: true, force: true });
        cleaned += 1;
    }
    return { restored, cleaned };
}

/** Write `dir/name` through a sibling temp file and a rename: never half-written, never through a link at `name`. */
export function writeFileAtomic(dir: string, name: string, data: string | Buffer): void {
    const tempAbs = path.join(dir, `.sa-write-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
    writeNew(tempAbs, data);
    try {
        const existing = lstatOrNull(path.join(dir, name));
        if (existing !== null && existing.isFile()) fs.chmodSync(tempAbs, existing.mode & 0o7777);
        fs.renameSync(tempAbs, path.join(dir, name));
    } catch (error) {
        try {
            fs.unlinkSync(tempAbs);
        } catch {
            // already gone
        }
        throw error;
    }
}
```

- [ ] **Step 4: Run GREEN.**
Run: `npx vitest run --project unit tests/doc-pull-writes.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-2-green.log`
Then: `npm run build 2>&1 | tail -3` (it must compile cleanly).
Expected: PASS, and the build is clean.

- [ ] **Step 5: Report (do not commit).** List every changed path, each run with its counts and log path, and anything you had to stop on.

---

### Task 3: doc pull commits through the staging folder (cli#168, cli#188, cli#182)

**Files (file scope):**
- Modify: `src/commands/doc-pull.ts`:
  - `docPullWithConfig`: the leftover check before the destination checks;
  - `commitDocs` and `report()`: the final manifest computed before writes, the authorized states, the module calls, rollback, finalize, and rename cleanup plus deletion propagation after publication.
  - Task 1 edited `docPullWithConfig`'s destination block; keep it.
- Modify: `src/utils/docs-manifest.ts` (`writeManifest` uses `writeFileAtomic`)
- Create: `tests/doc-pull-transactional.test.ts` (spawned; the failure points and leftovers)
- Modify: `tests/doc-pull-write-safety.test.ts` (the hard-link stand-in tests ~433-478, I1)
- Modify: `tests/doc-pull-rename-matrix.test.ts` (`sameFileCases` ~619-636 and the "two renamed docs alias each other targets via hardlinks" rows ~744-761, I1)
- Modify: `tests/doc-pull.test.ts` (the case-only rename hard-link test ~1864-1898, I1)
- Modify: `tests/doc-pull-display-guard.test.ts` (only `ALLOWED` entries for new printed names that hold no raw server text, each with a reason, I1)
- Modify: `README.md` (`### doc` section: one paragraph, spec §1.9)

**Interfaces:**
- Consumes: everything Task 2 produces (`src/utils/doc-pull-writes.ts`).
- Produces: `report()` builds `manifestDocs` and a `pendingWarnings: string[]` before any write. Task 4 edits those rules.

**Spec:** §1.3-1.5, §1.8, §1.9. Lines (values through `shown()`; `<D>` is the destination):
- write failure: `error: cannot write <rel>: <error message> — nothing was changed.`
- publication refusal: `error: <rel> changed after doc pull checked it — nothing was changed. Pull again, or pass --overwrite to replace it.`
- rollback incomplete: `error: cannot write <rel>: <error message> — could not restore <rel2> (<message>); its previous copy is in <staging name>/backup/<rel2>.` (the refusal form ends the same way)
- staging left behind after success: `! could not remove <staging name>: <message> — it holds the previous copies of the files this pull replaced; delete it yourself`
- leftovers: `! cleaned up after an interrupted doc pull in <D> (restored <n> file(s))`; `error: an interrupted doc pull left saved copies in <D>/<name>; <k> file(s) differ from their saved copies (first: <rel>), so neither was changed. Keep the versions you want, delete that folder, and pull again.`; `error: another doc pull (pid <pid>) is writing to <D>; wait for it to finish.`; `error: <D>/<name> is not a folder doc pull created; remove it and pull again.`

- [ ] **Step 1: Write the failing tests** in `tests/doc-pull-transactional.test.ts`.
  - Fixture: a first pull (`-y`) writes `a.md` (`A1`), `sub/b.md` (`B1`) and media `pic.png` (`P1`).
  - `snapshot(out)` maps every entry under `<out>` (dot-entries included) to its bytes, and every regular file to its inode.
  - Each case serves `A2`, `B2`, `P2` and pulls again with `-y`.
  - "Nothing changed" means: `snapshot` equals the one taken before (bytes, inodes, manifest), and no `.solidactions-pull-*` entry exists.
  - Fault cases set `SOLIDACTIONS_TEST_HOOKS=1` and `SOLIDACTIONS_DOC_PULL_TEST_FAULT`.
  1. **Each doc rename fails:** for `fail-rename:1`, `fail-rename:2` and `fail-rename:3`: exit 1, the write-failure line naming that doc, nothing changed (the docs renamed before it are restored with their original inodes).
  2. **Manifest temp fails** (`fail-manifest-temp`): exit 1, the write-failure line names `.solidactions-docs.json`, nothing changed.
  3. **Manifest rename fails** (`fail-manifest-rename`): the same; every doc is restored.
  4. **Doc temp fails for real** (skip on win32/root): `chmod 0o555 <out>` (the root, where the staging folder must be created). Exit 1, the write-failure line names the `.solidactions-pull-<pid>` folder, nothing changed.
  5. **Publication refusal (INV-B):** the server adds a new doc `n.md`, and the fault is `create-before-commit:n.md`. Exit 1, the refusal line for `n.md`, `n.md` reads `RACE`, and everything else is unchanged. With `--overwrite`: exit 0, `n.md` holds the served bytes.
  6. **A planted link:** `link-before-commit:n.md><tmp>/outside.txt`. Without `--overwrite`: exit 1, the refusal line, `outside.txt` unchanged, and the link left in place. With `--overwrite`: exit 0, `n.md` is a regular file, and `outside.txt` is unchanged.
  7. **Restore failure:** `fail-rename:3,fail-restore:1`. Exit 1, the rollback-incomplete line, and the `.solidactions-pull-<pid>` folder kept. A second, hook-free pull prints the cleaned-up line (the target of the unrestored backup is absent, or holds identical bytes) and completes.
  8. **Killed mid-commit:** `kill-after-renames:1`. The child is killed (`signal === 'SIGKILL'`), the manifest is the old one, and the staging folder exists.
     - A second, hook-free pull prints the leftover-differs error and exits 1: `a.md` now holds `A2`, while its saved copy holds `A1`. Both stay, and the folder is kept.
     - After the test deletes the folder by hand, a third pull with `--overwrite` completes.
  9. **Killed after only new files:** the server adds `n.md`, ordered first, and the fault is `kill-after-renames:1`. The second pull prints `! cleaned up after an interrupted doc pull in <out> (restored 0 file(s))`, then adopts `n.md` (identical bytes) and completes.
  10. **Another pull running:** create `<out>/.solidactions-pull-<pid of a live child>` (spawn `sleep 5`). The pull exits 1 with the another-pull line, nothing changed. Kill the child after.
  11. **A foreign entry:** `<out>/.solidactions-pull-1` as a symlink. Exit 1, the not-a-folder line.
  12. **Hard link (cli#188):** hard-link `<tmp>/outside.md` to `<out>/a.md`. Pull: exit 0, `a.md` reads `A2`, and `outside.md` still reads `A1`.
  13. **Mode kept:** `chmod 0o600 <out>/a.md` before the pull; afterwards it is still `0o600`.

- [ ] **Step 2: Run them and watch them fail.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull-transactional.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-3-red.log`
Expected: FAIL on cases 1-12 (case 13 may pass today: say so). The hooks are inert before Step 3, so the fault cases fail on their assertions.

- [ ] **Step 3: Implement** in `src/commands/doc-pull.ts`.
  1. **Leftover check** (spec §1.4), at the top of `docPullWithConfig` when `destination` exists, before the `previousManifest` read:

```ts
        try {
            const leftovers = cleanupLeftovers(destination);
            if (leftovers.cleaned > 0) {
                process.stderr.write(chalk.yellow(`! cleaned up after an interrupted doc pull in ${shown(destination)} (restored ${leftovers.restored.length} file(s))\n`));
            }
        } catch (error) {
            if (error instanceof AnotherPullRunningError) {
                process.stderr.write(chalk.red(`error: another doc pull (pid ${error.pid}) is writing to ${shown(destination)}; wait for it to finish.\n`));
            } else if (error instanceof ForeignStagingEntryError) {
                process.stderr.write(chalk.red(`error: ${shown(path.join(destination, error.entryName))} is not a folder doc pull created; remove it and pull again.\n`));
            } else if (error instanceof LeftoverDiffersError) {
                process.stderr.write(chalk.red(`error: an interrupted doc pull left saved copies in ${shown(path.join(destination, error.folderName))}; ${error.differing.length} file(s) differ from their saved copies (first: ${shown(error.differing[0])}), so neither was changed. Keep the versions you want, delete that folder, and pull again.\n`));
            } else if (error instanceof LinkOnTheWayError) {
                process.stderr.write(chalk.red(`error: cannot restore an interrupted pull's saved copies: ${shown(error.component)} is a symbolic link or not a directory.\n`));
            } else {
                throw error;
            }
            process.exit(1);
        }
```

     (`error.pid` is a number. If the display guard flags it, add an `ALLOWED` entry with the reason "a process id, a number".)
  2. **Final manifest and authorized states first** (spec §1.3 step 2). In `report()`, move every rule that changes `manifestDocs` so it runs **before** any write:
     - today's rule-5 block (a failed download over a local file);
     - the rename-keep block (`!m.replacementWritten` restores the old entry);
     - the single-doc merge.

     Their yellow warning lines go into `pendingWarnings`, printed after publication. `commitDocs` no longer writes: it returns the manifest entries for `planned`, in today's entry shape. Then build:

```ts
    const writes: PlannedWrite[] = [];
    for (const p of planned) {
        const data = p.isMedia ? p.mediaBytes : p.doc.body;
        if (data === null) continue; // a failed media download writes nothing
        const targetAbs = path.join(destination, ...p.relPath.split('/'));
        writes.push({ relPath: p.relPath, dirRel: p.dirRel, data, authorized: authorizedStateOf(targetAbs, options.overwrite === true) });
    }
    const manifestBytes = `${JSON.stringify({ folder_path: folderPath, docs }, null, 2)}\n`;
```

     The authorized states are taken right after wave cli-safety's checks, before anything is written.
  3. **The commit**, replacing today's `commitDocs` write loop and `writeManifest(destination, manifest)`:

```ts
    fs.mkdirSync(destination, { recursive: true });
    const faults = faultsFromEnv();
    let commit: Commit | null = null;
    try {
        commit = stageAll(destination, DOCS_MANIFEST, writes, manifestBytes, faults);
        commitAll(commit, faults);
    } catch (error) {
        const restoreFailure = commit === null ? null : rollbackAll(commit, faults).restoreFailure;
        const stagingName = `${STAGING_PREFIX}${process.pid}`;
        const tail = restoreFailure === null
            ? 'nothing was changed.'
            : `could not restore ${shown(restoreFailure.relPath)} (${shown((restoreFailure.error as Error).message)}); its previous copy is in ${shown(`${stagingName}/backup/${restoreFailure.relPath}`)}.`;
        if (error instanceof LinkOnTheWayError) {
            const p = planned.find((q) => q.relPath.startsWith(`${error.component}/`))!;
            refuseLink(p.relPath, error.component, p.doc);
        }
        if (error instanceof PublicationRefusedError) {
            process.stderr.write(chalk.red(`error: ${shown(error.relPath)} changed after doc pull checked it — ${tail} Pull again, or pass --overwrite to replace it.\n`));
            process.exit(1);
        }
        const relPath = error instanceof WriteStepError ? error.relPath : DOCS_MANIFEST;
        process.stderr.write(chalk.red(`error: cannot write ${shown(relPath)}: ${shown((error as Error).message)} — ${tail}\n`));
        process.exit(1);
    }
    const leftover = finalizeCommit(commit!);
    if (leftover !== null) {
        process.stderr.write(chalk.yellow(`! could not remove ${shown(`${STAGING_PREFIX}${process.pid}`)}: ${shown((leftover.error as Error).message)} — it holds the previous copies of the files this pull replaced; delete it yourself\n`));
    }
    for (const line of pendingWarnings) process.stderr.write(chalk.yellow(`${line}\n`));
```

     `tail` holds only `shown()` parts: add it to the display guard's `ALLOWED` with that reason if the guard flags it. The `files` list (paths written) is every `commit.items` entry with `placed`.
  4. **After publication**, unchanged in logic: compute `writtenIdentities` from the written files, run the rename-cleanup **removal** loop (today's `fs.rmSync` part), print the existing warnings, and run deletion propagation. None of these may run before publication.
  5. `src/utils/docs-manifest.ts`: `writeManifest` becomes `writeFileAtomic(dir, DOCS_MANIFEST, \`${JSON.stringify(manifest, null, 2)}\n\`)`.
  6. README `### doc` paragraph (spec §1.9): "`doc pull` writes everything to a staging folder (`.solidactions-pull-<pid>`) inside the destination first, then moves the files into place and saves the manifest last. If it fails, it puts back every file it replaced and leaves the manifest unchanged. If the process is killed while moving files, the manifest is the old one, and tracked files are always re-checked by hash, so nothing is overwritten silently. The next pull cleans up the leftover folder, or tells you which files to resolve. There is no guarantee after a power loss."

- [ ] **Step 4: Migrate the hard-link stand-ins (I1).** These tests used a hard link to stand in for a case-insensitive alias. After this task, a pull replaces a file through a rename, so a hard link is an **independent** name: it keeps the old bytes, and rename cleanup removes an unmodified old twin. For each test listed in Files:
  1. Rewrite the Linux hard-link version to assert exactly:
     - **write-safety "a same-file case-only rename adopts instead of refusing, with no --overwrite":** exit 0, `page.md` reads `NEW5`, `Page.md` is gone, the manifest keys are `['page.md']`, and stderr has no `not tracked` and no `kept … same file`.
     - **write-safety "a cross-alias hard link under --overwrite …":** exit 0. `new5.md`/`new6.md` read `NEW5`/`NEW6B`, `page.md` and `other.md` are gone, stderr has no `kept … same file`, and the manifest is unchanged from today's expectation.
     - **rename-matrix `sameFileCases`** (unmodified source, hard-linked target): the after files become `{ [newRel]: newBytes }` (oldRel removed), with the manifest unchanged.
     - **rename-matrix "two renamed docs alias each other targets via hardlinks":**
       - with `--overwrite`, the after files are `{ 'page.html': <its new bytes>, 'other.html': <six> }`, `page.md`/`other.md` are removed, and the M2 stderr expectations are dropped;
       - without `--overwrite`, today's refusal is unchanged.
     - **doc-pull.test.ts "case-only rename hard link"** (~1864-1898): `readme.md` holds `BODY`, `Readme.md` is gone, and the manifest keys are `['readme.md']`. Convert it to the spawned harness.
     If the code's actual result differs from one of these, stop and report it with the test name: do not change the expectation to whatever the code does.
  2. Keep each **true** alias as a separate test, gated by a runtime case-insensitivity check (spec §1.7): `it.skipIf(!caseInsensitive)('… (needs a case-insensitive filesystem; CI unit tests run on Linux)', …)`. Those tests assert today's expectation (both names show the new bytes; nothing is removed).

- [ ] **Step 5: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull-transactional.test.ts tests/doc-pull-writes.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-3-green.log`
Then (run the heavy-run gate first): `npx vitest run --project unit tests/doc-pull.test.ts tests/doc-pull-write-safety.test.ts tests/doc-pull-rename-matrix.test.ts tests/doc-pull-display-guard.test.ts tests/doc-pull-display-text.test.ts tests/doc-pull-destination-checks.test.ts tests/doc-push.test.ts tests/docs-manifest.test.ts tests/doc-media-401.test.ts tests/readme-contract.test.ts tests/host-display-guard.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-3-neighbours.log`
Expected: PASS (the rename matrix takes about a minute). Every skipped test names its reason in its title.

- [ ] **Step 6: Report (do not commit).** List every changed path, each older test you changed (by name, old vs new expectation), each run with its counts and log path, and anything you had to stop on.

---

### Task 4: a failed download keeps the tracking it had (cli#183, cli#190)

**Files (file scope):**
- Modify: `src/commands/doc-pull.ts`:
  - the manifest entry for a failed media download (now built before any write, Task 3);
  - the failed-download-over-a-local-file rule;
  - `report()`'s parameters and its two call sites in `docPullWithConfig`.
- Create: `tests/doc-pull-failed-download.test.ts` (spawned)
- Modify: `tests/doc-pull-write-safety.test.ts` (only the rule-5 warning assertion "failed to download and pic.png holds a local file; not tracking it" ~565, if its text gains the cli#190 sentence)
- Modify: `tests/doc-pull-display-guard.test.ts` (only to add one `ALLOWED` entry for `lost`, if the guard flags it, with the reason "built from shown() parts")

**Interfaces:**
- Consumes: Task 3's pre-write manifest building in `report()`.
- Produces: `report(…, listedIds: Set<number>)`, a new last parameter. A folder pull passes the ids of the listing rows; the single-doc fallback passes `new Set([data.id])`.

**Spec:** §2. Lines, for failed doc A at path P (values through `shown()`):
- B kept: `! doc <A id> ("<A title>") failed to download and <P> holds doc <B id>'s file ("<B title>"); still tracking it as doc <B id> — pull again later`
- B not kept: `! doc <A id> ("<A title>") failed to download and <P> holds a local file; not tracking it — pull again later. Doc <B id> ("<B title>") was tracked at <P> before and is no longer tracked there.`

- [ ] **Step 1: Write the failing tests** in `tests/doc-pull-failed-download.test.ts` (spawned; the media fixtures from `tests/doc-pull.test.ts`, with a signed-URL route you can make answer 500).
  1. **cli#183, with M1:**
     - A first pull writes media doc 5 at `pic.png` (revision 50, hash H1). Save that manifest entry.
     - Then the listing shows doc 5 with the **same title** (same path) but **revision 51**, and the download answers 500. Pull with `-y`: exit 0.
     - The manifest entry at `pic.png` is deep-equal to the saved entry (revision **50**, hash H1), not revision 51 and not `body_sha256: null`. `pic.png`'s bytes are unchanged.
  2. **cli#190, B kept.** Write the previous manifest and file by hand (as `tests/doc-pull-write-safety.test.ts` does): `<out>/P.png` tracked for doc B (id 9, with its real sha256).
     - The server lists media doc A (id 7) titled to land at `P.png`, plus doc B. `bulk_read` answers A found and B with a non-`found` status, so B is skipped with a warning.
     - A's download answers 500. Pull with `-y`.
     - Expect: the B-kept line, the manifest still has `P.png` → doc 9 with its hash, and `P.png` is unchanged.
  3. **cli#190, B gone:** the same, but B is not in the listing at all. Expect the B-not-kept line, and the manifest has no entry for doc 9 at `P.png`. Don't assert `P.png`'s presence: deletion propagation treats it as an orphan.
  4. **Unchanged:** a failed download at a new path with no previous entry keeps today's behaviour.

- [ ] **Step 2: Run them and watch them fail.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull-failed-download.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-4-red.log`
Expected: FAIL on 1-3; 4 passes.

- [ ] **Step 3: Implement** in `src/commands/doc-pull.ts`.
  - **The failed-download entry:** for `p.isMedia && p.mediaBytes === null`, when `previousManifest?.docs[p.relPath]` exists with `id === p.doc.id`, the entry is **that previous entry, unchanged**.
  - `report(…, listedIds)`: pass `new Set(rows.map((row) => row.id))` for a folder pull and `new Set([data.id])` for the single-doc fallback.
  - **The failed-download-over-a-local-file rule:** where today it deletes A's entry and queues the yellow warning, it becomes:

```ts
        const before = previousManifest?.docs[p.relPath];
        const otherDoc = before !== undefined && before.id !== p.doc.id && before.body_sha256 != null ? before : undefined;
        const plannedIds = new Set(planned.map((q) => q.doc.id));
        delete manifestDocs[p.relPath];
        if (otherDoc !== undefined && listedIds.has(otherDoc.id) && !plannedIds.has(otherDoc.id)) {
            // cli#190: the other doc is still on the server and was not moved: keep its tracking.
            manifestDocs[p.relPath] = otherDoc;
            pendingWarnings.push(`! doc ${p.doc.id} ("${shown(p.doc.title)}") failed to download and ${shown(p.relPath)} holds doc ${otherDoc.id}'s file ("${shown(otherDoc.title)}"); still tracking it as doc ${otherDoc.id} — pull again later`);
            continue;
        }
        const lost = otherDoc === undefined ? '' : ` Doc ${otherDoc.id} ("${shown(otherDoc.title)}") was tracked at ${shown(p.relPath)} before and is no longer tracked there.`;
        pendingWarnings.push(`! doc ${p.doc.id} ("${shown(p.doc.title)}") failed to download and ${shown(p.relPath)} holds a local file; not tracking it — pull again later.${lost}`);
```

  Keep the block's existing early `continue`s. Today it continues when the previous entry at P is the same doc with a hash; with cli#183 that entry is now the kept previous one.

- [ ] **Step 4: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull-failed-download.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-4-green.log`
Then (run the heavy-run gate first): `npx vitest run --project unit tests/doc-pull.test.ts tests/doc-pull-write-safety.test.ts tests/doc-pull-rename-matrix.test.ts tests/doc-pull-display-guard.test.ts tests/doc-pull-display-text.test.ts tests/doc-pull-transactional.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-4-neighbours.log`
Expected: PASS.

- [ ] **Step 5: Report (do not commit).** List every changed path, each older test you changed (by name), each run with its counts and log path, and anything you had to stop on.

---

### Task 5: one sweep test per invariant (cli#168, cli#188, cli#182, cli#183, cli#190; I2)

**Files (file scope):**
- Create: `tests/doc-pull-inv-outside.test.ts` (INV-A, spawned)
- Create: `tests/doc-pull-inv-no-clobber.test.ts` (INV-B, spawned)
- Create: `tests/doc-pull-inv-honest-manifest.test.ts` (INV-C, spawned)

**Interfaces:**
- Consumes: the CLI as built after Tasks 1-4, and its test-only injected failures (spec §1.8).
- Produces: tests only. If a sweep row fails on the built code, that is a finding: stop and report it with the row. Do not change `src/`.

**Spec:** §1.2 (the invariants), §1.7, §1.8, §2.

Each file builds its rows from a table and runs one spawned scenario per row. Each test title gives the row's coordinates.

- [ ] **Step 1: Write the sweep tests.**
  - **INV-A, never outside the destination (`doc-pull-inv-outside`).** Rows: {markdown, media} × {folder pull, single-doc pull} × the link case:
    - (a) a tracked file hard-linked to a file outside the destination;
    - (b) a symlink to an outside file at a new target name before the pull, which wave cli-safety refuses;
    - (c) a symlink to an outside file planted at a new target name after staging (`link-before-commit:<rel>><abs>`), both without and with `--overwrite`;
    - (d) case (a) plus an injected failure after its rename (`fail-rename:<n+1>`), so the rollback path runs.

    In every row, every file outside the destination keeps its bytes and inode.
  - **INV-B, no clobber (`doc-pull-inv-no-clobber`).** Rows: {an untracked file at the target at preflight, a file created at the target after staging (`create-before-commit`), a tracked file rewritten after staging (`create-before-commit` rewriting it)} × {without `--overwrite`: refused and the bytes unchanged; with `--overwrite`: replaced} × {markdown, media}. Add one composed row: with `--overwrite`, a late file at target 1, then `fail-rename:2`. The late file is restored with its bytes.
  - **INV-C, honest manifest (`doc-pull-inv-honest-manifest`).** For every row, after the pull exits (0 or 1): every manifest entry with a `body_sha256` matches the sha256 of the file at its path, and an exit-1 row leaves the manifest bytes identical to before. Rows are the product of:
    - **doc kind:** markdown, media;
    - **pull form:** folder, single-doc;
    - **target state:** new path, unchanged tracked path, renamed doc;
    - **outcome:** success, `fail-rename:1`, `fail-manifest-temp`, `fail-manifest-rename`, publication refusal.

    Add a **mixed fixture** (I2/N5): one media doc whose download fails at an unchanged tracked path (cli#183), next to a staged markdown sibling, with outcomes success and `fail-rename:1`. In both, the failed doc's entry equals its previous entry, and on failure the sibling is restored. Prune impossible combinations, listed in a comment.
  - **Platform rows** (spec §1.7), in INV-B and INV-C, gated by runtime detection with the reason in the title:
    - a case-only rename on a case-insensitive filesystem;
    - an NFC/NFD name pair on a normalising filesystem;
    - (INV-A) the no-`O_NOFOLLOW` path, which skips unless `fs.constants.O_NOFOLLOW` is undefined.

- [ ] **Step 2: Run them.** Run the heavy-run gate first.
Run: `npm run build && npx vitest run --project unit tests/doc-pull-inv-outside.test.ts tests/doc-pull-inv-no-clobber.test.ts tests/doc-pull-inv-honest-manifest.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-5-sweeps.log`
Expected: PASS, with every skip naming its reason. No RED step applies: these pin behaviour Tasks 1-4 built. Show each test is real by temporarily breaking one assertion per file (note it in the report, then restore it).

- [ ] **Step 3: Report (do not commit).** List every changed path, the row counts per file (run / skipped with reasons), the run with its counts and log path, and any row that failed (as a finding).

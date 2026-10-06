# Wave cli-docpull Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sa-subagent-driven-development to implement this plan task-by-task (the wave's build step). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `doc pull` is all-or-nothing on its files and manifest, including after a kill, and it never writes through a link or over a file it doesn't own, even one created after its checks. It also keeps tracking that a failed download would lose, and fails loudly on an unreadable destination or a missing terminal.

**Architecture:**
- A new module, `src/utils/doc-pull-writes.ts`, runs a journalled transaction (spec §1):
  - stage doc temp files and the new manifest temp;
  - write a journal;
  - move each replaced file to a backup and rename its staged file into place, re-checking ownership first;
  - publish the manifest;
  - remove the backups and the journal.
- Any failure before publication rolls back. The next pull recovers an interrupted one.
- `report()` in `src/commands/doc-pull.ts` computes the final manifest before any write, drives the transaction, and runs rename cleanup and deletion propagation only after publication.

**Tech Stack:** TypeScript (Node 20+, CommonJS), commander, vitest 4 (`unit` project). Unit tests run on Linux in CI.

**Spec:** `docs/superpowers/specs/2026-10-05-cli-docpull-design.md` (cited as "spec §N"; it wins over this plan on any conflict).

**Issues:** cli#168, cli#183, cli#190, cli#188, cli#191, cli#176, cli#182 (SolidActions/solidactions-cli). Approved by Peter in CrewOps ask task-starttheclidoc-01c7 ("approved", built mainly on Muse), recorded on each issue. The transaction design and its test-only fault points are recorded on cli#168 (issuecomment-6008515604).

**Plan review:** Sol (task-planreviewcli-d807) REQUEST CHANGES d5474a7. The PM's rulings 1-6 (plan card task-planclidocpull-948e) are folded in, cited as "C1/C2/I1-I3/M1".

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

1. **INV-1 at every boundary:** a failure while staging a doc temp, the manifest temp or the journal, a failed doc rename, a failed manifest rename, a publication refusal, a kill after N renames, and a kill after publication. After each, plus the next pull's recovery for a kill, the destination is exactly the previous state or exactly the new one (spec §1.1-1.4). Tasks 3 and 5 pin it.
2. **INV-3 at publication time:** a file created or changed at a target after staging is never replaced without `--overwrite`, and is replaced with it (spec §1.2 step 3). Tasks 2, 3 and 5 pin it.
3. **INV-2 with the qualified race:** a hard-linked tracked file's other name keeps its bytes, and a link planted at the final name is replaced, not followed. A rollback restores the original inode (spec §1.2-1.3). Tasks 2, 3 and 5 pin it.
4. **Scripts keep working:** `doc pull … -y` with no terminal still pulls into a non-empty destination. Without `-y` it exits 1 with the line, and the terminal "no" still prints `Cancelled.` and exits 0 (spec §4). Task 1 pins all three.
5. **The rename matrix and write-safety suites stay green,** with the hard-link stand-ins for case-insensitive aliases rewritten to the new semantics. The true alias cases run where the filesystem allows and are skipped with a reason on Linux (spec §1.7). Task 3 pins them.

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

### Task 2: the journalled transaction module (cli#168, cli#188, cli#182)

**Files (file scope):**
- Create: `src/utils/doc-pull-writes.ts`
- Create: `tests/doc-pull-writes.test.ts` (direct tests against real temp directories)

**Interfaces:**
- Consumes: nothing from this wave.
- Produces (exactly these exports; Task 3 uses them):
  - `JOURNAL_NAME = '.solidactions-pull-journal.json'`
  - `class LinkOnTheWayError extends Error { readonly component: string }`
  - `class PublicationRefusedError extends Error { readonly relPath: string }`
  - `class WriteStepError extends Error { readonly relPath: string; readonly cause: unknown }`
  - `class JournalDamagedError extends Error {}`
  - `type Expectation = { kind: 'absent' } | { kind: 'sha256'; sha256: string } | { kind: 'any' }`
  - `interface StagedDoc { relPath: string; dirRel: string; tempAbs: string; targetAbs: string; backupAbs: string | null; expect: Expectation; backedUp: boolean; committed: boolean }`
  - `interface Transaction { destination: string; manifestName: string; docs: StagedDoc[]; createdDirs: string[]; manifestTempAbs: string | null; manifestSha256: string | null; journalWritten: boolean }`
  - `interface Faults { beforeCommit(tx: Transaction): void; afterRename(count: number): void; afterPublish(tx: Transaction): void }`
  - `function faultsFromEnv(env?: NodeJS.ProcessEnv): Faults`
  - `function newTransaction(destination: string, manifestName: string): Transaction`
  - `function tempName(suffix: '.tmp' | '.bak'): string`
  - `function ensureRealDirs(destination: string, dirRel: string, tx: Transaction | null): string`
  - `function stageDoc(tx: Transaction, dirRel: string, fileName: string, relPath: string, data: string | Buffer, overwrite: boolean): void`
  - `function stageManifest(tx: Transaction, bytes: string): void`
  - `function writeJournal(tx: Transaction): void`
  - `function commitTransaction(tx: Transaction, faults: Faults): void`. It renames docs, then publishes the manifest.
  - `function rollbackTransaction(tx: Transaction): { restoreFailure: { relPath: string; error: unknown } | null }`
  - `function finalizeTransaction(tx: Transaction): Array<{ relPath: string; backupRel: string; error: unknown }>`
  - `function recoverInterrupted(destination: string, manifestName: string): { action: 'none' } | { action: 'forward' } | { action: 'back'; restored: string[] }`. It throws `JournalDamagedError`.
  - `function writeFileAtomic(dir: string, name: string, data: string | Buffer): void`

**Spec:** §1.1-1.5, §1.8.

- [ ] **Step 1: Write the failing tests** in `tests/doc-pull-writes.test.ts`. Each test makes its own `fs.mkdtempSync` root, with `dest = <root>/dest` created and `MANIFEST = '.solidactions-docs.json'`, and removes the root after. The helper `run(tx)` means `writeJournal(tx); commitTransaction(tx, noFaults)`, where `noFaults` is `faultsFromEnv({})`.
  1. **Happy path:**
     - Stage `a.md` (root) and `x/y/b.md`, then the manifest `{"v":2}`, and run.
     - Both targets hold their bytes and the manifest reads `{"v":2}`.
     - `finalizeTransaction` returns `[]`. Afterwards no `.sa-pull-*` file and no journal exist under `dest`.
  2. **Staging touches no target:** after staging and `writeJournal`, but before commit, no target exists, a `.sa-pull-*.tmp` exists next to each, and the journal exists.
  3. **Link on the way:** `ensureRealDirs(dest, 'x/y', tx)` with `dest/x` a symlink to `<root>/outside` throws `LinkOnTheWayError`, whose `component` is `'x'`. Nothing is created under `<root>/outside`.
  4. **Planted link at the final name (cli#182):** stage `a.md` (absent at staging, so expectation `absent`), then create `dest/a.md` as a symlink to `<root>/outside.txt` (`OUTSIDE`). Commit throws `PublicationRefusedError` (INV-3). `rollbackTransaction` leaves `outside.txt` reading `OUTSIDE`, keeps the link, and removes all temps and the journal. Then the same with `overwrite = true`: the commit succeeds, `dest/a.md` is a regular file with the staged bytes, and `outside.txt` still reads `OUTSIDE`.
  5. **Hard link (cli#188):** `dest/a.md` (`OLD`) is hard-linked as `<root>/other.txt`. Stage `NEW` and run: `a.md` reads `NEW` and `other.txt` reads `OLD`. In a second case, the rollback after a publication failure (step 9) restores `a.md` with **the same inode** as `other.txt`.
  6. **Mode kept:** an existing `dest/a.md` with mode `0o600` keeps `0o600` after run. A new file gets `0o666 & ~umask`.
  7. **Publication refusal (C2):** stage `a.md` over an existing `OLD`, then rewrite it to `EDITED` before commit. Commit throws `PublicationRefusedError('a.md')`, and after rollback `a.md` reads `EDITED`. The same flow with `overwrite = true` commits.
  8. **Doc rename failure rolls back:**
     - Stage `a.md` (existing `A1`) and `sub/b.md` (existing `B1`).
     - After `writeJournal`, `chmod 0o555 dest/sub` (skip on win32/root).
     - Commit throws `WriteStepError` with `relPath 'sub/b.md'`.
     - `rollbackTransaction` returns `{ restoreFailure: null }`: `a.md` reads `A1` with its original inode, and `sub/b.md` reads `B1`. Restore the mode, then check that no `.sa-pull-*` file and no journal remain.
  9. **Manifest rename failure:** make `dest/.solidactions-docs.json` a non-empty directory before commit. Commit throws `WriteStepError` with `relPath '.solidactions-docs.json'` after all doc renames, and rollback restores every doc to its old bytes.
  10. **Recovery, roll back:**
      - Stage and journal `a.md` (existing `A1`) and `n.md` (new). Then do by hand what an interrupted commit does: rename `a.md` to its backup, the `a.md` temp to `a.md`, and the `n.md` temp to `n.md`. Leave the journal and the old manifest.
      - `recoverInterrupted(dest, MANIFEST)` returns `{ action: 'back', restored: ['a.md'] }`.
      - Afterwards `a.md` reads `A1`, `n.md` is gone, and no `.sa-pull-*` file or journal remains.
  11. **Recovery, roll forward:** the same, but also rename the manifest temp into place. The result is `{ action: 'forward' }`: the backups and the journal are removed, and `a.md` keeps the new bytes.
  12. **Damaged journal:** a journal holding `not json`, or one whose `entries[0].target` is `'../escape'`, makes `recoverInterrupted` throw `JournalDamagedError` and change nothing.
  13. **No journal:** `recoverInterrupted` returns `{ action: 'none' }`.
  14. **Finalize failure:** after a successful run with a backup in `sub/`, `chmod 0o555 dest/sub` before `finalizeTransaction` (skip on win32/root). It returns one item naming `sub/b.md` and the backup's relative path. The journal is already gone.
  15. **`writeFileAtomic`** writes the file and replaces a symlink at its name without following it. `tempName('.tmp')` matches `/^\.sa-pull-\d+-[0-9a-f]{12}\.tmp$/`.
  16. **Faults** (also `link-before-commit:a.md>/abs/outside.txt` creates that symlink in `beforeCommit`):
      - `faultsFromEnv({ SOLIDACTIONS_DOC_PULL_TEST_FAULT: 'kill-after-renames:1' })` without `SOLIDACTIONS_TEST_HOOKS` is inert: `afterRename(1)` returns.
      - With `SOLIDACTIONS_TEST_HOOKS: '1'` and `readonly-before-commit:sub`, `beforeCommit` makes `dest/sub` mode `0o555` (skip on win32/root; restore it).
      - Don't test the kill fault here: Task 3 covers it in a spawned process.

- [ ] **Step 2: Run them and watch them fail** (the module is missing).
Run: `npx vitest run --project unit tests/doc-pull-writes.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-2-red.log`
Expected: FAIL (cannot resolve `../src/utils/doc-pull-writes`).

- [ ] **Step 3: Implement** `src/utils/doc-pull-writes.ts`:

```ts
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * The journalled doc pull transaction (cli#168, cli#188, cli#182; spec §1). Stage doc
 * temps and the manifest temp, write a journal, then for each doc re-check ownership,
 * move the old file to a backup and rename the temp into place, then publish the
 * manifest. Any failure before publication rolls back; the next pull recovers an
 * interrupted one. A rename replaces the directory entry, so a hard link's other names
 * keep their bytes and a link planted at the final name is replaced, not followed.
 * Node has no openat: a directory component swapped for a link between the re-check
 * and the rename is a documented residual race (spec §1.6).
 */
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const TEMP_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW;

export const JOURNAL_NAME = '.solidactions-pull-journal.json';

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

export class JournalDamagedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'JournalDamagedError';
    }
}

export type Expectation = { kind: 'absent' } | { kind: 'sha256'; sha256: string } | { kind: 'any' };

export interface StagedDoc {
    relPath: string;
    dirRel: string;
    tempAbs: string;
    targetAbs: string;
    backupAbs: string | null;
    expect: Expectation;
    backedUp: boolean;
    committed: boolean;
}

export interface Transaction {
    destination: string;
    manifestName: string;
    docs: StagedDoc[];
    createdDirs: string[];
    manifestTempAbs: string | null;
    manifestSha256: string | null;
    journalWritten: boolean;
}

export interface Faults {
    beforeCommit(tx: Transaction): void;
    afterRename(count: number): void;
    afterPublish(tx: Transaction): void;
}

interface JournalEntry {
    target: string;
    temp: string;
    backup: string | null;
}

interface Journal {
    version: 1;
    manifest_sha256: string;
    manifest_temp: string;
    created_dirs: string[];
    entries: JournalEntry[];
}

const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

/** True when anything (a file, a directory, even a dangling link) is at `abs`. */
function lexists(abs: string): boolean {
    try {
        fs.lstatSync(abs);
        return true;
    } catch {
        return false;
    }
}

export function tempName(suffix: '.tmp' | '.bak'): string {
    return `.sa-pull-${process.pid}-${crypto.randomBytes(6).toString('hex')}${suffix}`;
}

export function newTransaction(destination: string, manifestName: string): Transaction {
    return { destination, manifestName, docs: [], createdDirs: [], manifestTempAbs: null, manifestSha256: null, journalWritten: false };
}

/**
 * Test-only fault points (spec §1.5). Inert unless SOLIDACTIONS_TEST_HOOKS=1; each one
 * performs a real filesystem action or a real kill so a spawned test reaches a failure
 * point deterministically. Never documented for users.
 */
export function faultsFromEnv(env: NodeJS.ProcessEnv = process.env): Faults {
    const none: Faults = { beforeCommit: () => undefined, afterRename: () => undefined, afterPublish: () => undefined };
    if (env.SOLIDACTIONS_TEST_HOOKS !== '1') return none;
    const [name, arg = ''] = (env.SOLIDACTIONS_DOC_PULL_TEST_FAULT ?? '').split(/:(.*)/s);
    const kill = (): void => {
        process.kill(process.pid, 'SIGKILL');
    };
    switch (name) {
        case 'kill-after-renames':
            return { ...none, afterRename: (count) => { if (count === Number(arg)) kill(); } };
        case 'kill-after-publish':
            return { ...none, afterPublish: () => kill() };
        case 'readonly-before-commit':
            return { ...none, beforeCommit: (tx) => fs.chmodSync(path.join(tx.destination, ...arg.split('/')), 0o555) };
        case 'create-before-commit':
            return { ...none, beforeCommit: (tx) => fs.writeFileSync(path.join(tx.destination, ...arg.split('/')), 'RACE') };
        case 'link-before-commit': {
            const [linkRel, linkTarget] = arg.split('>');
            return { ...none, beforeCommit: (tx) => fs.symlinkSync(linkTarget, path.join(tx.destination, ...linkRel.split('/'))) };
        }
        case 'readonly-after-publish':
            return { ...none, afterPublish: (tx) => fs.chmodSync(path.join(tx.destination, ...arg.split('/')), 0o555) };
        default:
            return none;
    }
}

export function ensureRealDirs(destination: string, dirRel: string, tx: Transaction | null): string {
    const parts = dirRel === '' ? [] : dirRel.split('/');
    let current = destination;
    for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i]);
        let stat: fs.Stats | null = null;
        try {
            stat = fs.lstatSync(current);
        } catch (error) {
            if (tx === null || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (stat === null) {
            fs.mkdirSync(current);
            tx!.createdDirs.push(current);
            stat = fs.lstatSync(current);
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new LinkOnTheWayError(parts.slice(0, i + 1).join('/'));
        }
    }
    return current;
}

function writeTemp(dirAbs: string, data: string | Buffer, mode: number | null): string {
    const tempAbs = path.join(dirAbs, tempName('.tmp'));
    const fd = fs.openSync(tempAbs, TEMP_FLAGS, 0o666);
    try {
        if (mode !== null) fs.fchmodSync(fd, mode);
        fs.writeFileSync(fd, data);
    } catch (error) {
        fs.closeSync(fd);
        fs.unlinkSync(tempAbs);
        throw error;
    }
    fs.closeSync(fd);
    return tempAbs;
}

/** The target as it is now: absent, a regular file (its bytes' hash and mode), or anything else. */
function inspect(targetAbs: string): { kind: 'absent' } | { kind: 'file'; sha256: string; mode: number } | { kind: 'other' } {
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(targetAbs);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
        throw error;
    }
    if (!stat.isFile()) return { kind: 'other' };
    return { kind: 'file', sha256: sha256(fs.readFileSync(targetAbs)), mode: stat.mode & 0o7777 };
}

export function stageDoc(tx: Transaction, dirRel: string, fileName: string, relPath: string, data: string | Buffer, overwrite: boolean): void {
    let dirAbs: string;
    try {
        dirAbs = ensureRealDirs(tx.destination, dirRel, tx);
    } catch (error) {
        if (error instanceof LinkOnTheWayError) throw error;
        throw new WriteStepError(relPath, error);
    }
    const targetAbs = path.join(dirAbs, fileName);
    const now = inspect(targetAbs);
    if (now.kind === 'other' && !overwrite) throw new PublicationRefusedError(relPath);
    const expect: Expectation = overwrite ? { kind: 'any' } : now.kind === 'file' ? { kind: 'sha256', sha256: now.sha256 } : { kind: 'absent' };
    let tempAbs: string;
    try {
        tempAbs = writeTemp(dirAbs, data, now.kind === 'file' ? now.mode : null);
    } catch (error) {
        throw new WriteStepError(relPath, error);
    }
    const backupAbs = now.kind === 'absent' ? null : path.join(dirAbs, tempName('.bak'));
    tx.docs.push({ relPath, dirRel, tempAbs, targetAbs, backupAbs, expect, backedUp: false, committed: false });
}

export function stageManifest(tx: Transaction, bytes: string): void {
    const targetAbs = path.join(tx.destination, tx.manifestName);
    const now = inspect(targetAbs);
    try {
        tx.manifestTempAbs = writeTemp(tx.destination, bytes, now.kind === 'file' ? now.mode : null);
    } catch (error) {
        throw new WriteStepError(tx.manifestName, error);
    }
    tx.manifestSha256 = sha256(bytes);
}

const rel = (tx: Transaction, abs: string): string => path.relative(tx.destination, abs).split(path.sep).join('/');

export function writeJournal(tx: Transaction): void {
    const journal: Journal = {
        version: 1,
        manifest_sha256: tx.manifestSha256 ?? '',
        manifest_temp: tx.manifestTempAbs === null ? '' : rel(tx, tx.manifestTempAbs),
        created_dirs: tx.createdDirs.map((dir) => rel(tx, dir)),
        entries: tx.docs.map((d) => ({ target: rel(tx, d.targetAbs), temp: rel(tx, d.tempAbs), backup: d.backupAbs === null ? null : rel(tx, d.backupAbs) })),
    };
    try {
        writeFileAtomic(tx.destination, JOURNAL_NAME, `${JSON.stringify(journal, null, 2)}\n`);
    } catch (error) {
        throw new WriteStepError(JOURNAL_NAME, error);
    }
    tx.journalWritten = true;
}

function stillAsExpected(d: StagedDoc): boolean {
    if (d.expect.kind === 'any') return true;
    const now = inspect(d.targetAbs);
    if (d.expect.kind === 'absent') return now.kind === 'absent';
    return now.kind === 'file' && now.sha256 === d.expect.sha256;
}

export function commitTransaction(tx: Transaction, faults: Faults): void {
    faults.beforeCommit(tx);
    let renamed = 0;
    for (const d of tx.docs) {
        if (!stillAsExpected(d)) throw new PublicationRefusedError(d.relPath);
        try {
            ensureRealDirs(tx.destination, d.dirRel, null);
            if (d.backupAbs !== null && lexists(d.targetAbs)) {
                fs.renameSync(d.targetAbs, d.backupAbs);
                d.backedUp = true;
            }
            fs.renameSync(d.tempAbs, d.targetAbs);
            d.committed = true;
        } catch (error) {
            if (error instanceof LinkOnTheWayError) throw error;
            throw new WriteStepError(d.relPath, error);
        }
        renamed += 1;
        faults.afterRename(renamed);
    }
    try {
        fs.renameSync(tx.manifestTempAbs!, path.join(tx.destination, tx.manifestName));
    } catch (error) {
        throw new WriteStepError(tx.manifestName, error);
    }
    faults.afterPublish(tx);
}

const quietly = (action: () => void): void => {
    try {
        action();
    } catch {
        // already gone
    }
};

export function rollbackTransaction(tx: Transaction): { restoreFailure: { relPath: string; error: unknown } | null } {
    let restoreFailure: { relPath: string; error: unknown } | null = null;
    for (const d of [...tx.docs].reverse()) {
        try {
            if (d.backedUp && d.backupAbs !== null) {
                fs.renameSync(d.backupAbs, d.targetAbs); // restores the original inode, links included
            } else if (d.committed) {
                fs.unlinkSync(d.targetAbs);
            }
        } catch (error) {
            restoreFailure ??= { relPath: d.relPath, error };
            continue;
        }
        quietly(() => fs.unlinkSync(d.tempAbs));
    }
    if (tx.manifestTempAbs !== null) quietly(() => fs.unlinkSync(tx.manifestTempAbs!));
    for (const dir of [...tx.createdDirs].reverse()) quietly(() => fs.rmdirSync(dir));
    if (restoreFailure === null) quietly(() => fs.unlinkSync(path.join(tx.destination, JOURNAL_NAME)));
    return { restoreFailure };
}

export function finalizeTransaction(tx: Transaction): Array<{ relPath: string; backupRel: string; error: unknown }> {
    quietly(() => fs.unlinkSync(path.join(tx.destination, JOURNAL_NAME)));
    const failures: Array<{ relPath: string; backupRel: string; error: unknown }> = [];
    for (const d of tx.docs) {
        if (!d.backedUp || d.backupAbs === null) continue;
        try {
            fs.unlinkSync(d.backupAbs);
        } catch (error) {
            failures.push({ relPath: d.relPath, backupRel: rel(tx, d.backupAbs), error });
        }
    }
    return failures;
}

function inside(destination: string, relPath: string): string {
    if (relPath === '' || path.isAbsolute(relPath) || relPath.split('/').includes('..')) {
        throw new JournalDamagedError(`journal path ${JSON.stringify(relPath)} is not inside the destination`);
    }
    return path.join(destination, ...relPath.split('/'));
}

export function recoverInterrupted(destination: string, manifestName: string): { action: 'none' } | { action: 'forward' } | { action: 'back'; restored: string[] } {
    const journalAbs = path.join(destination, JOURNAL_NAME);
    if (!fs.existsSync(journalAbs)) return { action: 'none' };
    let journal: Journal;
    try {
        journal = JSON.parse(fs.readFileSync(journalAbs, 'utf8'));
    } catch {
        throw new JournalDamagedError('the journal is not valid JSON');
    }
    if (journal?.version !== 1 || !Array.isArray(journal.entries) || !Array.isArray(journal.created_dirs)) {
        throw new JournalDamagedError('the journal has an unknown shape');
    }
    const entries = journal.entries.map((e) => ({
        target: inside(destination, e.target),
        temp: inside(destination, e.temp),
        backup: e.backup === null ? null : inside(destination, e.backup),
        rel: e.target,
    }));
    const manifestTemp = journal.manifest_temp === '' ? null : inside(destination, journal.manifest_temp);
    const dirs = journal.created_dirs.map((d) => inside(destination, d));

    const manifestAbs = path.join(destination, manifestName);
    const published = fs.existsSync(manifestAbs) && sha256(fs.readFileSync(manifestAbs)) === journal.manifest_sha256;
    if (published) {
        for (const e of entries) {
            if (e.backup !== null) quietly(() => fs.unlinkSync(e.backup!));
            quietly(() => fs.unlinkSync(e.temp));
        }
        if (manifestTemp !== null) quietly(() => fs.unlinkSync(manifestTemp));
        fs.unlinkSync(journalAbs);
        return { action: 'forward' };
    }

    const restored: string[] = [];
    for (const e of [...entries].reverse()) {
        if (e.backup !== null && fs.existsSync(e.backup)) {
            fs.renameSync(e.backup, e.target);
            restored.push(e.rel);
        } else if (!fs.existsSync(e.temp)) {
            quietly(() => fs.unlinkSync(e.target)); // this pull's new file
        }
        quietly(() => fs.unlinkSync(e.temp));
    }
    if (manifestTemp !== null) quietly(() => fs.unlinkSync(manifestTemp));
    for (const dir of [...dirs].reverse()) quietly(() => fs.rmdirSync(dir));
    fs.unlinkSync(journalAbs);
    return { action: 'back', restored: restored.reverse() };
}

export function writeFileAtomic(dir: string, name: string, data: string | Buffer): void {
    const targetAbs = path.join(dir, name);
    const now = inspect(targetAbs);
    const tempAbs = writeTemp(dir, data, now.kind === 'file' ? now.mode : null);
    try {
        fs.renameSync(tempAbs, targetAbs);
    } catch (error) {
        quietly(() => fs.unlinkSync(tempAbs));
        throw error;
    }
}
```

Watch one edge: in recovery, an entry whose backup exists but whose temp also still exists means the target was moved to the backup and the temp was never renamed. Restoring the backup is right there, and the code's order (backup first) handles it.

- [ ] **Step 4: Run GREEN.**
Run: `npx vitest run --project unit tests/doc-pull-writes.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-2-green.log`
Then: `npm run build 2>&1 | tail -3` (it must compile cleanly).
Expected: PASS, and the build is clean.

- [ ] **Step 5: Report (do not commit).** List every changed path, each run with its counts and log path, and anything you had to stop on.

---

### Task 3: doc pull runs through the transaction (cli#168, cli#188, cli#182)

**Files (file scope):**
- Modify: `src/commands/doc-pull.ts`:
  - `docPullWithConfig`: call recovery before the destination checks;
  - `commitDocs` and `report()`: compute the final manifest before writes, run the transaction, roll back, finalize, then rename cleanup and deletion propagation after publication.
  - Task 1 edited `docPullWithConfig`'s destination block; keep it.
- Modify: `src/utils/docs-manifest.ts` (`writeManifest` uses `writeFileAtomic`)
- Create: `tests/doc-pull-transactional.test.ts` (spawned; the failure points)
- Modify: `tests/doc-pull-write-safety.test.ts` (the hard-link stand-in tests ~433-478, I1)
- Modify: `tests/doc-pull-rename-matrix.test.ts` (`sameFileCases` ~619-636 and the "two renamed docs alias each other targets via hardlinks" rows ~744-761, I1)
- Modify: `tests/doc-pull.test.ts` (the case-only rename hard-link test ~1864-1898, I1)
- Modify: `tests/doc-pull-display-guard.test.ts` (only `ALLOWED` entries for new printed names that hold no server text, each with a reason, I1)
- Modify: `README.md` (`### doc` section: one paragraph, spec §1.9)

**Interfaces:**
- Consumes: everything Task 2 produces (`src/utils/doc-pull-writes.ts`).
- Produces: `commitDocs`'s callers now get the manifest written by the transaction. Task 4 edits the manifest-building rules in `report()`.

**Spec:** §1.2-1.5, §1.8-1.9. Lines (values through `shown()`):
- write failure: `error: cannot write <rel>: <error message> — nothing was changed.`
- publication refusal: `error: <rel> changed after doc pull checked it — nothing was changed. Pull again, or pass --overwrite to replace it.`
- rollback incomplete: `error: cannot write <rel>: <error message> — could not restore <rel2> (<message>); the next doc pull into this folder finishes the rollback.`
- leftover backup: `! could not remove <backupRel>: <message> — it is the previous copy of <rel>; delete it yourself`
- recovery: `! finished an interrupted pull in <destination> (removed its leftover backups)`; `! rolled back an interrupted pull in <destination>: restored <n> file(s)`
- damaged journal: `error: <destination> holds a damaged pull journal (.solidactions-pull-journal.json) from an interrupted pull; check the .sa-pull-*.bak files next to your docs, then delete the journal and pull again.`

- [ ] **Step 1: Write the failing tests** in `tests/doc-pull-transactional.test.ts`.
  - Fixture: a first pull (`-y`) writes `a.md` (`A1`), `sub/b.md` (`B1`) and media `pic.png` (`P1`).
  - `snapshot(out)` maps every file under `<out>` (dot-files included) to its bytes, and every regular file to its inode.
  - Each case serves new versions (`A2`, `B2`, `P2`) and pulls again with `-y`.
  - "Nothing changed" means: `snapshot` equals the one taken before the pull (bytes and inodes), and no `.sa-pull-*` file or journal exists.
  - Fault cases set `SOLIDACTIONS_TEST_HOOKS=1` and `SOLIDACTIONS_DOC_PULL_TEST_FAULT`.
  1. **Doc temp fails** (skip on win32/root): `chmod 0o555 <out>/sub` before the pull. Exit 1, the write-failure line for `sub/b.md`, nothing changed.
  2. **Manifest temp fails** (Sol's case; skip on win32/root). Use a separate fixture whose only doc is `sub/a.md`: a first pull writes it, then `chmod 0o555 <out>` (the root) while `sub/` stays writable. The second pull stages `sub/a.md` fine, then fails creating the manifest temp in the root: exit 1, the write-failure line names `.solidactions-docs.json`, nothing changed.
  3. **Doc rename fails:** fault `readonly-before-commit:sub` (skip on win32/root). Exit 1, the write-failure line for `sub/b.md`, nothing changed. This includes `a.md`, already renamed and then restored with its original inode.
  4. **Manifest rename fails:** `<out>/.solidactions-docs.json` is replaced by a non-empty directory before the pull (preserve the real manifest bytes elsewhere; this pull treats the folder as untracked, so pass `--overwrite`). Exit 1, a write-failure line naming `.solidactions-docs.json`, and every doc file keeps its old bytes and inode.
  5. **Publication refusal (C2):** the server adds a new doc `n.md`, and the fault is `create-before-commit:n.md`. Exit 1, the publication-refusal line for `n.md`, `n.md` reads `RACE`, and everything else is unchanged. The same with `--overwrite`: exit 0, and `n.md` holds the served bytes.
  6. **Interrupted commit:** fault `kill-after-renames:1`. The child is killed (`signal === 'SIGKILL'`), and the journal exists. A second pull without hooks prints `! rolled back an interrupted pull in <out>: restored 1 file(s)`, then completes. The end state is the new state (`A2`, `B2`, `P2`, a manifest matching them), with no `.sa-pull-*` file and no journal.
  7. **Interrupted cleanup:** fault `kill-after-publish`. The child is killed, and the manifest already matches the new bytes. A second pull prints `! finished an interrupted pull in <out> (removed its leftover backups)`, and afterwards no `.sa-pull-*` file remains.
  8. **Cleanup failure:** fault `readonly-after-publish:sub` (skip on win32/root). Exit 0, the leftover-backup line for `sub/b.md`, and the manifest matches the new bytes. Restore the mode.
  9. **Damaged journal:** write `not json` to `<out>/.solidactions-pull-journal.json`. Exit 1, the damaged-journal line, nothing changed.
  10. **Hard link (cli#188):** hard-link `<tmp>/outside.md` to `<out>/a.md`. Pull: exit 0, `a.md` reads `A2`, and `outside.md` still reads `A1`.
  11. **Mode kept:** `chmod 0o600 <out>/a.md` before the pull; afterwards it is still `0o600`.

- [ ] **Step 2: Run them and watch them fail.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull-transactional.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-3-red.log`
Expected: FAIL on cases 1-10 (case 11 may pass today: say so). Before Step 3, the hooks are inert, so the fault cases fail on their assertions.

- [ ] **Step 3: Implement** in `src/commands/doc-pull.ts`.
  1. **Recovery** (spec §1.4), at the top of `docPullWithConfig`, before the `previousManifest` read, when `destination` exists:

```ts
        try {
            const recovery = recoverInterrupted(destination, DOCS_MANIFEST);
            if (recovery.action === 'forward') {
                process.stderr.write(chalk.yellow(`! finished an interrupted pull in ${shown(destination)} (removed its leftover backups)\n`));
            } else if (recovery.action === 'back') {
                process.stderr.write(chalk.yellow(`! rolled back an interrupted pull in ${shown(destination)}: restored ${recovery.restored.length} file(s)\n`));
            }
        } catch (error) {
            if (!(error instanceof JournalDamagedError)) throw error;
            process.stderr.write(chalk.red(`error: ${shown(destination)} holds a damaged pull journal (${JOURNAL_NAME}) from an interrupted pull; check the .sa-pull-*.bak files next to your docs, then delete the journal and pull again.\n`));
            process.exit(1);
        }
```

  2. **Final manifest first** (spec §1.2 step 1). In `report()`, move every rule that changes `manifestDocs` so it runs **before** any write:
     - today's rule-5 block (a failed download over a local file);
     - the rename-keep block (`!m.replacementWritten` restores the old entry);
     - the single-doc merge.

     Their yellow warning lines go into a `pendingWarnings: string[]`, printed only after publication. `commitDocs` no longer writes: it returns the manifest entries for `planned` (today's entry shape). The final `docs` object, and the bytes `${JSON.stringify({ folder_path: folderPath, docs }, null, 2)}\n`, exist before the transaction starts.
  3. **The transaction**, replacing today's `commitDocs` call and `writeManifest(destination, manifest)`:

```ts
    fs.mkdirSync(destination, { recursive: true });
    const tx = newTransaction(destination, DOCS_MANIFEST);
    try {
        for (const p of planned) {
            const data = p.isMedia ? p.mediaBytes : p.doc.body;
            if (data === null) continue; // a failed media download writes nothing
            stageDoc(tx, p.dirRel, p.fileName, p.relPath, data, options.overwrite === true);
        }
        stageManifest(tx, manifestBytes);
        writeJournal(tx);
        commitTransaction(tx, faultsFromEnv());
    } catch (error) {
        const { restoreFailure } = rollbackTransaction(tx);
        const tail = restoreFailure === null
            ? 'nothing was changed.'
            : `could not restore ${shown(restoreFailure.relPath)} (${shown((restoreFailure.error as Error).message)}); the next doc pull into this folder finishes the rollback.`;
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
    for (const leftover of finalizeTransaction(tx)) {
        process.stderr.write(chalk.yellow(`! could not remove ${shown(leftover.backupRel)}: ${shown((leftover.error as Error).message)} — it is the previous copy of ${shown(leftover.relPath)}; delete it yourself\n`));
    }
    for (const line of pendingWarnings) process.stderr.write(chalk.yellow(`${line}\n`));
```

     The `files` list (paths written) is the `relPath` of every `tx.docs` entry with `committed`.
  4. **After publication**, unchanged in logic: compute `writtenIdentities` from the written files, run the rename-cleanup **removal** loop (today's `fs.rmSync` part), print the existing warnings, and run deletion propagation. None of these may run before publication.
  5. `src/utils/docs-manifest.ts`: `writeManifest` becomes `writeFileAtomic(dir, DOCS_MANIFEST, \`${JSON.stringify(manifest, null, 2)}\n\`)`.
  6. README `### doc` paragraph (spec §1.9): "A `doc pull` is all or nothing: it writes every file to a hidden temp file first and publishes the manifest last, so a failed pull leaves your folder exactly as it was. If a pull is killed mid-way, the next `doc pull` into that folder finishes or rolls it back before doing anything else. `.sa-pull-*` files and `.solidactions-pull-journal.json` belong to that mechanism; leave them unless a pull tells you otherwise."

- [ ] **Step 4: Migrate the hard-link stand-ins (I1).** These tests used a hard link to stand in for a case-insensitive alias. After this task, a pull replaces a file through a rename, so a hard link is an **independent** name: it keeps the old bytes, and rename cleanup removes an unmodified old twin. For each test listed in Files:
  1. Rewrite the Linux hard-link version to assert the new behaviour exactly:
     - **write-safety "a same-file case-only rename adopts instead of refusing, with no --overwrite":** exit 0, `page.md` reads `NEW5`, `Page.md` is gone (rename cleanup removed the unmodified old twin), the manifest keys are `['page.md']`, and stderr has no `not tracked` and no `kept … same file`.
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
  - the manifest entry for a failed media download (now built before the transaction, Task 3);
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
- Create: `tests/doc-pull-inv-all-or-nothing.test.ts` (INV-1, spawned)
- Create: `tests/doc-pull-inv-no-link.test.ts` (INV-2, spawned)
- Create: `tests/doc-pull-inv-no-clobber.test.ts` (INV-3, spawned)

**Interfaces:**
- Consumes: the CLI as built after Tasks 1-4, and its test-only fault points (spec §1.5).
- Produces: tests only. If a sweep row fails on the built code, that is a finding: stop and report it with the row. Do not change `src/`.

**Spec:** §1.1 (the invariants), §1.5, §1.7, §2.

Each file builds its rows from a table and runs one spawned scenario per row. For each scenario, it prints (in the test title) the row's coordinates.

- [ ] **Step 1: Write the sweep tests.**
  - **INV-1 (`doc-pull-inv-all-or-nothing`).** Rows are the product of:
    - **doc kind:** markdown, media (successful download), media (failed download at an unchanged tracked path, cli#183);
    - **pull form:** folder pull, single-doc pull;
    - **target state:** new path, unchanged tracked path, renamed doc (old → new path);
    - **failure point:** none, doc rename (`readonly-before-commit` of the target's directory), manifest rename (the manifest path is a directory; folder form only), publication refusal (`create-before-commit` at a new target), kill after the first rename then recovery, kill after publish then recovery.

    Prune impossible combinations (say which, in a comment). For every row, the end state, after the second, hook-free pull for kill rows, is exactly the previous snapshot or exactly the new expected state: bytes, manifest entries and inodes of untouched files. No `.sa-pull-*` file and no journal remain. A failed row's stderr has exactly one `error:` line, from spec §1.3.
  - **INV-2 (`doc-pull-inv-no-link`).** Rows: {markdown, media} × {folder, single-doc} × the link case:
    - (a) a tracked file hard-linked to a file outside the destination;
    - (b) a symlink to an outside file at a new target name **before** the pull, which wave cli-safety refuses at preflight;
    - (c) a symlink to an outside file planted at a new target name **after staging** (fault `link-before-commit:<rel>><abs outside file>`). This is refused without `--overwrite` (INV-3). With `--overwrite` the link is replaced by a regular file.

    Assert in every row that no byte outside the destination changes.
  - **INV-3 (`doc-pull-inv-no-clobber`).** Rows: {untracked file at the target at preflight, a file created at the target after staging (`create-before-commit`), a tracked file edited after staging (`create-before-commit` rewriting it)} × {without `--overwrite`: refused, the file's bytes unchanged; with `--overwrite`: replaced} × {markdown, media}.
  - **Platform rows** (spec §1.7), in INV-1 and INV-3, gated by runtime detection with the reason in the title:
    - a case-only rename on a case-insensitive filesystem;
    - an NFC/NFD name pair on a normalising filesystem;
    - (INV-2) the no-`O_NOFOLLOW` path, which skips unless `fs.constants.O_NOFOLLOW` is undefined.

- [ ] **Step 2: Run them.** Run the heavy-run gate first.
Run: `npm run build && npx vitest run --project unit tests/doc-pull-inv-all-or-nothing.test.ts tests/doc-pull-inv-no-link.test.ts tests/doc-pull-inv-no-clobber.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-5-sweeps.log`
Expected: PASS, with every skip naming its reason. No RED step applies: these pin behaviour Tasks 1-4 built. Show each test is real by temporarily breaking one assertion per file (note it in the report, then restore it).

- [ ] **Step 3: Report (do not commit).** List every changed path, the row counts per file (run / skipped with reasons), the run with its counts and log path, and any row that failed (as a finding).

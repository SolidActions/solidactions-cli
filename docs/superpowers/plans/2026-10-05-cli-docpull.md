# Wave cli-docpull Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sa-subagent-driven-development to implement this plan task-by-task (the wave's build step). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `doc pull` is all-or-nothing on its files and manifest. It never writes through a hard link or a link planted after its checks, it keeps tracking that a failed download would lose, and it fails loudly on an unreadable destination or a missing terminal.

**Architecture:**
- A new module, `src/utils/doc-pull-writes.ts`, stages each file as an `O_EXCL|O_NOFOLLOW` temp file in its own directory, then renames it into place.
- `commitDocs` in `src/commands/doc-pull.ts` uses it in two phases (stage, then commit). A staging failure rolls back. A commit failure records exactly what was written.
- `writeManifest` becomes temp-and-rename.
- The failed-download manifest rules and the destination checks are small changes in doc-pull.ts.

**Tech Stack:** TypeScript (Node 20+, CommonJS), commander, vitest 4 (`unit` project). Unit tests run on Linux in CI.

**Spec:** `docs/superpowers/specs/2026-10-05-cli-docpull-design.md` (cited as "spec §N"; it wins over this plan on any conflict).

**Issues:** cli#168, cli#183, cli#190, cli#188, cli#191, cli#176, cli#182 (SolidActions/solidactions-cli). Approved by Peter in CrewOps ask task-starttheclidoc-01c7 ("approved", built mainly on Muse), recorded on each issue.

**Card rule (for the manager):** every developer card carries this plan's **Global Constraints** section verbatim and the spec path. Each task states its own expected lines.

## Global Constraints

- **Where:** the CLI wave slot `/home/mercer/projects/solid/solidactions-cli/__worktrees/wave-a`, branch `wave/2026-10-05-cli-docpull`. Work only there. Every path below is relative to that folder.
- **Spec:** `/home/mercer/projects/solid/solidactions-cli/__worktrees/wave-a/docs/superpowers/specs/2026-10-05-cli-docpull-design.md`. Read the section your task cites.
- **File scope:** touch only the paths in your task's **Files** block. A change that needs another path is a plan defect: stop and report it.
- **Never commit, stage, stash, switch branches, reset or rebase.** Never create a worktree. The manager commits after the task review.
- **Build before tests:** run `npm run build` after every source change and before every test run (the tests spawn `dist/index.js`).
- **Filtered runs only:** run only the test files your task names (`npx vitest run --project unit tests/<file>.test.ts …`). Never the full suite, never `tests/live/`.
- **Real tests (PM ruling 14 of wave cli-trust, still binding):** new or changed command tests spawn the built binary.
  - Spawn with async `child_process.spawn` of `node dist/index.js …`, against a real in-process `http.createServer` on `127.0.0.1`.
  - Use a temp `HOME` (`makeTmpEnv`/`writeGlobal` from `tests/helpers.ts`) whose `~/.solidactions/config.json` points at that server with a plain host (`http://127.0.0.1:<port>`; a host with `user:pass@` is refused) and carries a `workspaceId`.
  - Remove `SOLIDACTIONS_HOST` / `SOLIDACTIONS_API_KEY` / `SOLIDACTIONS_WORKSPACE_ID` / `DEBUG` / `NODE_DEBUG` / `FORCE_COLOR` from the child env unless the test sets them on purpose.
  - Assert real stdout, stderr, exit status, and files on disk.
  - Never use `process.exit` / `console` / output-sink substitutions in new or changed tests. No `vi.fn` or `vi.spyOn`; never mock `axios`, `fs` or a module.
  - Module functions that work on the filesystem are tested directly against real temp directories (no fs mocks).
  - Copy the spawn pattern and the doc-pull MCP fixtures (`list`, `bulk_read`, media routes) from `tests/doc-pull-write-safety.test.ts` and `tests/doc-pull.test.ts`.
- **Permission tests:** a test that relies on `chmod` (EACCES) skips when `process.platform === 'win32'` or `process.getuid?.() === 0`. It restores the mode in `finally`, so temp-dir cleanup works.
- **Display:** every value printed by doc-pull.ts goes through its `shown()` helper. `tests/doc-pull-display-guard.test.ts` fails otherwise, and it is in every doc-pull task's neighbour run. Never interpolate a host into a template literal (`tests/host-display-guard.test.ts`).
- **Evidence:** save the raw output of every test run you cite to a log in `/home/mercer/projects/solid/solidactions-cli/__worktrees/wave-a/.superpowers/sdd/2026-10-05-cli-docpull/` (`… 2>&1 | tee <log>`), and cite the log next to each count. Every run you cite must have its log saved. RED before GREEN for every behaviour change. Describe passing output accurately: name any product diagnostics it prints, and never call it "pristine" when it isn't.
- **Style:** 4-space indent, single quotes, chalk colours as the surrounding code uses them. Errors are red `error: …` lines on stderr. Warnings are doc pull's yellow `! …` lines.
- **Report, never commit:** your last step lists every changed path and the test commands you ran with their pass/fail counts and log paths.

## Review Focus

1. **A pull that fails while staging changes nothing:** previous files keep their bytes, the manifest is byte-identical, no `.sa-pull-*.tmp` file and no new directory is left behind (spec §1). Task 3 pins it.
2. **A hard link or a planted link is never written through:** a tracked file hard-linked outside the destination is replaced, and the outside name keeps its bytes. A link planted at the final component after staging is replaced, not followed (spec §1). Tasks 2 and 3 pin both.
3. **Replacing a tracked file keeps its permissions** (`0o600` stays `0o600`) (spec §1). Tasks 2 and 3 pin it.
4. **Scripts keep working:** `doc pull … -y` with no terminal still pulls into a non-empty destination. Without `-y`, it now exits 1 with the line (spec §4). Task 1 pins both.
5. **The rename matrix and write-safety suites stay green.** The case-only rename on a case-insensitive filesystem is not "untracked" (wave cli-safety). Tasks 3 and 4 run them.

---

### Task 1: an unreadable destination and a missing terminal fail with one line (cli#191, cli#176)

**Files (file scope — the only paths this task may touch):**
- Modify: `src/commands/doc-pull.ts` (`docPullWithConfig`, the destination checks and the prompt, ~573-610)
- Create: `tests/doc-pull-destination-checks.test.ts` (spawned)

**Interfaces:**
- Consumes: `shown(value: unknown): string` (doc-pull.ts).
- Produces: nothing new.

**Spec:** §3 and §4. For a destination `<D>` (absolute; printed through `shown()`), the lines are exactly:
- unreadable: `error: cannot read <D>: <the fs error's message>`, e.g. `error: cannot read /tmp/x/out: EACCES: permission denied, scandir '/tmp/x/out'`
- no terminal: `error: <D> is not empty and there is no terminal to confirm the pull; pass -y to pull into it.`

- [ ] **Step 1: Write the failing tests** in `tests/doc-pull-destination-checks.test.ts`. Use a server whose MCP `list` answers one doc and `bulk_read` returns it (copy the fixture from `tests/doc-pull-write-safety.test.ts`). The spawned child's stdin is a pipe, which is not a terminal.
  1. **Unreadable destination** (skip on win32/root): `<tmp>/out` exists and holds a file `x.txt`, then `chmod 0o000`. `doc pull F <tmp>/out`: exit 1. Stderr contains `error: cannot read <tmp>/out: EACCES` and no `    at ` stack line. Restore the mode in `finally`.
  2. **No terminal, non-empty destination, no `-y`:** `<tmp>/out/x.txt` exists. `doc pull F <tmp>/out`: exit 1, stderr contains the exact no-terminal line, and stdout does not contain `Continue?`. No doc file was written and no manifest was created.
  3. **No terminal with `-y`:** the same setup with `-y`: exit 0 and the doc file is written (scripts keep working).
  4. **No terminal with `--overwrite`:** exit 0 and the doc file is written.
  5. **Empty destination, no `-y`:** exit 0 (no prompt is needed).

- [ ] **Step 2: Run them and watch them fail.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull-destination-checks.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-1-red.log`
Expected: FAIL on 1 (wrong wording) and 2 (today it prints the prompt and exits 0). Cases 3-5 pass.

- [ ] **Step 3: Implement** in `docPullWithConfig`. Replace the destination block with:

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
                // cli#176: nobody can answer the prompt, so a script must not read "Cancelled" as success.
                process.stderr.write(chalk.red(`error: ${shown(destination)} is not empty and there is no terminal to confirm the pull; pass -y to pull into it.\n`));
                process.exit(1);
            }
            // … the existing two yellow lines, the prompt and the "Cancelled." exit 0, unchanged …
        }
    }
```

The `previousManifest` read just above (`fs.existsSync(destination) ? readManifest(destination) : null`) stays as it is. If it throws on an unreadable destination, catch that the same way, with the same line.

- [ ] **Step 4: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull-destination-checks.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-1-green.log`
Then: `npx vitest run --project unit tests/doc-pull.test.ts tests/doc-pull-write-safety.test.ts tests/doc-pull-display-guard.test.ts tests/doc-pull-display-text.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-1-neighbours.log`
Expected: PASS. An older test that pulled into a non-empty destination without `-y` now exits 1. That is a finding: stop and report it with the test name. Do not edit it.

- [ ] **Step 5: Report (do not commit).** List every changed path, each run with its counts and log path, and anything you had to stop on.

---

### Task 2: the staged-write module (cli#168, cli#188, cli#182)

**Files (file scope):**
- Create: `src/utils/doc-pull-writes.ts`
- Create: `tests/doc-pull-writes.test.ts` (direct tests against real temp directories)

**Interfaces:**
- Consumes: nothing from this wave.
- Produces (exactly these exports; Task 3 uses them):
  - `export class LinkOnTheWayError extends Error { readonly component: string }`. `component` is the '/'-joined relative directory path that is a link or not a directory.
  - `export interface StagedFile { relPath: string; dirRel: string; tempAbs: string; targetAbs: string }`
  - `export interface StageState { staged: StagedFile[]; createdDirs: string[] }`
  - `export function newStageState(): StageState`
  - `export function tempName(): string`, which returns `.sa-pull-<pid>-<12 hex>.tmp`.
  - `export function ensureRealDirs(destination: string, dirRel: string, state: StageState | null): string`. It returns the directory's absolute path. With `state === null` it only checks and never creates.
  - `export function stageFile(destination: string, dirRel: string, fileName: string, relPath: string, data: string | Buffer, state: StageState): void`
  - `export function rollbackStage(state: StageState): void`
  - `export function commitStaged(destination: string, state: StageState): { committed: string[]; failure: { relPath: string; error: unknown } | null }`
  - `export function writeFileAtomic(dir: string, name: string, data: string | Buffer): void`

**Spec:** §1.

- [ ] **Step 1: Write the failing tests** in `tests/doc-pull-writes.test.ts`. Each test makes its own `fs.mkdtempSync` root, with `dest = <root>/dest` created, and removes the root after.
  1. `stageFile` + `commitStaged` for `('a.md', dirRel '')` and `('x/y/b.md', dirRel 'x/y')`: both targets hold the bytes, `committed` is `['a.md', 'x/y/b.md']`, `failure` is null, and no `.sa-pull-*.tmp` file remains anywhere under `dest`.
  2. Before `commitStaged`, the targets don't exist, and a `.sa-pull-…tmp` file exists in each target directory (staging writes nothing at the target name).
  3. `ensureRealDirs(dest, 'x/y', state)`, where `dest/x` is a **symlink** to `<root>/outside`, throws `LinkOnTheWayError` with `component === 'x'`. Nothing is created under `<root>/outside`.
  4. `rollbackStage`: stage `x/y/b.md` (creating `x` and `x/y`), then roll back. `x` and `x/y` are gone, no temp remains, and a directory that existed before (`dest/keep/`, staged into as `keep/c.md`) still exists.
  5. **Planted link at the final component (cli#182):** stage `a.md`, then create `dest/a.md` as a symlink to `<root>/outside.txt` (content `OUTSIDE`), then commit. `<root>/outside.txt` still reads `OUTSIDE`. `dest/a.md` is a regular file (lstat, not a link) with the staged bytes.
  6. **Hard link (cli#188):** `dest/a.md` exists with `OLD`, and `<root>/other.txt` is a hard link to it. Stage + commit `a.md` with `NEW`. `dest/a.md` reads `NEW`, `<root>/other.txt` still reads `OLD`, and the two no longer share an inode.
  7. **Mode kept:** `dest/a.md` exists with mode `0o600`. After stage + commit, its mode `& 0o777` is `0o600`. A new file gets `0o666 & ~umask`.
  8. **Commit failure:** stage `a.md` and `b.md`, then make `dest/b.md` a **non-empty directory** before commit. `commitStaged` returns `committed: ['a.md']` and `failure.relPath === 'b.md'`. `dest/a.md` holds its new bytes, and no temp remains.
  9. `writeFileAtomic(dest, 'm.json', '{}')` writes the file. Over an existing `m.json` that is a symlink to `<root>/outside.json`, it replaces the link: the outside file is unchanged and `m.json` is a regular file. A write that fails (dir not writable; skip on win32/root) leaves no temp.
  10. `tempName()` matches `/^\.sa-pull-\d+-[0-9a-f]{12}\.tmp$/`.

- [ ] **Step 2: Run them and watch them fail** (the module is missing).
Run: `npx vitest run --project unit tests/doc-pull-writes.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-2-red.log`
Expected: FAIL (cannot resolve `../src/utils/doc-pull-writes`).

- [ ] **Step 3: Implement** `src/utils/doc-pull-writes.ts`:

```ts
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Staged writes for `doc pull` (cli#168, cli#188, cli#182; spec §1): every file is
 * written to an O_EXCL|O_NOFOLLOW temp file in its own directory, then renamed into
 * place. A rename replaces the directory entry, so a hard-linked target's other
 * names keep their bytes and a link planted at the final component is replaced,
 * not followed. Node has no openat: a directory component swapped for a link
 * between the re-check and the rename is a documented residual race.
 */
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const TEMP_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW;

export class LinkOnTheWayError extends Error {
    constructor(public readonly component: string) {
        super(`${component} is a symbolic link or not a directory`);
        this.name = 'LinkOnTheWayError';
    }
}

export interface StagedFile {
    relPath: string;
    dirRel: string;
    tempAbs: string;
    targetAbs: string;
}

export interface StageState {
    staged: StagedFile[];
    createdDirs: string[];
}

export function newStageState(): StageState {
    return { staged: [], createdDirs: [] };
}

/** A short, fixed-length sibling name, so a 255-byte file name cannot overflow NAME_MAX. */
export function tempName(): string {
    return `.sa-pull-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
}

/**
 * Walk `dirRel` below `destination` one component at a time: each must be a real
 * directory, never a link. With a state, a missing component is created (and
 * recorded for rollback); without one, this only checks.
 */
export function ensureRealDirs(destination: string, dirRel: string, state: StageState | null): string {
    const parts = dirRel === '' ? [] : dirRel.split('/');
    let current = destination;
    for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i]);
        let stat: fs.Stats | null = null;
        try {
            stat = fs.lstatSync(current);
        } catch (error) {
            if (state === null || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (stat === null) {
            fs.mkdirSync(current);
            state!.createdDirs.push(current);
            stat = fs.lstatSync(current);
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new LinkOnTheWayError(parts.slice(0, i + 1).join('/'));
        }
    }
    return current;
}

/** Open a fresh temp file in `dirAbs`, give it `mode` when set, write `data`, close it. */
function writeTemp(dirAbs: string, data: string | Buffer, mode: number | null, onOpen: (tempAbs: string) => void): void {
    const tempAbs = path.join(dirAbs, tempName());
    const fd = fs.openSync(tempAbs, TEMP_FLAGS, 0o666);
    onOpen(tempAbs);
    try {
        if (mode !== null) fs.fchmodSync(fd, mode);
        fs.writeFileSync(fd, data);
    } finally {
        fs.closeSync(fd);
    }
}

/** The permission bits of an existing regular file at `targetAbs`, or null. */
function existingMode(targetAbs: string): number | null {
    try {
        const stat = fs.lstatSync(targetAbs);
        return stat.isFile() ? stat.mode & 0o7777 : null;
    } catch {
        return null;
    }
}

export function stageFile(destination: string, dirRel: string, fileName: string, relPath: string, data: string | Buffer, state: StageState): void {
    const dirAbs = ensureRealDirs(destination, dirRel, state);
    const targetAbs = path.join(dirAbs, fileName);
    writeTemp(dirAbs, data, existingMode(targetAbs), (tempAbs) => {
        state.staged.push({ relPath, dirRel, tempAbs, targetAbs });
    });
}

/** Undo a stage: remove every temp file, then every directory this stage created (newest first, only if empty). */
export function rollbackStage(state: StageState): void {
    for (const s of state.staged) {
        try {
            fs.unlinkSync(s.tempAbs);
        } catch {
            // already gone
        }
    }
    for (const dir of [...state.createdDirs].reverse()) {
        try {
            fs.rmdirSync(dir);
        } catch {
            // not empty, or gone: keep it
        }
    }
}

/** Rename every staged file into place, in order. Stops at the first failure and removes the remaining temps. */
export function commitStaged(destination: string, state: StageState): { committed: string[]; failure: { relPath: string; error: unknown } | null } {
    const committed: string[] = [];
    for (let i = 0; i < state.staged.length; i++) {
        const s = state.staged[i];
        try {
            ensureRealDirs(destination, s.dirRel, null);
            fs.renameSync(s.tempAbs, s.targetAbs);
            committed.push(s.relPath);
        } catch (error) {
            for (const rest of state.staged.slice(i)) {
                try {
                    fs.unlinkSync(rest.tempAbs);
                } catch {
                    // already gone
                }
            }
            return { committed, failure: { relPath: s.relPath, error } };
        }
    }
    return { committed, failure: null };
}

/** Write `dir/name` through a temp file and a rename: never half-written, never through a link at `name`. */
export function writeFileAtomic(dir: string, name: string, data: string | Buffer): void {
    const targetAbs = path.join(dir, name);
    let tempAbs: string | null = null;
    try {
        writeTemp(dir, data, existingMode(targetAbs), (opened) => {
            tempAbs = opened;
        });
        fs.renameSync(tempAbs!, targetAbs);
    } catch (error) {
        if (tempAbs !== null) {
            try {
                fs.unlinkSync(tempAbs);
            } catch {
                // already gone
            }
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

### Task 3: doc pull commits through staged writes (cli#168, cli#188, cli#182)

**Files (file scope):**
- Modify: `src/commands/doc-pull.ts` (`commitDocs` ~520-555 and its call in `report()` ~1146-1150; the manifest write ~1251). Task 1 changed `docPullWithConfig` earlier; don't touch that.
- Modify: `src/utils/docs-manifest.ts` (`writeManifest` uses `writeFileAtomic`)
- Create: `tests/doc-pull-transactional.test.ts` (spawned)
- Modify: `README.md` (the `### doc` section: one sentence about `.sa-pull-*.tmp`)

**Interfaces:**
- Consumes: from `src/utils/doc-pull-writes.ts` (Task 2): `newStageState`, `stageFile`, `rollbackStage`, `commitStaged`, `writeFileAtomic`, `LinkOnTheWayError`. From doc-pull.ts: `refuseLink(rel, link, doc)`, `shown()`.
- Produces: `commitDocs(destination: string, planned: PlannedDoc[]): { manifestDocs; files; failure: { relPath: string; error: unknown; committed: number; total: number } | null }`. Task 4 edits the manifest entries it builds.

**Spec:** §1. For a doc at `<relPath>` (printed through `shown()`), the lines are exactly:
- staging failure: `error: cannot write <relPath>: <error message> — nothing was changed.`
- commit failure: `error: cannot write <relPath>: <error message> — <k> of <n> files were updated; the manifest records exactly what was written.`

- [ ] **Step 1: Write the failing tests** in `tests/doc-pull-transactional.test.ts` (spawned; the doc-pull fixtures as in `tests/doc-pull-write-safety.test.ts`). Pull with `-y` where the destination is non-empty.
  1. **Staging failure changes nothing** (skip on win32/root).
     - Setup: a first pull writes `a.md` (body `A1`) and `sub/b.md` (body `B1`). Save the manifest's bytes. Then `chmod 0o555 <out>/sub`.
     - The server now returns `A2` and `B2`. Pull again: exit 1, stderr has `error: cannot write sub/b.md: ` … ` — nothing was changed.`
     - `a.md` still reads `A1`, `sub/b.md` reads `B1`, and the manifest bytes are identical to the saved ones.
     - No file matching `.sa-pull-*.tmp` exists anywhere under `<out>`. Restore the mode in `finally`.
  2. **A failed pull leaves no new directory** (skip on win32/root).
     - Setup: a first pull writes `sub/b.md`. Then the server also lists a new doc in a new subfolder, `new/c.md`, ordered so that it is planned **before** `sub/b.md`. Check the planned order, and reorder the fixture if needed. Then `chmod 0o555 <out>/sub`.
     - Pull with `-y`: staging creates `new/` and stages `c.md`, then fails on `sub/b.md`.
     - Expect exit 1 with the staging line for `sub/b.md`, `<out>/new` does not exist, and no temp files remain. Restore the mode in `finally`.
  3. **Hard link (cli#188):** a first pull writes `a.md` (`A1`). Hard-link `<tmp>/outside.md` to `<out>/a.md`. The server returns `A2`; pull with `-y`: exit 0, `a.md` reads `A2`, `<tmp>/outside.md` still reads `A1`.
  4. **Mode kept:** after a first pull, `chmod 0o600 <out>/a.md`. The server returns `A2`; pull: `a.md` reads `A2`, and its mode `& 0o777` is `0o600`.
  5. **No temp files after a normal pull:** the walk of `<out>` finds no `.sa-pull-*.tmp`, and the manifest parses.
  - The commit-failure line (a rename failing mid-commit) cannot be provoked by a spawned test without a mock. It is pinned at module level in Task 2 (case 8). Here, describe in the report where `commitDocs` handles `failure`.

- [ ] **Step 2: Run them and watch them fail.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull-transactional.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-3-red.log`
Expected: FAIL on 1 (today `a.md` is already `A2` and the error is a raw EACCES line), 2 and 3 (`outside.md` reads `A2`). Cases 4-5 may pass today: say so in the report.

- [ ] **Step 3: Implement** in `src/commands/doc-pull.ts`:

```ts
import { LinkOnTheWayError, commitStaged, newStageState, rollbackStage, stageFile } from '../utils/doc-pull-writes';

function commitDocs(destination: string, planned: PlannedDoc[]): {
    manifestDocs: DocsManifest['docs'];
    files: Array<{ path: string; action: 'written' }>;
    failure: { relPath: string; error: unknown; committed: number; total: number } | null;
} {
    // Phase 1 (spec §1): stage every file next to its target. Any failure removes
    // every temp and every directory this pull created: nothing else was touched.
    const state = newStageState();
    for (const p of planned) {
        const data = p.isMedia ? p.mediaBytes : p.doc.body;
        if (data === null) continue; // a failed media download writes nothing
        try {
            stageFile(destination, p.dirRel, p.fileName, p.relPath, data, state);
        } catch (error) {
            rollbackStage(state);
            if (error instanceof LinkOnTheWayError) refuseLink(p.relPath, error.component, p.doc);
            process.stderr.write(chalk.red(`error: cannot write ${shown(p.relPath)}: ${shown((error as Error).message)} — nothing was changed.\n`));
            process.exit(1);
        }
    }

    // Phase 2: rename each staged file into place.
    const { committed, failure } = commitStaged(destination, state);
    const committedSet = new Set(committed);
    const manifestDocs: DocsManifest['docs'] = {};
    const files: Array<{ path: string; action: 'written' }> = [];
    for (const p of planned) {
        const wrote = committedSet.has(p.relPath);
        if (wrote) files.push({ path: p.relPath, action: 'written' });
        if (failure !== null && !wrote) continue; // not committed: report() keeps the previous entry
        manifestDocs[p.relPath] = {
            id: p.doc.id,
            title: p.doc.title,
            current_revision_id: p.doc.current_revision_id,
            media: p.isMedia,
            body_sha256: p.bodySha256,
        };
    }
    return {
        manifestDocs,
        files,
        failure: failure === null ? null : { relPath: failure.relPath, error: failure.error, committed: committed.length, total: state.staged.length },
    };
}
```

In `report()`:
- Keep `fs.mkdirSync(destination, { recursive: true });`: the destination itself may be created. Its components below are created by staging.
- After `const { manifestDocs, files, failure } = commitDocs(destination, planned);`, handle a failure before the rule-5 and rename-cleanup blocks:

```ts
    if (failure !== null) {
        // cli#168: record exactly what was written. Committed docs get their new
        // entries; every other doc keeps its previous entry (its old file is in place).
        const committedIds = new Set(Object.values(manifestDocs).map((entry) => entry.id));
        const kept = Object.fromEntries(Object.entries(previousManifest?.docs ?? {}).filter(([, entry]) => !committedIds.has(entry.id)));
        writeManifest(destination, { folder_path: folderPath, docs: { ...kept, ...manifestDocs } });
        process.stderr.write(chalk.red(`error: cannot write ${shown(failure.relPath)}: ${shown((failure.error as Error).message)} — ${failure.committed} of ${failure.total} files were updated; the manifest records exactly what was written.\n`));
        process.exit(1);
    }
```

In `src/utils/docs-manifest.ts`:

```ts
import { writeFileAtomic } from './doc-pull-writes';

export function writeManifest(dir: string, manifest: DocsManifest): void {
    writeFileAtomic(dir, DOCS_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}
```

README, `### doc` section, one sentence: "`doc pull` writes each file to a hidden `.sa-pull-*.tmp` file next to it and renames it into place. A pull that fails leaves your files and the manifest as they were, though a pull that is killed mid-way can leave such temp files behind, and they are safe to delete."

- [ ] **Step 4: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull-transactional.test.ts tests/doc-pull-writes.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-3-green.log`
Then: `npx vitest run --project unit tests/doc-pull.test.ts tests/doc-pull-write-safety.test.ts tests/doc-pull-rename-matrix.test.ts tests/doc-pull-display-guard.test.ts tests/doc-pull-display-text.test.ts tests/doc-push.test.ts tests/docs-manifest.test.ts tests/doc-media-401.test.ts tests/readme-contract.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-3-neighbours.log`
Expected: PASS. The rename matrix has ~391 rows and takes about a minute. An older row that now fails is a finding: stop and report it with the row name.

- [ ] **Step 5: Report (do not commit).** List every changed path, each run with its counts and log path, and anything you had to stop on.

---

### Task 4: a failed download keeps the tracking it had (cli#183, cli#190)

**Files (file scope):**
- Modify: `src/commands/doc-pull.ts` (`commitDocs`'s entry for a failed media download; the rule-5 block in `report()` after `commitDocs`, ~1152-1170; `report()`'s parameters and its two call sites in `docPullWithConfig`)
- Create: `tests/doc-pull-failed-download.test.ts` (spawned)
- Modify: `tests/doc-pull-display-guard.test.ts` (only to add one `ALLOWED` entry for `lost`, if the guard flags it; see Step 3)

**Interfaces:**
- Consumes: Task 3's `commitDocs`.
- Produces: `report(…, listedIds: Set<number>)`, a new last parameter. A folder pull passes the ids of the listing rows; the single-doc fallback passes `new Set([data.id])`. `commitDocs` gains a third parameter, `previousManifest: DocsManifest | null`.

**Spec:** §2. Lines, for failed doc A at path P (values through `shown()`):
- B kept: `! doc <A id> ("<A title>") failed to download and <P> holds doc <B id>'s file ("<B title>"); still tracking it as doc <B id> — pull again later`
- B not kept: `! doc <A id> ("<A title>") failed to download and <P> holds a local file; not tracking it — pull again later. Doc <B id> ("<B title>") was tracked at <P> before and is no longer tracked there.`

- [ ] **Step 1: Write the failing tests** in `tests/doc-pull-failed-download.test.ts` (spawned; the media fixtures from `tests/doc-pull.test.ts`, with a signed-URL route you can make answer 500).
  1. **cli#183:** a first pull writes media doc 5 at `pic.png`, so the manifest records its hash and revision. Then the download route answers 500 with doc 5 unchanged in the listing. Pull with `-y`: exit 0. The manifest entry at `pic.png` is deep-equal to the first pull's entry (same `body_sha256`, same `current_revision_id`), not `body_sha256: null`. `pic.png`'s bytes are unchanged.
  2. **cli#190, B kept.** Write the previous manifest and file by hand (as `tests/doc-pull-write-safety.test.ts` does): `<out>/P.png` tracked for doc B (id 9, with its real sha256).
     - The server lists media doc A (id 7) titled to land at `P.png`, plus doc B (id 9). `bulk_read` answers A found and B with a non-`found` status, so B is skipped with a warning.
     - A's download answers 500. Pull with `-y`.
     - Expect: the B-kept line in stderr, and the manifest still has `P.png` → doc 9 with its hash. `P.png` is unchanged.
  3. **cli#190, B gone:** the same, but B is not in the listing at all (deleted on the server). Expect: the B-not-kept line in stderr, and the manifest has no entry for doc 9 at `P.png`. Do not assert on `P.png`'s presence: deletion propagation treats it as an orphan.
  4. **Unchanged:** a failed download at a new path with no previous entry keeps today's behaviour (no entry for it, no warning beyond the existing download warning).

- [ ] **Step 2: Run them and watch them fail.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull-failed-download.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-4-red.log`
Expected: FAIL on 1 (hash null), 2 (B's entry dropped) and 3 (no "no longer tracked" sentence). Case 4 passes.

- [ ] **Step 3: Implement** in `src/commands/doc-pull.ts`.
  - `commitDocs(destination, planned, previousManifest)`: for a media doc whose download failed (`p.isMedia && p.mediaBytes === null`), when `previousManifest?.docs[p.relPath]` exists with `id === p.doc.id`, record **that previous entry unchanged** at `p.relPath`. Otherwise record today's entry.
  - `report(…, listedIds: Set<number>)`: in `docPullWithConfig`, pass `new Set(rows.map((row) => row.id))` for a folder pull and `new Set([data.id])` for the single-doc fallback.
  - In the rule-5 block, where today `delete manifestDocs[p.relPath]` and the yellow warning are printed:

```ts
        const before = previousManifest?.docs[p.relPath];
        const otherDoc = before !== undefined && before.id !== p.doc.id && before.body_sha256 != null ? before : undefined;
        const plannedIds = new Set(planned.map((q) => q.doc.id));
        delete manifestDocs[p.relPath];
        if (otherDoc !== undefined && listedIds.has(otherDoc.id) && !plannedIds.has(otherDoc.id)) {
            // cli#190: the other doc is still on the server and was not moved: keep its tracking.
            manifestDocs[p.relPath] = otherDoc;
            process.stderr.write(chalk.yellow(`! doc ${p.doc.id} ("${shown(p.doc.title)}") failed to download and ${shown(p.relPath)} holds doc ${otherDoc.id}'s file ("${shown(otherDoc.title)}"); still tracking it as doc ${otherDoc.id} — pull again later\n`));
            continue;
        }
        const lost = otherDoc === undefined ? '' : ` Doc ${otherDoc.id} ("${shown(otherDoc.title)}") was tracked at ${shown(p.relPath)} before and is no longer tracked there.`;
        process.stderr.write(chalk.yellow(`! doc ${p.doc.id} ("${shown(p.doc.title)}") failed to download and ${shown(p.relPath)} holds a local file; not tracking it — pull again later.${lost}\n`));
```

  Keep the block's existing early `continue`s. Today it continues when the previous entry at P is the same doc with a hash; with cli#183 that entry is now the kept previous one. `lost` is built from `shown()` parts; add it to the display guard's `ALLOWED` map only if the guard flags it, with that reason.

- [ ] **Step 4: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull-failed-download.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-4-green.log`
Then: `npx vitest run --project unit tests/doc-pull.test.ts tests/doc-pull-write-safety.test.ts tests/doc-pull-rename-matrix.test.ts tests/doc-pull-display-guard.test.ts tests/doc-pull-display-text.test.ts tests/doc-pull-transactional.test.ts 2>&1 | tee .superpowers/sdd/2026-10-05-cli-docpull/task-4-neighbours.log`
Expected: PASS. If a write-safety row asserting the old rule-5 warning text now differs only by the added sentence, that is a finding: report the row; do not edit it.

- [ ] **Step 5: Report (do not commit).** List every changed path, each run with its counts and log path, and anything you had to stop on.

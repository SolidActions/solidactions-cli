# Wave cli-docpull — design

**Wave:** cli-docpull (CrewOps wave card task-waveclidocpull-da80, run seq:sa-wave-cli:f1b70309), branch `wave/2026-10-05-cli-docpull`, cut from main at bd7efc5 (wave cli-hardening merged).
**Issues:** cli#168, cli#183, cli#190, cli#188, cli#191, cli#176, cli#182. Peter approved the wave in CrewOps ask task-starttheclidoc-01c7 ("approved", built mainly on Muse), recorded on each issue.
**Plan:** `docs/superpowers/plans/2026-10-05-cli-docpull.md`.
**Plan review:** Sol (task-planreviewcli-d807) REQUEST CHANGES d5474a7. The PM's rulings 1-6 (plan card task-planclidocpull-948e, also on cli#168) are folded in below.

Each issue lists acceptable fixes; this spec picks one per issue. Cited later as "spec §N". Every message below is printed through doc-pull.ts's `shown()` display sanitiser (wave cli-hardening, cli#189), and `tests/doc-pull-display-guard.test.ts` keeps that true.

## 1. An ordered, journalled commit: a pull is all-or-nothing (cli#168, cli#188, cli#182)

`commitDocs` (src/commands/doc-pull.ts) today does `mkdirSync(recursive)` and `writeFileSync` on each target in turn, then rename cleanup, then the manifest. A failure part-way leaves changed files behind the old manifest. A hard-linked target is written in place (cli#188). A link planted after wave cli-safety's checks is followed (cli#182). Per-file atomic replacement alone does not fix the group, as the plan review showed (task-planreviewcli-d807 C1).

PM rulings 1-2 (plan card task-planclidocpull-948e) set the order. The ruling and the test hooks are recorded on cli#168 (issuecomment-6008515604). The new module `src/utils/doc-pull-writes.ts` does the file work and throws; doc-pull.ts prints every message.

### 1.1 The three invariants

- **INV-1, all or nothing.** After any `doc pull` exit, the destination's tracked files and manifest are either entirely the previous state or entirely the new state. A failure, or a refusal at publication, leaves the previous state. An interruption (kill, crash, power loss) leaves a journal, and the next pull into that destination completes or rolls back first (§1.4).
- **INV-2, never through a link.** No byte outside the destination changes, whether through a hard link to a tracked file or through a symbolic link planted at the final path component. This is qualified by the directory-component race in §1.6.
- **INV-3, no clobber.** A file the pull does not own is never replaced without `--overwrite`, neither at wave cli-safety's preflight nor at publication. A file that changed after the pull checked it counts as not owned.

### 1.2 Order

0. **Recover** (§1.4): this runs before anything else in a destination that holds a journal.
1. **Preflight and plan:** unchanged (wave cli-safety's checks). New: `report()` computes the **final manifest** (every entry, including the failed-download, rename-keep and single-doc merge rules) **before** any write. Rename cleanup and deletion propagation are computed then but run only after publication (step 5).
2. **Stage**, writing only temp files:
   - **Directories:** walk each `dirRel` one component at a time below the destination. A missing component is created (non-recursive `mkdirSync`) and recorded. Every component must `lstat` as a real directory, never a link; otherwise `LinkOnTheWayError(component)`. The destination itself is not checked (wave cli-safety allows a symlinked destination).
   - **Doc temps:**
     - Each doc with bytes gets `.sa-pull-<pid>-<12 hex>.tmp` in its target directory, opened with `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` (`fs.constants.O_NOFOLLOW ?? 0`), mode `0o666` less the umask.
     - When the target exists as a regular file, the temp gets its permission bits (`fchmod`).
     - Staging records the target's **expectation**: `absent`, `sha256:<hex of its current bytes>`, or `any` when `--overwrite` is given.
     - It reserves a backup name `.sa-pull-<pid>-<12 hex>.bak` for an existing target.
   - **Manifest temp:** the new manifest bytes go to a temp file in the destination root, the same way.
   - **Journal:** `.solidactions-pull-journal.json` in the destination root, written through a temp file and a rename. It holds `{ "version": 1, "manifest_sha256": "<hex of the new manifest bytes>", "manifest_temp": "<rel>", "created_dirs": ["<rel>", …], "entries": [{ "target": "<rel>", "temp": "<rel>", "backup": "<rel>" | null }] }`. All paths are relative to the destination.
3. **Commit**, for each staged doc in plan order:
   1. **Re-check:** the target's `lstat` and bytes must still match the expectation. `absent` means no entry at the name. `sha256` means a regular file with those bytes. `any` always passes. A mismatch is a publication refusal (INV-3).
   2. Re-check that every directory component is still a real directory.
   3. If the target exists, `rename(target, backup)`.
   4. `rename(temp, target)`. This rename replaces the directory entry: a hard link's other names keep their old inode and bytes (cli#188), and a link planted at the final name is replaced, not followed (cli#182).
4. **Publish:** `rename(manifest temp, .solidactions-docs.json)`.
5. **Finalize:**
   - Unlink the journal, then the backups. A backup that cannot be removed prints `! could not remove <backup rel>: <message> — it is the previous copy of <target rel>; delete it yourself`, and the pull still exits 0.
   - Then rename cleanup and deletion propagation run as today, now after publication, so their removals never precede the manifest.

### 1.3 Failure before publication: roll back, nothing changed

Any error in steps 2-4, or a publication refusal, rolls back in reverse:
- each entry already renamed into place: if it has a backup, `rename(backup, target)`, which restores the original inode, hard links included; otherwise `unlink(target)`;
- every remaining temp, the manifest temp and the journal are removed;
- each directory this pull created is removed (newest first, only if empty).
The previous manifest was never touched.

doc-pull.ts prints one line and exits 1:
- an error: `error: cannot write <rel>: <error message> — nothing was changed.` (`<rel>` is the path being written: a doc, the manifest `.solidactions-docs.json`, or the journal);
- a publication refusal: `error: <rel> changed after doc pull checked it — nothing was changed. Pull again, or pass --overwrite to replace it.`;
- a `LinkOnTheWayError`: wave cli-safety's link refusal (`refuseLink`).

If a rollback step itself fails, the journal is **kept** and the line ends `— could not restore <rel> (<message>); the next doc pull into this folder finishes the rollback.` instead of `— nothing was changed.` The exit is still 1.

### 1.4 Recovery from an interrupted pull

At the start of every pull into an existing destination, before the "not empty" check, `doc pull` looks for the journal:
- **Unreadable or invalid:** the JSON does not parse, the version is not 1, or a path is absolute or contains `..`. The pull refuses and changes nothing:
  `error: <destination> holds a damaged pull journal (.solidactions-pull-journal.json) from an interrupted pull; check the .sa-pull-*.bak files next to your docs, then delete the journal and pull again.`
- **The manifest's bytes hash to `manifest_sha256`:** the interrupted pull had published, so it is **rolled forward**. Its backups, temps and journal are removed: `! finished an interrupted pull in <destination> (removed its leftover backups)`.
- **Otherwise** it is **rolled back**, per entry:
  - a backup exists: `rename(backup, target)`;
  - no backup, and the temp is gone: the target is this pull's new file, so `unlink(target)`;
  - the temp exists: `unlink(temp)`.

  Then the manifest temp, the created directories (if empty) and the journal are removed: `! rolled back an interrupted pull in <destination>: restored <n> file(s)`.

The pull then continues normally.

### 1.5 Test-only fault points

These are inert unless `SOLIDACTIONS_TEST_HOOKS=1`. `SOLIDACTIONS_DOC_PULL_TEST_FAULT` selects one:
- `kill-after-renames:<n>`: `process.kill(process.pid, 'SIGKILL')` after the n-th doc rename of step 3;
- `kill-after-publish`: the same kill right after step 4;
- `readonly-before-commit:<dirRel>`: `chmod 0o555` that directory between steps 2 and 3;
- `create-before-commit:<rel>`: write a file `RACE` at that path between steps 2 and 3.
- `link-before-commit:<rel>><abs target>`: create a symbolic link at `<rel>` pointing to `<abs target>` between steps 2 and 3 (a link planted after the checks).
- `readonly-after-publish:<dirRel>`: `chmod 0o555` that directory right after step 4, so removing a backup there fails (the cleanup failure point).

They perform real filesystem actions or a real kill, never a substitute. A spawned test can then reach every failure point: a doc temp, the manifest temp, a doc rename, the manifest rename, a publication refusal (a file or a link planted after staging), an interrupted commit, an interrupted cleanup, and a cleanup failure. The code documents them as test-only; the README does not.

### 1.6 Limits (documented, not closed)

- Node has no `openat`. A directory component swapped for a link between the step-3 re-check and the rename can still redirect the rename. This is a local race in the user's own folder (cli#182 says so). The final component, which the issue names, is closed.
- A case-insensitive or normalising filesystem (macOS, Windows) can make two names refer to one entry. The behaviour there is tested where the filesystem allows (§1.7). CI's unit tests run on Linux, so those cases skip there with a stated reason.

### 1.7 Platform-sensitive cases

The tests detect a case-insensitive filesystem at runtime (create `aB`, check that `Ab` exists), and Unicode normalisation the same way (NFC name, NFD lookup). On a filesystem without the property, each such test is **skipped with an explicit reason in its title** (`it.skipIf(…)('… (needs a case-insensitive filesystem; CI unit tests run on Linux)')`), never silently. The `O_NOFOLLOW`-less path (Windows) is covered the same way.

### 1.8 Manifest helper

`writeManifest` (src/utils/docs-manifest.ts) writes through the same temp-and-rename helper (`writeFileAtomic`), so `doc push`'s manifest writes are never half-written either. `doc pull` itself publishes through §1.2 step 4.

### 1.9 README

The README's `### doc` section gets a paragraph:
- a pull is all or nothing;
- an interrupted pull is finished or rolled back by the next pull into the folder;
- `.sa-pull-*` and `.solidactions-pull-journal.json` files belong to that mechanism.

## 2. A failed download keeps the tracking it had (cli#183, cli#190)

**cli#183.** A media doc whose download failed, at an unchanged path the previous manifest tracked for the **same** doc id, keeps that previous manifest entry unchanged (hash, revision, title, media), as a failed rename already does. Today `commitDocs` records `body_sha256: null` there.

**cli#190.** A media doc A whose download failed, at a path P that the previous manifest tracked, with a hash, for a **different** doc B. Wave cli-safety's rule 5 drops A's entry and prints a warning. Now:
- If B is still on the server (its id is in the set of doc ids the server listed in this pull) and B is not planned at any path in this pull, B's previous entry at P is kept:
  `! doc <A id> ("<A title>") failed to download and <P> holds doc <B id>'s file ("<B title>"); still tracking it as doc <B id> — pull again later`
- Otherwise (B was deleted on the server, or this pull moves it elsewhere), the existing warning gains a sentence. When B was deleted on the server, deletion propagation then treats P as it treats any orphan (an unmodified file is removed and listed as "removed (deleted remotely)").
  The warning:
  `! doc <A id> ("<A title>") failed to download and <P> holds a local file; not tracking it — pull again later. Doc <B id> ("<B title>") was tracked at <P> before and is no longer tracked there.`
- "Listed by the server in this pull" is new data for `report()`: `docPullWithConfig` passes the set of ids from the listing rows (for the single-doc fallback, that one doc's id).

## 3. An unreadable destination is one line (cli#191)

In `docPullWithConfig`, the existence/`statSync`/`readdirSync` checks of the destination catch a filesystem error and print one line, then exit 1:
`error: cannot read <destination>: <error message>`
(for example `error: cannot read /home/u/out: EACCES: permission denied, scandir '/home/u/out'`). Wave cli-hardening's command boundary already prints such an error on one line. This gives it the issue's wording, at the point where it happens.

## 4. No terminal to answer the prompt fails loudly (cli#176)

When the destination is not empty, neither `-y` nor `--overwrite` is given, and stdin is not a terminal (`process.stdin.isTTY !== true`), `doc pull` does not prompt. It prints one line and exits 1:
`error: <destination> is not empty and there is no terminal to confirm the pull; pass -y to pull into it.`
With a terminal, the prompt and its "Cancelled." exit 0 on a "no" are unchanged. `-y` and `--overwrite` keep skipping the prompt.

## 5. Out of scope

- Closing the directory-component race (§1 residual window) needs `openat`, which Node's `fs` lacks.
- `doc push`'s own write paths (beyond `writeManifest`).

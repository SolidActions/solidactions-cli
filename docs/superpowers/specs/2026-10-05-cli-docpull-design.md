# Wave cli-docpull — design

**Wave:** cli-docpull (CrewOps wave card task-waveclidocpull-da80, run seq:sa-wave-cli:f1b70309), branch `wave/2026-10-05-cli-docpull`, cut from main at bd7efc5 (wave cli-hardening merged).
**Issues:** cli#168, cli#183, cli#190, cli#188, cli#191, cli#176, cli#182. Peter approved the wave in CrewOps ask task-starttheclidoc-01c7 ("approved", built mainly on Muse), recorded on each issue.
**Plan:** `docs/superpowers/plans/2026-10-05-cli-docpull.md`.
**Plan reviews:** Sol re-check 2 (task-planrecheck2cli-d0bc, REQUEST CHANGES 7d9a0f4) gave the mandatory build rulings 8-10 (build card task-buildclidocpull-c955), folded in below. Earlier: Sol (task-planreviewcli-d807) REQUEST CHANGES d5474a7; PM rulings 1-6 (plan card task-planclidocpull-948e). Sol's re-check (task-planrecheckcli-48d5) REQUEST CHANGES 0a92aa3; PM ruling 7 (plan-check card task-plancheckcli-f9a4) simplified §1. Both are folded in below.

Each issue lists acceptable fixes; this spec picks one per issue. Cited later as "spec §N". Every message below is printed through doc-pull.ts's `shown()` display sanitiser (wave cli-hardening, cli#189), and `tests/doc-pull-display-guard.test.ts` keeps that true.

## 1. An ordered commit with a staging folder (cli#168, cli#188, cli#182)

`commitDocs` (src/commands/doc-pull.ts) today does `mkdirSync(recursive)` and `writeFileSync` on each target in turn, then rename cleanup, then the manifest. A failure part-way leaves changed files behind the old manifest. A hard-linked target is written in place (cli#188). A link planted after wave cli-safety's checks is followed (cli#182).

This is the design of **PM ruling 7** (plan-check card task-plancheckcli-f9a4), which replaced the journal design. Recorded on cli#168 (issuecomment-6008646035). The module `src/utils/doc-pull-writes.ts` does the file work and throws; doc-pull.ts prints every message.

### 1.1 The guarantee (what the README says)

- **In-process failures leave the previous state.** Any error while a pull writes leaves the previous files and the previous manifest, and the pull exits 1 with one line. That covers a write, a rename, the manifest temp or the manifest rename, and a target that changed after the checks.
- **A hard kill leaves the old manifest.** If the process is killed while files are being renamed into place, some files may already hold the new bytes while the manifest is still the old one. Tracked files are always re-verified by hash, so the next pull sees those files as differing from the manifest. It never overwrites them silently. The next pull also finds the leftover staging folder and cleans it up (§1.4).
- **No power-loss durability is claimed.** The CLI does not `fsync`. After a power loss the files are in whatever state the OS persisted.

### 1.2 The three invariants (one sweep test each)

- **INV-A, never outside the destination.** No byte outside the destination changes, whether through a hard link to a tracked file or through a symbolic link at the final path component, planted before or after the checks. This is qualified by the directory-component race in §1.6.
- **INV-B, no clobber.** A file the pull does not own is never replaced without `--overwrite`, neither at wave cli-safety's preflight nor at the moment of each rename. A file created or changed after the preflight is not owned.
- **INV-C, honest manifest.** Every manifest doc pull writes records, for each entry with a hash, exactly the bytes that pull left at that path. An in-process failure writes no manifest. The sweep's assertion (ruling 10): every hash matches the file on disk, or the file is listed as refused with its reason.

### 1.3 Order

1. **Leftover check** (§1.4): this runs before anything else in an existing destination.
2. **Preflight and plan:** wave cli-safety's checks, unchanged. New:
   - `report()` computes the **final manifest** (every entry, including the failed-download, rename-keep and single-doc merge rules) before any write. Rename cleanup and deletion propagation are computed then, but run only after publication (step 6).
   - Right after the checks, `report()` records each target's **authorized state**: `absent`, `sha256:<hex of its bytes now>` (a file the checks allowed the pull to replace), or `any` when `--overwrite` is given. This is the state the preflight approved. A later snapshot never widens it.
3. **Stage:** create the staging folder `<destination>/.solidactions-pull-<pid>/`, with a non-recursive `mkdirSync`, mode `0o700`. A leftover of the same name is removed first only if its pid is not running (§1.4). Then write each doc with bytes (a media doc whose download failed has none) to `new/<n>` inside it, `n` a counter, opened with `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` (`fs.constants.O_NOFOLLOW ?? 0`). Then write the new manifest to `manifest.tmp` there.
4. **Commit**, for each staged doc in plan order:
   1. **Directories:** walk the target's `dirRel` one component at a time from the destination. A missing component is created (non-recursive) and recorded. Every component must `lstat` as a real directory, never a link; otherwise `LinkOnTheWayError`. The destination itself is not checked (wave cli-safety allows a symlinked destination).
   2. **Re-check (INV-B):** `lstat` the target. `absent` requires no entry at the name. `sha256` requires a regular file with exactly those bytes. `any` always passes. A mismatch is a publication refusal.
   3. **Backup:** if a file or a link is at the target (ruling 9: a folder or any other entry type is refused with `UnsupportedTargetError` before the authorization check, even under `--overwrite`, and is never moved or deleted), `rename(target, <staging>/backup/<relPath>)`, creating the backup's parent folders inside the staging folder. The backup is decided now, at commit time, so a target created late under `--overwrite` is backed up too.
   4. **Mode:** if the backup is a regular file, `chmod` the staged file to its permission bits.
   5. **Rename:** `rename(<staging>/new/<n>, target)`. A rename replaces the directory entry. A hard link's other names keep their old inode and bytes (cli#188), and a link at the final name is replaced, not followed (cli#182).
5. **Publish:** `rename(<staging>/manifest.tmp, .solidactions-docs.json)`.
6. **Finalize:** remove the staging folder, backups included. A failure to remove it prints `! could not remove <staging rel>: <message> — it holds the previous copies of the files this pull replaced; delete it yourself` and the pull still exits 0. Then rename cleanup and deletion propagation run as today, after publication.

All renames stay inside the destination. A destination subfolder on a different filesystem makes a rename fail with `EXDEV`, which is an ordinary in-process failure.

### 1.4 Leftovers from a killed pull

At the start of every pull into an existing destination, before the "not empty" check, `doc pull` looks for entries named `.solidactions-pull-<digits>` in the destination root:
- **A real directory whose pid is a running process** (`process.kill(pid, 0)` succeeds, and it is not this process): another pull is running there. Refuse, changing nothing:
  `error: another doc pull (pid <pid>) is writing to <destination>; wait for it to finish.`
- **Anything else with that name that is not a real directory** (for example a link): refuse, changing nothing:
  `error: <destination>/<name> is not a folder doc pull created; remove it and pull again.`
- **A real directory whose pid is not running:** clean it up. Walk `backup/` without following links. Every path is derived from the walk, never from stored text, and checked to be inside the destination with real-directory parents (the `ensureRealDirs` check). For each backup at `backup/<rel>`:
  - **target absent:** `rename(backup, target)` (restored);
  - **target present with the same bytes:** drop the backup;
  - **target present with different bytes** (the killed pull's new version, or a later edit): change nothing for that file, and count it.

  Then:
  - **no differing targets:** remove the folder and print `! cleaned up after an interrupted doc pull in <destination> (restored <n> file(s))`, and the pull continues;
  - **otherwise:** keep the folder and refuse:
    `error: an interrupted doc pull left saved copies in <destination>/<name>; <k> file(s) differ from their saved copies (first: <rel>), so neither was changed. Keep the versions you want, delete that folder, and pull again.`

A file the killed pull created new, with no backup, is not removed. With the old manifest it is an untracked file. Wave cli-safety's rules then handle it: the next pull adopts it if the bytes match, and otherwise refuses without `--overwrite`.

### 1.5 In-process failure: roll back

Any error in steps 3-5, or a publication refusal, rolls back in reverse:
- every target already renamed into place gets its backup renamed back; with no backup it is unlinked;
- every directory this pull created is removed (newest first, only if empty);
- the staging folder is removed;
- the previous manifest was never touched.

doc-pull.ts prints one line and exits 1:
- an error: `error: cannot write <rel>: <error message> — nothing was changed.`, where `<rel>` is the doc path, or `.solidactions-docs.json` for the manifest temp or rename;
- a publication refusal: `error: <rel> changed after doc pull checked it — nothing was changed. Pull again, or pass --overwrite to replace it.`;
- a `LinkOnTheWayError`: wave cli-safety's link refusal (`refuseLink`);
- a folder at a target (ruling 9): `error: <rel> is a folder now (doc pull writes a file there) — nothing was changed. Move it aside and pull again.`

**Ruling 8:** every reverse step runs the forward path's parent checks (`ensureRealDirs`) on both ends: the target's parents in the destination, and the backup's parents in the staging folder. That covers putting a backup back, removing a new file, removing a created folder, and leftover cleanup. Leftover cleanup also requires `backup/` itself to be a real folder. A failed check is a restore failure (the staging folder is kept), never a write through a link.

If a rollback step itself fails, the staging folder (with its backups) is **kept**. The line then ends `— could not restore <rel> (<message>); its previous copy is in <staging rel>/backup/<rel>.` instead of `— nothing was changed.`, and the next pull's leftover check (§1.4) picks it up.

### 1.6 Limits (documented, not closed)

- Node has no `openat`. A directory component swapped for a link between the step-4 directory walk and the rename can still redirect the rename. This is a local race in the user's own folder (cli#182 says so). The final component, which the issue names, is closed.
- No power-loss durability (§1.1).
- A case-insensitive or normalising filesystem (macOS, Windows) can make two names one entry. That is tested where the filesystem allows; CI's unit tests run on Linux, so those tests skip there with a stated reason (§1.7).

### 1.7 Platform-sensitive cases

The tests detect a case-insensitive filesystem at runtime (create `aB`, check that `Ab` exists), and Unicode normalisation the same way (NFC name, NFD lookup). On a filesystem without the property, each such test is **skipped with an explicit reason in its title** (`it.skipIf(…)('… (needs a case-insensitive filesystem; CI unit tests run on Linux)')`), never silently. The `O_NOFOLLOW`-less path (Windows) is covered the same way.

### 1.8 Test-only injected failures

These are inert unless `SOLIDACTIONS_TEST_HOOKS=1`. `SOLIDACTIONS_DOC_PULL_TEST_FAULT` selects one or more, comma-separated:
- `fail-rename:<n>`: the n-th doc rename (step 4.5) throws an `EIO` error instead of renaming;
- `fail-manifest-temp`: writing `manifest.tmp` throws `EIO`;
- `fail-manifest-rename`: step 5 throws `EIO`;
- `fail-restore:<n>`: during rollback, restoring the n-th backup throws `EIO` (the kept-folder path);
- `kill-after-renames:<n>`: `process.kill(process.pid, 'SIGKILL')` after the n-th doc rename (for §1.4's tests);
- `create-before-commit:<rel>`: write a file `RACE` at `<rel>` after staging (INV-B);
- `link-before-commit:<rel>><abs target>`: create a symlink at `<rel>` to `<abs target>` after staging (INV-A/B);
- `mkdir-before-commit:<rel>`: create a folder at `<rel>` holding `user.txt` after staging (ruling 9);
- `swap-before-rollback:<dirRel>><abs folder>`: before rollback, rename `<dirRel>` aside and put a symlink to `<abs folder>` in its place (ruling 8).

PM ruling 7 sanctions injected failures for the in-process failure points. The code documents these as test-only; the README does not.

### 1.9 Manifest helper and README

- `writeManifest` (src/utils/docs-manifest.ts, used by `doc push`) writes through a temp file and a rename (`writeFileAtomic`, temp next to the target), so it is never half-written. `doc pull` itself publishes through §1.3 step 5.
- The README's `### doc` section states §1.1 plainly:
  - in-process failures leave everything as it was;
  - a killed pull leaves the old manifest, and the next pull cleans up its `.solidactions-pull-*` folder or tells you what to resolve;
  - no power-loss guarantee.

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

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

1. **Claim, then leftover check** (§1.4): this runs before anything else in an existing destination, and in a new destination right after it is created. The pull creates its own staging folder `<destination>/.solidactions-pull-<pid>/` first (a non-recursive `mkdirSync`, mode `0o700`), and only then looks at every other `.solidactions-pull-*` entry. The claimed folder is empty and ignored by the "not empty" check, the planned-writes checks and `doc push` (which skips dot entries), and it is removed on every way out before the commit takes it over: a refusal, an error, a "no" at the prompt.
2. **Preflight and plan:** wave cli-safety's checks, unchanged. New:
   - `report()` computes the **final manifest** (every entry, including the failed-download, rename-keep and single-doc merge rules) before any write. Rename cleanup and deletion propagation are computed then, but run only after publication (step 6).
   - Each target's **authorized state** is the state the checks themselves saw, carried into the commit: `absent`, `sha256:<hex of the bytes the check read>` (a file the checks allowed the pull to replace), or `any` when `--overwrite` is given. Every check that reads a target (the unpushed-local-changes check, the untracked-file check, the rename-target check) records what it read; nothing reads the target again to authorize it, and the first thing recorded stands. A target no check saw is authorized as `absent`, so anything found there is refused. A later snapshot never widens it.
   - **Names.** The allocator never gives a doc file or a folder segment the manifest's name (`.solidactions-docs.json`) or a name starting with `.solidactions-pull-`, compared NFC-normalised and case-folded, at any level. Such a name takes a leading `_` (`_.solidactions-docs.json`, `_.solidactions-pull-7/`), then the usual `-N` suffix if that is taken. Names are compared the same way (NFC, case-folded) for collisions, for file names and for folder segments, so two docs (or folders) that differ only by case or Unicode normalisation get distinct names on every filesystem. Two planned writes whose paths still compare equal that way (possible only through a legacy tracked path) are refused before anything is staged: `error: <a> (doc <id>) and <b> (doc <id>) would be the same file on a case-insensitive or Unicode-normalising filesystem; this pull would write different docs through those names.` and `Nothing was written. Rename one of the docs on the server and pull again.`
3. **Stage:** inside the folder claimed in step 1, create `new/`. If something already holds the claim's name (a leftover of an earlier process that had this pid) it is classified and cleaned with the other leftovers first (§1.4). Then write each doc with bytes (a media doc whose download failed has none) to `new/<n>` inside it, `n` a counter, opened with `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` (`fs.constants.O_NOFOLLOW ?? 0`). Then write the new manifest to `manifest.tmp` there.
4. **Commit**, for each staged doc in plan order:
   1. **Directories:** walk the target's `dirRel` one component at a time from the destination. A missing component is created (non-recursive) and recorded. Every component must `lstat` as a real directory, never a link; otherwise `LinkOnTheWayError`. The destination itself is not checked (wave cli-safety allows a symlinked destination).
   2. **Re-check (INV-B):** `lstat` the target. `absent` requires no entry at the name. `sha256` requires a regular file with exactly those bytes. `any` always passes. A mismatch is a publication refusal.
   3. **Backup:** if a file or a link is at the target (ruling 9: a folder or any other entry type is refused with `UnsupportedTargetError` before the authorization check, even under `--overwrite`, and is never moved or deleted), `rename(target, <staging>/backup/<relPath>)`, creating the backup's parent folders inside the staging folder. The backup is decided now, at commit time, so a target created late under `--overwrite` is backed up too.
   4. **Mode:** if the backup is a regular file, `chmod` the staged file to its permission bits.
   5. **Rename:** `rename(<staging>/new/<n>, target)`. A rename replaces the directory entry. A hard link's other names keep their old inode and bytes (cli#188), and a link at the final name is replaced, not followed (cli#182).
5. **Publish:** `rename(<staging>/manifest.tmp, .solidactions-docs.json)`.
6. **Finalize:** remove the staging folder, backups included. A failure to remove it prints `! could not remove <staging rel>: <message> — it holds the previous copies of the files this pull replaced; delete it yourself` and the pull still exits 0. Then rename cleanup and deletion propagation run as today, after publication.

All renames stay inside the destination. A destination subfolder on a different filesystem makes a rename fail with `EXDEV`, which is an ordinary in-process failure.

### 1.4 Leftovers from a killed pull, and overlapping pulls

After claiming its own staging folder (§1.3 step 1), and before the "not empty" check, `doc pull` looks at every other entry named `.solidactions-pull-<digits>` in the destination root. **It classifies all of them first and changes none until every one is classified**; only then does it clean up the dead ones:
- **A real directory whose pid is a running process** (`process.kill(pid, 0)` succeeds or fails with `EPERM`, the pid is at least 1, and it is not this process): another pull is running there. Refuse, changing nothing (the pull removes only its own new, empty staging folder):
  `error: another doc pull (pid <pid>) may be writing to <destination> (folder <name>); wait for it to finish, or delete that folder if no doc pull is running.`
  A pid below 1 is never "running" (`kill(0, 0)` would signal the caller's own process group). A reused pid is still read as running; reliable liveness is cli#202.
- **Anything else with that name that is not a folder doc pull created** refuses the same way, changing nothing: a link, a file, or a real folder with anything at its top level other than `new/` (a folder), `backup/` (a folder) and `manifest.tmp` (a file). A real folder with other contents is never deleted, whatever its pid:
  `error: <destination>/<name> is not a folder doc pull created; remove it and pull again.`
- **A real directory in doc pull's own layout whose pid is not running:** clean it up. Walk `backup/` without following links. Every path is derived from the walk, never from stored text, and checked to be inside the destination with real-directory parents (the `ensureRealDirs` check). For each backup at `backup/<rel>`:
  - **target absent:** `rename(backup, target)` (restored);
  - **target present with the same bytes:** drop the backup;
  - **target present with different bytes** (the killed pull's new version, or a later edit): change nothing for that file, and count it.

  Then:
  - **no differing targets:** remove the folder and print `! cleaned up after an interrupted doc pull in <destination> (restored <n> file(s))`, and the pull continues;
  - **otherwise:** keep the folder and refuse:
    `error: an interrupted doc pull left saved copies in <destination>/<name>; <k> file(s) differ from their saved copies (first: <rel>), so neither was changed. Keep the versions you want, delete that folder, and pull again.`

Two pulls that start together each claim a folder, and each then sees the other's: both refuse. That is the intended safe outcome, never two publications; run the pull again. A pull that starts while another one is already fetching sees its claimed folder and refuses the same way, so no two pulls can publish into one destination at once, and no pull merges its result into a manifest that another pull is about to replace.

Any other error while cleaning up (not the destination listing itself failing) prints `error: could not clean up after an interrupted doc pull in <destination>: <message>` and changes nothing further. Only the destination listing's own failure prints `error: cannot read <destination>: <message>` (cli#191).

A file the killed pull created new, with no backup, is not removed. With the old manifest it is an untracked file. Wave cli-safety's rules then handle it: the next pull adopts it if the bytes match, and otherwise refuses without `--overwrite`.

### 1.5 In-process failure: roll back

Any error in steps 3-5, or a publication refusal, rolls back in reverse:
- every target already renamed into place gets its backup renamed back; with no backup it is unlinked. **Only if the entry at the target is still the one this pull placed** (the same device and inode as the staged file that was renamed in, read just before that rename). A file moved aside whose replacement was never placed must find the target still vacant. If something else is there, rollback leaves both the entry at the target and the saved copy alone, keeps the staging folder, and reports it as a restore failure (below);
- every directory this pull created is removed (newest first, only if empty);
- the staging folder is removed;
- the previous manifest was never touched.

doc-pull.ts prints one line and exits 1:
- an error: `error: cannot write <rel>: <error message> — nothing was changed.`, where `<rel>` is the doc path, or `.solidactions-docs.json` for the manifest temp or rename;
- a publication refusal: `error: <rel> changed after doc pull checked it — nothing was changed. Pull again, or pass --overwrite to replace it.`;
- a `LinkOnTheWayError`: wave cli-safety's link refusal (`refuseLink`);
- a folder at a target (ruling 9): `error: <rel> is a folder now (doc pull writes a file there) — nothing was changed. Move it aside and pull again.`

**Ruling 8:** every reverse step runs the forward path's parent checks (`ensureRealDirs`) on both ends: the target's parents in the destination, and the backup's parents in the staging folder. That covers putting a backup back, removing a new file, removing a created folder, and leftover cleanup. Leftover cleanup also requires `backup/` itself to be a real folder. A failed check is a restore failure (the staging folder is kept), never a write through a link.

If a rollback step itself fails, the staging folder (with its backups) is **kept**. The line ends with the one that is true, instead of `— nothing was changed.`, and the next pull's leftover check (§1.4) picks it up:
- a backup that could not be put back: `— could not restore <rel> (<message>); its previous copy is in <staging rel>/backup/<rel>.` (the saved copy is there);
- a new file this pull created that could not be removed, or was left alone because it is no longer the file this pull placed: `— could not remove <rel> (<message>); this pull created it, so it has no previous copy.`;
- a folder this pull created that could not be removed: `— could not remove the folder <rel> (<message>); this pull created it.`

Every removal of the staging folder (rollback, a failed staging step, finalize) first checks that it is still a real folder; a link that has replaced it is left alone.

### 1.6 Limits (documented, not closed)

- Node has no `openat`. A directory component swapped for a link between the step-4 directory walk and the rename can still redirect the rename. This is a local race in the user's own folder (cli#182 says so). The final component, which the issue names, is closed against a link: a rename replaces the entry and never follows it.
- **The final-component window.** Between a check (the preflight's read, or the step-4.2 re-check) and the rename that follows it, a file that the user's own tools create or change at the target is not seen. This is the same local-race class as the directory-component race, in the user's own folder, and it is not closed: closing it needs a non-replacing publish (`link()`), which `exFAT` and network shares do not offer. What is closed is the part the pull controls: the authorized state is what the checks saw, not a fresh read (§1.3 step 2), and rollback never puts a backup over, or unlinks, a file this pull did not place (§1.5). Rename cleanup and deletion propagation, which hash a file and then remove it, keep that same window (cli#204).
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
- `create-after-checks:<rel>`: write a file `RACE` at `<rel>` (creating its folders) right after the preflight's checks, before anything is staged (INV-B: the authorized state is the one the checks saw);
- `create-before-commit:<rel>`: write a file `RACE` at `<rel>` after staging (INV-B);
- `replace-before-rollback:<rel>`: before rollback, move the file at `<rel>` aside to `<rel>.aside` (if there is one) and write a new file `LATER` there (§1.5's identity check);
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

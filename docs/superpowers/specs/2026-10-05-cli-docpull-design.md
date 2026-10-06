# Wave cli-docpull — design

**Wave:** cli-docpull (CrewOps wave card task-waveclidocpull-da80, run seq:sa-wave-cli:f1b70309), branch `wave/2026-10-05-cli-docpull`, cut from main at bd7efc5 (wave cli-hardening merged).
**Issues:** cli#168, cli#183, cli#190, cli#188, cli#191, cli#176, cli#182. Peter approved the wave in CrewOps ask task-starttheclidoc-01c7 ("approved", built mainly on Muse), recorded on each issue.
**Plan:** `docs/superpowers/plans/2026-10-05-cli-docpull.md`.
**Ruling 12:** after final reviews 1 and 2 found the same two families of Criticals (rollback and staging that move or delete what they did not write; a manifest re-derived from surviving entries), the PM adopted the design review by the Fable seat (`design-review-fable.md`) as ruling 12. §1 is rewritten to it; the staging folder, the claim, leftover recovery and rollback no longer exist.
**Plan reviews:** Sol re-check 2 (task-planrecheck2cli-d0bc, REQUEST CHANGES 7d9a0f4) gave the mandatory build rulings 8-10 (build card task-buildclidocpull-c955), folded in below. Earlier: Sol (task-planreviewcli-d807) REQUEST CHANGES d5474a7; PM rulings 1-6 (plan card task-planclidocpull-948e). Sol's re-check (task-planrecheckcli-48d5) REQUEST CHANGES 0a92aa3; PM ruling 7 (plan-check card task-plancheckcli-f9a4) simplified §1. Both are folded in below.

Each issue lists acceptable fixes; this spec picks one per issue. Cited later as "spec §N". Every message below is printed through doc-pull.ts's `shown()` display sanitiser (wave cli-hardening, cli#189), and `tests/doc-pull-display-guard.test.ts` keeps that true.

## 1. Stop on the first error and record exactly what was written (cli#168, cli#188, cli#182)

`commitDocs` (src/commands/doc-pull.ts) used to do `mkdirSync(recursive)` and `writeFileSync` on each target in turn, then rename cleanup, then the manifest. A failure part-way left changed files behind the old manifest. A hard-linked target was written in place (cli#188). A link planted after wave cli-safety's checks was followed (cli#182).

**This section is the design of PM ruling 12** (recorded on cli#168 and on build card task-buildclidocpull-c955), which adopts the design review by the Fable seat (`design-review-fable.md`) in full. It supersedes ruling 1's rollback, ruling 7's staging folder, and ruling 11's option A for the overlap case. cli#168's own alternative wording is the guarantee: "stop on the first error and record exactly what was written". The module `src/utils/doc-pull-writes.ts` does the file work and returns or throws; doc-pull.ts prints every message.

### 1.1 The guarantee (what the README says)

- **A failure stops the pull and the manifest records exactly what was written.** Any error while a pull writes (a write, a rename, a target that changed after the checks, a folder where a doc goes) stops the loop at that file. The files before it stay written and are recorded in the manifest with their own hashes; the failing file and the ones after it keep their bytes and their earlier entries. The pull exits 1 with one line saying how many files were updated. Nothing is rolled back, and the next pull completes the job (rule 5 below).
- **A hard kill leaves the old manifest and the lock.** If the process is killed while files are being written, some files may already hold the new bytes while the manifest is still the old one, and the lock file is still there. Tracked files are always re-verified by hash, and the next pull (once the lock is deleted, §1.4) adopts a file that already holds the bytes it would write instead of calling it a local edit.
- **No power-loss durability is claimed.** The CLI does not `fsync`.

**The five build rules** (binding on every doc pull change; ruling 12):

1. The pull never deletes, moves or restores a file or folder it did not create in this run. There is no `rm`, `rmdir` or `rename` on a path derived from a listing or a name pattern. The only removals are the pre-existing, manifest-owned rename cleanup and deletion propagation, this run's own temp file, and this run's own lock file.
2. The destination holds exactly two internal entries: the manifest and its `.lock`. Those names, and the `.sa-write-` temp-file prefix, are reserved under `nameKey` at every level.
3. The manifest is a pure function of (previous manifest, per-doc outcomes, single-doc flag). The outcomes are `placed(hash)`, `kept-previous`, `dropped(reason)` and `refused(reason)`. The single-doc merge keeps only previous entries whose doc ids are NOT in the outcome set, so an explicit drop is never undone. Bytes this run placed win: an earlier entry (a placed doc's old twin, a refused doc's, a failed download's retention, an unaffected doc's) at a name a placed entry holds, or at one equal to it under `nameKey`, is dropped, and the doc that lost it is told so. **Dictionaries (PM ruling 14):** every dictionary doc pull and its manifest code key by a path, a title or a name (the manifest's entries, the outcomes, every index, the MIME extension table) is a `Map`, or a null-prototype object read only through own-key checks (`Object.hasOwn`). A parsed manifest is copied into one before use, and serialisation writes every key as an own property, so a file named `__proto__`, `constructor`, `toString` or any other Object.prototype name is an entry like any other (`tests/doc-pull-special-names.test.ts` sweeps them).
4. INV-C is a runtime gate just before the manifest is written, on the FINAL manifest: the pull refuses (exit 1, reporting what was placed, the manifest unchanged) on any `nameKey` collision between two paths of the final manifest, on a file this run placed that the final manifest does not record with the hash written (PM ruling 14), or on any hash it cannot vouch for (§1.3 step 4). A read or `lstat` it cannot make, a link or a folder where a file should be, or bytes that differ, is a refusal, never a pass.
5. A file whose bytes already equal what the pull would write is never a conflict, tracked or untracked, at every refusal that looks at a file's bytes (the unpushed-local-changes check, the untracked-file check, a rename's source and target, a rename's source another doc's write lands on, and the re-check at the rename), so the next pull heals any interrupted state.

### 1.2 The three invariants (one sweep test each)

- **INV-A, never outside the destination.** No byte outside the destination changes, whether through a hard link to a tracked file or through a symbolic link at the final path component, planted before or after the checks. This is qualified by the directory-component race in §1.6.
- **INV-B, no clobber.** A file the pull does not own is never replaced without `--overwrite`, neither at wave cli-safety's preflight nor at the moment of each rename. A file created or changed after the preflight is not owned. A folder where a doc goes is never moved or deleted, even with `--overwrite` (ruling 9).
- **INV-C, honest manifest.** Every hash this pull records matches the file at that path; on a failure the manifest records exactly the files placed. The sweep's assertion: every hash matches the file on disk, or the file is listed as refused (a changed-after-the-check or folder line), or it is a target a failed manifest write left under the old manifest.

### 1.3 Order

1. **Lock** (§1.4): taken before anything reads the destination. An existing destination is locked first; a destination this pull creates is locked right after it is created, and the pull then checks that no manifest appeared meanwhile.
2. **Preflight and plan:** wave cli-safety's checks, unchanged. New:
   - Each target's **authorized state** is the state the checks themselves saw, carried into the write loop: `absent`, `sha256:<hex of the bytes the check read>` (a file the checks allowed the pull to replace), or `any` when `--overwrite` is given. Every check that reads a target (the unpushed-local-changes check, the untracked-file check, the rename-target check) records what it read; nothing reads the target again to authorize it, and the first thing recorded stands. A target no check saw is authorized as `absent`, so anything found there is refused. A later snapshot never widens it.
   - **Rule 5.** A tracked file whose bytes differ from its recorded hash is an unpushed local change, except when its current bytes are exactly the bytes this pull would write: that is not a conflict (the untracked-file check already adopted such a file). The same holds for a rename's source: a source whose bytes are exactly those this pull writes for its doc, or for the doc whose write lands on that file, holds no edit (an interrupted pull placed them, and the old name aliases the placed file). A source with a real edit, or one whose doc has nothing to write (a failed download), is still refused.
   - **Names.** The allocator never gives a doc file or a folder segment the manifest's name (`.solidactions-docs.json`), the lock's name (`.solidactions-docs.json.lock`), or a name starting with `.sa-write-`, compared NFC-normalised and case-folded, at any level. Such a name takes a leading `_` (`_.solidactions-docs.json.lock`), then the usual `-N` suffix if that is taken. Names are compared the same way (NFC, case-folded) for collisions, for file names and for folder segments, so two docs (or folders) that differ only by case or Unicode normalisation get distinct names on every filesystem. Two planned writes whose paths still compare equal that way (possible only through a legacy tracked path) are refused before anything is written: `error: <a> (doc <id>) and <b> (doc <id>) would be the same file on a case-insensitive or Unicode-normalising filesystem; this pull would write different docs through those names.` and `Nothing was written. Rename one of the docs on the server and pull again.` Names that were reserved by the retired staging design (`.solidactions-pull-*`) are ordinary names now.
3. **Write loop,** for each doc that has bytes (a media doc whose download failed has none), in plan order, stopping at the first error or refusal:
   1. **Directories:** walk the target's `dirRel` one component at a time from the destination. A missing component is created (non-recursive). Every component must `lstat` as a real directory, never a link; otherwise `LinkOnTheWayError`. The destination itself is not checked (wave cli-safety allows a symlinked destination).
   2. **Temp file:** write the bytes to a sibling `.sa-write-<pid>-<random>.tmp`, opened with `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` (`fs.constants.O_NOFOLLOW ?? 0`).
   3. **Re-check (INV-B),** just before the rename: `lstat` the target. A folder or any entry that is neither a file nor a link stops the loop (`UnsupportedTargetError`), whatever the authorization. Otherwise `absent` requires no entry at the name, `sha256` requires a regular file with exactly those bytes, `any` always passes; a regular file already holding exactly the bytes about to be written passes under any of them (rule 5). A mismatch is a publication refusal and stops the loop. The temp file is removed. The write records the `dev:ino` of the temp file it renames in, which the gate below compares.
   4. **Mode:** if the target is a regular file, `chmod` the temp file to its permission bits.
   5. **Rename:** `rename(temp, target)`. A rename replaces the directory entry. A hard link's other names keep their old inode and bytes (cli#188), and a link at the final name is replaced, not followed (cli#182). A rename that fails removes the temp file and stops the loop.
4. **Outcomes, gate, manifest.** After the loop, or after the first error or refusal, the pull settles one outcome per planned doc and writes the manifest once, through `writeManifest` (itself a temp file and a rename):
   - `placed(hash)`: the doc's file was written (the hash is of the bytes written); also a doc tracked with no bytes after a failed download that has no local file at its path.
   - `kept-previous`: the earlier entry stays: a failed download at a path the previous manifest tracked for the same doc (cli#183) when the file there is still the one the entry names, another doc's entry kept at a path a failed download found its file at (cli#190), a renamed doc whose download failed (its old path keeps its file and entry). An earlier entry with a hash is kept only while its file is there with exactly that hash.
   - `dropped`: no entry: a failed download over a local file that is not the entry's; and a failed download, renamed or not, whose earlier entry has a hash but whose file is gone (manager ruling on cli#168, issuecomment-6013479498, I1(b)): `! doc <id> ("<title>") failed to download and <rel> is not present locally; not tracking it — pull again later.` A failed download at a path another doc tracked whose file is gone is dropped with the same line; when the pull did not stop, it ends with cli#190's ` Doc <id> ("<title>") was tracked at <rel> before and is no longer tracked there.` The previous owner's entry is never replaced by the failed doc's id with no hash.
   - `refused`: the doc was not written (the pull stopped at it or before it): its earlier entry is carried unchanged, or none if it had none.

   **"Gone" is only ENOENT** (cli#168, issuecomment-6025529901). Every path an outcome depends on is classified once, with `lstat`: a failed download's own path, a renamed doc's old path whose download failed, a placed renamed doc's old twin after a stop, and a failed download's path another doc tracked. It is absent only on `ENOENT`, or a regular file (no link) with the hash of its bytes; anything else is a refusal with its reason: an `lstat` error (`cannot check it (<CODE>: <description>)`, e.g. `cannot check it (EACCES: permission denied)`), a folder (`is a folder, not a file`), a link (`is a symbolic link, not a file`), another non-regular entry (`is not a regular file`), or a file whose bytes cannot be read (`cannot read it (<CODE>: <description>)`). The doc keeps its earlier entries and the gate below refuses the manifest with that path and reason, through its own line (§1.5): exit 1, the previous manifest unchanged, so no tracking is lost; files already placed stay, and rule 5 adopts them on the next pull. A renamed doc's old name that could not be checked (any error but `ENOENT`, when the rename was planned or after the writes) refuses the same way after a complete pull too, since nobody could check it for edits; a folder or a link there is still nothing to keep or remove (cli#157).
   
   The manifest is built from these (rule 3). A single-doc pull, or a pull that stopped, also keeps every earlier entry whose doc has no outcome: a pull that stopped never ran deletion propagation, so a doc deleted on the server stays tracked for the next pull to propagate. A stopped pull also keeps a renamed doc's old-path entry beside the new one, since the old file is still there. Where an earlier entry and a placed entry meet at one name (exactly, or under `nameKey`), the placed entry stays and the earlier one goes; the doc that lost it gets `! <rel> now holds the file this pull wrote for doc <id> ("<title>"); doc <id> ("<title>") was tracked at <rel> before and is no longer tracked there` (none when it is the placed doc's own old twin). The overlap is settled before anything is collapsed by name. Immediately before the write, the **INV-C gate** (rule 4) checks the final manifest: it refuses first on an outcome's own refusal (above, with that path and reason); then on a `nameKey` collision between any two of its paths; on a file this pull placed that the final manifest does not record, or records with another hash (`this pull wrote it but the manifest would not record it`; PM ruling 14); and on every entry with a hash that this run vouches for:
   - a file this pull placed must `lstat` as a regular file with the `dev:ino` the write renamed in, the entry must be the hash of the bytes written, and the bytes are read back and must match;
   - an entry kept for a doc this pull acted on (a failed download's kept entry, the old twin of a placed rename) must `lstat` as a regular file (no link, no folder) whose bytes hash to the entry; any `lstat` or read failure (`ENOENT`, `ENOTDIR`, `ELOOP`, `EACCES`, `EISDIR`) is a refusal.

   PM ruling 13 makes every other read or `lstat` failure a refusal. The gate's three exceptions to it are exactly those of the manager ruling on cli#168 (issuecomment-6013479498, I1):
   - (a) **sanctioned:** an entry carried unchanged for a refused doc (ruling 10) is not re-read; neither is one for a doc this pull never listed. This run did not touch either: a folder or an edited file at that name is the refusal's own state.
   - (b) **not sanctioned:** a kept entry whose file is missing. The cli#183/cli#190 keep applies only when the file at the path has exactly the entry's hash; a missing file (`ENOENT`, nothing else) makes the outcome `dropped` (above), so the gate never meets a kept entry with a hash for a missing file, and one that went missing after the outcome was decided is a refusal (`the file it tracks is not there`).
   - (c) **sanctioned:** for a file this pull just placed, `EPERM` on the read-back is treated like `EACCES` (the same permission failure on some platforms): a write-only mode kept from the file it replaced falls back to the hash written.
   The tracking decisions that apply to the manifest just recorded (a doc no longer tracked, another doc's tracking kept or lost, a renamed doc's old entry kept, the displaced entries above) are printed before the error line of a pull that stopped, as for a pull that did not. A pull whose manifest was not recorded changed no tracking and prints none. A stopped pull keeps every earlier entry of a doc it has no outcome for, so it never says such a doc is no longer tracked.
5. **After a successful pull:** warnings, rename cleanup (each unmodified old twin of a renamed doc is removed now that the new file is written, never one this pull just wrote for another doc), deletion propagation, and the summary, as before. A pull that stopped runs none of these: nothing is deleted.

All renames stay inside the destination. A destination subfolder on a different filesystem makes a rename fail with `EXDEV`, which is an ordinary in-process failure.

### 1.4 The lock, and overlapping pulls

The destination holds one internal file besides the manifest: `<destination>/.solidactions-docs.json.lock`, created with `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` and holding this pid. If any entry is already there (a file, a link, a folder), the pull refuses and changes nothing:
`error: <destination>/.solidactions-docs.json.lock exists: another doc pull may be writing to <destination>. If none is running, delete that file and pull again.`

- **It is never auto-removed and never liveness-tested.** A lock is removed only by the pull that created it, and only while it is still a regular file holding that pid. There is no scan, no pid check and no recovery protocol. cli#202 (reliable pid liveness) is obsolete.
- **When it is taken.** For an existing destination, before the manifest is read, so the plan is built on a manifest no other pull can change while this one runs. For a destination this pull creates, right after creating it; the pull then checks that no manifest appeared in the meantime, and if one did it refuses: `error: another doc pull wrote to <destination> while this one was running — nothing was changed. Pull again.` In every case the plan is built on the manifest read under the lock, or the pull refuses before any write.
- **When it is released.** After the manifest is written, and on every exit path reachable in-process: success, a refusal, an error, a "no" at the prompt (a `process.exit` runs the exit listener), and an interrupt (`SIGINT` exits 130 and `SIGTERM` 143, through the same listener). It is held while the prompt waits. A `SIGKILL` leaves it, and the lock line tells the user what to do.
- The lock is ignored by the "not empty" check, so a destination holding only the lock counts as empty.
- If the lock cannot be created for another reason, the line is `error: cannot write .solidactions-docs.json.lock: <message> — nothing was changed.`, or `error: cannot read <destination>: <message>` when the destination cannot be listed (cli#191).

### 1.5 Failure lines

Every value goes through `shown()`; `<N>` is the number of files written before the stop and `<M>` the number planned (docs with bytes to write). All exit 1.

- A write error at doc `<rel>`: `error: cannot write <rel>: <message> — <N> of <M> files were updated and are tracked; pull again.`
- A target that changed after the checks: `error: <rel> changed after doc pull checked it — <N> of <M> files were updated and are tracked. Pull again, or pass --overwrite to replace it.`
- A folder at a target (ruling 9): `error: <rel> is a folder (doc pull writes a file there) — <N> of <M> files were updated and are tracked. Move it aside and pull again.`
- A link on the way: wave cli-safety's `refuseLink`, as before.
- The INV-C gate: `error: doc pull stopped before recording a manifest that would not match the files (<rel>: <reason>) — <N> of <M> files were updated; the manifest was not changed.` The next pull adopts the placed files (rule 5).
- The manifest itself could not be written: `error: cannot write .solidactions-docs.json: <message> — <N> of <M> files were updated; the manifest was not changed.` When a stop and a manifest failure happen together, this line is printed first and the stop's line follows without its "tracked" tail.
- The lock lines are in §1.4.

With `<N>` = 0 the same lines apply (`0 of <M> files were updated`).

### 1.6 Limits (documented, not closed)

- Node has no `openat`. A directory component swapped for a link between the write loop's directory walk and the rename can still redirect the rename. This is a local race in the user's own folder (cli#182 says so). The final component, which the issue names, is closed against a link: a rename replaces the entry and never follows it.
- **The final-component window.** Between a check (the preflight's read, or the write loop's re-check) and the rename that follows it, a file that the user's own tools create or change at the target is not seen. This is the same local-race class as the directory-component race, in the user's own folder, and it is not closed: closing it needs a non-replacing publish (`link()`), which `exFAT` and network shares do not offer. What is closed is the part the pull controls: the authorized state is what the checks saw, not a fresh read (§1.3 step 2), and the pull never deletes or restores anything it did not create (rule 1). Rename cleanup and deletion propagation, which hash a file and then remove it, keep that same window (cli#204).
- **A SIGKILL leaves the lock file** (and any files already placed, under the old manifest). Delete the lock and pull again (§1.4).
- No power-loss durability (§1.1).
- A case-insensitive or normalising filesystem (macOS, Windows) can make two names one entry. That is tested where the filesystem allows; CI's unit tests run on Linux, so those tests skip there with a stated reason (§1.7). The `nameKey` checks of the INV-C gate are pure string logic and run on Linux.

### 1.7 Platform-sensitive cases

The tests detect a case-insensitive filesystem at runtime (create `aB`, check that `Ab` exists), and Unicode normalisation the same way (NFC name, NFD lookup). On a filesystem without the property, each such test is **skipped with an explicit reason in its title** (`it.skipIf(…)('… (needs a case-insensitive filesystem; CI unit tests run on Linux)')`), never silently. The `O_NOFOLLOW`-less path (Windows) is covered the same way.

### 1.8 Test-only injected failures

These are inert unless `SOLIDACTIONS_TEST_HOOKS=1`. `SOLIDACTIONS_DOC_PULL_TEST_FAULT` selects one or more, comma-separated:
- `fail-rename:<n>`: the n-th doc's write (step 3.5) throws an `EIO` error just before its rename, so its temp file is removed;
- `fail-manifest-temp`: the manifest write throws `EIO` before its temp file is created;
- `fail-manifest-rename`: the manifest write throws `EIO` just before its rename (its temp file is removed);
- `kill-after-renames:<n>`: `process.kill(process.pid, 'SIGKILL')` after the n-th doc is written (for §1.4's killed-pull tests);
- `create-after-checks:<rel>`: write a file `RACE` at `<rel>` (creating its folders) right after the preflight's checks (INV-B: the authorized state is the one the checks saw);
- `create-before-commit:<rel>`: write a file `RACE` at `<rel>` just before the write loop starts (INV-B);
- `link-before-commit:<rel>><abs target>`: create a symlink at `<rel>` to `<abs target>` just before the write loop starts (INV-A/B);
- `change-after-writes:<rel>`: write `CHANGED` to the file at `<rel>` right after the write loop, before the INV-C gate (rule 4);
- `break-after-writes:<how>:<rel>`: right after the write loop, before the outcomes are decided, make the entry at `<rel>` uninspectable: `chmod0` sets its mode to `000`; `folder`, `file` and `loop` replace it with an empty folder, a file, or a link to its own name; `remove` deletes it (the outcome classification's error sweep, cli#168 issuecomment-6025529901);
- `mkdir-before-commit:<rel>`: create a folder at `<rel>` holding `user.txt` just before the write loop starts (ruling 9).

PM ruling 7 sanctions injected failures for the in-process failure points. The code documents these as test-only; the README does not. The hooks that only served rollback and leftovers (`fail-restore`, `replace-before-rollback`, `swap-before-rollback`) are gone with them.

### 1.9 Manifest helper and README

- `writeManifest` (src/utils/docs-manifest.ts, used by `doc push` and now by `doc pull`) writes through a temp file and a rename (`writeFileAtomic`, temp next to the target), so it is never half-written. It takes an optional step that runs just before the rename, which is how `fail-manifest-rename` reaches it.
- The README's `### doc` section states §1.1 plainly:
  - a failure stops the pull, the files written before it stay and are recorded in the manifest, and the next pull completes the job;
  - a killed pull leaves the old manifest and its lock file; delete the lock and pull again;
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

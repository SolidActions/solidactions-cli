# Wave cli-docpull — design

**Wave:** cli-docpull (CrewOps wave card task-waveclidocpull-da80, run seq:sa-wave-cli:f1b70309), branch `wave/2026-10-05-cli-docpull`, cut from main at bd7efc5 (wave cli-hardening merged).
**Issues:** cli#168, cli#183, cli#190, cli#188, cli#191, cli#176, cli#182. Peter approved the wave in CrewOps ask task-starttheclidoc-01c7 ("approved", built mainly on Muse), recorded on each issue.
**Plan:** `docs/superpowers/plans/2026-10-05-cli-docpull.md`.

Each issue lists acceptable fixes; this spec picks one per issue. Cited later as "spec §N". Every message below is printed through doc-pull.ts's `shown()` display sanitiser (wave cli-hardening, cli#189), and `tests/doc-pull-display-guard.test.ts` keeps that true.

## 1. Staged writes: a pull is all-or-nothing on its files (cli#168, cli#188, cli#182)

`commitDocs` (src/commands/doc-pull.ts) today does `mkdirSync(recursive)` and then `writeFileSync` on each target in turn. A filesystem error part-way through leaves a half-written tree and the old manifest. A hard-linked target is written in place, so its other names outside the destination change (cli#188). And a link planted after wave cli-safety's checks is followed (cli#182).

The new module `src/utils/doc-pull-writes.ts` replaces that with two phases. doc-pull.ts prints every message, and the module only throws.

**Phase 1, stage.** For each planned doc that has bytes to write (a media doc whose download failed has none):
1. **Directories:** walk `dirRel` one component at a time from the destination.
   - A missing component is created with a non-recursive `mkdirSync` and recorded as created by this pull.
   - Every component is then `lstat`-ed and must be a real directory, not a symbolic link. A component that is a link throws `LinkOnTheWayError(component)`.
   - The destination itself is not checked here: wave cli-safety allows a symlinked destination.
2. **Temp file:** create it in the target's own directory, named `.sa-pull-<pid>-<12 hex>.tmp`. It is a short fixed-length name, so a 255-byte file name cannot overflow `NAME_MAX`.
   - Flags: `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, mode `0o666` (less the umask, as `writeFileSync` does). `O_NOFOLLOW` is `fs.constants.O_NOFOLLOW ?? 0`, since it is absent on Windows.
   - The file gets the doc's bytes and is closed.
   - **Mode is kept:** when the target already exists as a regular file, the temp file gets that file's permission bits (`fchmod`) before it is closed. Replacing a tracked file never resets permissions the user set (today's in-place `writeFileSync` keeps them).

If any stage step throws:
- every temp file staged so far is removed;
- every directory this pull created is removed (newest first, only if empty);
- nothing else has been touched, and the previous manifest is unchanged.

doc-pull.ts then prints one line and exits 1:
`error: cannot write <relPath>: <error message> — nothing was changed.`
A `LinkOnTheWayError` prints wave cli-safety's existing link refusal instead (`refuseLink`).

**Phase 2, commit.** For each staged file, in plan order:
1. Re-check, with `lstat` only, that each directory component is still a real directory.
2. `renameSync(temp, target)`.
   - The rename replaces the target's directory entry. A hard-linked target therefore gets a new file, and its other names keep their old bytes (cli#188).
   - A symbolic link planted at the final component is replaced, not followed (cli#182).
   - A wave cli-safety untracked hard-linked target is still refused before any write unless `--overwrite`. With `--overwrite`, the rename breaks the link the same way.

If a rename throws, the commit stops. The remaining temp files are removed, and doc-pull.ts:
- writes the manifest for exactly what was committed. Committed docs get their new entries. Every doc not committed keeps its previous entry, if it had one, because its previous file is still in place;
- skips rename cleanup and deletion propagation;
- prints one line and exits 1:
  `error: cannot write <relPath>: <error message> — <k> of <n> files were updated; the manifest records exactly what was written.`

**Residual window (documented, not closed):** Node has no `openat`. Between the phase-2 directory re-check and the `rename`, a directory component swapped for a link could still redirect the rename. This is a local race in the user's own folder (cli#182 says so). The final component, which the issue names, is closed by `O_NOFOLLOW`/`O_EXCL` on the temp file and by rename semantics.

**A killed process** can leave `.sa-pull-*.tmp` files. They are dot-files, and the plan does not track or delete them. The README `### doc` section says so in one sentence.

**Manifest:** `writeManifest` (src/utils/docs-manifest.ts) writes through the same temp-and-rename helper (`writeFileAtomic`), so the manifest is never half-written. `doc push` uses `writeManifest` too and gets the same guarantee.

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
- Cleaning up stale `.sa-pull-*.tmp` files from a killed earlier run.
- `doc push`'s own write paths (beyond `writeManifest`).

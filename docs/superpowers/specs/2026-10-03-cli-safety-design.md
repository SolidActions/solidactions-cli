# Wave cli-safety — design

**Wave:** cli-safety (CrewOps wave card task-waveclisafety-74b1, run seq:sa-wave-cli:f9574ba0), branch `wave/2026-10-03-cli-safety`, cut from main at 9161437 (wave cli-polish merged).
**Issues:** cli#170, cli#169, cli#167, cli#163, cli#181, cli#179, cli#173. Peter approved the wave in CrewOps ask task-startthenextcli-767c ("Approve: start it now", 2026-10-03), recorded on each issue.
**Plan:** `docs/superpowers/plans/2026-10-03-cli-safety.md`.
**Plan review:** Fable (task-planreviewcli-9e43) REQUEST CHANGES 5bc563f. The PM accepted all eight Important findings and ruled the minors on plan card task-planclisafety-7af2. They are folded in below and cited as "plan review I<n>/m<n>".

This spec records the design calls the issues leave open. Cited later as "spec §N".

## 1. cli#170 — `login` sends the key only to the host it was told

`resolveLoginHost` (src/commands/login.ts) today picks `--host`, then `--dev`, then the cloud default. It never reads `SOLIDACTIONS_HOST`, so `SOLIDACTIONS_HOST=http://localhost:8002 solidactions login --stdin` validates the key against https://app.solidactions.com. `device-login` uses the same function.

- **Precedence:** an explicit host flag (`--host <url>`, or the hidden `--dev`, which means `http://localhost:8000`) wins. With no flag, a non-empty `SOLIDACTIONS_HOST` is the host. With neither, the cloud default (`https://app.solidactions.com`, `isDefault: true`).
- **Disagreement refuses:** when an explicit flag and `SOLIDACTIONS_HOST` are both set and name different hosts, `login` (and `login --device`) exits 1 before any request or file write. It prints one red line naming both hosts, and a second line with the fix:
  `error: --host https://a.example disagrees with SOLIDACTIONS_HOST=http://localhost:8002; refusing to send the API key.`
  `Unset SOLIDACTIONS_HOST or pass the same host to --host.`
  For `--dev` the first line reads `--dev (http://localhost:8000)`.
- **Same host** is cli#124's existing rule, reused rather than duplicated: `normalizeHost` in src/utils/config.ts (trim, drop trailing slashes, lower-case the whole string). Ports compare literally: `https://example.com` and `https://example.com:443` differ, as README "Resolution order" documents. `http://LocalHost:8002/` equals `http://localhost:8002`. (Plan review I8.)
- **Stored host:** `login` strips trailing slashes from the host it resolves, whichever source it came from. `SOLIDACTIONS_HOST=http://h:1/` is stored as `http://h:1`, so requests are not built as `//api/…`. (Plan review m5.)
- **A non-empty host that strips to nothing is invalid** (PM ruling 9, from Sol's plan re-check C1). A `SOLIDACTIONS_HOST` or `--host` that is non-empty but has nothing left once whitespace and trailing slashes are stripped (`/`, `///`, `' / '`) refuses before any request or write, in `login` and `login --device`: `error: SOLIDACTIONS_HOST="/" is not a usable host; refusing to send the API key.` (or `--host "/"`). It never falls back to the cloud default. Only an unset or empty/whitespace-only `SOLIDACTIONS_HOST` counts as absent.
- The host line `login` already prints (`Host: <url>` / `Logging into … (SolidActions Cloud)`) reports the chosen host; it goes through §3's `displayHost`.
- **README** (`### solidactions login flags`): one bullet, "`login` uses `SOLIDACTIONS_HOST` when it is set." It does not name `--host`, which stays hidden (#994; plan review m4). Plus one line that decides app#1951: "An agent that should be credited as itself in SolidActions (e.g. docs it pushes are recorded as Agent) logs the CLI in with its own agent token, not a person's key."
- **Test (issue ask):** a spawned test proves zero requests reach the cloud when `SOLIDACTIONS_HOST` points elsewhere.
  - The child runs with `HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/`http_proxy` pointing at a local recording listener, and `NO_PROXY=127.0.0.1,localhost` keeps the test's own server direct.
  - axios routes any request to another host through that listener, so a request to app.solidactions.com is recorded there.
  - The listener records both `request` and `connect` events, so a CONNECT tunnel is caught too (plan review m1).
  - Assert the listener saw zero requests and the local server saw the workspace request.
  - RED: the same test on the unfixed code records a proxy hit.

## 2. cli#169 + cli#167 — `doc pull` never writes through a link, outside the destination, or over bytes it does not own

Wave cli-polish made every **rename** path safe (the rename matrix, `tests/doc-pull-rename-matrix.test.ts`). These rules extend the same guards to **every** planned write: a new doc, a tracked doc at an unchanged path, a rename target, and a failed media download (whose directory `commitDocs` still creates). A refusal exits 1 with nothing written (no file and no directory) and the manifest unchanged.

**Placement.** The new checks live in one function, `checkPlannedWrites`, in `report()` (src/commands/doc-pull.ts):
- It runs **after** the existing rename block and **before** the unpushed-local-changes check and `commitDocs`. The rename block keeps its own, more specific messages for rename cases, and the matrix rows keep their messages.
- Every `physicalTargetPath` call in `report()` (including the rename block's, today doc-pull.ts:828 and :849) goes through one wrapper, `resolveOrExplain`, so a resolution error never escapes as a stack trace (plan review I3).

1. **Containment (cli#169).** Each target's physical path (`physicalTargetPath`) must lie inside the destination's physical path, `physicalTargetPath(path.resolve(destination))`.
   - That holds whether the destination exists or not. A destination that is a symlink, or a not-yet-created destination under a symlinked ancestor (`~/link/new`, `/tmp/x` on macOS), is fine (plan review I1).
   - A target that resolves outside refuses, with or without `--overwrite`:
     `error: <rel> resolves outside the destination (<physical path>); this pull would write doc <id> ("<title>") there.`
2. **No symbolic links on the way (cli#169).** A target refuses, with or without `--overwrite`, when its own path is a symbolic link or it has a symbolic-link directory component **below** the destination.
   - This matches the recorded rename rule (cli#157 issuecomment-5963370604: a symlink rename target refuses even with `--overwrite`).
   - It applies to failed media downloads too, whose directory would otherwise be created through the link (plan review I2).
   - The pull never replaces or follows a user's link:
     `error: <rel> is a symbolic link (or sits under one: <component>); this pull would write doc <id> ("<title>") through it.` then `Replace it with a regular file or folder and pull again.`
   - A self-referential link at a target is a symbolic link: this message, with or without a previous manifest (plan review I3).
3. **Unresolvable paths (cli#169 comment, M3).** `resolveOrExplain` handles an error other than ENOENT (ELOOP, EACCES, ENOTDIR).
   - When the path is a planned target with a link on the way, it prints rule 2's message.
   - Otherwise it prints one line naming the relative path and the reason, then exits 1 before any write:
     `error: cannot resolve <rel>: too many symbolic links (ELOOP). Fix or remove the link and pull again.`
     For other codes: `error: cannot resolve <rel>: <code> <message>.`
   - Example (PM ruling 10, Sol's re-check R1): a renamed **media** doc whose download fails, where its tracked old path (`pic.png`) is now a self-referential link. The failed-download path resolves the old path through `resolveOrExplain` (the cross-doc claim check), which is not a write target, so it prints `cannot resolve pic.png: too many symbolic links (ELOOP)`. A successful replacement never resolves the old path. That case is not where ELOOP is pinned.
4. **Untracked bytes are not overwritten without `--overwrite` (cli#167).** A target that holds a regular file the pull does not own refuses unless `--overwrite`, once for all such paths:
   `N file(s) exist locally but are not tracked:` then the paths, then `Move them aside and pull again, or pass --overwrite to replace them.`
   - Not owned means: the previous manifest has no entry at that path, or its entry has no recorded hash (`body_sha256` null).
   - Exempt: a target that is the same file (`dev:ino`) as the doc's own tracked rename source. This is a case-only rename on a case-insensitive filesystem; the rename block's `targetIsSource` rule governs it, and matrix row "unmodified source, target is the same file as the source" stays outcome (a) (plan review I4).
   - `-y`/`--yes` does not override this; it only answers the existing "destination is not empty" prompt. That prompt's text changes from "Pulling will overwrite existing files." to "Pulling overwrites tracked files; local files the folder doesn't track are refused unless --overwrite." (plan review m7)
   - A file whose bytes equal what this pull would write loses nothing. It is adopted (tracked), with no refusal.
   - Tracked files with a recorded hash keep the existing unpushed-local-changes check.
5. **A failed download never claims someone else's bytes (cli#167).** A media doc whose download fails is not recorded in the manifest at a path that holds a file the pull does not own (rule 4's sense). It prints `! doc <id> ("<title>") failed to download and <rel> holds a local file; not tracking it — pull again later`. The existing rename rule for failed downloads (keep the old entry) is unchanged.
6. **Hard-link stray (cli#169 comment, M2).** Rename cleanup skips removing an old path that is the same file as a path this pull just wrote. It now warns, in doc-pull.ts's `!` style, naming the **written path that shares the identity** (which may be another doc's target, not this doc's own):
   `! kept <old>: it is the same file as <written path> (a link); the extra name is not tracked — remove it yourself if you don't need it`
   - No warning when `targetIsSource` (a case-only rename on a case-insensitive filesystem), where removing the "extra" name would delete the doc's only file (plan review I5).

**README** (`### doc` section): one paragraph stating rules 1-5 in user terms.

**Existing tests:** any existing test whose expectation changes (for example a pull with `--yes` over an untracked file of different bytes, which now refuses) is converted to the spawned-binary harness when changed (PM ruling 14). The rename matrix must stay green, and its rows may only gain the M2 warning.

**Filed, not in this wave** (plan review m6, m8): the check-then-write window (a link planted between the checks and `commitDocs`; `O_NOFOLLOW`), and a failed download at an unchanged tracked path nulling the recorded hash.

## 3. cli#163 — no host is printed with its userinfo

`displayHost(host)` (src/utils/api.ts) already strips `user:pass@` for the 401 lines. Every other place the CLI prints a host uses it too:
- `whoami`'s Host line;
- the mutation banner `Workspace: … on <host>` (src/utils/api.ts);
- `login`'s host lines and messages (`Host:`, `Invalid API key for`, `Could not reach`, `Generate an API key at`);
- the credential refusals in src/utils/config.ts;
- any other console/stderr line that interpolates a host value.

`displayHost` moves to `src/utils/host-display.ts` (no dependencies), and `api.ts` re-exports it so existing imports keep working.

**The audit and guard are structural, not a list of names** (plan review I6). The guard test is a static test in the style of `tests/no-raw-error-body.test.ts`:
- It fails on any template interpolation under `src/` whose expression names a host. That means an identifier containing `host`/`Host`, such as `config.host.padEnd(50)`, `resolved.config.host`, `conflict.otherHost` or `conflict.keyHost`, or the `keyHome` value built from one.
- **Exemptions are per interpolation, not per line** (PM ruling 11, Sol's re-check R2). An interpolation is exempt only when **that interpolation itself** is `displayHost(…)`, or begins a request URL: the template continues directly with `/api/`, `/oauth/` or `/mcp`, and the template is an argument to an axios/fetch call or a URL builder (`new URL(`, `projectStatusUrl(`).
  - A printed template such as `console.error(`Cannot reach ${host}/api/v1`)` is NOT exempt.
  - A template with both `${displayHost(host)}` and `${config.host}` fails on the second.
  - Genuine builder sites the parser cannot classify go on the allowlist by file and expression.
- The rest goes on an **explicit allowlist** with a reason per entry: src/utils/mcp.ts's `URL.host`, which has no userinfo, and src/utils/source-provenance.ts's git remote.

Returned strings (`loginHostLines`, config.ts's refusal builders) count as prints. The audit covers, at least:
- `whoami`'s Host line (login.ts, `config.host.padEnd(50)`);
- the mutation banner (api.ts);
- `login`'s messages and `loginHostLines`;
- config.ts's refusal strings;
- deploy.ts's host prints;
- database-push.ts's `on ${config.host}` line;
- index.ts's `SOLIDACTIONS_DEBUG` dump.

## 4. cli#181 — the last 401 site, and a structural audit

`resolveWorkspaceInput` (src/utils/workspace-lookup.ts, the `-w` lookup) prints `Failed to list workspaces: <message>` for every failure.
- On a 401 it prints `authFailedLine(config.host)` and exits 1, like every other command.
- Other HTTP failures print `formatApiFailure(status, data)`.
- A network error prints `Connection failed: <message>`.
- Each prints one line and exits 1.

**Audit** (the issue's ask, made structural per plan review I7). The developer lists every `src/` file that makes an HTTP call (`axios`, `fetch(`, `http.request`, `callDocsTool`/`callMcpTool`). For each, the report says whether a 401 from it reaches `authFailedLine`/`authFailureMessage`.
- **Fixed in this wave**, same one-line shape: the one-line sites src/commands/skill-run.ts (`?? e.message` on a failed run call) and src/commands/crew-env-map-database.ts, plus workspace-lookup.ts.
- **Listed in the report for the manager to file**: cross-cutting sites such as src/utils/mcp.ts's `MCP request failed with HTTP <status>` (the transport for `doc push`/`doc pull`), and calls to non-SolidActions hosts (GitHub, a git remote) with a decision each.

## 5. cli#179 — `workflow view` says which environment is missing

`workflow view` keeps building its canonical slug itself (`projectSlugForState`); it does **not** call `resolveProjectSlug` (the cli-polish regression for read-only users: final review 7, cli#179). On a 404 from the workflow request it asks `lookupProjectFamilyEnvironments(config, project)`.
- When the family exists and lacks the requested environment, it prints, inside the command's `display()` sanitiser: `Project "<project>" has no <env> environment (exists in: <list>). Pass -e <env> to target a different environment.`
- Otherwise it keeps today's message (the server's, else `Project or workflow not found.`).
- A failed family lookup (any error, including 403) falls back to today's message.

## 6. cli#173 — already fixed

Wave cli-polish shipped it (#172, 9161437): `webhook list` / `webhook secret` print the family hint, pinned by `tests/webhook-project-404-hint.test.ts`. No task; the manager raised it with the PM on plan card task-planclisafety-ae5b.

## 7. Out of scope

- cli#168 (non-transactional writes), cli#174-178 and cli#180 (message wording), cli#176 (no-TTY prompt exit code): filed, not in this wave.
- Replacing a user's symlink under `--overwrite` (rule 2 refuses instead).

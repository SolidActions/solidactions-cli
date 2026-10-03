# Wave cli-safety — design

**Wave:** cli-safety (CrewOps wave card task-waveclisafety-74b1, run seq:sa-wave-cli:f9574ba0), branch `wave/2026-10-03-cli-safety`, cut from main at 9161437 (wave cli-polish merged).
**Issues:** cli#170, cli#169, cli#167, cli#163, cli#181, cli#179, cli#173. Peter approved the wave in CrewOps ask task-startthenextcli-767c ("Approve: start it now", 2026-10-03), recorded on each issue.
**Plan:** `docs/superpowers/plans/2026-10-03-cli-safety.md`.

This spec records the design calls the issues leave open. Cited later as "spec §N".

## 1. cli#170 — `login` sends the key only to the host it was told

`resolveLoginHost` (src/commands/login.ts) today picks `--host`, then `--dev`, then the cloud default. It never reads `SOLIDACTIONS_HOST`, so `SOLIDACTIONS_HOST=http://localhost:8002 solidactions login --stdin` validates the key against https://app.solidactions.com. `device-login` uses the same function.

- **Precedence:** an explicit host flag (`--host <url>`, or the hidden `--dev`, which means `http://localhost:8000`) wins. With no flag, a non-empty `SOLIDACTIONS_HOST` is the host. With neither, the cloud default (`https://app.solidactions.com`, `isDefault: true`).
- **Disagreement refuses:** when an explicit flag and `SOLIDACTIONS_HOST` are both set and name different hosts, `login` (and `login --device`) exits 1 before any request or file write. It prints one red line naming both hosts, and a second line with the fix:
  `error: --host https://a.example disagrees with SOLIDACTIONS_HOST=http://localhost:8002; refusing to send the API key.`
  `Unset SOLIDACTIONS_HOST or pass the same host to --host.`
  For `--dev` the first line reads `--dev (http://localhost:8000)`.
- **Same host** means the same URL after normalisation: trim whitespace, drop trailing slashes, lower-case the scheme and hostname (path kept). `http://LocalHost:8002/` equals `http://localhost:8002`.
- The host line `login` already prints (`Host: <url>` / `Logging into … (SolidActions Cloud)`) reports the chosen host; it goes through §3's `displayHost`.
- **README** (`### solidactions login flags`): one bullet that `login` honours `SOLIDACTIONS_HOST` and refuses a disagreeing `--host`. One line (decides app#1951): "An agent that should be credited as itself in SolidActions (e.g. docs it pushes are recorded as Agent) logs the CLI in with its own agent token, not a person's key."
- **Test (issue ask):** a spawned test proves zero requests reach the cloud when `SOLIDACTIONS_HOST` points elsewhere. The child runs with `HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/`http_proxy` pointing at a local recording listener. axios routes any request to a host other than `127.0.0.1`/`localhost` through it, so a request to app.solidactions.com is recorded there. `NO_PROXY=127.0.0.1,localhost` keeps the test's own server direct. Assert the listener saw zero requests and the local server saw the workspace request. RED: the same test on the unfixed code records a proxy hit.

## 2. cli#169 + cli#167 — `doc pull` never writes through a link, outside the destination, or over bytes it does not own

Wave cli-polish made every **rename** path safe (the rename matrix, `tests/doc-pull-rename-matrix.test.ts`). These rules extend the same guards to **every** planned write: a new doc, a tracked doc at an unchanged path, and a rename target. Every rule is checked in `report()` (src/commands/doc-pull.ts) before the first write, with the existing rename checks. A refusal exits 1 with nothing written and the manifest unchanged.

1. **Containment (cli#169).** Each target's physical path (`physicalTargetPath`) must lie inside the destination's real path (`fs.realpathSync(destination)`, so a destination that is itself a symlink is fine). A target that resolves outside refuses, with or without `--overwrite`:
   `error: <rel> resolves outside the destination (<physical path>); this pull would write doc <id> ("<title>") there.`
2. **No symbolic links on the way (cli#169).** A target whose own path is a symbolic link, or that has a symbolic-link directory component **below** the destination, refuses with or without `--overwrite`. This matches the recorded rename rule (cli#157 issuecomment-5963370604: a symlink rename target refuses even with `--overwrite`). The pull never replaces or follows a user's link:
   `error: <rel> is a symbolic link (or sits under one: <component>); this pull would write doc <id> ("<title>") through it.` then `Replace it with a regular file or folder and pull again.`
3. **Unresolvable paths (cli#169 comment, M3).** An error other than ENOENT while resolving a target (ELOOP, EACCES, ENOTDIR) is caught and printed as one line naming the relative path and the reason, then exit 1 before any write:
   `error: cannot resolve <rel>: too many symbolic links (ELOOP). Fix or remove the link and pull again.`
   For other codes: `error: cannot resolve <rel>: <code> <message>.`
4. **Untracked bytes are not overwritten without `--overwrite` (cli#167).** A target that holds a regular file the pull does not own refuses unless `--overwrite`, once for all such paths:
   `N file(s) exist locally but are not tracked:` then the paths, then `Move them aside and pull again, or pass --overwrite to replace them.`
   - Not owned means: the previous manifest has no entry at that path, or its entry has no recorded hash (`body_sha256` null).
   - `-y`/`--yes` does not override this; it only answers the existing "destination is not empty" prompt.
   - A file whose bytes equal what this pull would write loses nothing. It is adopted (tracked), with no refusal.
   - Tracked files with a recorded hash keep the existing unpushed-local-changes check.
5. **A failed download never claims someone else's bytes (cli#167).** A media doc whose download fails is not recorded in the manifest at a path that holds a file the pull does not own (rule 4's sense). It prints `warn: doc <id> ("<title>") failed to download and <rel> holds a local file; not tracking it — pull again later.` The existing rename rule for failed downloads (keep the old entry) is unchanged.
6. **Hard-link stray (cli#169 comment, M2).** Rename cleanup skips removing an old path that is the same file as a path this pull just wrote. In that case it prints `warn: kept <old>: it is the same file as <new> (a link); the extra name is not tracked — remove it yourself if you don't need it.` today it skips silently.

**README** (`### doc` section): one paragraph stating rules 1-5 in user terms.

**Existing tests:** any existing test whose expectation changes (for example a pull with `--yes` over an untracked file of different bytes, which now refuses) is converted to the spawned-binary harness when changed (PM ruling 14). The rename matrix must stay green, and its rows may only gain the M2 warning.

## 3. cli#163 — no host is printed with its userinfo

`displayHost(host)` (src/utils/api.ts) already strips `user:pass@` for the 401 lines. Every other place the CLI prints a host uses it too:
- `whoami`'s Host line;
- the mutation banner `Workspace: … on <host>` (src/utils/api.ts);
- `login`'s host lines and messages (`Host:`, `Invalid API key for`, `Could not reach`, `Generate an API key at`);
- the credential refusals in src/utils/config.ts;
- any other console/stderr line that interpolates a host value.

`displayHost` moves to `src/utils/host-display.ts` (no dependencies), and `api.ts` re-exports it so existing imports keep working. A static guard test (in the style of `tests/no-raw-error-body.test.ts`) fails if a line under `src/` both prints (`console.`, `process.stderr.write`, `process.stdout.write`, `chalk.`, `announce(`) and interpolates `${config.host}`, `${host}`, `${resolved.host}` or `${conflict.host}` without `displayHost(`. Request URLs are never printed and stay unchanged.

## 4. cli#181 — the last 401 site

`resolveWorkspaceInput` (src/utils/workspace-lookup.ts, the `-w` lookup) prints `Failed to list workspaces: <message>` for every failure. On a 401 it prints `authFailedLine(config.host)` and exits 1, like every other command. Other HTTP failures print `formatApiFailure(status, data)`, and a network error prints `Connection failed: <message>`, each on one line with exit 1. **Audit** (the issue's ask): the developer greps `src/` for any remaining 401 output that bypasses `authFailedLine`/`authFailureMessage` and lists each hit in the report. Hits are fixed in the same task (this is the issue's own scope). The audit commands are in the plan.

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

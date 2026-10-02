# Wave cli-trust: CLI you can trust — design

**Wave:** cli-trust (CrewOps wave card task-waveclitrustcli-3f00, run seq:sa-wave-cli:94e95f4a), branch `wave/2026-10-02-cli-trust`.
**Issues:** cli#124, cli#114, cli#112, cli#99, cli#102, cli#129, cli#153, cli#154, cli#155. Peter approved the wave in CrewOps ask task-approvewave2cli-9ad4 ("Approve: start Wave 2 now", 2026-10-02); the PM filed cli#154 and cli#155 for pitch items 2 and 4 and recorded that approval on them.
**Plan:** `docs/superpowers/plans/2026-10-02-cli-trust.md`.
**Plan review:** Fable (task-planreviewwave-19c8) returned REQUEST CHANGES on ea01583; the PM accepted every finding as nine numbered rulings on plan card task-planclitrust-faad. This revision carries them; each is cited as "PM ruling N" where it applies. Follow-ups out of this wave: cli#156 (raw error bodies elsewhere), cli#157 (pull-side visual/canvas mapping), app#1940 (`workflows_guide` drift).

This spec records the design calls the issues leave open. Where an issue already states the fix, the plan follows the issue and this spec says nothing more.

## 1. cli#124 — credentials never cross to a different host

### The bug

`mergeConfigs` (`src/utils/config.ts`) picks `host` and `apiKey` independently, each from the highest layer that sets it (env > nearest local `.solidactions/config.json` > global `~/.solidactions/config.json`). A local file that sets only `host` therefore sends the **global** API key to that local host; `SOLIDACTIONS_HOST` alone sends the global key to the env host. Separately, `ensureWorkspaceSelected` (`src/utils/api.ts`) persists the whole merged config (host, key, scope) into the active config file when it auto-selects a workspace, which copies a credential from one layer (env or global) into another file.

### The rule (one sentence)

**An API key is only ever sent to the host configured with it: a host set in a layer above the layer that supplies the key must equal the key's own host, or the CLI refuses.**

Definitions, per call to `mergeConfigs(env, local, localPath, global, globalPath)`:
- *Layers*, top to bottom: env, local (when present), global.
- *Key layer*: the highest layer that sets `apiKey`.
- *Resolved host*: the `host` of the highest layer that sets one (unchanged from today).
- *Key host*: the `host` of the highest layer **at or below the key layer** that sets one, or none.
- *Conflict*: there is a key layer, the resolved host comes from a layer **above** the key layer, and the key host is missing or differs from the resolved host after normalization (trim, strip trailing `/`, lowercase).

**A key from the environment** (PM ruling 1 on plan card task-planclitrust-faad, after Fable's plan review): when `SOLIDACTIONS_API_KEY` supplies the key and `SOLIDACTIONS_HOST` is not set, the key has no host of its own, so the rule above can never fire for it. It is used only if **every file layer that sets a host agrees** (after normalization) with the resolved host; otherwise the CLI refuses and tells the user to set `SOLIDACTIONS_HOST` too. An env key with only a global host, or with no file host at all, keeps working, so CI that exports only the key is unaffected unless two files name different hosts. This matches the repo's existing stance in `src/commands/dev.ts:318-330`, which refuses a half-set env override for `dev --env`.

On a conflict, `mergeConfigs` still returns the merged config, but with `apiKey: ''` (fail closed: no code path can send the key) and a `credentialConflict` describing both sides. `requireResolvedConfig` refuses with exit 1 and one message, `whoami` shows the same message and exits 1, and `SOLIDACTIONS_DEBUG=1` prints it.

The message (exact wording is the plan's; these facts are required): the resolved host and where it came from, the key's host (or "no host") and where the key came from, and the two fixes: run `solidactions login --local` in this folder (when the host came from a local file) or unset `SOLIDACTIONS_HOST` / set `SOLIDACTIONS_API_KEY` too (when it came from env), or remove `host` from the file that set it.

### Existing configs (the migration)

No config file is rewritten. Every shape the CLI itself writes keeps working:

| Shape | Today | After |
|---|---|---|
| global from `login --global` (host + key) | works | works (one layer) |
| local from `login --local` (host + key) | works | works (one layer) |
| local pin from `workspace set --local` (workspace only) + global | works | works (no host above the key) |
| env `SOLIDACTIONS_HOST` + `SOLIDACTIONS_API_KEY` | works | works (one layer) |
| env `SOLIDACTIONS_API_KEY` only + global host | key sent to the global host | same (host is below the key) |
| local `host` only, same host as global | works | works (hosts equal) |
| **local `host` only, different host from global** | **global key sent to the local host** | **refused** |
| **env `SOLIDACTIONS_HOST` only, different from the file's host** | **file's key sent to the env host** | **refused** |
| env `SOLIDACTIONS_HOST` + a file with a key and no host | key sent to the env host | refused (the key has no host of its own) |
| env `SOLIDACTIONS_API_KEY` only + local `host` equal to the global host (or no global) | works | works (every file host agrees) |
| **env `SOLIDACTIONS_API_KEY` only + local `host` different from the global host** | **env key sent to the local host** | **refused: set `SOLIDACTIONS_HOST` too** |
| **env `SOLIDACTIONS_API_KEY` only + local host+key different from the global host** | **env key sent to the local host, in place of the local key** | **refused: set `SOLIDACTIONS_HOST` too** |

The "file with a key and no host" row is a hand-edited file (the CLI never writes a key without a host). Refusing it is the fail-closed choice; the message tells the user to put `host` in that file.

**Host comparison** is exact after trimming, stripping trailing slashes and lowercasing the whole string. So `https://host` and `https://host:443` count as different hosts, as do two paths that differ only in case. Both fail closed (a refusal, never a leak), and the README says so, because the refusal can surprise someone.

**`whoami`** prints the refusal on stderr, as `requireResolvedConfig` does. The unused `saveConfig()` and `getConfig()` in `src/commands/login.ts` (no callers) are deleted: `saveConfig` wrote a whole merged config to the active file, the same crossing the auto-select fix removes.

The README's "Resolution order" section says each field resolves independently and "you can mix". It is rewritten to state the rule above; mixing workspace fields stays allowed.

### Auto-select no longer copies credentials

`ensureWorkspaceSelected` writes only the workspace pin (`workspace`, `workspaceId`, `workspaceOrg`) to the active config file, through the existing `writeWorkspaceToFile`, which keeps whatever else that file already held. It never writes `host`, `apiKey`, `scopeMode` or `scopedWorkspaceIds` there.

### Destructive commands name the host

- The workspace banner every mutating command prints before it writes (`applyWorkspaceGuard`, stderr) becomes `Workspace: <name — organization <org>> (<id>) on <host>`. It already prints for every mutating command with a workspace, `--yes` or not, so this covers every destructive command at once.
- `database push`'s `WARNING:` line names the host and workspace: `WARNING: This destructively replaces database "<name>" in workspace <workspaceId> on <host>. …` (rest unchanged).

## 2. cli#114 — one line, never a raw error body

A shared helper `formatApiFailure(status, data)` in `src/utils/api.ts` returns `Failed: <status> <message>` when the response body is an object whose `message` is a non-empty string, and `Failed: <status>` otherwise. It never stringifies a response body (a debug-mode server puts the stack trace there; a proxy may send an HTML page). `env list` and `connection list` print their HTTP failures through it, so a 403 reads `Failed: 403 This action is unauthorized.`; a request that never got a response keeps its existing `Connection failed:` line. Their 401 line names the host (`Authentication failed against <host>. Run "solidactions login --global" to re-configure.`), like the shared `authFailureMessage` already does (PM ruling 7). `env list` prints its `Global variables:` / `Variables for project …` header only after the request succeeded.

Scope: the issue names `env list` and `connection list`. About 25 other commands dump `error.response.data` the same way; the manager files one follow-up issue for them (scope ladder rung 4) instead of widening this wave.

## 3. cli#112 — what remains

Since the issue was filed, #132 (app#1196, 2026-08-20) made a cross-org name collision a hard error that lists every candidate with its organization, role, slug and id (`classifyWorkspaceInput`, `describeWorkspaceMatchFailure`). The headline hazard is fixed and tested (`tests/workspace-lookup.test.ts`, "#1196(3)"). This wave ships the two parts still open:
- **The confirmation names the slug.** `Workspace set to: Main — organization Acme, slug acme-south-ws (019f…)`, so two same-named workspaces in same-named organizations never confirm identically. Without a slug the line is unchanged.
- **A miss suggests, never picks.** When nothing matches, the error adds a line `Did you mean: <slug-or-name> (<org>), …?` for up to 5 workspaces whose slug or name contains the input case-insensitively, or (for slugs and names of 3+ characters) is contained in it. Exit stays 1; nothing is ever auto-selected from a suggestion.

## 4. cli#99 — `--wait`, cancelled runs and admission

- `run start --wait` treats every terminal run status the app defines as terminal (solidactions-app `RunTrigger::TERMINAL_STATUSES`: `completed`, `failed`, `cancelled`, `dispatch_failed`, `skipped_no_credit`). `cancelled` prints `Workflow was cancelled.`; `dispatch_failed` and `skipped_no_credit` print `Workflow did not run (status: <status>).`; all exit 1. Recognising the last two is a same-surface papercut (scope ladder rung 2): today they also wait out the 5-minute timeout and print "It may still be running".
- When the run ends `failed` and the payload carries `admission_denied_reason` (from `GET /api/v1/runs/{id}`, `RunsApiController::show`), it prints the reason instead of a bare failure: `ttl_expired` reads `Run never started: it waited for a free run slot longer than its time limit (admission_denied_reason: ttl_expired).`; any other value reads `Run never started (admission_denied_reason: <value>).`. Exit 1 either way.
- One shared `getStatusColor` (new `src/utils/run-status.ts`) replaces the two copies in `run-list.ts` and `run-view.ts`; it colours `admission_pending` yellow and `cancelled` gray. `run view` shows `admission_pending` as `admission_pending (waiting for a free run slot)` and, when present, an `Admission: <reason>` line under the status.

## 5. cli#102 — mixed-case names

- **Deploy lookups fall back to the canonical slug.** Both project lookups in `deploy` (`GET /api/v1/projects/<x>`) try the name as typed first and, on a 404 only, the canonical slug (`buildProjectSlug(name, environment)`) when it differs. A legacy slug that `slugifyName` would rewrite still resolves by its exact spelling. Create keeps using the canonical slug as today.
- **`init` names the project by its canonical slug** (the issue's 2026-08-04 comment, canon): `slugifyName(path.basename(targetDir))`, or `solidactions-project` when that is empty. That one value replaces `__PROJECT_NAME__` in the template (so `package.json` gets a valid npm name) and appears in the printed next steps.

## 6. cli#129 — `env pull` on a bind-mounted `.env`

`writeSecretFileSync` keeps temp + rename. When the rename fails with `EBUSY` (a file-level bind mount is a mount point, and `rename(2)` over it fails), it falls back to writing in place, tightening the mode before any secret byte lands: `openSync(target, O_RDWR | O_NOFOLLOW)` → `fchmodSync(fd, 0o600)` → `ftruncateSync(fd, 0)` → write → `closeSync`, then removes its temp file. Any other rename error still throws as today. If `fchmod` fails, nothing has been truncated or written and the error is thrown.

The temp file becomes `<basename>.<pid>.<hex>.tmp` (no leading dot), so a temp leaked by a SIGKILL during `env pull` of `.env` still matches a `.env*` gitignore pattern.

**Deliberate consequences** (recorded here because the app spec the issue names, solidactions-app `docs/superpowers/specs/2026-08-15-issue-1328-design.md`, is in another repo; the manager notes this on cli#129):
- On the `EBUSY` fallback only, the write is not atomic: a reader that opens the file mid-write can see a truncated or partial file.
- On that path the file keeps its inode, owner and group; only its mode is forced to 0600.

The fallback never writes through a symlink (PM ruling 5): it opens the target with `O_RDWR | O_NOFOLLOW`, so a target that is a symlink makes the fallback throw (`ELOOP`) and writes nothing. (`writeSecretFileSync` already passes the realpath, so this guards the exported `writeViaTempFileSync` and the window between `realpath` and `open`.)

The fallback is tested through an injected rename function (the issue's "rename wrapper injection point"), never by mocking `fs`.

## 7. cli#153 — single-doc pulls record the doc's folder

- The single-doc fallback of `doc pull <folder>/<doc>` records the doc's real folder in the manifest's `folder_path`: the `folder_path` `read_doc` returns when it is a string, otherwise `path.posix.dirname` of the argument, with `''` for the root (`.`). (Today's `read_doc` payload, solidactions-app `DocReadService::read`, carries `folderId` but no `folder_path`, so the dirname is what runs; the found doc lives exactly at the folder the CLI asked `read_doc` for.)
- The manifest-clobber check compares the previous manifest's `folder_path` with that **resolved** folder, so it runs after the server tells the CLI whether the argument is a folder or a doc, and still before anything is written. Re-pulling the same doc agrees with itself; pulling the parent folder into a single-doc directory is allowed.
- A single-doc pull into a directory whose manifest tracks the same folder **merges** its one entry into the existing manifest instead of replacing it, so the other tracked files stay tracked. Deletions are still never propagated from a single-doc pull.

## 8. cli#154 — `doc push` creates visual docs and canvases

The approach is the PM-accepted technical ruling recorded on cli#154: bodies go inline through `docs_manage`, not app#1902's upload links.

- **File kinds.** `doc push` picks up these kinds: `<title>.md` (markdown, as today), `<title>.html` (doc type `visual`), and `<title>.canvas.json` or `<title>.canvas` (doc type `canvas`; `.canvas` is the JSON Canvas extension other tools write, accepted by PM ruling 8). The title is the file name without that suffix. Untracked visual and canvas files go through `bulk_create` with a per-item `type` (`visual` / `canvas`), which overrides the top-level `--type` for that item. They are no longer reported as "not pushed — use doc upload".
- **Canvas files are checked locally.** A canvas file whose text does not parse as a JSON object fails the push before any server call, naming the file. Everything else about canvas shape is the server's (`invalid_canvas_body`), reported per file like any other row error.
- **Size, checked locally (PM ruling 3).** The server caps a body at 1 MiB (`docs.blob_size_cap_bytes`, 1,048,576 bytes; app#1902 uses the same cap for markdown and visual). Any file the push would send that is larger fails the push before the first request, naming the file and its size. `bulk_create` chunks are cut at 50 items **or** about 4 MiB of bodies (4,194,304 bytes), whichever comes first, so fifty large pages never become one 50 MB request a proxy rejects with an HTML page.
- **A single file.** `doc push <path>` accepts a file as well as a directory. A file is pushed alone, as if its directory were pushed with only that file present: a tracked file is written by id with the drift guard, an untracked one is created through `bulk_create`, and `--folder`, `--on-conflict`, `--type`, `--dry-run` and `--json` mean what they mean for a directory. Untracked binaries elsewhere in that directory are ignored.
- **`--replace <id>`** replaces the body of an existing doc by numeric id. It requires a single doc-kind file and refuses `--folder`, `--on-conflict` and `--type`. **It checks the doc's type first (PM ruling 2)**, because the server does not: a visual doc accepts any body under the cap (solidactions-app `VisualBodyValidator.php:16-21` checks size only) and a markdown doc accepts any text, and this path has no drift guard. The CLI calls `docs_read read_doc {id}`, then compares `doc_type.slug` with the file kind: `.html` needs `visual`, `.canvas.json` / `.canvas` need `canvas`, `.md` needs anything that is not `visual`, `canvas` or `media` (no type, or another type such as `skill`). A mismatch refuses with both kinds and the doc's title named; nothing is written. On a match it sends `docs_manage write {id, body}` with no `base_revision` (the user named the doc). The success and `--dry-run` lines name the doc's title (`replaced doc 42 ("Pricing page") with page.html (revision 8)`); the dry run still reads the doc (a read, not a write). `--json` prints `{replaced: {id, title, file, current_revision_id}}`.
- **Push and pull do not round-trip the new kinds yet (PM ruling 4).** `doc pull` is unchanged: it still writes every non-media doc as `<title>.md`; mapping visual → `.html` and canvas → `.canvas.json` on pull is cli#157. Docs created by an untracked push are not added to the manifest (as for markdown today), so pushing the same directory again skips them under the default `--on-conflict skip`. When a push skips a visual or canvas row, it prints one line saying how to update that doc: push again with `--on-conflict overwrite`, or `doc push <file> --replace <id>` (with the id when the row carries one). The README states both limits.

## 9. cli#155 — route tables only resolve their own keys

`resolveCrewsCall` and `resolveDocsCall` (`src/utils/mcp.ts`) look actions up with `Object.hasOwn`, and so does the per-route param `rename` lookup, so `constructor`, `toString` or `__proto__` throw `unsupported … action` (or pass a param through unrenamed) instead of resolving to an inherited `Object.prototype` member.

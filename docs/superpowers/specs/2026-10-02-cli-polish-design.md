# Wave cli-polish — design

**Wave:** cli-polish (CrewOps wave card task-waveclipolishone-80b1, run seq:sa-wave-cli:f7a03b84), branch `wave/2026-10-02-cli-polish`.
**Issues:** cli#156, cli#157, cli#161, cli#162, cli#113, cli#91, cli#158. Peter approved the wave in CrewOps ask task-startthenextcli-6fc8 ("Approve: start it now", 2026-10-02), recorded on each issue. The PM folded cli#158 in as a same-surface tooling papercut with cli#91 (ruling on plan card task-planclipolish-a1a7).
**Plan:** `docs/superpowers/plans/2026-10-02-cli-polish.md`.
**Plan review:** Fable (task-planreviewcli-d532) REQUEST CHANGES 3e59485; the PM accepted it as rulings 1-6 on plan card task-planclipolish-9da6 (nit 7 withdrawn by Fable). Cited below as "PM ruling N".

This spec records the design calls the issues leave open.

## 1. cli#91 + cli#158 — the test toolchain

cli#91's advisories are already gone on main: the lockfile resolves vitest 4.1.11 → vite 8.3.1 → postcss 8.5.28 and `npm audit` reports 0 vulnerabilities. PM ruling (option b): raise the declared floor so a lockfile regeneration cannot resolve an advisory version again: `"vitest": "^4.1.11"` in `package.json`, lockfile updated to match. cli#158: rename `vitest.config.ts` to `vitest.config.mts` so Vite loads it as ESM and the config-loader warning disappears from every run; update the one doc reference (`tests/live/README.md`). Both the `unit` and `live` projects must still resolve.

## 2. cli#156 — one line on every API failure

Every command that prints `Failed: <status>` followed by the raw response body switches to the existing `formatApiFailure(status, data)` (`src/utils/api.ts`, from cli#114): `Failed: <status> <message>` or `Failed: <status>`, never the body. The 25 sites (23 exact, `schedule-state.ts`'s `?.message ?? data` variant, and `deploy.ts`'s `JSON.stringify(data)` print) are listed in the plan. Same surface, same change:
- **401 lines name the host** (the issue's 2026-10-02 comment): a shared `authFailedLine(host)` returns `Authentication failed against <host>. Run "solidactions login --global" to re-configure.`, with any `user:pass@` userinfo stripped from the host (PM ruling 6); every command's 401 branch prints it, including the eight commands that print the old text without a raw-body site (`crew-env-push`, `doc-upload`, `env-push`, `project-create`, `project-view`, `pull`, `state`, `workflow-view`; PM ruling 1) and `env list` / `connection list`.
- **`env list`'s global 404** prints the server's message through `formatApiFailure` instead of the fixed `Resource not found.` (cleanroom F5 comment), so one failure reads the same in every command.
- **The two 422 branches** that print `data.message || data.errors` (`env-map.ts`, `schedule-set.ts`) use the existing `formatValidationError(data)` so a validation-error object is never dumped.
- A static guard test fails if any `src/commands/*.ts` file passes `error.response.data` bare to a `console.*` call, `JSON.stringify`s it into output, or prints the old 401 text (PM ruling 1: the print shape only, so `return formatValidationError(error.response.data)` is not flagged).

## 3. cli#161 — a project argument resolves by its canonical slug everywhere

`project deploy` already finds a mixed-case project by its canonical slug (cli#102). One shared resolver replaces each command's ad-hoc slug building:
- `src/utils/project-ref.ts` exports `resolveProjectSlug(config, typed, environment?)`. It tries, in order and without duplicates: the slug the command builds today (the typed name for production or no environment, else `<typed>-<environment>`), then the canonical slug (`buildProjectSlug(typed, environment)`). The first candidate that `GET /api/v1/projects/<candidate>` answers 200 wins, and the server's `slug` (else the candidate) is returned. A 404 moves on to the next candidate. A 403 stops the lookup and returns the first candidate, letting the command's own request decide (PM ruling 3: a token may be allowed the command's route but not the project read). Any other error propagates to the command's existing error handling. If every candidate 404s, it returns the first candidate, so the command's existing 404 message still runs. The candidate goes into the lookup URL the same way the commands put the slug into theirs (unencoded; PM ruling 6).
- `getProjectBySlugOrCanonical` moves from `deploy.ts` to that module (deploy keeps its behaviour).
- Every command that takes a project argument resolves it once before its first project-scoped request: `run start`, `webhook list`, `webhook secret`, `env list/set/delete/pull/push/reset/map`, `project pull`, `project logs` (the path without `-e`), `project view`, `schedule list/set/delete/enable/disable/reset`. Cost: one extra GET per command.
- `run list <project>` filters on the server by the typed text. When the server answers `project_not_found`, the CLI looks the project up in `GET /api/v1/projects` (exact name, exact slug, then the canonical slug, then a case-insensitive name) and retries once with that project's name. If the case-insensitive rung matches more than one project, it refuses and lists them, as `workspace set` does (PM ruling 4).
- `lookupProjectFamilyEnvironments` (`src/utils/api.ts`, used by the friendly 404 messages) matches the canonical slug and the name case-insensitively too (an ambiguous case-insensitive match gives no hint rather than a guess, PM ruling 4), which removes the self-contradictory "has no production environment (exists in: production)".
- The post-deploy webhook hint prints the canonical slug instead of the typed name.
- Not changed (ruling): `project view` without `-e` still defaults to `dev`, the CLI-wide default; its existing 404 message already lists the environments the project has.

## 4. cli#162 + cli#113 — what `whoami` and `workspace list` say about the workspace

- **`whoami` shows the organization** (cli#162): the workspace line reads `<slug-or-name> — organization <org> (<id>)` when the config's `workspaceOrg` is set (it always comes from the same layer as `workspaceId`; `-w` clears it).
- **`whoami`'s "(inherited from a different config file)" suffix is deleted** (cli#113 part 2): it fired whenever the workspace and the API key came from different files, which is the normal local-pin case, and contradicted the line it was on. The Host and API Key lines already name their own sources.
- **A dangling pin is called out** (cli#113 part 1): when the active `workspaceId` is not in `workspace list`'s results, the list ends with a warning naming the pinned workspace, its id and where the pin came from, and saying it may belong to another host or no longer be accessible, with the `workspace set` fix. `workspace list` therefore resolves its config with sources (`requireResolvedConfig`).

## 5. cli#157 — `doc pull` and `doc push` round-trip visual docs and canvases

### Pull writes the right extension
`doc pull` writes a doc whose type is `visual` as `<title>.html` and a `canvas` as `<title>.canvas.json`; every other non-media doc stays `<title>.md`; media is unchanged. The type comes from the folder listing: `docs_read list` rows carry `doc_type` (`null` for untyped docs) today, although the app does not guarantee it, and `bulk_read` does not return it at all (app `BulkItemResult`). **Ruling:** use the `list` row's `doc_type.slug` when the row has a `doc_type` key; for a row without the key, ask `read_doc {id}` for that doc's type. So the pull is right today and stays right if the `list` shape changes, at worst one extra call per doc. The single-doc fallback already reads the doc with `read_doc`, which returns `doc_type`. The manager files an app issue to make `doc_type` part of the `list`/`bulk_read` contract.
- Collision naming applies per extension as today (`allocateName(used, base, ext)`).
- **Same doc id, different path is a rename (PM ruling 2).** When the previous manifest tracks a pulled doc's id under a different path (e.g. `page.md` for a doc now written as `page.html`), in folder and single-doc pulls alike: if the old file is modified locally, the pull refuses (exit 1, nothing written) unless `--overwrite`, naming both paths and saying to rename the old file to the new extension and push it first; with `--overwrite` the edited old file is kept untracked with a warning (never deleted). If the old file is unmodified, it is removed after the new file is written, so no stale twin is left. These paths never get the "deleted remotely" orphan warning.

### Push records the docs it creates
When `doc push` creates docs from untracked files, each `created`, `renamed` or `overwritten` row is recorded in the directory's manifest under the file's relative path (`{ id, title, current_revision_id, media: false, body_sha256: sha256 of the local file }`), so a second push writes that doc by id with the drift guard instead of skipping it. Rules:
- Only when the docs land in the manifest's folder tree: no `--folder`, or `--folder` equal to the manifest's `folder_path`. With a different `--folder` nothing is recorded and the push says so once.
- With no manifest, a directory push creates one with `folder_path` = the folder it pushed into (`--folder`, else the root `''`). A single-file push records only into a manifest its directory already has (PM ruling 5), so `doc push ~/Downloads/page.html` never turns `~/Downloads` into a tracked directory.
- A `renamed` row (the server created the doc under a new title because the original was taken) is recorded under the local path with the server's title, and the push says the next `doc pull` will name the local file after that title (PM ruling 5).
- `skipped` (title already taken), `error` and dry-run rows are never recorded.
- The skip hint from cli#154 stays for skipped visual/canvas rows; the README's "do not round-trip yet" paragraph is replaced by the new behaviour.
- A recorded markdown doc's local hash is of the local file; the server may strip frontmatter from the stored body, which only means the next pull rewrites the file once.

## 6. Out of scope

Server-side changes (the app's `list`/`bulk_read` contract) — filed, not done here. `dev`'s yaml-derived project slug (`dev.ts`) — not a user-typed argument.

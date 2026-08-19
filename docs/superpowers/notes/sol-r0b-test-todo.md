# sol-r0b — test todos and follow-ups

Items uncovered during implementation and the live smoke battery against
`https://e2e.formup.cc` that aren't blocking this PR but should be revisited.

## Verified working (no action needed)

- App PR #128's new error format (`Project '<slug>' not found in your active workspace '<workspace-slug>'.`) lands as JSON when `Accept: application/json` is sent, and matches the axios interceptor regex exactly. Cross-workspace same-slug create works (POST `/api/v1/projects` with the same `slug` in two different workspaces succeeds, returning two distinct project ids).

## Open follow-ups

### `whoami` slug/UUID can mismatch when local has only `workspaceId` and global has both

When a legacy local config (pre-this-PR — only `workspaceId`, no `workspace` slug) coexists with a new-format global config (both keys), `mergeConfigs` picks `workspace` from the global layer and `workspaceId` from the local layer. `whoami` then prints e.g. `Workspace: second-workspace (019d344f-...)` where the slug came from global but the UUID belongs to a different workspace. API behavior is unaffected (calls use the local UUID); only the display label is wrong.

Fix options: couple `workspace` and `workspaceId` in `mergeConfigs` so they're always picked from the same layer (the test for "falls through missing keys to the next layer" would need to be updated since a local with only `workspace` and no `workspaceId` is no longer a realistic state); OR have `whoami` detect a source-mismatch between the two and warn.

Out of scope for this PR — affects display only on a rare upgrade path. Note for the next CLI release.

### `solidactions login --local` does not populate the `workspace` slug

`login --local <token>` followed by `ensureWorkspaceSelected` writes `{host, apiKey, workspaceId}` only — the `workspace` slug is not stored. Result: the next `whoami` shows `<uuid> (slug unknown — run 'workspace set <slug>' to populate)`. Minor UX gap; `ensureWorkspaceSelected` could write the slug too, given the API response already includes `name`/`slug`.

Out of scope; trivial follow-up patch.

### ~~Deploy prints the augmented hint twice~~ — FIXED in `351b1a1`

`project deploy <missing-slug> -e production` triggers two `{project:slug}` lookups (the production-existence check and the env-specific lookup). Both used to print the augmented `Did you mean to switch workspaces?` block independently. Now hoisted a `workspaceMismatchPrinted` flag and a `printWorkspaceMismatchOnce` closure inside `deploy()` so the hint surfaces at most once per invocation. The closure captures the flag by reference; subsequent calls are silent even if the two 404s carry different message strings.

Live re-verification deferred — `e2e.formup.cc` is shared across branches and currently has a baseline build deployed (see "shared env" note below). Unit-level guarantee comes from the per-call closure; the live pre-fix double-print was observed on 2026-04-25.

### ~~Test-fixture gotcha: HOME redirect is bypassed by `findLocalConfigPath` walk-up when cwd is under the real `/home/<user>`~~ — FIXED in `351b1a1`

`findLocalConfigPath` now skips both `os.homedir()` (HOME-respecting) and `os.userInfo().homedir` (OS-level real home). Under HOME redirection the two paths differ and both are skipped; in normal runtime the `Set` collapses to one entry with no extra cost. HOME-redirected test fixtures are safe regardless of cwd.

### Most CLI commands do not surface the new `Project not found in active workspace` error

Only `project deploy` was updated in this PR to surface the augmented backend message. The other commands that touch a project by slug — `env list`, `env set`, `schedule list`, `webhook list`, `run list`, `project logs`, `project pull` — return older controller-level messages (`Project 'X' not found.` or `Project 'X' not found for the specified environment.`) because they hit different controller methods that do explicit `where('slug', $slug)->where('workspace_id', $ws)` queries instead of relying on the `{project:slug}` route binding from app#128.

Audit pass on those controllers (in `solidactions-app`) would have them fall through to the same error helper as the route binding, so the augmented hint shows up for every command. Tracked as a separate ticket — backend change, not CLI.

### ~~Cross-tenant slug ambiguity in workspace lookup~~ — RESOLVED by #1196

`matchWorkspace(input, workspaces)` did a flat search across every workspace the API key returns and silently took the first match — a user with access to two tenants each having a workspace slugged `acme` would silently land in the wrong one. Resolved with a CLI-only fix rather than the `?tenant=<tenant-slug>` API-filter approach floated here originally: `matchWorkspace` is retired and replaced with `classifyWorkspaceInput`, which refuses (rather than guesses) on a duplicate-slug match, a duplicate-name match, and the org/workspace name collision that #1196 was filed for, returning an `ambiguous`/`org-only` result the caller reports instead of picking a winner.

### `e2e-init-cli` script in `solidactions-app` is broken

The `solidactions-app/scripts/e2e-init-cli` script calls `solidactions init <token> --local --gitignore --host <host>`, but the current CLI uses `solidactions login` for auth — `init` is project scaffolding now. The script is dead until updated. Pre-existing tech debt; flag for the app dev to fix.

### `e2e.formup.cc` is a shared env — confirm HEAD before smoking

`e2e.formup.cc` is a single shared staging environment that gets torn down and redeployed by whichever GitHub Actions Tests workflow ran most recently — across all branches. Running a smoke battery against it tells you what the *last branch's CI run* deployed, NOT what your branch contains. Confirmed live: app#115 deployed #128's behavior on 2026-04-25; the next day branch `docs-pillar-spec` overwrote the env with a baseline build, taking the `Project::resolveRouteBinding` override with it. Source code at app `HEAD abba3fe` was unchanged — just not what was deployed.

**Preflight before any future cross-branch smoke** — verify the deployed backend has the route-binding override before drawing conclusions:

```bash
TOKEN="<a valid token for e2e>"
WS_ID="<a workspace UUID the token can see>"
curl -s -X GET https://e2e.formup.cc/api/v1/projects/__preflight_marker__ \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Workspace-Id: $WS_ID" \
  -H "Accept: application/json" \
  | jq -r '.message'
```

Expected output if app#128 is live:
> `Project '__preflight_marker__' not found in your active workspace '<slug>'.`

If you see `No query results for model [App\\Models\\Project] __preflight_marker__` instead, e2e is on a baseline build and the smoke will not exercise the new error path. Re-trigger the relevant branch's Tests workflow to refresh the env before continuing.

### CI ordering gotcha (memory note)

Per the project's auto-memory: solidactions CI must run unit before e2e on the shared self-hosted runner — out-of-order CI breaks staging. When `.github/workflows/*.yml` is touched, verify the unit job is a dependency of the e2e job.

## Manual smoke battery results

Full report mailed to mayor (`SMOKE-FULL-REPORT`, `FIXES-VERIFIED`) — kept here for traceability.

Tested against `https://e2e.formup.cc` with PR #128 deployed:

- `whoami`: shows slug + uuid + provenance label (env / file / -w flag) — works for all three sources.
- `workspace list`: works.
- `workspace set <slug> --global`: writes both `workspace` + `workspaceId` keys; verified with file diff.
- `workspace set <slug> --local`: writes ONLY `{workspace, workspaceId}` to `./.solidactions/config.json` — partial-write contract verified end-to-end.
- `.gitignore` prompt fires + writes `.solidactions/` correctly.
- Directory-scoped pinning: from `sub/` uses local pin; from grandparent uses global. Precedence chain end-to-end works.
- `project list`: works in active workspace.
- Cross-workspace same-slug create (the actual app#128 fix): WORKS — POST `/api/v1/projects` with `{slug:'foo'}` succeeded in BOTH `e2e-workspace` AND `second-workspace`, returning DIFFERENT ids.
- `env set` / `env list` with `-e production`: works.
- `-w <slug-or-uuid-or-name>`: resolves correctly via `/api/v1/workspaces` and proceeds without an interactive prompt (verified after fixup commit `fc862b0`).
- `project deploy <missing> ./path`: surfaces the augmented `Project 'X' not found in your active workspace 'Y'.` error with the workspace-switch hint, before falling through to the first-deploy environment-pick prompt (verified after fixup commit `fc862b0`).
- **Cross-workspace same-slug deploy via the CLI (the actual #128 fix end-to-end)**: verified — `project deploy crossfoo /path -e production` succeeded against `e2e-workspace` (default), then `-w second-workspace project deploy crossfoo /path -e production --config-only` succeeded too. The DB now has two distinct `crossfoo` projects (different UUIDs) in different workspaces, exactly the constraint app#128 unlocks.
- `project deploy` against an unreachable Daytona on e2e times out at `Still waiting for build to start...` (60 polls × 1s). The CLI handles the timeout gracefully (`Timeout waiting for build. It might still finish.`); the build-completion piece is e2e infrastructure, not a CLI concern.

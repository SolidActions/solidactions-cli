# Per-folder workspace pin via `workspace set --local`

**Bead:** `sol-r0b`
**Issue:** [#22](https://github.com/SolidActions/solidactions-cli/issues/22)
**Companion to:** [solidactions-app#115](https://github.com/SolidActions/solidactions-app/issues/115) / [PR #128](https://github.com/SolidActions/solidactions-app/pull/128)
**Date:** 2026-04-25

## Problem

It is too easy to run `solidactions deploy` in a project directory while the global active workspace doesn't match the workspace the user intended to deploy to. The mistake produces a confusing 404 (or the wrong project gets touched, before app#115/#128). Pinning a workspace per directory — git-config-style — gives the user an unambiguous "this folder targets that workspace" knob.

## Background — what's already in place

- `Config` type in `src/utils/config.ts` already carries `host`, `apiKey`, and `workspaceId`. The token field is normalized from a legacy `token` alias.
- `resolveConfig` already merges three layers field-by-field: env > local > global. Sources are surfaced for `whoami`.
- `findLocalConfigPath` walks up from `cwd`, skipping `$HOME` so the global config is never matched as a local hit.
- `login` already supports `--local` / `--global` (mutually exclusive; prompts in TTY; refuses non-interactively); `logout` accepts `--local` / `--global`; `--local` writes go through the same `.gitignore` prompt path. We will copy that pattern verbatim into `workspace set`.
- `getApiHeaders` sends `X-Workspace-Id: <uuid>` on every API call. The CLI does not (and will not) send a slug header — the backend already keys on UUID.
- No test framework is wired up today. Adding one is in scope.

So this is finishing-the-job work plus a small ergonomic addition: a per-folder workspace key, a top-level `-w` override, and a hint surfaced from a new backend error.

## Scope

In scope:

- New `--local` / `--global` flags on `workspace set`, mirroring `login` semantics.
- File-format change: local (and going forward, global) configs may carry a human-readable `workspace` slug alongside the cached `workspaceId` UUID.
- New top-level `-w, --workspace <id-or-slug-or-name>` flag.
- Lookup-precedence chain implemented in `resolveConfig`: `-w` flag → `SOLIDACTIONS_WORKSPACE_ID` env → local file → global file.
- Axios response interceptor that detects the new "Project '\<slug\>' not found in your active workspace '\<workspace-slug\>'." 404 from the backend and appends a "switch workspaces" hint.
- `whoami` updated to show `workspace: <slug> (<uuid>)`.
- Vitest as the test framework; four tests covering merge, `--local` partial write, precedence chain, and error-hint augmentation.

Out of scope:

- No backend changes from the CLI side. App PR #128 owns the new error message; we just consume it.
- No `init`-command changes — `init` scaffolds project files, never touches CLI auth/workspace config.
- No new `workspace unset` command. `logout --local` already removes the entire local file; we don't need a finer-grained "unpin workspace key" yet.
- No new `SOLIDACTIONS_WORKSPACE` (slug) env var. Spec text mentioned one; we're rejecting it in favor of keeping the existing `SOLIDACTIONS_WORKSPACE_ID` (UUID) — the env-var case is for scripts and CI, where UUIDs are more stable.
- No deprecation period for the previous `workspace set` flagless behavior. Hard cut: from this release on, `workspace set` requires `--local` or `--global` (or prompts in TTY).

## File format

### Layered files — slug canonical, UUID cached

Both the local file (`./.solidactions/config.json`) and global file (`~/.solidactions/config.json`) may carry both keys:

```json
{
  "host": "https://app.solidactions.com",
  "apiKey": "sk_…",
  "workspace": "mercer",
  "workspaceId": "01HZ-…"
}
```

The local file may be partial — `--local` writes never write `host` or `apiKey`:

```json
{
  "workspace": "mercer",
  "workspaceId": "01HZ-…"
}
```

### Truth and display

- `workspaceId` is **truth**. Every API call uses the UUID via `X-Workspace-Id`.
- `workspace` (slug) is a **display hint** — it makes `whoami`, `git diff`, and "what's in this folder?" readable.
- If an admin renames the workspace's slug after we cached, the file becomes inconsistent on the slug field. The UUID still works. `whoami` may show a stale slug; the user can re-run `workspace set <new-slug>` to refresh.
- If the workspace itself is deleted/recreated and our cached UUID 404s, we **fail with a clear message**: `Workspace '<slug>' (cached id <uuid>) not found. Run 'solidactions workspace set <slug>' to refresh.` No silent self-heal.

### Backwards compatibility

- Existing files with only `workspaceId` (no `workspace` slug) keep working. `whoami` will show `workspace: (unknown — run 'workspace set <slug>' to populate)`. The slug is only required for human display, not for API calls.
- Existing files with the legacy `token` field continue normalizing to `apiKey`; this PR does not touch that path.

## `workspace set <id-or-slug-or-name> [--local | --global]`

### Flag handling — copy `login`

```text
solidactions workspace set <ws> --local      # writes ./.solidactions/config.json
solidactions workspace set <ws> --global     # writes ~/.solidactions/config.json
solidactions workspace set <ws>              # TTY: prompt local/global
                                             # non-TTY: error, "pass --local or --global"
solidactions workspace set <ws> --local --global   # error, mutually exclusive
```

The prompt text and helper functions come from `login.ts`'s existing `promptLocation()` / `ensureGitignoreCovers()`. We extract them into `src/utils/config-write-target.ts` so `login` and `workspace set` share one implementation.

### Lookup behaviour during `set`

The argument may be an id, slug, or workspace name (parity with today's `workspaceSet`). We hit `/api/v1/workspaces`, find the match, and write **both** `workspace` (slug) and `workspaceId` (UUID) to the chosen target file.

`--local` writes ONLY `{workspace, workspaceId}`. It does not copy `host` or `apiKey` into the local file. Existing local files with `host`/`apiKey` keys are preserved untouched (we shallow-merge over what's there); only the two workspace keys are updated.

### `.gitignore` and the API key

`--local` reuses login's `ensureGitignoreCovers` flow, but with a softer message: the local file in this case may not contain an API key. The prompt still appears — the directory could later have credentials added (e.g., via `login --local`) and we want `.solidactions/` ignored from the start.

### `-w` interaction with `set`

`-w` is a "use this workspace for THIS call" override. Running `solidactions -w foo workspace set bar --local` is contradictory — `-w` says "act as foo", `set bar` says "pin the directory to bar". We resolve this by **warning to stderr and ignoring `-w`** during `set`. The intent of `set` is to write; the override is for the read path.

```text
$ solidactions -w foo workspace set bar --local
warn: -w/--workspace is ignored on `workspace set`; the argument is the new workspace.
…
```

## Precedence chain

`resolveConfig(cwd, cliWorkspaceOverride?)` becomes the single source of truth. New ordering for the active workspace:

1. **`-w <id|slug|name>` flag** (highest): if set, resolve once via `/api/v1/workspaces` (in-process; no cache file write). The resolved UUID becomes the active workspace for this invocation only.
2. **`SOLIDACTIONS_WORKSPACE_ID` env var** (UUID, unchanged from today).
3. **Local file** (`./.solidactions/config.json`, walked up from cwd, skipping `$HOME`): `workspaceId` if present, else `workspace` slug → resolve via `/workspaces`.
4. **Global file** (`~/.solidactions/config.json`): same — `workspaceId` first, then slug.

Layers 3 and 4 may carry both keys; in case both are present we trust `workspaceId` (truth) and surface `workspace` for display only.

The `-w` flag is wired up as a top-level commander option in `src/index.ts`. A module-level setter (`setCliWorkspaceOverride(value)` exported from `src/utils/config.ts`) is invoked once from `index.ts` before any subcommand runs. `resolveConfig` reads from that module-level state — minimal change to the dozens of `resolveConfig()` call sites in commands.

### Slug → UUID resolution

The `/api/v1/workspaces` endpoint returns the user's full workspace list. We do a flat in-memory match by `id`/`slug`/`name` (today's `workspaceSet` behavior). If no match: `Workspace '<input>' not found. Run 'solidactions workspace list'.`

There is a known-but-out-of-scope ambiguity: a user with access to two tenants where each has a workspace slugged `acme` would silently get the first one. We're not solving that here — see "Out of scope" — but a follow-up note goes in `docs/test-todo.md`.

## Error display improvement — axios response interceptor

App PR #128 makes the route binding for `{project:slug}` workspace-scoped. On a 404, the backend returns:

```json
{ "message": "Project 'foo' not found in your active workspace 'mercer'." }
```

We install one global response interceptor in `src/utils/api.ts` (registered once on the default axios instance at module load):

```ts
axios.interceptors.response.use(
  (r) => r,
  (error) => {
    const msg = error?.response?.data?.message;
    if (typeof msg === 'string' && /Project .+ not found in your active workspace/.test(msg)) {
      const hint = "Did you mean to switch workspaces? Run 'solidactions workspace set <name> --local' to pin this directory.";
      error.response.data.message = `${msg}\n\n${hint}`;
    }
    return Promise.reject(error);
  }
);
```

Loose regex on purpose — backend phrasing can drift one character (period, casing, quote style) and we don't want to silently lose the hint. The pattern is still narrow enough to exclude the 422 write-path message ("A project named '\<slug\>' already exists in workspace '\<workspace-slug\>'.") because *that* error has different remediation — renaming, not switching.

Existing per-command error printing already prints `error.response?.data?.message`; the interceptor mutates that field in place, so no command-side changes are needed.

## `whoami` updates

```text
$ solidactions whoami
Current configuration:
  Host:        https://app.solidactions.com               (from /home/me/.solidactions/config.json)
  API Key:     sk_abc1...wxyz                              (from /home/me/.solidactions/config.json)
  Workspace:   mercer (01HZ-…)                             (from /home/me/repo/.solidactions/config.json)
```

Old global files without a slug surface as `workspaceId only — run 'workspace set <slug>' to populate the slug for display`. The slug column is purely cosmetic; absence does not break anything.

## Tests

Vitest, configured for Node-only (no DOM). Add a single devDep — `vitest` (latest stable, install fresh during implementation) — and a minimal `vitest.config.ts`. New `npm test` script runs `vitest run`.

Four test files (one per spec test):

1. `tests/config-merge.test.ts` — **unit, no I/O.** Extract the merge logic from `resolveConfig` into a pure `mergeConfigs(env, local, global)` function. Test: each layer wins for present keys; missing-key fallthrough; env-only path; local-wins-over-global; both-empty returns null. Includes the new `workspace` slug field alongside `workspaceId`.

2. `tests/workspace-set-local.test.ts` — **integration, real fs.** Tmp HOME, tmp cwd. Pre-write `~/.solidactions/config.json` with `{host, apiKey, workspaceId: "old-uuid"}`. Run the **file-write portion** of `workspaceSet('mercer', {local: true})` (refactored out of the network-touching code so it can be invoked with a fabricated workspace object). Assert: `./.solidactions/config.json` contains exactly `{workspace: "mercer", workspaceId: "<new-uuid>"}` — no `host`, no `apiKey` leaked. Assert: `~/.solidactions/config.json` is **untouched**. Assert: the file mode is `0o600`.

3. `tests/precedence-chain.test.ts` — **integration, real fs.** Tmp HOME and tmp cwd. Write all four layers (each layer a different known UUID). Run `resolveConfig` (or its public equivalent) once per case, asserting the chosen UUID:
   - all four set → `-w` wins
   - no `-w`, env set → env wins
   - no env, local set → local wins
   - only global → global wins
   - none set → null

4. `tests/api-error-hint.test.ts` — **unit on the interceptor function.** Construct a fabricated `AxiosError` with `response.data.message = "Project 'foo' not found in your active workspace 'mercer'."` Pass through the interceptor's error handler. Assert: the rejected error's `response.data.message` ends with the hint. Negative cases: a 422 unique-violation message does NOT get the hint; a generic 500 does NOT get the hint.

   The same interceptor logic exercised by this unit test also runs in real deploys once app#128 is merged + deployed to staging. That cross-process integration is verified manually against `e2e.formup.cc` (deploy to a workspace where the project does not exist; observe the hint in the CLI output) — that manual smoke is the BLOCKED step in the bead. The unit test stands on its own and gives the regression coverage we'd otherwise lose between releases.

We follow vitest defaults — `tests/` lives at repo root, files use `.test.ts`. No mocking framework; we use real fs (with `os.tmpdir()`-based tmp dirs that are cleaned up in `afterEach`) and fabricated input objects for unit-level tests on pure functions.

## File touches

```
docs/superpowers/specs/2026-04-25-workspace-local-pin-design.md   # this spec
docs/superpowers/plans/2026-04-25-workspace-local-pin-plan.md     # next step

src/utils/config.ts
  - add `workspace?: string` to Config
  - export `mergeConfigs(env, local, global)` as a pure function (extracted from resolveConfig)
  - add `setCliWorkspaceOverride(value: string | undefined): void` and read it in resolveConfig
  - extend ResolvedConfig.sources with `workspace`
src/utils/api.ts
  - axios.interceptors.response.use(...) added once at module load
src/utils/config-write-target.ts                                  # new
  - extracted from login.ts: promptLocation(), ensureGitignoreCovers(), the local/global decision tree
src/commands/workspaces.ts
  - workspaceSet(input, {local?, global?, gitignore?}) — flag handling mirrors login
  - resolves input → workspace, writes {workspace, workspaceId} to chosen target
  - --local: shallow-merges into existing local file (preserves any host/apiKey already there); on first creation, file contains exactly the two keys
src/commands/login.ts
  - refactor to use the extracted helpers from config-write-target.ts (no behavior change)
  - whoami(): print "workspace: <slug> (<uuid>)"
src/index.ts
  - top-level option `-w, --workspace <id-or-slug-or-name>`
  - in the action callback (or pre-action hook), call setCliWorkspaceOverride(opts.workspace)
  - emit a stderr warning if `-w` and `workspace set` appear together (Commander gives us the parsed command name)

package.json
  - devDeps: vitest (latest stable; install fresh during implementation)
  - scripts: { "test": "vitest run", "test:watch": "vitest" }
vitest.config.ts                                                  # new
tests/config-merge.test.ts                                        # new
tests/workspace-set-local.test.ts                                 # new
tests/precedence-chain.test.ts                                    # new
tests/api-error-hint.test.ts                                      # new
```

## Architecture decisions

**Why slug canonical + UUID cached, instead of slug-only or UUID-only.** Slug-only forces a `/workspaces` round-trip every CLI invocation (or a heuristic invalidation scheme). UUID-only matches today's code but is hostile to humans editing the file or reading a `git diff`. Storing both gives us readable files plus zero round-trips on the hot path. The cost is a write-time consistency contract, which is small.

**Why hard-cut `set` flag requirement instead of deprecation period.** Workspace pinning is a new mental model — users opting into per-folder pinning are also opting into the new flag dance. The smart-default ("write to activePath") is exactly the kind of magic that confuses users who expect the same command to do the same thing in any directory. A clean break is the right cost-benefit.

**Why not a new `SOLIDACTIONS_WORKSPACE` (slug) env var.** The env-var path is mostly used by CI and scripts, where UUIDs are more stable than slugs (admins can rename slugs; UUIDs don't change). Keeping `SOLIDACTIONS_WORKSPACE_ID` only avoids two ways of doing the same thing.

**Why a global axios interceptor instead of per-command error handlers.** The new diagnostic message can appear on any `{project:slug}` route — `deploy`, `env set`, `run start`, `pull`, etc. A single interceptor at the http-client level is one regex; the per-command alternative is N changes that drift over time as commands are added.

**Why warn-and-ignore on `-w` for `workspace set`** instead of erroring. Erroring is harsh for what's clearly user confusion. Silent-ignoring is too quiet for a state-mutating command. A warning teaches the boundary without aborting.

## Risks and mitigations

- **Backend wording drift on the new error.** App PR #128 spec quotes the message exactly; if implementation drifts (an extra space, lowercase 'in', a removed period), our regex might miss it. Mitigation: loose regex (`/Project .+ not found in your active workspace/`); the `api-error-hint` test will catch regressions before staging.
- **Stale UUID after admin recreates a workspace.** We fail explicitly rather than self-heal. The error message names the slug and the cached UUID and tells the user the exact command to run. Documented above.
- **Cross-tenant slug collision** in `workspace set <slug>` lookup. Pre-existing — out of scope. Recorded as a follow-up note in `docs/test-todo.md`.
- **`-w` propagation breaks if commander parsing order changes.** We use commander's pre-action hook (which fires after option parsing, before the subcommand handler), so the order is well-defined. The `-w` test in `precedence-chain.test.ts` covers the happy path.
- **Concurrent CLI processes** writing to the same config file. Existing atomic write (`.tmp` + rename) is preserved. No new sharing concern.
- **`tests/` accidentally compiled into `dist/`.** Verified out of scope: `tsconfig.json` already pins `rootDir: ./src` and `include: ["src/**/*"]`, so `npm run build` (`tsc`) never picks up `tests/`. Vitest brings its own esbuild path, so test compilation is independent of the production build.

## References

- App spec: `/home/mercer/gc/soliddev/rigs/solid/.worktrees/sol-bsb-app/docs/superpowers/specs/2026-04-24-workspace-scoped-project-slugs-design.md`
- Issue #22: https://github.com/SolidActions/solidactions-cli/issues/22
- Companion app PR #128: https://github.com/SolidActions/solidactions-app/pull/128
- App issue #115: https://github.com/SolidActions/solidactions-app/issues/115

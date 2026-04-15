# Per-folder CLI configuration

**Issue:** [SolidActions/solidactions-cli#13](https://github.com/SolidActions/solidactions-cli/issues/13)
**Status:** Approved design, not yet implemented
**Date:** 2026-04-14

## Problem

The CLI stores its configuration in a single global file at `~/.solidactions/config.json`. When a user runs multiple AI coding agents concurrently — each in a different project folder, pointed at a different SolidActions workspace — every agent mutates the same file. `solidactions workspace set` in one agent silently reconfigures every other agent. There is no way to "init" the CLI for just one folder.

## Goal

Let users scope the full CLI identity (`host`, `apiKey`, `workspaceId`) to a folder, with a clear resolution order and minimal breaking change for existing single-user setups.

## Non-goals

- Not changing the shape of `config.json` itself (same three fields).
- Not adding multi-profile support (`--profile foo`). Folder scoping is the isolation boundary.
- Not adding config encryption or keychain integration.
- Not forcing isolation — users who keep using the global file still work exactly as today.

## Resolution model

On every command, the CLI resolves each of `host`, `apiKey`, `workspaceId` independently through three layers, highest precedence first:

1. **Environment variables**
   - `SOLIDACTIONS_HOST`
   - `SOLIDACTIONS_API_KEY`
   - `SOLIDACTIONS_WORKSPACE_ID`
2. **Nearest local config file** — walk up from `process.cwd()` looking for `.solidactions/config.json`. Stop at filesystem root. **Skip `$HOME` itself** during the walk so the global location is never accidentally matched as a local hit.
3. **Global config file** — `~/.solidactions/config.json` (today's location, unchanged).

Fields resolve independently. A user can set only `SOLIDACTIONS_WORKSPACE_ID` in the environment and still inherit `host` + `apiKey` from a file.

### Resolution record

Resolution returns both the merged config and a per-field source map:

```ts
type Source = 'env' | string /* absolute path */ | null;

type Resolved = {
    config: Config;
    sources: { host: Source; apiKey: Source; workspaceId: Source };
};
```

The source map is used by `whoami` and `SOLIDACTIONS_DEBUG=1`.

## `init` behavior

Flags:
- `--local` — write `./.solidactions/config.json` in the current folder (create the directory if needed).
- `--global` — write `~/.solidactions/config.json` (today's behavior).
- `--gitignore` — when combined with `--local`, add `.solidactions/` to the nearest `.gitignore` without prompting.

Interactive (TTY) with no flag:
1. Prompt `Save config locally (./.solidactions) or globally (~/.solidactions)? [global]`. Enter accepts `global`.
2. If the user chose `--local` (or answered `local`), check for `.gitignore` in the target directory. If `.solidactions/` is not already covered, prompt to add it. The `--gitignore` flag skips the prompt.

Non-TTY with no flag: exit with a clear error —
`"Refusing to init non-interactively. Pass --local or --global."`

Overwrite semantics:
- Always overwrite an existing target when the flag is explicit (today's behavior for `--global`).
- In interactive mode, if the target already exists, print `"Existing config at <path> will be overwritten."` before the save (no confirm prompt — matches today's behavior).
- `init --local` always writes all three fields (`host`, `apiKey`, `workspaceId`) so that the local config is self-contained. Partial local files that inherit fields from global are the footgun case (see Risks).

## `workspace set` behavior

- Writes to the **active** config path: nearest local if present, else global.
- Prints the absolute path of the file it wrote.
- If `SOLIDACTIONS_WORKSPACE_ID` is set in the environment, exits with an error:
  `"SOLIDACTIONS_WORKSPACE_ID is set in the environment; the change would not take effect. Unset the env var or edit the config file directly."`

## `logout` behavior

Flags:
- `--local` — remove `./.solidactions/config.json` at the active local path.
- `--global` — remove `~/.solidactions/config.json`.

Without a flag: remove the nearest local-via-walk-up if present, else remove global. No interactive prompt. Always print which file was removed. `--local` with no local config anywhere in the walk-up path exits with `"No local config found in <cwd> or any parent directory."`

## `whoami` behavior

Prints each field with its source:

```
Host:       https://app.solidactions.com  (from /home/me/projects/foo/.solidactions/config.json)
API Key:    sa_abc1...wxyz                (from /home/me/.solidactions/config.json)
Workspace:  my-workspace                  (from $SOLIDACTIONS_WORKSPACE_ID)
```

If no config is resolvable at all, keep today's behavior: `"Not initialized. Run solidactions init <api-key>."`

## Verbose / debug mode

- `SOLIDACTIONS_DEBUG=1` — when set, any command prints the full resolution table (same format as `whoami`) to stderr before executing. Nothing else changes.
- No `--verbose` flag in v1. Env var alone avoids touching commander parsing on every subcommand.

## Default output (read commands)

Read-only commands (`deploy`, `pull`, `run list`, `run view`, `project list`, `project logs`, `env *`, `schedule *`, `webhook list`, etc.) stay silent about config source. This matches `git`, `gh`, `aws`, and `kubectl` conventions.

Write commands (`init`, `workspace set`, `logout`) always echo the absolute path of the file they mutated.

## Security

- Local config files are written with mode `0o600` (same as global today).
- Directories are created with mode `0o700`.
- `init --local` offers to add `.solidactions/` to `.gitignore` so the API key is not accidentally committed. See `init` above.

## Atomic writes

All config writes go through a helper that writes to `<target>.tmp` and then `fs.renameSync` to `<target>`. This prevents two concurrent CLIs from producing a torn JSON file when both write the global config. Cheap hardening.

## Code changes

### New: `src/utils/config.ts`

Single module that owns all config I/O and resolution.

```ts
export type ConfigSource = 'env' | string | null;

export interface ResolvedConfig {
    config: Config;
    sources: Record<'host' | 'apiKey' | 'workspaceId', ConfigSource>;
    activePath: string;  // path that write-mutating commands should target
}

export function resolveConfig(cwd?: string): ResolvedConfig | null;
export function findLocalConfigPath(startDir: string): string | null;
export function readConfigFile(path: string): Config | null;
export function writeConfigFile(path: string, config: Config): void;  // atomic (tmp + rename)
export function getGlobalConfigPath(): string;
export function getLocalConfigPath(cwd?: string): string;  // ./.solidactions/config.json
```

`activePath` rules:
- Nearest local config file, if one exists on disk during walk-up.
- Otherwise `~/.solidactions/config.json`.

Walk-up details:
- Start at `cwd` (defaults to `process.cwd()`).
- At each directory, check for `.solidactions/config.json`.
- If the current directory equals `os.homedir()`, skip the check and stop walking.
- Stop on reaching filesystem root.

### Modified: `src/commands/init.ts`

Three entry points live in this file today: `init`, `logout`, `whoami`. All three change.

- Remove in-line config I/O from all three; delegate to `config.ts`.
- Re-export `getConfig`/`saveConfig` as thin shims during the refactor so other commands keep compiling. Then migrate call sites in a second pass and remove the shims.
- `init` — add `--local`, `--global`, `--gitignore` flags; interactive local/global prompt; non-TTY guard; `.gitignore` check/write when writing local.
- `logout` — add `--local`, `--global` flags; no-flag default (local-if-present-else-global); always print which file was removed.
- `whoami` — print per-field source table; handle the fully-unset case with today's error message.

### Modified: `src/utils/api.ts`

- `requireConfig()` calls `resolveConfig()`, exits with today's error message if nothing resolves.
- `ensureWorkspaceSelected()` writes back to `resolved.activePath`, not always global.
- `getApiHeaders()` unchanged.
- Error path in `ensureWorkspaceSelected` for env-var conflict (workspace cannot persist when `SOLIDACTIONS_WORKSPACE_ID` is set) — but since this code also auto-saves the selection during initial interactive selection, the rule is: if the workspace came from env, skip the save entirely (don't error); error only in `workspace set`, which is an explicit user action.

### Modified: `src/commands/workspaces.ts`

- `workspaceSet` writes to `resolved.activePath`; prints path.
- Errors on env-var conflict.

### Modified: `src/index.ts`

- `init` command registers `--local`, `--global`, `--gitignore` flags.
- `logout` registers `--local`, `--global`.
- At process start (before command dispatch), check `SOLIDACTIONS_DEBUG` and, if set and a config can be resolved, print the resolution table to stderr.

### Not changed

- Every other command (`deploy`, `pull`, `run *`, `project *`, `env *`, `schedule *`, `webhook list`, `dev`, `ai-*`) routes through `requireConfig()` / `requireConfigWithWorkspace()` and picks up the new behavior transparently.

## Risks and limitations

1. **Global-file stomping is not eliminated.** Two agents that both use the global config still race each other on `workspace set`. This design gives users the tools to isolate (`--local` or env vars) but does not force it. That's deliberate — existing single-folder users should not have to migrate. Documented in the user-facing help text.

2. **Partial local configs.** A hand-edited local config with only one or two fields silently inherits the rest from global. Mis-pairing a prod host with a staging API key could produce confusing auth errors. Mitigations:
   - `init --local` always writes all three fields, so the default path produces complete files.
   - `whoami` shows exactly where each field came from, so debugging a mixed resolution is a single command.
   - `SOLIDACTIONS_DEBUG=1` makes every command self-diagnose.

3. **Back-compat for the `token` field.** `getConfig()` today has a compat shim for an old `token` field that gets normalized to `apiKey`. `readConfigFile()` in the new module preserves this shim.

## Testing / verification

Manual verification (per this project's testing workflow, tests are written after the feature ships and is verified end-to-end):

1. Existing global-only setup still works for all commands (no regressions).
2. `solidactions init KEY --local` in a project folder writes `./.solidactions/config.json`, prompts about `.gitignore`.
3. From a subdirectory of that project, every command picks up the local config via walk-up.
4. With both local and global present, local wins.
5. `SOLIDACTIONS_WORKSPACE_ID=xyz solidactions run start ...` uses `xyz` regardless of files.
6. `solidactions whoami` prints accurate per-field sources across all combinations.
7. `solidactions workspace set` with env var set produces the expected error.
8. `SOLIDACTIONS_DEBUG=1` emits the resolution table.
9. `solidactions init --local` without a TTY (piped stdin) and without explicit flag exits with the guard error — verified here by running with `</dev/null`.
10. `logout --local` and `logout --global` remove the right file; bare `logout` removes local-if-present.

Test notes for later (per project convention): add to the active project folder's `test-todo.md` when the implementation branch opens.

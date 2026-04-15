# Test TODO — CLI

When a test framework is introduced, cover the following for per-folder config (#13):

## `src/utils/config.ts` unit tests

- `findLocalConfigPath` returns null when no `.solidactions/config.json` exists anywhere up the tree.
- `findLocalConfigPath` skips `$HOME` — never reports `~/.solidactions/config.json` as a local hit.
- `findLocalConfigPath` stops at filesystem root without throwing.
- `findLocalConfigPath` returns the deepest match when multiple ancestors have `.solidactions/` directories.
- `readConfigFile` returns null for missing / malformed files (no throw).
- `readConfigFile` normalizes `{ token }` into `{ apiKey }` (legacy shim).
- `writeConfigFile` is atomic (tmp-file exists only briefly; readers never see a torn file).
- `writeConfigFile` creates the parent directory at mode 0o700, file at mode 0o600.
- `writeConfigFile` warns but does not crash when the target `.gitignore` is read-only.
- `writeConfigFile` does NOT narrow permissions on a pre-existing directory (documented behavior).
- `removeConfigFile` returns false when the file doesn't exist; doesn't throw on TOCTOU.
- `resolveConfig` merges field-by-field: env > local > global.
- `resolveConfig` preserves `activePath = nearest-local-if-present, else-global`.
- `resolveConfig` returns null when no layer contributes `apiKey` and `host`.
- `resolveConfig` reads env overrides lazily from `process.env` (tests can mutate env between calls).

## `init` integration tests

- `--local` writes to `./.solidactions/config.json` and leaves `~/.solidactions/config.json` untouched.
- `--global` writes to `~/.solidactions/config.json`.
- `--local --global` errors.
- Non-TTY without either flag errors.
- `--gitignore` auto-adds `.solidactions/` to `.gitignore`.
- `--gitignore` is a no-op when one of these patterns is already present: `.solidactions/`, `.solidactions`, `/.solidactions/`, `/.solidactions`, `**/.solidactions/`, `.solidactions/*`, `.solidactions/**`.
- Existing target path is overwritten silently with a warning line.
- `promptLocation()` re-prompts on invalid input rather than silently defaulting to global.

## `logout` integration tests

- `--local` removes the walk-up match; errors if no local config found.
- `--global` removes global only.
- Bare `logout` removes local if present, else global.

## `whoami` integration tests

- Shows correct source annotation for each of: env override, local file, global file, unset.

## `workspace set` integration tests

- Errors if `SOLIDACTIONS_WORKSPACE_ID` is set in the environment.
- Writes to `resolved.activePath` (local takes precedence over global).
- Prints the absolute path of the file it wrote.

## `SOLIDACTIONS_DEBUG=1`

- Prints resolution table to stderr on any command; absent when unset.
- Does not leak the API key (prints `<redacted>`).

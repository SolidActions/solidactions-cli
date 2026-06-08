# Deploy: user-configurable ignore list

**Issue:** [#44](https://github.com/SolidActions/solidactions-cli/issues/44)
**Date:** 2026-06-08
**Status:** Approved; revised per Codex review (2026-06-08)

## Problem

`solidactions project deploy` bundles the entire project root and only applies a
hardcoded ignore list:

```js
const ignore = ['node_modules/**', '.git/**', '.steps-deploy.tar.gz', '.steps-deploy.zip', 'dist/**', 'vendor/**', '**/node_modules/**'];
archive.glob('**/*', { ignore });
```

Two consequences:

1. **413 / upload bloat.** Large local-only dirs at the repo root (`.venv` ~400 MB,
   a legacy `web/` sub-app ~270 MB) get archived and the upload fails with
   `413 Request Entity Too Large`. There is no way for a user to exclude them.
2. **Secret leakage.** `.env` is *not* excluded, so a project's `.env` (API tokens)
   is shipped inside the deploy artifact. Secrets are supposed to come from
   `solidactions env set` (`ctx.vars`) and should never be baked into the bundle.

## Goals

- Let a user exclude additional paths from a deploy, configured in `solidactions.yaml`.
- Optionally honor the project's existing `.gitignore` (opt-in, not automatic).
- Always exclude `.env` / `.env.*` to stop secret leakage.
- No silent behavior change: nothing new is excluded unless the user opts in,
  except the `.env` safety default.

## Non-goals

- A separate `.solidactionsignore` dotfile. Rejected: long name, and redundant
  once config + opt-in `.gitignore` exist — a third place to look for the same info.
- A `--exclude` CLI flag. Deferred (YAGNI); the yaml list covers the durable need.
- Changing how the server builds the bundle (build still runs `npm run build`
  server-side; anything excluded here is purely client-side bundling).

## Design

### Config schema

A new optional `deploy:` block in `solidactions.yaml`:

```yaml
deploy:
  exclude:            # additive list, gitignore-style patterns
    - web/
    - "*.tmp"
  gitignore: true     # opt-in: also honor the project's .gitignore
```

- Both keys optional. If the `deploy:` block is absent, behavior is
  `defaults + .env` only.
- `deploy.exclude` — array of gitignore-style patterns. Additive.
- `deploy.gitignore` — boolean, default `false`. When `true`, the project's
  root `.gitignore` (if present) is also applied.

Add to `SolidActionsConfig` in `src/utils/env.ts`:

```ts
export interface SolidActionsConfig {
    project?: string;
    workflows: { id?: string; name: string; command?: string; file?: string; enabled?: boolean }[];
    env?: (string | { [key: string]: string | { oauth: string } })[];
    deploy?: {
        exclude?: string[];
        gitignore?: boolean;
    };
}
```

### Two-layer exclusion: hard deny + gitignore matcher

Codex review (2026-06-08) flagged that feeding `.env` into the same ordered
`ignore` matcher as user patterns lets a `!` negation re-include it, breaking the
security guarantee. So exclusion is **two layers**:

**Layer 1 — hard deny (non-negotiable, checked first, no negation can override).**
A path is dropped unconditionally if it matches:
- `.env`, or any `.env.*` (secret-leak fix)
- `.steps-deploy.tar.gz`, `.steps-deploy.zip` (our own deploy artifacts — the
  live archive is being written into `sourceDir` *while we walk*, see Archiving
  change; this guard prevents self-inclusion regardless of matcher state)

This layer is a plain predicate in the walker, **not** part of the `ignore`
matcher, so user negations cannot defeat it.

**Layer 2 — the gitignore matcher (`ignore` package), ordered.**
Patterns are added in this order; with negations, **later patterns win** (standard
gitignore semantics — this is an *ordered* rule list, not an unordered union):

1. **Defaults:** `node_modules/`, `.git/`, `dist/`, `vendor/`.
2. **`deploy.exclude:`** entries, if present.
3. **`.gitignore`** entries, only if `deploy.gitignore: true` and the file exists.

So `.gitignore`/`deploy.exclude` may use `!` to re-include something a *default*
or an earlier pattern excluded (e.g. `!dist/keep.js`) — matches the gitignore
mental model and is a deliberate opt-in. They can **never** re-include a Layer-1
path. `deploy.exclude` and `.gitignore` share identical semantics (anchoring,
`*.log` at any depth, `!` negation) because both feed the one matcher.

### Archiving change

Replace the single `archive.glob('**/*', { ignore })` call (deploy.ts ~line 438)
with an explicit walk + per-file add. **Crucially, do the walk BEFORE creating the
archive write stream** (currently `fs.createWriteStream(archivePath)` at ~line 321):

1. Build the plan via `planDeployFiles(sourceDir, yamlConfig)` → `{ files, summary }`.
   This runs the matcher + walk. If it throws (permission error, unreadable dir),
   we have not yet created `.steps-deploy.tar.gz`, so the deploy aborts cleanly with
   no orphan artifact to clean up. (Codex review: the old "archive not present yet"
   reasoning was wrong — the write stream is opened before entries are added — so the
   *real* fix is ordering the walk first, plus the Layer-1 hard deny on the artifact.)
2. Log the summary line (see Logging).
3. Create the write stream + archiver as today.
4. In place of `archive.glob(...)`, loop `files` and add each via
   `archive.file(absPath, { name: 'tenantcode/' + relPosixPath })`.

The Dockerfile-append (`archive.append(universalDockerfile, { name: 'Dockerfile' })`)
and `archive.finalize()` stay exactly as today. The `tenantcode/` prefix is
preserved.

**Behavior change — empty directories.** `archive.glob('**/*', { dot: true })`
adds empty directories as entries; the per-file walk does not (it adds files only).
This is acceptable for a deploy bundle (the server runs `npm run build`; empty dirs
carry nothing) and is called out here as an intentional, documented change. A test
asserts the new behavior so it is not a silent surprise.

### New module: `src/utils/deploy-ignore.ts`

Pure, no archiver/network deps, unit-testable in isolation.

```ts
import ignore, { Ignore } from 'ignore';
import { SolidActionsConfig } from './env';

// Layer-2 matcher defaults (gitignore syntax).
export const DEFAULT_DEPLOY_IGNORES: string[];   // node_modules/, .git/, dist/, vendor/

// Layer-1 hard deny — never re-includable by any negation.
export const HARD_DENY_BASENAMES: RegExp;         // ^\.env($|\..*) , .steps-deploy.(tar.gz|zip)

/** True if a path is hard-denied (Layer 1). Checked before the matcher. */
export function isHardDenied(relPosixPath: string): boolean;

/** Build the Layer-2 ignore matcher from defaults + deploy.exclude + optional .gitignore. */
export function buildDeployMatcher(sourceDir: string, config: SolidActionsConfig | null): {
    matcher: Ignore;
    summary: { gitignoreApplied: boolean; excludeRuleCount: number };
};

/** True if a directory should be pruned (not descended into). */
export function isIgnoredDirectory(relPosixDir: string, matcher: Ignore): boolean;

/**
 * Walk sourceDir, returning { files, summary }. files = relative POSIX paths to
 * include, with Layer-1 hard deny + Layer-2 matcher applied and ignored
 * directories pruned (so we never read into a 400 MB .venv).
 */
export function planDeployFiles(sourceDir: string, config: SolidActionsConfig | null): {
    files: string[];
    summary: { gitignoreApplied: boolean; excludeRuleCount: number; symlinksSkipped: string[] };
};
```

Key details (each driven by a Codex finding):
- **Paths are relative, POSIX-separated.** `ignore` requires forward slashes;
  convert `path.sep` → `/` on Windows before every matcher call. Tested with a
  Windows-style input.
- **Directory pruning uses `isIgnoredDirectory`,** which tests the dir path
  *with a trailing slash semantics* via the `ignore` package so trailing-slash
  patterns (`node_modules/`) prune the directory before descent. The package's
  `.ignores('node_modules')` handles dir patterns, but we test explicitly against
  `node_modules`, `node_modules/`, `web/`, and a nested dir to lock the behavior.
- **Layer-1 hard deny is applied in the walker** to both files and directory
  pruning, independent of the matcher, so no `!` negation re-includes `.env*` or
  the deploy artifact.
- **Symlinks: skipped, not followed** (decision, replacing the old "confirm
  during review" hand-wave). Directory symlinks are not descended (avoids cycles
  and escaping `sourceDir`); file symlinks are skipped rather than dereferenced
  (avoids reading content outside the tree). Skipped symlinks are collected into
  `summary.symlinksSkipped` and surfaced as a one-line warning so the change from
  archiver's behavior is visible, not silent. (If a real project needs symlinked
  content deployed, that is a follow-up — out of scope here.)
- **Walk errors** (EACCES, etc.) propagate out of `planDeployFiles`; the caller
  in deploy.ts runs it before creating the archive, so the deploy aborts with a
  clear `Deployment failed: <path>: <error>` and no artifact is left behind.

### Logging

After building the matcher and collecting files, print one summary line so
silent truncation never reads as "shipped everything", e.g.:

```
Bundling 312 files (.env excluded; .gitignore applied; 2 exclude rules)
```

Compose the parenthetical from `summary`: always mention `.env excluded`;
add `.gitignore applied` when `gitignoreApplied`; add `N exclude rule(s)` when
`excludeRuleCount > 0`. When `summary.symlinksSkipped` is non-empty, print a
separate yellow warning line listing the skipped symlink paths so the change from
archiver's behavior is visible.

### Dependency

Add `ignore` to `dependencies` in `package.json` (tiny, zero-dep, the standard
gitignore parser). No `@types` needed — `ignore` ships its own types.

## Testing

`tests/deploy-ignore.test.ts` (vitest, mirrors existing pure-function test style):

**Layer-1 hard-deny tests** (`isHardDenied`):
- `.env`, `.env.local`, `.env.production` → denied
- `src/.env` (nested) → denied
- `.steps-deploy.tar.gz`, `.steps-deploy.zip` → denied
- `environment.ts`, `.envrc` → NOT denied (no false positives on `.env` prefix)
- **negation cannot defeat it:** with `deploy.exclude: ["!.env"]`, `.env` is still
  excluded by `planDeployFiles` (the Critical finding — security guarantee holds)

**Layer-2 matcher tests** (`buildDeployMatcher` → assert `.ignores(path)`):
- defaults excluded (`node_modules/x`, `.git/HEAD`, `dist/a.js`, `vendor/x`)
- `deploy.exclude` additive (`web/`, `*.tmp`)
- `deploy.gitignore: true` applies `.gitignore` entries; `false`/absent does not
- nested-dir patterns and `*.log`-at-any-depth behave like gitignore
- ordered negation works at Layer 2 (`dist/` default + `!dist/keep.js` → keep.js in)
- a normal source file (`src/index.ts`) is NOT excluded

**Directory-pruning tests** (`isIgnoredDirectory`):
- `node_modules`, `node_modules/`, `web/` (with `exclude: [web/]`), and a nested
  ignored dir all return true (locks trailing-slash behavior)

**Walker tests** (`planDeployFiles` over a temp dir tree):
- returns expected surviving relative POSIX paths in `files`
- prunes an ignored directory — assert NO path under it is returned AND (via a
  large/decoy fixture) that descent did not happen
- `.env` at root absent from `files` even with no `deploy:` config
- empty directory present in tree → its (non-existent) entry is absent from `files`
  (documents the intentional empty-dir behavior change)
- a symlink (file and dir) → skipped, listed in `summary.symlinksSkipped`
- `summary` reports `gitignoreApplied` / `excludeRuleCount` correctly
- **Windows path handling:** a path constructed with `\\` separators is normalized
  to `/` before matching (guard the separator conversion)

Use a temp dir built in the test (see how other tests construct fixtures; reuse
`tests/helpers.ts` if it offers a temp-dir helper). Skip the symlink test on
platforms where symlink creation needs privileges (guard with a try/catch around
`fs.symlinkSync`).

## Cross-repo updates

This feature touches three repos. The CLI change is necessary but not sufficient —
the docs and AI-facing skills must teach the new `deploy:` block, and an example
should demonstrate it.

### This repo (`solidactions-cli`)

- `src/utils/env.ts` — extend `SolidActionsConfig` with `deploy?`.
- `src/utils/deploy-ignore.ts` — **new** module (matcher + walker).
- `src/commands/deploy.ts` — swap `archive.glob` for walk + per-file add; log summary.
- `package.json` — add `ignore` dependency.
- `tests/deploy-ignore.test.ts` — **new** tests.
- `README.md` — document the `deploy:` block under Configuration: the `deploy.exclude`
  list, `deploy.gitignore` opt-in, and the always-on `.env`/`.env.*` exclusion. Note
  that secrets belong in `solidactions env set`, never in the bundle.

### Examples repo (`SolidActions/solidactions-examples`) — separate repo, follow-up PR

The CLI fetches skills and AI-helper docs from this repo at `ai init` time
(`src/utils/skills.ts`), so these are the authoritative AI-facing docs.

- **Skill** `skills/solidactions-deploy-and-config.md` — add a section on the
  `deploy:` block: when to use `deploy.exclude`, the `deploy.gitignore` opt-in,
  and the always-on `.env` exclusion + why (secrets via `env set`, not the bundle).
  This is the single most important doc update — it is what AI agents read when
  helping users deploy.
- **Example** — extend an example project's `solidactions.yaml` (or add a small
  dedicated example) showing a realistic `deploy:` block, e.g. excluding a `web/`
  sub-app and opting into `.gitignore`.
- **AI-helper files** (`CLAUDE.md` / `AGENTS.md` in that repo) — only if they
  reference deploy bundling rules; otherwise the skill update is sufficient.

> These live in a different repo and cannot be committed from this worktree.
> Tracked as a follow-up: open a companion PR/issue on `solidactions-examples`
> once the CLI change lands (so the skill documents shipped behavior).

### App repo (`SolidActions/solidactions-app`) — e2e coverage

The exclusion is computed client-side, but the *contract* (a deployed bundle never
contains `.env`, honors `deploy.exclude`, and respects `.gitignore` when opted in)
should be verified end-to-end against the real deploy endpoint. Tracked as
[solidactions-app#297](https://github.com/SolidActions/solidactions-app/issues/297).

## Out of scope / follow-ups

- `--exclude` CLI flag (deferred).
- Server-side size guard / friendlier 413 message (separate concern).
- `solidactions-examples` skill + example PR (companion, after CLI lands).
- `solidactions-app` e2e test (tracked as a GH issue).

# Deploy: user-configurable ignore list

**Issue:** [#44](https://github.com/SolidActions/solidactions-cli/issues/44)
**Date:** 2026-06-08
**Status:** Approved (pending Codex review)

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

### Ignore set (union, all gitignore-syntax)

The final matcher is the union of, in this order (order is immaterial — it is a
union, not a precedence chain, and there are no negations in the defaults):

1. **Defaults (always):** `node_modules/`, `.git/`, `dist/`, `vendor/`,
   `.steps-deploy.tar.gz`, `.steps-deploy.zip`.
2. **`.env` safety (always):** `.env`, `.env.*`.
3. **`deploy.exclude:`** entries, if present.
4. **`.gitignore`** entries, only if `deploy.gitignore: true` and the file exists.

All four are gitignore-syntax patterns fed into a single matcher built with the
[`ignore`](https://www.npmjs.com/package/ignore) npm package, so `exclude:` and
`.gitignore` share identical semantics (anchoring, `*.log` matching at any depth,
negation with `!`).

> Note on negation: a user `!keep.env` in `deploy.exclude` *would* re-include a
> file that an earlier `.env.*` pattern excluded, because `ignore` applies
> patterns in order and later patterns win. The defaults and `.env` rules are
> added *first*, so a deliberate `!` override in `exclude`/`.gitignore` can
> re-include them. This is acceptable and matches gitignore mental model; it is
> an explicit opt-in, not an accident.

### Archiving change

Replace the single `archive.glob('**/*', { ignore })` call (deploy.ts ~line 438)
with an explicit walk + per-file add:

1. Build the matcher via `buildDeployMatcher(sourceDir, yamlConfig)`.
2. Walk `sourceDir` with `collectDeployFiles(sourceDir, matcher)`, pruning any
   directory the matcher ignores (so we never descend into a 400 MB `.venv`).
3. Add each surviving file via
   `archive.file(absPath, { name: 'tenantcode/' + relPosixPath })`.

The Dockerfile-append (`archive.append(universalDockerfile, { name: 'Dockerfile' })`)
and `archive.finalize()` stay exactly as today. The `tenantcode/` prefix is
preserved.

### New module: `src/utils/deploy-ignore.ts`

Pure, no archiver/network deps, unit-testable in isolation.

```ts
import ignore, { Ignore } from 'ignore';

// Always-excluded patterns (gitignore syntax).
export const DEFAULT_DEPLOY_IGNORES: string[];   // node_modules/, .git/, dist/, vendor/, deploy artifacts
export const ENV_DEPLOY_IGNORES: string[];       // .env, .env.*

/** Build the ignore matcher from defaults + .env + yaml exclude + optional .gitignore. */
export function buildDeployMatcher(sourceDir: string, config: SolidActionsConfig | null): {
    matcher: Ignore;
    summary: { gitignoreApplied: boolean; excludeRuleCount: number };
};

/**
 * Walk sourceDir, returning relative POSIX paths of files to include.
 * Prunes ignored directories so we never read into them.
 */
export function collectDeployFiles(sourceDir: string, matcher: Ignore): string[];
```

Key details:
- Paths tested against `matcher` are **relative, POSIX-separated** (`ignore`
  requires forward slashes). Convert on Windows.
- Directories are tested with a trailing-context check so `node_modules/`
  (dir pattern) prunes the directory before descent.
- Symlinks: do not follow directory symlinks (avoid cycles / escaping the tree);
  include symlinked files as-is (matches current archiver glob behavior closely
  enough — confirm during review).
- Never include the live archive file itself (`.steps-deploy.tar.gz`) — already
  covered by defaults, but the walk runs before the archive is written so it is
  not present yet anyway.

### Logging

After building the matcher and collecting files, print one summary line so
silent truncation never reads as "shipped everything", e.g.:

```
Bundling 312 files (.env excluded; .gitignore applied; 2 exclude rules)
```

Compose the parenthetical from `summary`: always mention `.env excluded`;
add `.gitignore applied` when `gitignoreApplied`; add `N exclude rule(s)` when
`excludeRuleCount > 0`.

### Dependency

Add `ignore` to `dependencies` in `package.json` (tiny, zero-dep, the standard
gitignore parser). No `@types` needed — `ignore` ships its own types.

## Testing

`tests/deploy-ignore.test.ts` (vitest, mirrors existing pure-function test style):

**Matcher unit tests** (`buildDeployMatcher` → assert `.ignores(path)`):
- defaults always excluded (`node_modules/x`, `.git/HEAD`, `dist/a.js`, `vendor/x`)
- `.env` and `.env.local` excluded with no config
- `.env` excluded even when `deploy:` block present but empty
- `deploy.exclude` additive (`web/`, `*.tmp`)
- `deploy.gitignore: true` applies `.gitignore` entries; `false`/absent does not
- nested-dir patterns and `*.log`-at-any-depth behave like gitignore
- a non-`.env` file (`src/index.ts`) is NOT excluded

**Walker tests** (`collectDeployFiles` over a temp dir tree):
- returns expected surviving relative POSIX paths
- prunes an ignored directory (assert no path under it is returned)
- handles dotfiles (`.solidactions/` etc. per matcher)

Use a temp dir built in the test (see how other tests construct fixtures; reuse
`tests/helpers.ts` if it offers a temp-dir helper).

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

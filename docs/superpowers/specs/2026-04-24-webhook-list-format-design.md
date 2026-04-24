# `webhook list` — fix column collision, add `--format json`

**Bead:** sol-184 · **Issue:** SolidActions/solidactions-cli#19
**Date:** 2026-04-24

## Context

`solidactions webhook list <project> -e <env> --show-secrets` currently renders a table where the `URL` column and the `SECRET` column concatenate with no separator. The `SECRET` column appears empty and the `URL` column contains the URL + the 64-hex `X-API-Key` glued together.

Root cause: in `src/commands/webhook-list.ts`, rows are formatted with `url.padEnd(60)`. `padEnd` only pads *up to* the target width and never truncates. Real webhook URLs are ~73 characters (41-char prefix + 32-hex token), so no padding is inserted, and the secret is appended directly against the URL.

The same structural bug exists for the workflow-name column (`name.padEnd(30)`) — a 31+ char workflow name would collide with the URL column — but this has not been reported in practice.

Impact: scripts that grep CLI output for webhook URLs emit a broken 96-hex URL that always fails auth. Fix requires a readable table *and* a machine-parseable output mode so automation doesn't depend on table spacing.

## Goals

1. Fix the URL/SECRET column collision for `--show-secrets`.
2. Fix the latent workflow-name collision in the same change.
3. Add `--format json` for machine-parseable output.
4. Keep error handling and exit codes unchanged.

## Non-goals

- Adding a test framework. (Recommended as a follow-up; see end of doc.)
- Pagination, filtering, or any other feature-level change.
- Changing the API contract on the server side.

## Design

### Files changed

- **New:** `src/utils/webhook-formatters.ts` — pure formatting functions.
- **Modified:** `src/commands/webhook-list.ts` — I/O layer dispatches to a formatter based on `options.format`.
- **Modified:** `src/index.ts` — registers the `--format` option on `webhook list`.

Rationale for the split: `webhook-list.ts` currently imports `axios` and `chalk` at module top. Keeping pure formatters in `src/utils/` lets future tests import them without pulling axios into the test module graph, consistent with the existing `src/utils/api.ts` pattern.

### Formatter API

Both functions are pure: no I/O, no `console.log`, no `process.exit`.

```ts
// src/utils/webhook-formatters.ts
export interface WebhookRow {
  workflow_name?: string;
  workflow_slug?: string;
  webhook_path_url?: string;
  webhook_url?: string;
  webhook_secret?: string;
}

export interface FormatOptions {
  showSecrets: boolean;
}

export function formatTable(webhooks: WebhookRow[], opts: FormatOptions): string[];
export function formatJson(webhooks: WebhookRow[], opts: FormatOptions): string;
```

`formatTable` returns an array of styled lines (header, divider, rows). The caller prints them with `console.log`. Chalk is applied inline.

`formatJson` returns a single JSON string (two-space indentation). No chalk. Caller prints it raw to stdout.

### Column-width helper

```ts
function columnWidth(min: number, values: string[]): number {
  return Math.max(min, ...values.map(v => v.length)) + 2;
}
```

- `min` preserves today's visual layout when data is short (name=30, url=60).
- `+ 2` guarantees at least two spaces between columns regardless of content length.
- Applied uniformly to all columns — fixes both the reported URL-column bug and the latent workflow-name bug with one helper.
- Edge: empty-list case never enters the row-rendering path, so no `Math.max(min)` concerns.

### Table output

Behavior (with `--show-secrets`):

```
WORKFLOW                      URL                                                             SECRET
---------------------------------------------------------------------------------------------------------------
Gmail Search (...)            https://app.solidactions.com/api/webhook/cc384...  <64-hex secret>
```

- Column widths computed once from data + minimums.
- Divider width = sum of column widths.
- Without `--show-secrets`: name + url columns only, as today.

### JSON output

Shape: **bare array**, curated field names.

```json
[
  {
    "workflow": "Gmail Search (...)",
    "url": "https://app.solidactions.com/api/webhook/cc384...",
    "secret": "<64-hex secret>"
  }
]
```

- `workflow` ← `workflow_name ?? workflow_slug ?? null` (null, not `"?"`, since JSON consumers should not see UI sentinels).
- `url` ← `webhook_path_url ?? webhook_url ?? null`.
- `secret` field is **omitted entirely** when `!showSecrets`. Rationale: `"secret" in obj` becomes a truthy signal; users opting out of secrets shouldn't see a `null` field.
- Empty list → `[]`.
- No banner, no trailer, no "No webhooks found" yellow line in JSON mode — stdout must be valid parseable JSON.

### CLI option

In `src/index.ts`, extend the `webhook list` command:

```ts
webhook
    .command('list')
    .description('List webhook URLs for a project')
    .argument('<project>', 'Project name')
    .option('-e, --env <environment>', 'Environment (production/staging/dev)')
    .option('--show-secrets', 'Show webhook secrets')
    .option('--format <format>', 'Output format: table or json', 'table')
    .action((projectName, options) => {
        webhookList(projectName, options);
    });
```

Validation via an explicit check in `webhookList`. Commander can enforce choices natively, but in-code validation keeps all format logic in one place and produces a clearer error message:

```ts
if (options.format !== 'table' && options.format !== 'json') {
  console.error(chalk.red(`Invalid --format: ${options.format}. Expected 'table' or 'json'.`));
  process.exit(1);
}
```

### I/O layer dispatch

`webhookList` pseudocode:

```ts
validateFormat(options.format);
const format = options.format ?? 'table';

if (format === 'table') {
  // banner + blank + formatted lines + blank + trailer
  printBanner(projectName, environment);
  for (const line of formatTable(webhooks, { showSecrets })) console.log(line);
  printTrailer(webhooks.length);
} else {
  console.log(formatJson(webhooks, { showSecrets }));
}
```

### Error handling

Unchanged. All API errors go to stderr with chalk-colored messages; `process.exit(1)`. Format is irrelevant to the error path — scripts handle this via `cmd 2>/dev/null | jq ...` and the exit code.

## Behavior matrix

| `--format` | `--show-secrets` | empty list | output                                         |
|------------|------------------|------------|------------------------------------------------|
| table      | no               | no         | banner + 2-col table (name, url) + trailer     |
| table      | no               | yes        | banner + yellow "No webhooks found"            |
| table      | yes              | no         | banner + 3-col table (name, url, secret) + trailer |
| table      | yes              | yes        | banner + yellow "No webhooks found"            |
| json       | no               | no         | bare JSON array `[{workflow, url}]`            |
| json       | no               | yes        | `[]`                                           |
| json       | yes              | no         | bare JSON array `[{workflow, url, secret}]`    |
| json       | yes              | yes        | `[]`                                           |
| any        | any              | API error  | stderr chalk message, exit 1 (unchanged)       |
| invalid    | any              | any        | stderr "Invalid --format" message, exit 1      |

## Verification

### Pre-push (unit-level)

1. `npm run build` exits cleanly.
2. Throwaway `verify-formatters.ts` (NOT committed) that imports both formatters, feeds them sample data including:
   - A webhook with a 73-char URL (the regression)
   - A webhook with a 15-char URL (short-URL baseline)
   - Two webhooks with varying URL lengths (alignment check)
   - Empty list
   - `showSecrets: true` and `showSecrets: false`
   Asserts expected substrings (e.g., for table mode with secrets, that `'  '` appears between URL tail and secret start on every row; for JSON mode, that `JSON.parse` succeeds and `secret` is absent when `showSecrets: false`). Run via `npx tsx verify-formatters.ts`; delete after running.

### Post-CI-green (staging e2e against `e2e.formup.cc`)

Required before marking the bead DEV-DONE. This is the explicit regression check — the bug was user-reported against a real webhook, and we need a real webhook in the fix verification.

1. Build and link the local CLI build so the `solidactions` binary on `$PATH` is this branch:
   - From the worktree: `npm run build && npm link` (or run the dist directly: `node dist/index.js ...`).
2. Mint a staging token without polluting global config:
   - From `solidactions-app`: `./scripts/e2e-init-cli`. The script runs `solidactions init --local`, writing credentials to a local `.solidactions/config.json` in the cwd — not `~/.solidactions/config.json`.
3. From the same cwd (so the `--local` config is picked up), run against a staging project with at least one configured webhook:
   - `solidactions webhook list <project> -e <env>` — confirm the table renders correctly (no regression in non-secret mode).
   - `solidactions webhook list <project> -e <env> --show-secrets` — confirm URL and SECRET columns are visually separated by ≥2 spaces, URL is 32-hex-token-terminated, SECRET is a distinct 64-hex string.
   - `solidactions webhook list <project> -e <env> --show-secrets --format json | jq '.[0] | {url, secret}'` — confirm `jq` parses successfully and both fields are present and have the expected lengths (url ends with 32-hex token, secret is 64 hex chars).
   - `solidactions webhook list <project> -e <env> --format json | jq 'type'` — confirm `"array"`.
4. If possible, also test the empty-list path: `solidactions webhook list <project-with-no-webhooks> -e <env> --format json` → expect `[]`.
5. Capture the three invocation outputs (or a redacted transcript) and paste them into the PR description as evidence.

Reference: `solidactions-app/CLAUDE.md` → "Staging e2e (`e2e.formup.cc`)" section.

## Follow-up recommendations (not in this PR)

- Add `vitest` as devDep and real unit tests for `webhook-formatters.ts`. The bug existed because nothing tested the output; formatters are trivially testable now that they're pure. Introducing a test framework is a separable decision from this bug fix.
- Add a PR-check CI workflow (build + tests) once a framework is in place. The current `.github/workflows/publish.yml` only runs on release, so no enforcement happens on pull requests.

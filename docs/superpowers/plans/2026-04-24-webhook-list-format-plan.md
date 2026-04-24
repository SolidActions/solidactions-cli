# `webhook list` — Fix Column Collision & Add JSON Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the URL/SECRET column collision in `solidactions webhook list --show-secrets` and add a `--format json` output mode so scripts can parse webhook data reliably.

**Architecture:** Extract output rendering into pure functions in a new `src/utils/webhook-formatters.ts` module (two formatters: `formatTable` for humans, `formatJson` for machines). `src/commands/webhook-list.ts` becomes a thin I/O wrapper that fetches webhooks and dispatches to the formatter chosen by `options.format`. `src/index.ts` exposes the new `--format` CLI option. Pure formatters are trivially verifiable with a throwaway script today and fully testable by a framework in a follow-up PR.

**Tech Stack:** TypeScript, `commander` for CLI, `chalk` for TTY styling, `axios` for the API call, `npx tsx` for the throwaway verify script.

**Spec:** [`../specs/2026-04-24-webhook-list-format-design.md`](../specs/2026-04-24-webhook-list-format-design.md)

**Bead:** sol-184 · **Issue:** [SolidActions/solidactions-cli#19](https://github.com/SolidActions/solidactions-cli/issues/19)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/utils/webhook-formatters.ts` | Create | Pure `formatTable` + `formatJson` + `columnWidth` helper + exported types. No I/O, no `console.log`, no `process.exit`. |
| `src/commands/webhook-list.ts` | Modify | Still fetches from the API and handles errors. Replaces the inline `padEnd` block with a dispatch to the formatter chosen by `options.format`. Banner + trailer only printed in `table` mode. Validates `options.format`. |
| `src/index.ts` | Modify | Adds `.option('--format <format>', …, 'table')` to the `webhook list` command. Shape only — no behavior change in this file. |
| `verify-formatters.ts` | Create & delete | Throwaway sanity script at the worktree root. Exercises both formatters with sample rows, prints PASS/FAIL assertions. Never committed; removed at end of Task 7. |

---

## Task 1: Scaffold `webhook-formatters.ts` with types and throwing stubs

**Files:**
- Create: `src/utils/webhook-formatters.ts`

- [ ] **Step 1: Create the file with types and stubs**

```typescript
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

export function formatTable(_webhooks: WebhookRow[], _opts: FormatOptions): string[] {
    throw new Error('formatTable: not implemented');
}

export function formatJson(_webhooks: WebhookRow[], _opts: FormatOptions): string {
    throw new Error('formatJson: not implemented');
}
```

- [ ] **Step 2: Type-check the stub**

Run: `npm run build`
Expected: PASS (tsc exits 0). No callers yet, so unused params are fine because they're underscore-prefixed.

- [ ] **Step 3: Commit the scaffold**

```bash
git add src/utils/webhook-formatters.ts
git commit -m "refactor: scaffold webhook formatters module (stubs)"
```

---

## Task 2: Write the throwaway verify script and watch it fail

**Files:**
- Create: `verify-formatters.ts` (worktree root; NOT to be committed)

- [ ] **Step 1: Write the verify script**

```typescript
// verify-formatters.ts — throwaway. Delete in Task 7. NEVER git-add.
import { formatTable, formatJson, type WebhookRow } from './src/utils/webhook-formatters';

const ROW_LONG: WebhookRow = {
    workflow_name: 'Gmail Search (digest)',
    webhook_path_url: 'https://app.solidactions.com/api/webhook/cc384194e15515ccc04a449b70f7e652',
    webhook_secret: 'a'.repeat(64),
};

const ROW_SHORT: WebhookRow = {
    workflow_name: 'Short',
    webhook_path_url: 'https://x.test/w/abc',
    webhook_secret: 'b'.repeat(64),
};

const ROWS_MIXED: WebhookRow[] = [ROW_LONG, ROW_SHORT];

let failures = 0;
function assert(cond: boolean, label: string) {
    if (cond) {
        console.log(`PASS ${label}`);
    } else {
        console.log(`FAIL ${label}`);
        failures++;
    }
}

// ---- formatTable ----
{
    const lines = formatTable(ROWS_MIXED, { showSecrets: true });
    // lines: [header, divider, row1, row2]
    assert(lines.length === 4, 'table: 4 lines for 2 rows + header + divider');
    const row1 = stripAnsi(lines[2]);
    const row2 = stripAnsi(lines[3]);
    // The regression: URL + secret were glued together. Guarantee ≥2 spaces between them.
    assert(row1.includes('cc384194e15515ccc04a449b70f7e652  '), 'table: row1 URL token ends then ≥2 spaces');
    assert(row2.includes('https://x.test/w/abc  '), 'table: row2 short URL then ≥2 spaces');
    // Header/divider alignment sanity
    assert(stripAnsi(lines[0]).startsWith('WORKFLOW'), 'table: header starts with WORKFLOW');
    assert(stripAnsi(lines[1]).startsWith('---'), 'table: second line is divider');
}

// formatTable without --show-secrets should have 2 cols
{
    const lines = formatTable([ROW_LONG], { showSecrets: false });
    assert(lines.length === 3, 'table no-secrets: header + divider + 1 row');
    assert(!stripAnsi(lines[2]).includes('a'.repeat(64)), 'table no-secrets: secret absent from row');
}

// formatTable empty list — caller handles this before entering formatter; formatter should still
// return a valid (header + divider only) output without crashing.
{
    const lines = formatTable([], { showSecrets: false });
    assert(Array.isArray(lines), 'table empty: returns array');
}

// ---- formatJson ----
{
    const s = formatJson(ROWS_MIXED, { showSecrets: true });
    const parsed = JSON.parse(s);
    assert(Array.isArray(parsed), 'json: top-level is array');
    assert(parsed.length === 2, 'json: 2 rows');
    assert(parsed[0].workflow === 'Gmail Search (digest)', 'json: workflow name mapped');
    assert(parsed[0].url.endsWith('cc384194e15515ccc04a449b70f7e652'), 'json: url ends at 32-hex token');
    assert(parsed[0].secret === 'a'.repeat(64), 'json: secret present when showSecrets');
}

{
    const s = formatJson([ROW_LONG], { showSecrets: false });
    const parsed = JSON.parse(s);
    assert(!('secret' in parsed[0]), 'json no-secrets: secret key omitted');
}

{
    const s = formatJson([], { showSecrets: false });
    assert(s.trim() === '[]', 'json empty: produces bare []');
}

if (failures > 0) {
    console.log(`\n${failures} assertion(s) failed`);
    process.exit(1);
}
console.log('\nall assertions passed');

function stripAnsi(s: string): string {
    // Minimal ANSI CSI stripper — chalk uses SGR sequences.
    return s.replace(/\x1b\[[0-9;]*m/g, '');
}
```

- [ ] **Step 2: Run it — expect red**

Run: `npx tsx verify-formatters.ts`
Expected: FAIL — first assertion errors with `Error: formatTable: not implemented`. We watch the failure to confirm the script is wired to the real module, not a shadow.

- [ ] **Step 3: Do NOT commit**

The script is a throwaway. Skip `git add` — we only add listed files by name in every commit, and the final Task 7 removes this file. Confirm with: `git status` — `verify-formatters.ts` should be under "Untracked".

---

## Task 3: Implement `formatTable` (and `columnWidth` helper)

**Files:**
- Modify: `src/utils/webhook-formatters.ts`

- [ ] **Step 1: Replace the table stub**

Replace the `formatTable` stub and add the private `columnWidth` helper. Keep the `import chalk from 'chalk'` at the top — the module now needs it.

```typescript
import chalk from 'chalk';

function columnWidth(min: number, values: string[]): number {
    return Math.max(min, ...values.map(v => v.length)) + 2;
}

export function formatTable(webhooks: WebhookRow[], opts: FormatOptions): string[] {
    const names = webhooks.map(w => w.workflow_name || w.workflow_slug || '?');
    const urls = webhooks.map(w => w.webhook_path_url || w.webhook_url || '?');

    const nameWidth = columnWidth(30, names);
    const urlWidth = columnWidth(60, urls);

    const headerPlain = opts.showSecrets
        ? 'WORKFLOW'.padEnd(nameWidth) + 'URL'.padEnd(urlWidth) + 'SECRET'
        : 'WORKFLOW'.padEnd(nameWidth) + 'URL';

    const dividerWidth = opts.showSecrets ? nameWidth + urlWidth + 64 : nameWidth + urlWidth;

    const lines: string[] = [];
    lines.push(chalk.gray(headerPlain));
    lines.push(chalk.gray('-'.repeat(dividerWidth)));

    for (let i = 0; i < webhooks.length; i++) {
        const name = names[i];
        const url = urls[i];
        let line = name.padEnd(nameWidth) + chalk.cyan(url.padEnd(urlWidth));
        if (opts.showSecrets) {
            const secret = webhooks[i].webhook_secret || '-';
            line += chalk.gray(secret);
        }
        lines.push(line);
    }

    return lines;
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: PASS (tsc exits 0).

- [ ] **Step 3: Re-run verify script**

Run: `npx tsx verify-formatters.ts`
Expected: All `table:*` assertions PASS. JSON assertions still FAIL with `Error: formatJson: not implemented`.

- [ ] **Step 4: Commit**

```bash
git add src/utils/webhook-formatters.ts
git commit -m "feat(webhook-list): add formatTable with dynamic column widths"
```

---

## Task 4: Implement `formatJson`

**Files:**
- Modify: `src/utils/webhook-formatters.ts`

- [ ] **Step 1: Replace the JSON stub**

```typescript
export function formatJson(webhooks: WebhookRow[], opts: FormatOptions): string {
    const rows = webhooks.map(w => {
        const base: { workflow: string | null; url: string | null; secret?: string } = {
            workflow: w.workflow_name ?? w.workflow_slug ?? null,
            url: w.webhook_path_url ?? w.webhook_url ?? null,
        };
        if (opts.showSecrets) {
            base.secret = w.webhook_secret ?? '';
        }
        return base;
    });
    return JSON.stringify(rows, null, 2);
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Re-run verify script — expect all green**

Run: `npx tsx verify-formatters.ts`
Expected: `all assertions passed` printed at the end. Exit code 0.

- [ ] **Step 4: Commit**

```bash
git add src/utils/webhook-formatters.ts
git commit -m "feat(webhook-list): add formatJson for machine-parseable output"
```

---

## Task 5: Wire `webhook-list.ts` to dispatch by format

**Files:**
- Modify: `src/commands/webhook-list.ts`

- [ ] **Step 1: Replace the whole command body**

The command keeps config resolution, the API call, and all error handling. The rendering block is replaced with a format-aware dispatch.

```typescript
import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { formatTable, formatJson, type WebhookRow } from '../utils/webhook-formatters';

interface WebhookListOptions {
    env?: string;
    showSecrets?: boolean;
    format?: string;
}

export async function webhookList(projectName: string, options: WebhookListOptions = {}) {
    const format = options.format ?? 'table';
    if (format !== 'table' && format !== 'json') {
        console.error(chalk.red(`Invalid --format: ${options.format}. Expected 'table' or 'json'.`));
        process.exit(1);
    }

    const config = await requireConfigWithWorkspace();

    const environment = options.env || 'dev';
    const projectSlug = environment === 'production' ? projectName : `${projectName}-${environment}`;

    if (format === 'table') {
        console.log(chalk.blue(`Webhooks for project "${projectName}"${environment !== 'production' ? ` (${environment})` : ''}:`));
    }

    try {
        const params: Record<string, any> = {};
        if (options.showSecrets) {
            params.show_secrets = 'true';
        }

        const response = await axios.get(`${config.host}/api/v1/projects/${projectSlug}/webhooks`, {
            headers: getApiHeaders(config),
            params,
        });

        const webhooks: WebhookRow[] = response.data.data || [];
        const showSecrets = options.showSecrets === true;

        if (format === 'json') {
            console.log(formatJson(webhooks, { showSecrets }));
            return;
        }

        // table mode
        if (webhooks.length === 0) {
            console.log(chalk.yellow('No webhooks found for project "' + projectName + '".'));
            return;
        }

        console.log('');
        for (const line of formatTable(webhooks, { showSecrets })) {
            console.log(line);
        }
        console.log('');
        console.log(chalk.gray(`${webhooks.length} webhook(s)`));
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions login <api-key>" to re-configure.'));
            } else if (error.response.status === 404) {
                console.error(chalk.red(`Project "${projectName}" not found.`));
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Re-run verify script — sanity**

Run: `npx tsx verify-formatters.ts`
Expected: `all assertions passed`. (The formatters module wasn't touched; this confirms no regressions.)

- [ ] **Step 4: Commit**

```bash
git add src/commands/webhook-list.ts
git commit -m "refactor(webhook-list): dispatch to format-specific renderer"
```

---

## Task 6: Register `--format` on the CLI

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Edit the `webhook list` command definition**

Find the existing block (near line 322):

```typescript
webhook
    .command('list')
    .description('List webhook URLs for a project')
    .argument('<project>', 'Project name')
    .option('-e, --env <environment>', 'Environment (production/staging/dev)')
    .option('--show-secrets', 'Show webhook secrets')
    .action((projectName, options) => {
        webhookList(projectName, options);
    });
```

Replace with:

```typescript
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

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS. `dist/index.js` now exposes the `--format` flag.

- [ ] **Step 3: Local smoke — help text**

Run: `node dist/index.js webhook list --help`
Expected output contains:
```
--format <format>  Output format: table or json (default: "table")
```

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(webhook-list): add --format json|table option"
```

---

## Task 7: Final build + cleanup of throwaway artifact

**Files:**
- Delete: `verify-formatters.ts` (never committed; nothing to remove from git history)

- [ ] **Step 1: Final clean build**

Run: `npm run build`
Expected: PASS (no tsc warnings, `dist/` regenerated).

- [ ] **Step 2: Delete the verify script**

Run: `rm verify-formatters.ts`

- [ ] **Step 3: Confirm clean working tree**

Run: `git status`
Expected output:
```
On branch issue/19
nothing to commit, working tree clean
```

If anything unexpected appears, investigate before pushing. **No commit** is needed here — the verify script was never tracked.

---

## Task 8: Push, open PR, watch CI — see Dev lifecycle step 8–9

> This task is orchestrated by the Dev lifecycle, not by the executing-plans session. The executing agent should stop after Task 7, report "plan complete", and hand control back to the Dev main thread to run lifecycle steps 8 (push + `gh pr create --fill`) and 9 (`gh pr checks --watch`). If CI is red, fixes re-enter this plan's edit cycle.

---

## Task 9: Staging e2e verification against `e2e.formup.cc` (after CI green, before DEV-DONE)

> Required by the spec's "Post-CI-green" section. Runs in the Dev main thread after CI is green, before mailing `DEV-DONE` to mayor.

- [ ] **Step 1: Build and link the local CLI**

From the worktree root (`/home/mercer/gc/soliddev/rigs/solid/.worktrees/sol-184-cli`):

```bash
npm run build
npm link
which solidactions  # confirm it resolves to the linked binary
solidactions --version  # confirm 1.7.1 (or whatever this branch ships)
```

- [ ] **Step 2: Mint a staging token without polluting global config**

```bash
cd /home/mercer/gc/soliddev/rigs/solid/solidactions-app
./scripts/e2e-init-cli
```

The script runs `solidactions init --local`, writing credentials to `./.solidactions/config.json`. Stay in that directory for the next steps so the local config is picked up.

- [ ] **Step 3: Verify the four output modes**

Pick a staging project that has at least one configured webhook. Replace `<project>` and `<env>` in the commands below.

```bash
# a) Non-secret table — regression check on existing behavior
solidactions webhook list <project> -e <env>

# b) Secret table — the original bug
solidactions webhook list <project> -e <env> --show-secrets

# c) JSON with secrets — machine-parseable
solidactions webhook list <project> -e <env> --show-secrets --format json | jq '.[0] | {url, secret}'

# d) JSON bare — shape check
solidactions webhook list <project> -e <env> --format json | jq 'type'
```

Expected:
- (a) Table renders as today; no regression.
- (b) `WORKFLOW | URL | SECRET` with ≥2 spaces between URL and SECRET; URL ends at the 32-hex token; SECRET is a distinct 64-hex string.
- (c) `jq` succeeds; `.url` ends with a 32-hex token; `.secret` is 64 hex chars.
- (d) Prints `"array"`.

- [ ] **Step 4: Empty-list check (if reachable)**

```bash
solidactions webhook list <project-with-no-webhooks> -e <env> --format json
```

Expected: `[]` (exactly — no banner, no trailer).

- [ ] **Step 5: Unlink the CLI**

```bash
cd /home/mercer/gc/soliddev/rigs/solid/.worktrees/sol-184-cli
npm unlink -g @solidactions/cli
```

- [ ] **Step 6: Paste redacted outputs into the PR description**

`gh pr edit <pr-url> --body` or edit via web UI — add a "Staging e2e evidence" section with the four outputs (redact workflow names / tokens to your taste). These are the explicit regression evidence the spec requires.

---

## Self-Review Checklist (run before claiming plan complete)

- [x] Every spec goal (fix URL/secret collision; fix latent workflow-name collision; add `--format json`; error handling unchanged) is covered by a task.
- [x] No `TBD`, `similar to task N`, "add validation", "write tests for the above" — all code is inline.
- [x] Types (`WebhookRow`, `FormatOptions`) and method signatures (`formatTable`, `formatJson`, `columnWidth`) match across tasks.
- [x] `verify-formatters.ts` is explicitly never committed; Task 7 deletes it without needing a commit.
- [x] Staging e2e is scheduled after CI green and before `DEV-DONE`, matching the spec.

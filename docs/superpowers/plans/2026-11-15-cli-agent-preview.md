# CLI agent preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sa-subagent-driven-development to implement this plan task-by-task (the wave's build step). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `solidactions app preview <app> [--page <id>]` asks the server for a one-time link to an app's dev copy and prints it, and the command's own help tells an agent to use it before calling an app change done.

**Architecture:** A new `app` command group with one leaf, `app preview`, in `src/commands/app-preview.ts`. It calls the MCP tool `projects_sandbox` (action `preview_link`) on the unified `/mcp` endpoint through the existing `postMcpTool` path, via one new thin exported wrapper in `src/utils/mcp.ts`. It prints the link, the server's note and, when it applies, the production-data warning, and turns every refusal into a plain stderr message and exit 1. The command is classified mutating (it mints a session row). The README documents it.

**Tech Stack:** TypeScript, commander 11, chalk 4, vitest (tests spawn the built `dist/index.js` against an in-process HTTP server, no mock libraries).

**Spec:** `/home/mercer/crewops2/workspaces/solidactions/desk/proposals/2026-11-14-agent-preview-link.md` (W2 = section 7, the CLI line of section 4.1). No separate spec file: the wave is small and the proposal is the design. The server half is live (app v0.295.0, app PR #2756, `git log` on app main: `a3be6b83b wave agent-preview-link: agent preview link for apps, server (#2748) (#2756)`).

**Issues:** `cli#247`, sanctioned by Peter's approval ask `task-startwave2-b4f7` ("Go, size small", recorded on the issue: https://github.com/SolidActions/solidactions-cli/issues/247#issuecomment-6895212563).

## Global Constraints

- Binding ruling, verbatim from cli#247 (body, no later comment amends it): "New command `solidactions app preview <app> [--page <id>]`: calls the MCP action through the existing `postMcpTool` path (`src/utils/mcp.ts:70`) with the API key and prints the link on its own line (same style as `device-login.ts:155-160`). The CLI does not open a browser. Refusals (`no_dev_copy`, `project_not_found`, `page_not_found`, previews switched off) print a plain message and exit non-zero."
- Binding ruling, verbatim from cli#247: "Agent words: the ai-init / skill text tells agents to ask for a preview link and try the app in their own browser before calling an app change done (the link works once, within 60 seconds; the session ends after 3 minutes idle or 10 minutes)."
- Binding ruling, verbatim from Peter on cli#247 (2026-11-15, ask task-startwave2-b4f7): "Go, size small".
- Server contract (read from app main `a3be6b83b`, not from the proposal): `app/Domains/Projects/Mcp/Tools/ProjectsSandbox.php` lines 48-52 declare `preview_link` with params `project` (string, required: "An app name or the slug of any of its environment rows."), `page` (integer, "A page (doc id) to open first.") and `revoke` (boolean). Success is `Response::json` of `PreviewLinkService::mint`, which returns `link`, `expires_at`, `session_minutes`, `environment` (`dev`), `shares_production_data` (bool), `databases` (list of names) and `note` (a ready sentence, `PreviewLinkService.php` lines 82-89 and 96-103). An error is `Response::error(json {"error":{"code","message", ...meta}})` (`ProjectsSandbox.php` `error()`), so a refusal reaches the CLI as `result.data = {error:{code,message,...}}`. Codes: `previews_disabled`, `user_required`, `project_not_found`, `no_dev_copy`, `forbidden`, `page_not_found`, `rate_limited` (meta `retry_after`, seconds), and `invalid_action` for an unknown action. Server messages: `Agent previews are disabled (workspace setting agent_previews_enabled is off).`, `The app could not be found.` (the tool appends the visible app names), `This app has no dev copy to preview.`, `That page is not part of the app.`, `Too many preview links minted.`, `This action is unauthorized.`.
- Existing code this plan reuses (quoted from this branch):
  - `src/utils/mcp.ts:70` `async function postMcpTool(config: Config, endpointPath: string, toolName: string, args: Record<string, unknown>): Promise<McpRawResult>` (handles 401 with the host line and exit 1, 429 with retries, and throws `McpRpcError` or `Error` on other failures).
  - `src/utils/mcp.ts:159` `async function callMcpTool(config: Config, endpointPath: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult>` (not exported) and `src/utils/mcp.ts:176` `const UNIFIED_MCP_PATH = '/mcp';`; `McpToolResult` is `{ ok: boolean; data: any }`.
  - `src/commands/device-login.ts:160` `console.log('  ' + chalk.blue.underline(code.verification_uri));` (the link style: two-space indent, blue underline; chalk drops colour when stdout is not a TTY).
  - `src/utils/output.ts` `out(text, style?)` and `err(text, style?)` strip control bytes with `plainText` before printing (`src/utils/connect-link.ts:40`). `shellArg(value)` is at `src/utils/connect-link.ts:52`.
  - `src/utils/api.ts:656` `export async function requireConfigWithWorkspace(): Promise<Config>`; for a mutating command it prints one gray `Workspace: <id> (<name>) on <host>` line on stderr first (see `tests/connection-connect.test.ts` `splitWorkspaceLine`).
  - `src/utils/mutating-commands.ts:99` `'connection connect',` (the last entry of `MUTATING_COMMANDS`, with a comment above it); `tests/mutating-commands.test.ts` fails CI when a leaf command is in neither set.
- Naming and copy rules: noun-then-verb, singular noun (`docs/decisions/0001-cli-command-taxonomy.md` decisions 1 and 2); `app` is the noun the issue and the proposal name, so no decision file changes. Errors go to stderr through `err(..., chalk.red)`, successes to stdout through `out(...)`, so the same control-byte guard covers both.
- No browser is opened, no `open` dependency is added, and `package.json` is not touched (the version bump and release are the PM's).
- Out of scope (trimmed to the ask, do not add): `--json`, `--revoke` (the server supports it; the issue does not ask for it), a `--open` flag, an alias for `project`, a hint printed by `project deploy`.
- Premise check, no other open CLI PR touches these paths: `gh pr list --repo SolidActions/solidactions-cli --state open --json number,files` printed nothing at plan time (2026-11-15), so there is no merge-order question.
- Test grep for the changed symbols (plan time): `grep -rlE "mutating-commands|MUTATING_COMMANDS|isMutatingCommand" tests` lists `tests/mutating-commands.test.ts`, `tests/workspace-guard-write-exact.test.ts`, `tests/database-command-contract.test.ts`, `tests/workflow-view.test.ts`; the completeness test in the first is the only one that enumerates every leaf, and the manifest test `tests/command-manifest-artifact.test.ts` compares `dist/command-manifest.json` to a fresh walk (both are regenerated by `npm run build` in CI, so a new command needs no pinned file). No test or fake mentions `callCrewsTool`'s pass-through for `projects_sandbox`.
- No tests run on this box (Speed rules). Static checks that remain: `npx tsc --noEmit -p tsconfig.json`. Do not run `npm run build` in a task (two cards share `dist/`); the manager builds once before the live smoke.

Secret-bearing host paths this plan's code reads: none (the command reads the CLI config the existing commands read, `~/.solidactions/config.json`, through `requireConfigWithWorkspace`).

Verify data: the live smoke runs the CLI built from the branch against a free app slot's dev stack (`sa-dev-<slot>`) whose detached head contains app PR #2756 (`git merge-base --is-ancestor a3be6b83b HEAD` there). It needs a login to that stack, an app with a dev copy (`solidactions project deploy <app> . -e dev` creates one) and a second app name with no dev copy (for `no_dev_copy`; `solidactions project create <name> -e production`). The commands and expected lines are in the Verify section at the end. The cleanroom is a context-free agent driving the CLI cold against the same stack.

## Review Focus

Most likely first. Each line names the owning task and test.

1. An app name the server does not know: the user must see the server's message, which lists the app names they can use, and no link (Task 1 test `project_not_found`).
2. A refusal must never print a half link or a link on stdout: stdout stays empty on every refusal (Task 1, each refusal row asserts `stdout === ''`).
3. `--page` that is not a positive whole number (`abc`, `0`, `-3`, `1.5`, `12abc`, `99999999999999999999`): refused locally before any request, because the server schema takes an integer doc id (Task 1 test `bad --page`).
4. A server older than app v0.295.0 (the action does not exist): the user must be told the server may be too old rather than see a bare schema error (Task 1 test `invalid_action`).
5. A server answer with a control character or ANSI escape in the link or note, or no `link` at all: stripped on output; a missing link is a failure, never a blank success (Task 1 tests `control bytes` and `missing link`).
6. A dev copy that shares databases with production: the link is still printed, with a warning naming the databases (Task 1 test `shares production data`).

---

## Interface contract (frozen before dispatch; both tasks quote it)

**mcp.ts addition (Task 1 produces it, Task 1 alone consumes it):**

```ts
/** Call the projects_sandbox MCP tool (the app's dev-copy actions: exec, status, clear, promote, preview_link). */
export async function callProjectsSandbox(config: Config, args: Record<string, unknown>): Promise<McpToolResult> {
    return callMcpTool(config, UNIFIED_MCP_PATH, 'projects_sandbox', args);
}
```

**Command:** `solidactions app preview <app> [--page <id>]`.
- Request sent: `POST /mcp`, JSON-RPC `tools/call`, `params = { name: 'projects_sandbox', arguments: { action: 'preview_link', project: '<app as typed, trimmed>' } }`, plus `page: <integer>` only when `--page` is given. No `revoke` key, ever.
- `--page <id>` is valid only when it matches `/^[1-9][0-9]*$/` and `Number(id)` is a safe integer; anything else prints `app preview: --page needs a whole number (the page's doc id), e.g. --page 12.` on stderr, exit 1, no request.
- Success output, in this order, stdout only:
  1. `Preview link for <app> (dev copy):` (`<app>` is the app as typed)
  2. `  <link>` (two-space indent, `chalk.blue.underline`, the link alone on its line)
  3. the server `note` string on its own line, verbatim, when it is a non-empty string
  4. when `shares_production_data === true`: `Warning: this dev copy shares data with production (databases: <names joined by ", ">). What you press in the preview changes that data.` (when `databases` is empty or absent, `(databases: unknown)`)
  Every line goes through `out()`. Exit 0. Nothing else on stdout; stderr holds only the `Workspace:` banner the mutating classification prints.
- Missing or non-string `link`: stderr `Failed: the server answered without a preview link.`, exit 1, nothing on stdout.
- Refusal output, stderr only, red, exit 1, stdout empty. The first line is `error: <server message>` (the server's `error.message`; when the answer has no message, `error: <code>` or `error: the server refused the request`). Then, by code, one extra line:
  - `no_dev_copy`: `Deploy it to dev first: solidactions project deploy <app> . -e dev` (`<app>` through `shellArg`)
  - `rate_limited` with a numeric `retry_after`: `Try again in <n> seconds.`
  - `invalid_action`: `This server may be older than the CLI expects: preview links need app v0.295.0 or later.`
  - every other code (`project_not_found`, `page_not_found`, `previews_disabled`, `forbidden`, `user_required`, unknown): no extra line.
- A thrown error (`McpRpcError`, HTTP failure): stderr `error: <message>`, exit 1.
- The tool answer shape to read: `const e = result.data?.error ?? result.data;` then `e.code`, `e.message`, `e.retry_after` (the `{code,message}` flat shape of the CLI's own `empty_result` also works).

**Help text (frozen, Task 1 puts it in `src/index.ts`, Task 2 mirrors its figures in the README):**
- Group: `const app = program.command('app').description('Try an app before it ships');`
- Leaf description: `Print a one-time link that opens an app's dev copy in your own browser, no login`
- Argument: `.argument('<app>', 'App name, or the slug of any of its environment rows')`
- Option: `.option('--page <id>', "Open this page first (the page's numeric doc id)")`
- `addHelpText('after', ...)` with exactly this text (leading newline as shown):

```

The link opens the app's dev copy only, never production, as you. It works once and
must be opened within 60 seconds. The session ends after 3 minutes without use or
10 minutes in all; ask again for a new link when it ends. The CLI does not open a browser.

For agents: before you call an app change done, run this, open the link in your own
browser and try the app on the dev copy (open pages, press buttons, fill forms).
Deploy to dev first: solidactions project deploy <app> . -e dev
```

**Classification:** `'app preview'` goes into `MUTATING_COMMANDS` with the comment `// Mints a preview session row (counts against the workspace's mint limit); the link itself changes nothing until it is opened.`

---

## Dependency map

| Task | Issue | Depends on | Files (scope) |
|------|-------|------------|---------------|
| 1 `app preview` command, help words, classification | cli#247 | none | `src/commands/app-preview.ts`, `src/utils/mcp.ts`, `src/index.ts`, `src/utils/mutating-commands.ts`, `tests/app-preview.test.ts` |
| 2 README | cli#247 | none (quotes the frozen contract above) | `README.md`, `tests/readme-contract.test.ts` |

Tasks 1 and 2 touch disjoint paths and run in parallel. Each is far under the 1000-line cap (Task 1 about 350 lines with its test, Task 2 about 40).

---

### Task 1: `app preview` command, agent words in its help, mutating classification (cli#247)

**Files (file scope — the only paths this task may touch):**
- Create: `src/commands/app-preview.ts`
- Create: `tests/app-preview.test.ts`
- Modify: `src/utils/mcp.ts` (add `callProjectsSandbox` right after `callCrewsTool`, which ends before `callCrewsToolContent` at line 299; nothing else)
- Modify: `src/index.ts` (import `appPreview` beside the other command imports near line 37; add the `app` group and `preview` leaf between the `connection` block, which ends at line 1079, and the `ai` block; nothing else)
- Modify: `src/utils/mutating-commands.ts` (add `'app preview',` with its comment after `'connection connect',` at line 99; nothing else)

**Not yours; never touch:** `README.md`, `tests/readme-contract.test.ts` (Task 2), and every other path.

**Interfaces:**
- Consumes: `callMcpTool` and `UNIFIED_MCP_PATH` inside `src/utils/mcp.ts`; `requireConfigWithWorkspace` (`src/utils/api.ts:656`); `out`/`err` (`src/utils/output.ts`); `shellArg` (`src/utils/connect-link.ts:52`).
- Produces: `export async function appPreview(app: string, options: AppPreviewOptions): Promise<void>` where `export interface AppPreviewOptions { page?: string }`; `export async function callProjectsSandbox(config: Config, args: Record<string, unknown>): Promise<McpToolResult>`. Nothing else consumes them.

- [ ] **Step 1: Write the failing tests** in `tests/app-preview.test.ts`

Copy the harness of `tests/connection-connect.test.ts` (the in-process server that records requests, `writeGlobal` for the config with `host`, `apiKey: 'test-key'`, `workspaceId: 'workspace-1'`, the local `runCli`, `splitWorkspaceLine`). The server here answers `POST /mcp` with a JSON-RPC envelope; use this helper for every row:

```ts
/** The MCP envelope the unified server sends: one text content block holding the tool's JSON. */
function mcpAnswer(payload: unknown, isError = false): { status: number; payload: unknown } {
    return {
        status: 200,
        payload: { jsonrpc: '2.0', id: 1, result: { isError, content: [{ type: 'text', text: JSON.stringify(payload) }] } },
    };
}

function mint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        link: 'https://app.solidactions.com/preview/tok_abc123',
        expires_at: '2026-11-15T14:00:00+00:00',
        session_minutes: 10,
        environment: 'dev',
        shares_production_data: false,
        databases: [],
        note: "Open this link once, within 1 minute, in your own browser. It opens this app's dev copy as you; the session ends after 3 minutes without use or 10 minutes in all. If you land on the sign-in page, the preview ended: ask for a new link. Images that come from media docs do not show in a preview.",
        ...overrides,
    };
}

function refusal(code: string, message: string, extra: Record<string, unknown> = {}) {
    return mcpAnswer({ error: { code, message, ...extra } }, true);
}
```

Rows (each is one `it`; the mutating banner is the first stderr line of every row that gets past argument checks, so assert the remainder with `splitWorkspaceLine`):

1. `app preview my-app` with `mint()` → exit 0; exactly one request, `POST /mcp`, `authorization: Bearer test-key`, `x-workspace-id: workspace-1`; `body.method === 'tools/call'`, `body.params` equals `{ name: 'projects_sandbox', arguments: { action: 'preview_link', project: 'my-app' } }` (so no `page`, no `revoke`); stdout lines in order: `Preview link for my-app (dev copy):`, `  https://app.solidactions.com/preview/tok_abc123`, then the note; stderr after the banner is empty. Also assert the link line is exactly the two-space indent plus the link (colour is off in the child: `FORCE_COLOR` is deleted by `runCli`).
2. `app preview my-app --page 12` → `body.params.arguments` equals `{ action: 'preview_link', project: 'my-app', page: 12 }` (a number, not a string).
3. `shares production data`: `mint({ shares_production_data: true, databases: ['crm', 'billing'] })` → exit 0, link still printed, stdout contains `Warning: this dev copy shares data with production (databases: crm, billing). What you press in the preview changes that data.`. A second `it` with `databases: []` prints `(databases: unknown)`.
4. `project_not_found`: `refusal('project_not_found', 'The app could not be found. Apps you can use: alpha, beta.')` → exit 1, stderr (after the banner) is `error: The app could not be found. Apps you can use: alpha, beta.`, stdout is `''`.
5. `no_dev_copy`: `refusal('no_dev_copy', 'This app has no dev copy to preview.')` with app `my-app` → exit 1, stderr contains `error: This app has no dev copy to preview.` and `Deploy it to dev first: solidactions project deploy my-app . -e dev`; stdout `''`. A second app name with a space, `'my app'`, shows `solidactions project deploy 'my app' . -e dev` (shellArg).
6. `page_not_found`: `refusal('page_not_found', 'That page is not part of the app.')` with `--page 99` → exit 1, stderr `error: That page is not part of the app.` and no second line; stdout `''`.
7. `previews_disabled`: `refusal('previews_disabled', 'Agent previews are disabled (workspace setting agent_previews_enabled is off).')` → exit 1, the message on stderr, stdout `''`.
8. `rate_limited`: `refusal('rate_limited', 'Too many preview links minted.', { retry_after: 42 })` → stderr has `error: Too many preview links minted.` and `Try again in 42 seconds.`.
9. `invalid_action`: `refusal('invalid_action', 'Choose exec, status, clear, promote or describe.')` → stderr has the message and `This server may be older than the CLI expects: preview links need app v0.295.0 or later.`.
10. `bad --page`: for each of `abc`, `0`, `-3`, `1.5`, `12abc`, `99999999999999999999` (one `it.each`) → exit 1, stderr `app preview: --page needs a whole number (the page's doc id), e.g. --page 12.`, `requests` has length 0, stdout `''`. (Pass `-3` as `--page=-3` so commander does not read it as a flag.)
11. `control bytes`: `mint({ link: 'https://app.solidactions.com/preview/tok\u001b[31m_x', note: 'Open\u0007 once.' })` → exit 0 and `result.stdout` contains no `\u001b` and no `\u0007`.
12. `missing link`: `mint({ link: undefined })` and `mint({ link: 42 })` → exit 1, stderr `Failed: the server answered without a preview link.`, stdout `''`.
13. `unauthorized`: the server answers HTTP 401 → exit 1, stdout `''`, one request (the existing MCP transport prints the host line; assert only exit code and empty stdout).
14. `classification`: import `isMutatingCommand` and assert `isMutatingCommand(['app', 'preview'])` is `true`, and `MUTATING_COMMANDS.has('app preview')` is `true`.
15. `help words`: run `app preview --help` (no config needed; a fresh `home` is fine) → exit 0; stdout contains each of `one-time link`, `60 seconds`, `3 minutes without use or`, `10 minutes in all`, `The CLI does not open a browser`, `For agents: before you call an app change done`, `in your own`, `solidactions project deploy <app> . -e dev`, `--page <id>`.
16. `no browser`: assert `fs.readFileSync(<repo>/src/commands/app-preview.ts, 'utf8')` does not match `/child_process|require\(['"]open['"]\)|from ['"]open['"]|xdg-open/` (the CLI does not open a browser).

Expected-RED table (the reviewer checks each row against the test code; CI is the proof; on the base there is no `app` command, so commander answers `error: unknown command 'app'` and exits 1, and the server sees no request):

| Row | Assertion that must fail on the base | Why |
|-----|--------------------------------------|-----|
| 1, 2, 3, 11 | `expect(result.status).toBe(0)` and `requests` length 1 | unknown command, exit 1, no request |
| 4-9 | `requests` has length 1 and `splitWorkspaceLine(stderr)` finds the banner | the base prints no `Workspace:` banner and sends no request; a bare `exit 1` alone would pass, so every refusal row asserts the request and the banner |
| 10 | stderr equals the `--page needs a whole number` line | the base prints `unknown command 'app'` instead |
| 12 | stderr equals `Failed: the server answered without a preview link.` | base prints the unknown-command error |
| 13 | `requests` has length 1 | base sends none |
| 14 | `isMutatingCommand(['app','preview'])` is `true` already on the base (unknown path fails safe to true), so assert `MUTATING_COMMANDS.has('app preview')`, which is `false` on the base | the explicit membership is the new fact |
| 15 | exit 0 and the help text | base: unknown command, exit 1 |
| 16 | `readFileSync` throws ENOENT | the file does not exist on the base |

- [ ] **Step 2: Static check the test file compiles.** `tsconfig.json` includes only `src/**/*` (and sets `rootDir` to `src`), so the project command does not see tests. Run `npx tsc --noEmit --skipLibCheck --esModuleInterop --strict --module commonjs --target es2022 --moduleResolution node tests/app-preview.test.ts` and fix type errors in the file. Do not run vitest.

- [ ] **Step 3: Implement.** `src/utils/mcp.ts`, after `callCrewsTool`:

```ts
/** Call the projects_sandbox MCP tool (the app's dev-copy actions: exec, status, clear, promote, preview_link). */
export async function callProjectsSandbox(config: Config, args: Record<string, unknown>): Promise<McpToolResult> {
    return callMcpTool(config, UNIFIED_MCP_PATH, 'projects_sandbox', args);
}
```

`src/commands/app-preview.ts`:

```ts
import chalk from 'chalk';
import { requireConfigWithWorkspace } from '../utils/api';
import { shellArg } from '../utils/connect-link';
import { callProjectsSandbox } from '../utils/mcp';
import { err, out } from '../utils/output';

export interface AppPreviewOptions {
    page?: string;
}

function fail(line: string): never {
    err(line, chalk.red);
    process.exit(1);
}

/** The doc id for --page, or null when it is not a positive whole number a JSON integer can hold. */
function parsePage(value: string): number | null {
    if (!/^[1-9][0-9]*$/.test(value)) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
}

export async function appPreview(app: string, options: AppPreviewOptions): Promise<void> {
    const project = app.trim();
    if (project === '') {
        fail('app preview: give the app name, e.g. solidactions app preview my-app.');
    }
    const args: Record<string, unknown> = { action: 'preview_link', project };
    if (options.page !== undefined) {
        const page = parsePage(options.page);
        if (page === null) {
            fail("app preview: --page needs a whole number (the page's doc id), e.g. --page 12.");
        }
        args.page = page;
    }

    const config = await requireConfigWithWorkspace();

    let result: Awaited<ReturnType<typeof callProjectsSandbox>>;
    try {
        result = await callProjectsSandbox(config, args);
    } catch (error: any) {
        fail(`error: ${error.message}`);
    }

    if (!result.ok) {
        const refusal = result.data?.error ?? result.data ?? {};
        const code = typeof refusal.code === 'string' ? refusal.code : '';
        const message = typeof refusal.message === 'string' && refusal.message !== ''
            ? refusal.message
            : code !== '' ? code : 'the server refused the request';
        err(`error: ${message}`, chalk.red);
        if (code === 'no_dev_copy') {
            err(`Deploy it to dev first: solidactions project deploy ${shellArg(project)} . -e dev`, chalk.red);
        } else if (code === 'rate_limited' && typeof refusal.retry_after === 'number') {
            err(`Try again in ${refusal.retry_after} seconds.`, chalk.red);
        } else if (code === 'invalid_action') {
            err('This server may be older than the CLI expects: preview links need app v0.295.0 or later.', chalk.red);
        }
        process.exit(1);
    }

    const data = result.data ?? {};
    if (typeof data.link !== 'string' || data.link === '') {
        fail('Failed: the server answered without a preview link.');
    }

    out(`Preview link for ${project} (dev copy):`);
    // Same style as the device-login URL: two-space indent, blue underline, the link alone on its line.
    out('  ' + data.link, chalk.blue.underline);
    if (typeof data.note === 'string' && data.note !== '') {
        out(data.note);
    }
    if (data.shares_production_data === true) {
        const names = Array.isArray(data.databases) && data.databases.length > 0
            ? data.databases.filter((name: unknown) => typeof name === 'string').join(', ')
            : 'unknown';
        out(`Warning: this dev copy shares data with production (databases: ${names || 'unknown'}). What you press in the preview changes that data.`, chalk.yellow);
    }
}
```

`src/index.ts`: add `import { appPreview } from './commands/app-preview';` with the other command imports, and this block after the `connection` block:

```ts
// =============================================================================
// app <subcommand>
// =============================================================================

const app = program.command('app').description('Try an app before it ships');

app
    .command('preview')
    .description("Print a one-time link that opens an app's dev copy in your own browser, no login")
    .argument('<app>', 'App name, or the slug of any of its environment rows')
    .option('--page <id>', "Open this page first (the page's numeric doc id)")
    .addHelpText('after', `
The link opens the app's dev copy only, never production, as you. It works once and
must be opened within 60 seconds. The session ends after 3 minutes without use or
10 minutes in all; ask again for a new link when it ends. The CLI does not open a browser.

For agents: before you call an app change done, run this, open the link in your own
browser and try the app on the dev copy (open pages, press buttons, fill forms).
Deploy to dev first: solidactions project deploy <app> . -e dev`)
    .action(async (appName, options) => {
        await appPreview(appName, options);
    });
```

No top-level `const app` exists in `src/index.ts` at plan time (`grep -n "const app\b" src/index.ts` printed nothing); if the name has been taken by the time you build, use `appGroup`.

`src/utils/mutating-commands.ts`, after `'connection connect',`:

```ts
    // Mints a preview session row (counts against the workspace's mint limit); the link itself changes nothing until it is opened.
    'app preview',
```

- [ ] **Step 4: Static checks:** `npx tsc --noEmit -p tsconfig.json` must print nothing, plus the standalone test-file command from Step 2. The repo has no eslint or prettier config (checked at plan time: `ls -a` shows none), so there is no lint step; follow the surrounding files' 4-space style. Measure the diff: `git diff --stat -- <your paths>` plus `wc -l` of the two new files; stay under about 1000 lines.

- [ ] **Step 5: Report (do not commit).** List every changed path, test paths and source paths separately, the expected-RED table above (adjust a row only if you changed a test), and the output of the static checks. The manager commits them after the task review passes, with `git add -- <paths>` then `git commit -m "feat: app preview prints a one-time preview link for an app's dev copy (cli#247)" -- <paths>`.

---

### Task 2: README documents `app preview` (cli#247)

**Files (file scope — the only paths this task may touch):**
- Modify: `README.md` (add one `### app` section directly before `### workspace`, which starts at line 558; do not edit any other section)
- Modify: `tests/readme-contract.test.ts` (add one `it` inside the existing `describe('public README setup contract', ...)`; nothing else)

**Not yours; never touch:** `src/**`, `tests/app-preview.test.ts` (Task 1).

**Interfaces:**
- Consumes: the frozen contract above (command, flag, figures, success lines). No code from Task 1.
- Produces: nothing a task depends on.

- [ ] **Step 1: Write the failing test.** In `tests/readme-contract.test.ts`, inside the existing describe, add:

```ts
    it('documents app preview: the command, --page, the one-time link, the session limits and the agent step', () => {
        // README is the file-level constant already read at the top of this test file.
        expect(README.includes('### app\n')).toBe(true);
        const section = README.slice(README.indexOf('### app\n'), README.indexOf('### workspace\n'));

        expect(section).toContain('`app preview <app>`');
        expect(section).toContain('`--page <id>`');
        expect(section).toContain('dev copy');
        expect(section).toContain('60 seconds');
        expect(section).toContain('3 minutes');
        expect(section).toContain('10 minutes');
        expect(section).toContain('does not open a browser');
        expect(section).toContain('before calling an app change done');
        expect(section).toContain('solidactions project deploy <app> . -e dev');
    });
```

`README` is the constant at the top of `tests/readme-contract.test.ts` (line 6); `markdownSection` there stops at the next `## ` heading, so it cannot be used for a `###` section: slice by the two headings as shown.

Expected-RED table: `expect(README.includes('### app\n')).toBe(true)` fails on the base (no such heading); every later `toContain` would fail too.

- [ ] **Step 2: Write the README section**, directly before `### workspace`:

```markdown
### app

| Command | Key Flags | Description |
|---------|-----------|-------------|
| `app preview <app>` | `--page <id>` | Print a one-time link that opens the app's dev copy in your own browser, no login |

`app preview` asks the server for a link and prints it on its own line. The CLI does not open a browser. The link opens the app's **dev copy** only (never production) as you, and only if you may deploy the app. It works once and must be opened within 60 seconds; the session ends after 3 minutes without use or 10 minutes in all, and you ask again for a new link when it ends. `--page <id>` opens one page of the app first (the page's numeric doc id).

If the dev copy shares a database with production, the command prints a warning naming the databases; the link is still issued. A refusal (the app is unknown, it has no dev copy, the page is not part of it, previews are switched off for the workspace, too many links asked for) prints a plain message and exits non-zero.

**For agents:** before calling an app change done, deploy it to dev (`solidactions project deploy <app> . -e dev`), run `solidactions app preview <app>`, open the link in your own browser and try the app (open pages, press buttons, fill forms).
```

(The sentence "before calling an app change done" must appear in that exact lowercase form; the test pins it.)

- [ ] **Step 3: Static check:** a read-through that the README section renders (no broken table) and that `### app` sits before `### workspace`. `tsconfig.json` includes only `src/**/*`, so there is no type check for this test file beyond the standalone command in Task 1 Step 2. Do not run vitest.

- [ ] **Step 4: Report (do not commit).** List both paths and the expected-RED row. The manager commits them with `git add -- README.md tests/readme-contract.test.ts` then `git commit -m "docs: README documents app preview (cli#247)" -- README.md tests/readme-contract.test.ts`.

---

## Where the agent words live (ruling and open question for the PM)

The issue says "the ai-init / skill text tells agents to ask for a preview link". The skill text `ai init` installs is **not in this repo**: `src/utils/skills.ts:10-20` lists five skill names and fetches `content/skills/<name>.md` from `SolidActions/solidactions-examples` at the commit `EXAMPLES_REF` (`src/utils/examples-ref.ts`), and `fetchAiHelperContent` fetches the CLAUDE.md/AGENTS.md helper from the same repo. This wave therefore puts the agent words where this repo owns text an agent reads: the command's `--help` (Task 1) and the README (Task 2). Editing the skill text is a change in `solidactions-examples` followed by a bump of `EXAMPLES_REF` in this repo (the file's own header: "TO UPDATE: point this at the new solidactions-examples commit and re-run `npm run check:release`"). That is a separate change; mailed to the PM at plan time (see the wave card) so it can be filed or folded in. Nothing in this plan edits `src/utils/examples-ref.ts`.

## User-visible behaviour map (every behaviour the plan adds, mapped to the ruling's words)

| Behaviour | Ruling words |
|-----------|--------------|
| `solidactions app preview <app>` prints the link on its own line | "New command `solidactions app preview <app> [--page <id>]` ... prints the link on its own line (same style as `device-login.ts:155-160`)" |
| `--page <id>` sent as an integer, refused locally when not a whole number | "`[--page <id>]`"; the server schema (`ProjectsSandbox.php` line 50) types it integer |
| No browser is opened | "The CLI does not open a browser." |
| Refusals print a plain message, exit 1, link never printed | "Refusals (...) print a plain message and exit non-zero." |
| The server's note line under the link | proposal section 4.1: output includes "a one-line note on use" |
| Production-data warning, link still issued | proposal section 4.6: "Warn, do not block" |
| `no_dev_copy` extra line naming the deploy command; `rate_limited` retry seconds; `invalid_action` older-server line | the plain message the ruling asks for, helping the next step; no new capability |
| Help text and README carry the agent paragraph and the 60 s / 3 min / 10 min figures | "Agent words: ... try the app in their own browser before calling an app change done (the link works once, within 60 seconds; the session ends after 3 minutes idle or 10 minutes)" |
| `app preview` classified mutating (a `Workspace:` banner on stderr when the workspace was inferred) | not in the ruling: required by `tests/mutating-commands.test.ts` (every leaf must be classified) and it mints a row |

Dropped for lack of a mapping: `--json`, `--revoke`, `--open`, a deploy-time hint.

## Verify (manager, at the verify step; nothing here runs in build)

1. Pick a free app slot (no run holds its lock; its detached head contains app PR #2756: `git merge-base --is-ancestor a3be6b83b HEAD` there), `scripts/local-dev up` there, check nothing out. Build the CLI once: `npm run build` in this slot.
2. Log in to that stack with the built CLI; deploy an app to dev; run `node dist/index.js app preview <app>`, then `... --page <id>` with a real page id. Expected: the output shape above, exit 0. The link is single-use, so open it exactly once (a browser, or a curl on a link minted for that purpose: a curl burns it); a second open must answer "already used".
3. Refusals live: an unknown app (`project_not_found` with the app list), an app with no dev copy (`no_dev_copy` and the deploy line), `--page 99999999` (`page_not_found`).
4. Save the commands and output to the SDD workspace. Bring the stack down after.
5. Cleanroom: the qa seat drives the CLI cold on the same stack with goals only ("get a link that opens my app's dev copy"; "see why a link for an app that was never deployed to dev does not work").

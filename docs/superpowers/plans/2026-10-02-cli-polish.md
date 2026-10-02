# Wave cli-polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sa-subagent-driven-development to implement this plan task-by-task (the wave's build step). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every API failure prints one line naming its host; a project argument resolves by its canonical slug in every command; `whoami` and `workspace list` tell the truth about the pinned workspace; `doc pull` and `doc push` round-trip visual docs and canvases and track what push creates; the test toolchain is pinned past its advisories and runs warning-free.

**Architecture:** Six serial tasks. Shared helpers go to `src/utils/api.ts` (`authFailedLine`) and a new `src/utils/project-ref.ts` (`resolveProjectSlug`, `getProjectBySlugOrCanonical`); the command files call them. Docs changes stay inside `doc-pull.ts` / `doc-push.ts`.

**Tech Stack:** TypeScript (Node ≥ 20, CommonJS via `tsc`), commander, axios, chalk, vitest 4.

**Spec:** `docs/superpowers/specs/2026-10-02-cli-polish-design.md` (read the section for your task's issue first).

**Plan review:** revised after Fable's REQUEST CHANGES on 3e59485; the PM's rulings 1-6 are on plan card task-planclipolish-9da6 and are cited as "PM ruling N" in Tasks 3-6.

**Issues:** approved by Peter in CrewOps ask task-startthenextcli-6fc8 ("Approve: start it now", 2026-10-02), recorded on each issue; cli#158 folded in by the PM with cli#91:
- `cli#91` Vitest toolchain past the Vite/PostCSS advisories, `cli#158` Vite config-loader warning (Task 1)
- `cli#162` whoami shows the organization, `cli#113` workspace pin hygiene (Task 2)
- `cli#156` one-line API failures in 23 more commands (Task 3)
- `cli#161` mixed-case project names in every command (Task 4)
- `cli#157` doc pull writes .html / .canvas.json (Task 5); push records created docs in the manifest (Task 6)

## Global Constraints

- **Where:** paths are relative to the wave slot `/home/mercer/projects/solid/solidactions-cli/__worktrees/wave-a` (branch `wave/2026-10-02-cli-polish`). Work only there.
- **File scope:** touch only the paths in your task's **Files** block. A change that needs another path is a plan defect: stop and report it.
- **Never commit, stage, stash, switch branches, reset or rebase.** Never create a worktree. The manager commits after the task review.
- **Build before tests:** `npm run build` after every source change and before every test run (many tests spawn `dist/index.js`).
- **Filtered runs only:** run the test files your task names (`npx vitest run --project unit tests/<file>.test.ts …`). Never the full suite.
- **Real tests (PM ruling 14 of wave cli-trust, still binding):** new or changed command tests spawn the built binary (`node dist/index.js …`, async `child_process.spawn`, because the in-process HTTP server lives in the test process) against a real local `http.createServer`, with a temp `HOME` whose `~/.solidactions/config.json` points at that server and `SOLIDACTIONS_HOST` / `SOLIDACTIONS_API_KEY` / `SOLIDACTIONS_WORKSPACE_ID` cleared from the child env. Assert real stdout, stderr and exit status. No `process.exit` / `console` / output-sink substitutions in new or changed tests, no `vi.fn`, never mock `axios`, `fs` or a module. Pure functions may be unit-tested directly. Existing older tests you don't change may keep their helpers.
- **Live tests** (`tests/live/`) run only where a task says so, against the shared sa-dev stack the manager brings up (`eval "$(scripts/live-test-env.sh)" && npx vitest run --project live tests/live/docs.live.test.ts`). Never print, echo or save the token that script mints.
- **No secrets in output:** never print an API key or a config file's `apiKey`.
- **Style:** 4-space indent, single quotes, chalk colours as the surrounding code uses them; status text to stderr, a command's own output to stdout.
- **Report, never commit:** your last step lists every changed path and the test commands you ran with their pass/fail counts.

## Review Focus

1. **A command left on the old path (cli#156, cli#161).** A command that still prints a raw body, an old 401 line, or builds its project slug without the resolver. The static guard (Task 3) and the per-command spawned tests (Task 4) are the net; the reviewer should grep too.
2. **A resolver that hides a real error (cli#161).** Only a 404 may move to the next candidate; a 401/403/500 from the lookup must surface through the command's existing error handling, not turn into "not found".
3. **A pull that renames tracked markdown docs or loses edits (cli#157).** Docs without a visual/canvas type must stay `.md`; an edited local file must still refuse a pull without `--overwrite`.
4. **Push recording docs that live elsewhere (cli#157).** With `--folder` different from the manifest's folder, nothing may be recorded; skipped rows (a title someone else's doc holds) must never be recorded.
5. **The toolchain rename breaking a project (cli#158).** Both the `unit` and `live` vitest projects must still be discovered after `vitest.config.ts` → `vitest.config.mts`.

---

### Task 1: toolchain floor and warning-free config (cli#91, cli#158)

Read spec §1.

**Files (file scope — the only paths this task may touch):**
- Modify: `package.json` (`devDependencies.vitest`)
- Modify: `package-lock.json` (only through npm, never by hand)
- Delete: `vitest.config.ts`
- Create: `vitest.config.mts` (the same content)
- Modify: `tests/live/README.md` (the one `vitest.config.ts` reference)

**Interfaces:** none.

- [ ] **Step 1: Record the before state.** Run `npx vitest run --project unit tests/docs-tool.test.ts 2>&1 | head -12` and keep the output: it shows the `(!) Your Vite config uses features that are unsupported by configLoader: 'native'` warning (three times).
- [ ] **Step 2: Raise the floor.** Run `npm install --save-dev vitest@^4.1.11` (updates `package.json` to `"vitest": "^4.1.11"` and the lockfile). Confirm `git diff package.json` shows only that line, and `npm ls vitest vite postcss` resolves vite ≥ 8.0.16 and postcss ≥ 8.5.18. Run `npm audit` → `found 0 vulnerabilities`.
- [ ] **Step 3: Rename the config.** Write `vitest.config.mts` with exactly the content of `vitest.config.ts`, then delete `vitest.config.ts`. In `tests/live/README.md`, change `vitest.config.ts` to `vitest.config.mts`.
- [ ] **Step 4: Verify.**
Run: `npm run build && npx vitest run --project unit tests/docs-tool.test.ts tests/config-merge.test.ts 2>&1 | head -20`
Expected: PASS, and the output contains no `(!) Your Vite config` line. Also run `npx vitest list --project live 2>&1 | head -5` (it must list the live files or report them skipped, not "No projects matched").
- [ ] **Step 5: Report (do not commit).** Include the before/after outputs and the `npm ls` / `npm audit` lines. Manager's commit: `chore: vitest floor ^4.1.11 and an ESM vitest config (#91, #158)`.

---

### Task 2: whoami shows the organization; workspace list calls out a dangling pin (cli#162, cli#113)

Read spec §4.

**Files (file scope — the only paths this task may touch):**
- Modify: `src/commands/login.ts` (`whoami`, ~lines 530-569)
- Modify: `src/commands/workspaces.ts` (`workspacesList`)
- Create: `tests/whoami-workspace.test.ts`
- Create: `tests/workspace-list-dangling-pin.test.ts`

**Interfaces:** consumes `formatWorkspaceWithOrg` (`src/utils/workspace-lookup.ts`), `requireResolvedConfig` (`src/utils/api.ts`).

- [ ] **Step 1: Write the failing spawned tests.**
  - `tests/whoami-workspace.test.ts` (no server needed; `whoami` is offline): temp HOME, global config `{ host: 'http://127.0.0.1:9', apiKey: 'sk_test_whoami_secret', workspace: 'acme-south-ws', workspaceId: 'ws-2', workspaceOrg: 'Acme' }`.
    1. `whoami` → exit 0; stdout's workspace line contains `acme-south-ws — organization Acme (ws-2)`.
    2. Same with a cwd local `.solidactions/config.json` = `{ "workspace": "acme-north-ws", "workspaceId": "ws-1", "workspaceOrg": "Acme North" }` → the line contains `acme-north-ws — organization Acme North (ws-1)` and the local path; stdout does NOT contain `inherited from a different config file`.
    3. Without `workspaceOrg` → the line is `acme-south-ws (ws-2)` as before.
    4. Neither stream contains `sk_test_whoami_secret`.
  - `tests/workspace-list-dangling-pin.test.ts` (in-process server answering `GET /api/v1/workspaces` with `{ "workspaces": { "t1": [{ "id": "ws-1", "slug": "acme-north-ws", "name": "Main", "role": "admin", "tenant_name": "Acme" }] } }`):
    1. Global config pins `workspaceId: 'ws-9', workspace: 'gone-ws'` → `workspace list` exit 0; output still lists `Main`; it ends with a warning containing `gone-ws`, `ws-9`, the global config path, and `workspace set`; no `← current` anywhere.
    2. Global config pins `ws-1` → `← current` on `Main`, no warning.
    3. No pin → no warning.
- [ ] **Step 2: Run and see them fail.**
Run: `npm run build && npx vitest run --project unit tests/whoami-workspace.test.ts tests/workspace-list-dangling-pin.test.ts`
Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `whoami`: build `workspaceLabel` with the organization when `config.workspaceOrg` is set:

```ts
    const workspaceName = config.workspace ?? config.workspaceId;
    const workspaceLabel = !config.workspaceId && !config.workspace
        ? ''
        : !config.workspace
            ? `${config.workspaceId} (slug unknown — run 'workspace set <slug>' to populate)`
            : config.workspaceOrg
                ? `${workspaceName} — organization ${config.workspaceOrg}${config.workspaceId ? ` (${config.workspaceId})` : ''}`
                : `${workspaceName}${config.workspaceId ? ` (${config.workspaceId})` : ''}`;
```

    and delete `isFileSource`, `workspaceInheritedFromOtherFile` and the yellow `(inherited from a different config file)` suffix (cli#113 part 2).
  - `workspacesList`: use `const resolved = requireResolvedConfig(); const config = resolved.config;`. After the loop, before the final blank line:

```ts
    // cli#113: a pin the list doesn't contain gets no "← current" — say so instead of looking normal.
    if (config.workspaceId && !workspaces.some((ws) => ws.id === config.workspaceId)) {
        const label = config.workspace ? `${config.workspace} (${config.workspaceId})` : config.workspaceId;
        const from = resolved.sources.workspaceId === 'env' ? '$SOLIDACTIONS_WORKSPACE_ID' : resolved.sources.workspaceId;
        console.log('');
        console.log(chalk.yellow(`warn: the active workspace ${label} (from ${from}) is not in this list — it may belong to another host, or you may no longer have access.`));
        console.log(chalk.yellow('Pick one from the list with `solidactions workspace set <slug> --local` (or --global).'));
    }
```

- [ ] **Step 4: Run and see them pass.**
Run: `npm run build && npx vitest run --project unit tests/whoami-workspace.test.ts tests/workspace-list-dangling-pin.test.ts tests/config-credential-pair.test.ts tests/workspace-set-confirmation.test.ts`
Expected: PASS.
- [ ] **Step 5: Report (do not commit).** Manager's commit: `fix: whoami shows the organization; workspace list calls out a dangling pin (#162, #113)`.

---

### Task 3: one line on every API failure (cli#156)

Read spec §2. This is one batch of the same mechanical change across many files.

**Files (file scope — the only paths this task may touch):**
- Modify: `src/utils/api.ts` (add `authFailedLine`)
- Modify (each site's raw-body print and its 401 branch): `src/commands/env-reset.ts`, `oauth-action-search.ts`, `webhook-secret.ts`, `run-list.ts`, `webhook-list.ts`, `run-start.ts`, `crew-env-set.ts`, `env-map.ts`, `schedule-list.ts`, `env-pull.ts`, `crew-env-delete.ts`, `project-list.ts`, `env-set.ts` (2 sites), `oauth-action-view.ts`, `oauth-action-list.ts`, `schedule-set.ts`, `crew-env-list.ts`, `schedule-delete.ts`, `run-view.ts`, `env-delete.ts`, `oauth-action-platforms.ts`, `project-logs.ts`, `schedule-state.ts`, `deploy.ts` (the `JSON.stringify(error.response.data)` print ~line 883 and its 404 line), `env-list.ts` (401 line and the global 404 `Resource not found.`), `connection-list.ts` (401 line) — all under `src/commands/`
- Modify (401 line only, PM ruling 1): `src/commands/crew-env-push.ts`, `doc-upload.ts`, `env-push.ts`, `project-create.ts`, `project-view.ts`, `pull.ts`, `state.ts`, `workflow-view.ts`
- Modify: `tests/workflow-view.test.ts` (only its expectation of the old 401 text, if it fails)
- Create: `tests/api-failure-one-line.test.ts`
- Create: `tests/no-raw-error-body.test.ts`

**Interfaces:**
- Consumes: `formatApiFailure(status: number, data: unknown): string` (`src/utils/api.ts:355`), `formatValidationError(data: unknown): string` (same file).
- Produces: `export function authFailedLine(host: string): string` in `src/utils/api.ts` → `Authentication failed against ${host}. Run "solidactions login --global" to re-configure.`, with userinfo (`user:pass@`) stripped from the host (PM ruling 6).

- [ ] **Step 1: Write the failing tests.**
  - `tests/no-raw-error-body.test.ts` (static guard, real files; PM ruling 1: the PRINT shape only): read every `src/commands/*.ts`; fail on a line where `error.response.data` is passed bare as an argument of a `console.<method>(` call (e.g. `/console\.\w+\(.*[(,]\s*error\.response\.data(\?\.message \?\? error\.response\.data)?\s*\)/`), on `JSON.stringify(error.response.data`, and on the old 401 text `/Authentication failed\. Run/`. `return formatValidationError(error.response.data);` (`state.ts:99`) must NOT be flagged: add a case asserting the guard's matcher accepts that line and rejects `console.error(chalk.red(`x`), error.response.data);`. Print the offending file:line on failure.
  - `tests/api-failure-one-line.test.ts` (spawned, `it.each`): one in-process server that answers every request with status 403 and a Laravel-shaped body (`{ message: 'This action is unauthorized.', exception: '…AccessDeniedHttpException', file: '/var/www/html/vendor/…', trace: [50 frames] }`); global config `{ host, apiKey: 'test-key', workspaceId: 'workspace-1' }`. For at least these commands: `env reset FOO my-app -e production`, `webhook list my-app -e production`, `run list`, `schedule list my-app -e production`, `project list`, `env map FOO my-app`, `run view 7`, `oauth-action list`, `crew env list my-crew`, `project logs my-app`, `env pull my-app -e production` (with `--output <tmp>/.env --yes`), `env delete FOO my-app -e production --yes` — each: exit 1; stderr (after dropping the `AGENT NOTE` and `Workspace:` banner lines) has exactly one line and it is `Failed: 403 This action is unauthorized.`; nothing contains `vendor`. Read each command's `--help` (or `src/index.ts`) for its exact argument shape before writing its case. Plus a 401 case (`run list` against a server answering 401 `{message:'Unauthenticated.'}`) → stderr line `Authentication failed against http://127.0.0.1:<port>. Run "solidactions login --global" to re-configure.`
- [ ] **Step 2: Run and see them fail.**
Run: `npm run build && npx vitest run --project unit tests/no-raw-error-body.test.ts tests/api-failure-one-line.test.ts`
Expected: FAIL (the guard lists the 25 sites).
- [ ] **Step 3: Implement.**
  - `src/utils/api.ts`:

```ts
/** The one-line 401 every command prints: names the host that refused the key (cli#156), never its userinfo. */
export function authFailedLine(host: string): string {
    let shown = host;
    try {
        const url = new URL(host);
        if (url.username || url.password) {
            url.username = '';
            url.password = '';
            shown = url.toString().replace(/\/$/, '');
        }
    } catch {
        // Not a URL: show it as configured.
    }
    return `Authentication failed against ${shown}. Run "solidactions login --global" to re-configure.`;
}
```

  Add a pure test (in `tests/api-failure-one-line.test.ts`): `authFailedLine('https://u:p@host.example')` contains `https://host.example` and not `u:p`.

  - In every listed command: replace `console.error(chalk.red(\`Failed: ${error.response.status}\`), error.response.data);` (and the `schedule-state.ts` variant) with `console.error(chalk.red(formatApiFailure(error.response.status, error.response.data)));`, and the 401 line with `console.error(chalk.red(authFailedLine(config.host)));` (use the command's config variable; every listed command has one in scope). In `deploy.ts` replace `console.error(error.response.status, JSON.stringify(error.response.data, null, 2));` with the same `formatApiFailure` call. In `env-list.ts`, `connection-list.ts` and the eight 401-only files (PM ruling 1) replace the old 401 text with `authFailedLine(config.host)` (use the config variable in scope), and `env-list.ts`'s global-mode 404 `console.error(chalk.red('Resource not found.'));` with `console.error(chalk.red(formatApiFailure(404, error.response.data)));`. In `env-map.ts` and `schedule-set.ts`, replace `error.response.data.message || error.response.data.errors` in the 422 line with `formatValidationError(error.response.data)`. Keep every other branch (404 messages, 422 handling) as it is.
- [ ] **Step 4: Run and see them pass.**
Run: `npm run build && npx vitest run --project unit tests/no-raw-error-body.test.ts tests/api-failure-one-line.test.ts tests/env-list-forbidden.test.ts tests/connection-list.test.ts tests/workflow-view.test.ts tests/run-list.test.ts tests/env-reset.test.ts tests/run-start-env-mismatch.test.ts`
Expected: PASS. If `tests/workflow-view.test.ts` asserts the old 401 text, update only that expectation.
- [ ] **Step 5: Report (do not commit).** Manager's commit: `fix: every command prints one line on an API failure and names the host on a 401 (#156)`.

---

### Task 4: a project argument resolves by its canonical slug everywhere (cli#161)

Read spec §3. Task 3 changed the error branches of many of the same files; build on it.

**Files (file scope — the only paths this task may touch):**
- Create: `src/utils/project-ref.ts`
- Modify: `src/commands/deploy.ts` (move `getProjectBySlugOrCanonical` out; import it; the webhook hint ~line 836)
- Modify: `src/commands/run-start.ts`, `run-list.ts`, `webhook-list.ts`, `webhook-secret.ts`, `env-list.ts`, `env-set.ts`, `env-delete.ts`, `env-pull.ts`, `env-push.ts`, `env-reset.ts`, `env-map.ts`, `pull.ts`, `project-logs.ts`, `project-view.ts`, `schedule-list.ts`, `schedule-set.ts`, `schedule-delete.ts`, `schedule-state.ts` (all under `src/commands/`)
- Modify: `src/utils/api.ts` (`lookupProjectFamilyEnvironments`, ~line 239)
- Modify: `tests/deploy-mixed-case.test.ts` (its import path only)
- Create: `tests/project-ref.test.ts`
- Create: `tests/mixed-case-project-commands.test.ts`

**Interfaces:**
- Produces (`src/utils/project-ref.ts`):
  - `export async function getProjectBySlugOrCanonical(config: Config, typed: string, canonical: string): Promise<AxiosResponse>` (moved verbatim from `deploy.ts`).
  - `export function projectSlugCandidates(typed: string, environment?: string): string[]` → `[today's slug, canonical]` without duplicates and without an empty canonical: today's slug is `typed` when `environment` is undefined or `'production'`, else `` `${typed}-${environment}` ``; canonical is `buildProjectSlug(typed, environment ?? 'production')` when `slugifyName(typed) !== ''`.
  - `export async function resolveProjectSlug(config: Config, typed: string, environment?: string): Promise<string>`.

- [ ] **Step 1: Write the failing tests.**
  - `tests/project-ref.test.ts`: pure cases for `projectSlugCandidates` (`('CliTrustSmoke','production')` → `['CliTrustSmoke','clitrustsmoke']`; `('CliTrustSmoke','dev')` → `['CliTrustSmoke-dev','clitrustsmoke-dev']`; `('my-app','production')` → `['my-app']`; `('!!!')` → `['!!!']`), and `resolveProjectSlug` against a real in-process server: typed hit (one request); typed 404 → canonical 200 `{slug:'clitrustsmoke'}` → returns `'clitrustsmoke'`; all 404 → returns the first candidate; a 401 on the first lookup → rejects with status 401 (no second request); a 500 → rejects; a 403 on the first lookup → resolves to the first candidate (no second request; PM ruling 3).
  - `tests/mixed-case-project-commands.test.ts` (spawned built binary, one in-process server that knows a project with name `CliTrustSmoke` and slug `clitrustsmoke`: `GET /api/v1/projects/clitrustsmoke` → 200 `{ "slug": "clitrustsmoke", "name": "CliTrustSmoke" }`, `GET /api/v1/projects/CliTrustSmoke` → 404, `GET /api/v1/projects` → `{ "data": [{ "name": "CliTrustSmoke", "slug": "clitrustsmoke", "environment": "production" }] }`, and 200s for the project-scoped routes under `clitrustsmoke` only; it records every request path). Each case asserts exit 0 and that the project-scoped request went to `/api/v1/projects/clitrustsmoke/...`:
    1. `run start CliTrustSmoke hello -e production` (trigger answered 202 `{ "run": { "id": 1 } }`);
    2. `webhook secret CliTrustSmoke -e production` (webhooks answered `{ "data": [] }` or the shape the command expects — read it);
    3. `env list CliTrustSmoke -e production` (`variable-mappings` answered `[]`);
    4. `schedule list CliTrustSmoke -e production` (`schedules` answered the shape the command expects);
    5. `project view CliTrustSmoke -e production`;
    6. `run list CliTrustSmoke`: the server answers `GET /api/v1/runs?project=CliTrustSmoke…` with `{ "error": "project_not_found" }` only when `project` isn't exactly `CliTrustSmoke` — and the case where the user types `clitrustsmoke`: the first `/api/v1/runs?project=clitrustsmoke` answers `project_not_found`, the CLI looks up `/api/v1/projects`, retries with `project=CliTrustSmoke`, exit 0.
    7. A typo (`run start NoSuchApp hello -e production`) still prints the command's existing not-found message (exit 1), not a stack trace.
    8. (PM ruling 3) A token that may not read the project: the server answers `GET /api/v1/projects/<anything>` with 403 but `POST /api/v1/projects/my-app/workflows/hello/trigger` with 202 → `run start my-app hello -e production` exits 0.
    9. (PM ruling 4) `run list main-app` where `GET /api/v1/projects` lists `Main-App` and `MAIN-APP` (different slugs) and the runs request answers `project_not_found` → exit 1, stderr names both projects and asks for the exact name or slug; no second runs request.
- [ ] **Step 2: Run and see them fail.**
Run: `npm run build && npx vitest run --project unit tests/project-ref.test.ts tests/mixed-case-project-commands.test.ts`
Expected: FAIL.
- [ ] **Step 3: Implement `src/utils/project-ref.ts`.**

```ts
import axios, { AxiosResponse } from 'axios';
import { Config } from './config';
import { getApiHeaders } from './api';
import { buildProjectSlug, slugifyName } from './slug';

/** The slug a command used before cli#161, then the canonical slug — no duplicates, no empty canonical. */
export function projectSlugCandidates(typed: string, environment?: string): string[] {
    const today = environment === undefined || environment === 'production' ? typed : `${typed}-${environment}`;
    const out = [today];
    if (slugifyName(typed) !== '') {
        const canonical = buildProjectSlug(typed, environment ?? 'production');
        if (!out.includes(canonical)) out.push(canonical);
    }
    return out;
}

/**
 * Resolve a user-typed project to the slug the server stores (cli#161): try each candidate, move on only
 * on a 404, and return the server's slug. Any other error propagates to the command's own handling. When
 * every candidate 404s, return the first so the command's existing not-found message runs unchanged.
 */
export async function resolveProjectSlug(config: Config, typed: string, environment?: string): Promise<string> {
    const candidates = projectSlugCandidates(typed, environment);
    for (const candidate of candidates) {
        try {
            // Unencoded, as the commands put the slug into their own URLs (PM ruling 6).
            const response = await axios.get(`${config.host}/api/v1/projects/${candidate}`, { headers: getApiHeaders(config) });
            return (typeof response.data?.slug === 'string' && response.data.slug) || candidate;
        } catch (error: any) {
            // PM ruling 3: a token may be allowed the command's own route but not the project read —
            // a 403 here is not a failure; let the command's own request decide.
            if (error.response?.status === 403) return candidates[0];
            if (error.response?.status !== 404) throw error;
        }
    }
    return candidates[0];
}
```

  plus `getProjectBySlugOrCanonical` moved here verbatim (deploy imports it from `../utils/project-ref`; the test file's import changes accordingly).
- [ ] **Step 4: Use it in every command.** In each listed command, replace the local slug building (`environment === 'production' ? projectName : \`${projectName}-${environment}\``, `projectSlugForView(...)`, or the raw `projectName` in the URL) with `const projectSlug = await resolveProjectSlug(config, projectName, environment);` placed inside the command's existing `try` (so a lookup error reaches the command's existing error branches), before the first project-scoped request; keep the variable names the command already uses. For `project-logs.ts` only the path without `-e` changes (the `-e` path already asks the server to resolve the name). For `env-map.ts` (no environment) call `resolveProjectSlug(config, projectName)`. Keep `state.ts`, `workflow-view.ts` and `project-create.ts` as they are (they already slugify).
  - `run-list.ts`: when the response is `{ error: 'project_not_found' }` and a project argument was given, `GET /api/v1/projects` and match in rungs, stopping at the first rung with a hit: `name === typed`, then `slug === typed`, then `slug === slugifyName(typed)`, then `name.toLowerCase() === typed.toLowerCase()`. If the last rung matches more than one project, refuse (exit 1) with `"<typed>" matches more than one project: <name> (<slug>), … — re-run with the exact name or slug.` (PM ruling 4). If exactly one matches and its name differs from the typed text, repeat the runs request once with `project` set to that name. Otherwise keep the existing message.
  - `src/utils/api.ts` `lookupProjectFamilyEnvironments`: the same rungs; an ambiguous last rung returns `null` (no hint rather than a guess).
  - `deploy.ts`: the webhook hint prints `slugifyName(projectName) || projectName` instead of `projectName`.
- [ ] **Step 5: Run and see them pass.**
Run: `npm run build && npx vitest run --project unit tests/project-ref.test.ts tests/mixed-case-project-commands.test.ts tests/deploy-mixed-case.test.ts tests/api-failure-one-line.test.ts tests/no-raw-error-body.test.ts tests/run-list.test.ts tests/run-start-env-mismatch.test.ts tests/run-start-wait.test.ts tests/env-reset.test.ts tests/env-set-oauth-connection.test.ts tests/env-pull.test.ts tests/schedule*.test.ts tests/project-view*.test.ts tests/webhook*.test.ts`
Expected: PASS. Existing tests whose stub server only answers the old raw slug may now see one extra `GET /api/v1/projects/<slug>` first: if a test fails only because its server 404s or errors on that lookup, extend the stub to answer it (that test file joins your scope; list it in the report). Never weaken an assertion.
- [ ] **Step 6: Report (do not commit).** List every extra test file you pulled into scope and why (PM ruling 6). Manager's commit: `fix: every command resolves a project argument by its canonical slug (#161)`.

---

### Task 5: doc pull writes .html for visual docs and .canvas.json for canvases (cli#157, part 1)

Read spec §5 "Pull writes the right extension". The sa-dev stack must be up for Step 5.

**Files (file scope — the only paths this task may touch):**
- Modify: `src/commands/doc-pull.ts`
- Modify: `tests/doc-pull.test.ts`
- Modify: `tests/live/docs.live.test.ts`
- Modify: `README.md` (the `doc pull` rows/paragraphs that say every doc is `.md`)

**Interfaces:** `DocRow` / `FetchedDoc` gain `docType?: string | null` plus a flag recording whether the listing carried the field (e.g. `docTypeKnown: boolean`).

- [ ] **Step 1: Write the failing tests** in `tests/doc-pull.test.ts`, through the file's spawned helper `runPullCli` and its stub server:
  1. A folder whose `list` rows carry `doc_type: { slug: 'visual' }`, `{ slug: 'canvas' }`, `null`, and `{ slug: 'skill' }` → files `page.html`, `board.canvas.json`, `notes.md`, `skill-doc.md`; the manifest keys match; bodies are byte-identical to the served bodies.
  2. A `list` row WITHOUT a `doc_type` key → the CLI asks `read_doc {id}` for that doc (assert the request) and uses its `doc_type.slug`.
  3. Single-doc pull of a visual doc (`read_doc` returns `doc_type: { slug: 'visual' }`) → `<title>.html`.
  4. Collision: a visual doc `page` and a markdown doc `page` in one folder → `page.html` and `page.md` (no suffix needed); two visual docs whose titles sanitize alike → `x.html`, `x-2.html`.
  5. (PM ruling 2) Rename, unmodified: a directory whose manifest tracks doc 5 at `page.md` (file matches `body_sha256`), and the server now lists doc 5 as visual → exit 0; `page.html` holds the served body; `page.md` is gone; the manifest has doc 5 only at `page.html`; no "deleted remotely" line.
  6. (PM ruling 2) Rename, modified: same, but `page.md` was edited locally → exit 1 before anything is written; stderr names `page.md` and `page.html` and says to rename `page.md` to `page.html` and push it first (or pass `--overwrite`); files and manifest unchanged. With `--overwrite` → exit 0, `page.html` written, the edited `page.md` kept (not deleted) with a warning that it is now untracked, and the manifest tracks only `page.html`.
  7. (PM ruling 2) Single-doc rename: the same two cases through `doc pull <folder>/page` (single-doc fallback) — unmodified leaves no stale `page.md` twin; modified refuses.
- [ ] **Step 2: Run and see them fail.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull.test.ts`
Expected: FAIL on the new cases.
- [ ] **Step 3: Implement** in `src/commands/doc-pull.ts`:
  - `listTree`: keep the row's type: `docType: doc.doc_type == null ? null : (doc.doc_type.slug ?? null)` and `docTypeKnown: Object.prototype.hasOwnProperty.call(doc, 'doc_type')`.
  - Before planning, for every fetched doc with `docTypeKnown === false`, call `callDocsTool(config, { action: 'read_doc', id })` and take `data.doc_type?.slug ?? null` (an error → keep `null`, add a warning `warn: could not read the type of doc <id> (<title>); writing it as .md`).
  - Single-doc fallback: set `docType` from `data.doc_type?.slug ?? null`, `docTypeKnown: true`.
  - `planDocs`: for non-media docs, `const ext = doc.docType === 'visual' ? '.html' : doc.docType === 'canvas' ? '.canvas.json' : '.md';` (media keeps its existing extension logic). Pass `ext` to `allocateName` as today.
  - **Renames (PM ruling 2)**, in `report`, before the existing unpushed-changes check: for every planned doc whose id the previous manifest tracks under a DIFFERENT path `old`, with a file at `old`: if `old` is modified (its bytes' sha256 ≠ the entry's `body_sha256`) and not `--overwrite`, collect it; after the loop, if any were collected, refuse (exit 1, before any write) with, per file, `<old> is now written as <new> (doc <id> changed type); rename <old> to <new> and push it first, or pass --overwrite.` After `commitDocs`, remove each unmodified `old` file (same containment and identity safeguards the deletion loop uses), and with `--overwrite` keep each modified one and warn `! kept <old> — doc <id> is now <new>; <old> is untracked`. Exclude every `old` path handled here from the deletion-propagation loop and its "deleted remotely" messages. This runs for folder pulls and single-doc pulls alike.
  - Update the file's header comment and the kept-modified hint wording if it names `.md` only.
- [ ] **Step 4: Run and see them pass.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull.test.ts tests/doc-push.test.ts tests/docs-manifest.test.ts`
Expected: PASS.
- [ ] **Step 5: Live.** In `tests/live/docs.live.test.ts`, extend the visual/canvas test: after the push, `doc pull ${root}/visual <tmp>` writes `page.html` and `board.canvas.json` with the pushed bytes.
Run: `npm run build && eval "$(scripts/live-test-env.sh)" && npx vitest run --project live tests/live/docs.live.test.ts`
Expected: PASS.
- [ ] **Step 6: README.** Say that `doc pull` writes visual docs as `<title>.html` and canvases as `<title>.canvas.json` (other docs `<title>.md`).
- [ ] **Step 7: Report (do not commit).** Manager's commit: `feat: doc pull writes visual docs as .html and canvases as .canvas.json (#157)`.

---

### Task 6: doc push records the docs it creates in the manifest (cli#157, part 2)

Read spec §5 "Push records the docs it creates". Task 5 changed `doc-pull.ts` and the live test; build on it. The sa-dev stack must be up for Step 5.

**Files (file scope — the only paths this task may touch):**
- Modify: `src/commands/doc-push.ts`
- Modify: `tests/doc-push.test.ts`
- Modify: `tests/live/docs.live.test.ts`
- Modify: `README.md` (replace the "do not round-trip yet" paragraph and the doc push row's manifest note)

**Interfaces:** `BulkCreateResultRow` gains `title?: string` and `current_revision_id?: number | null`, and `id?: string | number`.

- [ ] **Step 1: Write the failing tests** in `tests/doc-push.test.ts`, through the file's spawned helper `runPush`. Make the stub's `bulk_create` answer realistic rows: `{ index, status: 'created', id: 101 + index, title, folder_path, current_revision_id: 500 + index }`.
  1. A directory with no manifest, pushed without `--folder` → a manifest is created with `folder_path: ''` and one entry per created file (`id`, `title`, `current_revision_id`, `media: false`, `body_sha256` = sha256 of the local file bytes).
  2. A pulled directory (manifest `folder_path: 'notes'`) with a new `extra.html` → after the push the manifest has `extra.html` → id, revision; a second push with `extra.html` edited sends `write { id, body, base_revision }` (no `bulk_create`) and updates the entry; a second push with it unchanged sends nothing for it (unchanged).
  3. `--folder other` while the manifest's `folder_path` is `notes` → nothing recorded, and stderr says the created docs were not recorded because they went to `other`, not `notes`.
  4. A `skipped` row and an `error` row are not recorded; a `renamed` row is recorded under the local file's path with the row's (new) title.
  5. `--dry-run` writes no manifest.
  5b. (PM ruling 5) A single-file push (`doc push <dir>/page.html`) into a directory with no manifest creates no manifest; the same push into a directory that has one records the entry.
  5c. (PM ruling 5) A `renamed` row prints `<file>: created as "<title>" (the original title was taken); the next doc pull will name the local file after "<title>"`.
  6. The skip hint for a skipped visual/canvas row still prints.
- [ ] **Step 2: Run and see them fail.**
Run: `npm run build && npx vitest run --project unit tests/doc-push.test.ts`
Expected: FAIL on the new cases.
- [ ] **Step 3: Implement** in `src/commands/doc-push.ts`, after the `bulk_create` loop and before reporting (skip entirely on `--dry-run`):

```ts
    // cli#157: record what this push created, so the next push updates it instead of skipping it.
    // Only when the docs landed in the manifest's own folder tree.
    // PM ruling 5: a single-file push records only into a manifest its directory already has.
    const recordable = !options.dryRun
        && (manifest !== null || !singleFile)
        && (manifest === null || options.folder === undefined || options.folder === manifest.folder_path);
    if (!options.dryRun && !recordable && allResultRows.some((r) => ['created', 'renamed', 'overwritten'].includes(r.status))) {
        process.stderr.write(chalk.yellow(`created docs were not recorded in ${DOCS_MANIFEST}: they went to "${options.folder}", not "${manifest!.folder_path}"\n`));
    }
    if (recordable) {
        const target: DocsManifest = manifest ?? { folder_path: options.folder ?? '', docs: {} };
        let changed = false;
        for (const row of allResultRows) {
            if (!['created', 'renamed', 'overwritten'].includes(row.status) || row.id === undefined) continue;
            const relPath = row.file.split(path.sep).join('/');
            const bytes = fs.readFileSync(path.join(absDir, ...relPath.split('/')));
            if (row.status === 'renamed' && row.title) {
                process.stderr.write(chalk.yellow(`${relPath}: created as "${row.title}" (the original title was taken); the next doc pull will name the local file after "${row.title}"\n`));
            }
            target.docs[relPath] = {
                id: Number(row.id),
                title: row.title ?? path.basename(relPath),
                current_revision_id: row.current_revision_id ?? null,
                media: false,
                body_sha256: sha256Hex(bytes),
            };
            changed = true;
        }
        if (changed) writeManifest(absDir, target);
    }
```

  Adjust names to the file's actual variables (`allResultRows`, `row.file`, `absDir`, `manifest`); `row.file` is relative to `absDir`. Update the file's header comment.
- [ ] **Step 4: Run and see them pass.**
Run: `npm run build && npx vitest run --project unit tests/doc-push.test.ts tests/doc-pull.test.ts tests/docs-manifest.test.ts`
Expected: PASS.
- [ ] **Step 5: Live.** In `tests/live/docs.live.test.ts`, add: push a temp dir with `page.html` into `${root}/round` (no manifest) → a second push after editing `page.html` updates the same doc (`read_doc` shows the new body; no duplicate `page` doc in `listFolder`); then `doc pull ${root}/round` into the same directory writes `page.html` and keeps the manifest consistent.
Run: `npm run build && eval "$(scripts/live-test-env.sh)" && npx vitest run --project live tests/live/docs.live.test.ts`
Expected: PASS.
- [ ] **Step 6: README.** Replace the "Visual docs and canvases do not round-trip yet" paragraph with the new behaviour: pull writes `.html` / `.canvas.json`; push records the docs it creates (when they land in the directory's tracked folder), so pushing again updates them.
- [ ] **Step 7: Report (do not commit).** Manager's commit: `feat: doc push records the docs it creates in the manifest (#157)`.

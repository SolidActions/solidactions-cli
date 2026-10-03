# Wave cli-safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sa-subagent-driven-development to implement this plan task-by-task (the wave's build step). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The CLI sends a key only to the host it was told, never prints a host's userinfo, names the host on every 401, and says which environment `workflow view` is missing. `doc pull` never writes through a link, outside its destination, or over bytes it does not own.

**Architecture:**
- `login`'s host resolution gains `SOLIDACTIONS_HOST`, reusing cli#124's `normalizeHost`.
- One dependency-free `displayHost` helper renders every printed host, enforced by a structural guard test.
- A structural 401 audit fixes the one-line sites and lists the cross-cutting ones.
- `workflow view` gains the family-lookup hint without the shared resolver.
- `doc pull`'s pre-write checks extend from rename targets to every planned write, in one function placed after the rename block.

**Tech Stack:** TypeScript (Node 20+), commander, axios 1.x, vitest 4 (`unit` and `live` projects in `vitest.config.mts`).

**Spec:** `docs/superpowers/specs/2026-10-03-cli-safety-design.md` (cited as "spec §N"; it wins over this plan on any conflict).

**Issues:** cli#170, cli#169, cli#167, cli#163, cli#181, cli#179, cli#173 (SolidActions/solidactions-cli). Approved by Peter in CrewOps ask task-startthenextcli-767c ("Approve: start it now", 2026-10-03). cli#173 is already fixed on main (spec §6) and has no task.

**Plan review:** Fable (task-planreviewcli-9e43) REQUEST CHANGES 5bc563f. The PM accepted all findings (plan card task-planclisafety-7af2), and this revision folds them in, cited as "I<n>/m<n>".

**Mandatory build rulings 9-11** (PM, build card task-buildclisafety-8dde, from Sol's plan re-check task-planrecheckcli-cff2). They override any code block below that disagrees:
- 9 (C1, security): a host that is non-empty but strips to nothing (`/`, `///`) is invalid and refuses. It never falls back to the cloud default. This is in Task 1.
- 10 (R1): the ELOOP case uses a failed renamed-media download whose old path is a self-link. That path actually reaches the old-path resolution, and the test must fail without the fix. This is in Task 4.
- 11 (R2): host-guard exemptions are per interpolation, not per line, with mixed-line guard cases. This is in Task 2.

## Global Constraints

- **Where:** the CLI wave slot `/home/mercer/projects/solid/solidactions-cli/__worktrees/wave-a`, branch `wave/2026-10-03-cli-safety`. Work only there.
- **File scope:** touch only the paths in your task's **Files** block. A change that needs another path is a plan defect: stop and report it.
- **Never commit, stage, stash, switch branches, reset or rebase.** Never create a worktree. The manager commits after the task review.
- **Build before tests:** run `npm run build` after every source change and before every test run (the tests spawn `dist/index.js`).
- **Filtered runs only:** run only the test files your task names (`npx vitest run --project unit tests/<file>.test.ts …`). Never the full suite, never `tests/live/`.
- **Real tests (PM ruling 14 of wave cli-trust, still binding):** new or changed command tests spawn the built binary.
  - Spawn with async `child_process.spawn` of `node dist/index.js …`, against a real in-process `http.createServer`.
  - Use a temp `HOME` whose `~/.solidactions/config.json` points at that server.
  - Remove `SOLIDACTIONS_HOST` / `SOLIDACTIONS_API_KEY` / `SOLIDACTIONS_WORKSPACE_ID` from the child env unless the test sets them on purpose.
  - Assert real stdout, stderr, exit status, and files on disk.
  - Never use `process.exit` / `console` / output-sink substitutions in new or changed tests. No `vi.fn` or `vi.spyOn`; never mock `axios`, `fs` or a module.
  - Pure functions may be unit-tested directly. Existing older tests you don't change keep their helpers. An older test whose expectation you must change is converted to the spawned harness.
  - The spawn pattern to copy: `tests/workspace-list-401.test.ts` (`runCli`).
- **Evidence:** save the raw output of every test run you cite to a log in `/home/mercer/projects/solid/solidactions-cli/__worktrees/wave-a/.superpowers/sdd/2026-10-03-cli-safety/` (`… 2>&1 | tee <log>`), and cite the log next to each count. RED before GREEN for every behaviour change. Describe product diagnostics in passing output accurately; never call output "pristine" when it isn't.
- **No secrets in output:** never print an API key or a config file's `apiKey`.
- **Style:** 4-space indent, single quotes, chalk colours as the surrounding code uses them; status text to stderr, a command's own output to stdout. `doc pull` warnings use its existing yellow `! ` prefix.
- **Report, never commit:** your last step lists every changed path and the test commands you ran with their pass/fail counts and log paths.

## Review Focus

1. **A destination that is a symlink, or a not-yet-created destination under a symlinked ancestor** (`~/link/new`; `/tmp/x` on macOS), must still pull normally (spec §2.1). Task 4 pins both.
2. **`--overwrite` never writes through a link,** including a failed media download whose directory would be created through one (spec §2.2). Task 4 pins it.
3. **The same host spelled differently:** `SOLIDACTIONS_HOST=http://LocalHost:8002/` with `--host http://localhost:8002` must not refuse, while `https://example.com` vs `https://example.com:443` must refuse (cli#124's rule, spec §1). Task 1 pins both.
4. **A first pull into a folder holding same-named files:** different bytes refuse without `--overwrite`, even with `-y`; identical bytes are adopted; a case-only rename onto its own source is not "untracked" (spec §2.4). Task 5 pins all three.
5. **Hosts without userinfo print exactly as before:** `displayHost('http://localhost:8007')` is `http://localhost:8007`. Task 2 pins it.

---

### Task 1: `login` honours SOLIDACTIONS_HOST and refuses a disagreeing --host (cli#170)

**Files (file scope — the only paths this task may touch):**
- Modify: `src/commands/login.ts` (`resolveLoginHost`, `login`)
- Modify: `src/commands/device-login.ts` (its `resolveLoginHost` call and the refusal before any request)
- Modify: `tests/login-host-hint.test.ts` (pure tests of `resolveLoginHost`; update for the new env parameter)
- Create: `tests/login-env-host.test.ts`
- Modify: `README.md` (`### \`solidactions login\` flags` only)

**Interfaces:**
- Consumes: `normalizeHost(host: string): string` from `src/utils/config.ts` (cli#124's rule: trim, strip trailing slashes, lower-case the whole string). Reuse it; do not write a second one (I8).
- Produces:
  - `resolveLoginHost(options: { dev?: boolean; host?: string }, env?: NodeJS.ProcessEnv): { host: string; isDefault: boolean }`. `env` defaults to `process.env`. It throws `LoginHostConflictError` on a disagreement.
  - The returned `host` has trailing slashes stripped (m5).
  - `export class LoginHostConflictError extends Error { flag: string; envHost: string }`.
  - `export class LoginHostInvalidError extends Error { label: string; raw: string }` (ruling 9).

- [ ] **Step 1: Write the failing spawned tests** in `tests/login-env-host.test.ts`. Use the `runCli` pattern from `tests/workspace-list-401.test.ts`, extended so the child env can carry `SOLIDACTIONS_HOST` and the proxy variables. Two servers:
  - `api`: answers `GET /api/v1/workspaces` with `{ "workspaces": { "Org": [{ "id": "ws-1", "slug": "ws-1", "name": "WS", "tenant_name": "Org" }] }, "scope": null }` and records every request path.
  - `proxy`: records every `request` event (method + url) **and every `connect` event** (m1), and answers 502 / closes the socket.

  For every spawned call, set in the child env: `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy` = `http://127.0.0.1:<proxyPort>`, and `NO_PROXY`/`no_proxy` = `127.0.0.1,localhost`.
  1. `SOLIDACTIONS_HOST=http://127.0.0.1:<apiPort>`, `login --stdin --global`, key `sk-test` on stdin.
     - Expect exit 0, and `proxy` saw **0** requests and 0 connects.
     - Expect `api` saw `GET /api/v1/workspaces`, and stdout contains `Host: http://127.0.0.1:<apiPort>`.
     - Expect `<HOME>/.solidactions/config.json`'s `host` to be `http://127.0.0.1:<apiPort>`.
  2. `SOLIDACTIONS_HOST=http://127.0.0.1:<apiPort>` plus `--host https://other.example`: exit 1, stderr contains both `https://other.example` and `SOLIDACTIONS_HOST=http://127.0.0.1:<apiPort>`, `proxy` and `api` saw 0 requests, and no config file was written.
  3. `SOLIDACTIONS_HOST=http://127.0.0.1:<apiPort>/` plus `--host http://127.0.0.1:<apiPort>`: exit 0 (same host).
  4. `SOLIDACTIONS_HOST=http://127.0.0.1:<apiPort>/` alone: exit 0, `api` saw exactly `/api/v1/workspaces` (no `//api`), and the stored `host` has no trailing slash.
  5. `SOLIDACTIONS_HOST=https://example.com` plus `--host https://example.com:443`: exit 1 (ports compare literally, cli#124).
  6. `SOLIDACTIONS_HOST` set plus `--dev`: exit 1, stderr names `--dev (http://localhost:8000)`.
  7. `login --device` with `SOLIDACTIONS_HOST=http://127.0.0.1:<apiPort>` and `--host https://other.example`: exit 1 with the same refusal, before any request.
  8. **Ruling 9:** `SOLIDACTIONS_HOST=/` (and, separately, `///`) with no flag:
     - exit 1, stderr names `SOLIDACTIONS_HOST="/"` as not a usable host;
     - `proxy` saw 0 requests and 0 connects, and `api` saw 0;
     - no config file was written.
     - The same holds for `--host /` with no env, and for `login --device` with `SOLIDACTIONS_HOST=/`.

- [ ] **Step 2: Run them and watch them fail.** Test 1 must show a `proxy` hit (the old code goes to the cloud).
Run: `npm run build && npx vitest run --project unit tests/login-env-host.test.ts 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-1-red.log`
Expected: FAIL. Test 1 records ≥1 proxy request or connect; tests 2, 5, 6, 7 and 8 do not refuse.

- [ ] **Step 3: Implement** in `src/commands/login.ts`:

```ts
import { normalizeHost } from '../utils/config';

export class LoginHostConflictError extends Error {
    constructor(public flag: string, public envHost: string) {
        super(`${flag} disagrees with SOLIDACTIONS_HOST=${displayHost(envHost)}; refusing to send the API key.`);
    }
}

export class LoginHostInvalidError extends Error {
    constructor(public label: string, public raw: string) {
        super(`${label}=${JSON.stringify(raw)} is not a usable host; refusing to send the API key.`);
    }
}

export function resolveLoginHost(
    options: { dev?: boolean; host?: string },
    env: NodeJS.ProcessEnv = process.env,
): { host: string; isDefault: boolean } {
    const strip = (h: string) => h.trim().replace(/\/+$/, '');
    // Ruling 9: a non-empty value that strips to nothing is INVALID, never "absent".
    const usable = (raw: string, label: string): string => {
        const value = strip(raw);
        if (value === '') throw new LoginHostInvalidError(label, raw);
        return value;
    };
    const rawEnv = env.SOLIDACTIONS_HOST;
    const envHost = rawEnv !== undefined && rawEnv.trim() !== '' ? usable(rawEnv, 'SOLIDACTIONS_HOST') : undefined;
    const explicit = options.host !== undefined && options.host !== ''
        ? (() => { const h = usable(options.host, '--host'); return { host: h, flag: `--host ${displayHost(h)}` }; })()
        : options.dev
            ? { host: 'http://localhost:8000', flag: '--dev (http://localhost:8000)' }
            : undefined;
    if (explicit && envHost && normalizeHost(explicit.host) !== normalizeHost(envHost)) {
        throw new LoginHostConflictError(explicit.flag, envHost);
    }
    if (explicit) return { host: explicit.host, isDefault: false };
    if (envHost) return { host: envHost, isDefault: false };
    return { host: 'https://app.solidactions.com', isDefault: true };
}
```

`displayHost` is imported from `../utils/api`. Task 2 later moves it to `../utils/host-display`, and api.ts keeps re-exporting it.

In `login()` and in `device-login.ts`'s caller, wrap the first `resolveLoginHost(options)` call:

```ts
let resolved: { host: string; isDefault: boolean };
try {
    resolved = resolveLoginHost(options);
} catch (error) {
    if (error instanceof LoginHostConflictError) {
        console.error(chalk.red(`error: ${error.message}`));
        console.error(chalk.red('Unset SOLIDACTIONS_HOST or pass the same host to --host.'));
        process.exit(1);
    }
    if (error instanceof LoginHostInvalidError) {
        console.error(chalk.red(`error: ${error.message}`));
        process.exit(1);
    }
    throw error;
}
```

Reading the key from stdin or the prompt before the refusal is fine. What must not happen before it is any network request or any config/backup file write. `src/index.ts` is not in your scope; you should not need it.

- [ ] **Step 4: Update `tests/login-host-hint.test.ts`.** Pass an explicit `env` (`{}`) in its existing `resolveLoginHost` calls so they don't depend on the runner's environment. Add pure cases:
  - `resolveLoginHost({}, { SOLIDACTIONS_HOST: 'http://h:1/' })` gives `{ host: 'http://h:1', isDefault: false }`.
  - `{ host: 'http://H:1/' }` with env `http://h:1` gives no throw.
  - `{ host: 'https://x' }` with env `http://h:1` throws `LoginHostConflictError`.
  - `{ host: 'https://example.com:443' }` with env `https://example.com` throws.
  - `resolveLoginHost({}, { SOLIDACTIONS_HOST: '/' })` and `'///'` throw `LoginHostInvalidError` (ruling 9).
  - `{ host: '/' }` with env `{}` throws `LoginHostInvalidError`.
  - `resolveLoginHost({}, { SOLIDACTIONS_HOST: '  ' })` returns the cloud default: whitespace-only counts as absent.

  These are pure-function tests, which ruling 14 allows.

- [ ] **Step 5: README.** Under `### \`solidactions login\` flags`, add two bullets (do not name `--host`, which stays hidden; m4):
  - "`login` uses `SOLIDACTIONS_HOST` when it is set."
  - "An agent that should be credited as itself in SolidActions (for example, docs it pushes are recorded as Agent) logs the CLI in with its own agent token, not a person's key."

- [ ] **Step 6: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/login-env-host.test.ts tests/login-host-hint.test.ts 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-1-green.log`
Then: `npx vitest run --project unit $(ls tests/*login*.test.ts tests/*device*.test.ts tests/readme-contract.test.ts 2>/dev/null) 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-1-neighbours.log`
Expected: PASS. Any older test that now fails because of the env parameter is fixed within your file scope; name it in the report.

- [ ] **Step 7: Report (do not commit).** List every changed path, each run with its counts and log path, and anything you had to stop on.

---

### Task 2: one host display, structurally guarded; every 401 names its host (cli#163, cli#181)

**Files (file scope):**
- Create: `src/utils/host-display.ts`
- Modify: `src/utils/api.ts` (`displayHost` moves out and is re-exported; the mutation banner ~line 636)
- Modify: `src/commands/login.ts` (whoami Host line ~566, `config.host.padEnd(50)`; `loginHostLines` ~277-279; `login`'s host messages ~467, 488, 490)
- Modify: `src/utils/config.ts` (host values in the refusal strings ~62, 65, 74, 79: `conflict.host`, `conflict.otherHost`, `keyHome`)
- Modify: `src/commands/deploy.ts` (host prints ~747, 773)
- Modify: `src/commands/database-push.ts` (`on ${config.host}` ~259)
- Modify: `src/index.ts` (the `SOLIDACTIONS_DEBUG` dump ~103)
- Modify: `src/utils/workspace-lookup.ts` (`resolveWorkspaceInput`'s catch, ~line 365)
- Modify: `src/commands/skill-run.ts` (the failed-run catch ~200-201, `?? e.message`)
- Modify: `src/commands/crew-env-map-database.ts` (the catch ~71-75)
- Create: `tests/host-display-guard.test.ts` (structural static guard + pure `displayHost` cases)
- Create: `tests/host-userinfo-output.test.ts` (spawned)
- Create: `tests/workspace-override-401.test.ts` (spawned)
- Create: `tests/one-line-401-sites.test.ts` (spawned: skill-run and crew-env-map-database 401s)

A host or 401 site the audit finds outside this list is a plan defect: list it in the report and stop on it only if it is a one-line fix you cannot make within scope. Cross-cutting ones go to the report's FILE list (Step 1).

**Interfaces:**
- Consumes: `resolveLoginHost` from Task 1 (unchanged); `authFailedLine(host)` and `formatApiFailure(status, data)` from `src/utils/api.ts`.
- Produces: `export function displayHost(host: string): string` in `src/utils/host-display.ts`, re-exported by `src/utils/api.ts`.

- [ ] **Step 1: Run the two structural audits and save them** (I6, I7).
  - **Host audit:** every template interpolation in `src/` whose expression names a host.
    Run: `grep -rnE '\$\{[^}]*([Hh]ost|keyHome)[^}]*\}' src | tee .superpowers/sdd/2026-10-03-cli-safety/task-2-audit-host.log`
    Classify each hit, in the report, as:
    - (a) a request URL (the line builds `/api/`, `/oauth/`, `/mcp` or `new URL(`, or is an axios/fetch call argument): leave it;
    - (b) already `displayHost(`: fine;
    - (c) a print or a returned message string: fix with `displayHost(`;
    - (d) allowlisted, with the reason: only `src/utils/mcp.ts` `URL.host` (no userinfo) and `src/utils/source-provenance.ts` (a git remote).
  - **401 audit:** every file that makes an HTTP call.
    Run: `grep -rlE 'axios\.|fetch\(|http\.request|callDocsTool|callMcpTool' src | sort | tee .superpowers/sdd/2026-10-03-cli-safety/task-2-audit-http-files.log`
    For each file, record in the report whether a 401 from its calls reaches `authFailedLine`/`authFailureMessage` (grep it, then read its catch).
    - **Fix** the one-line sites: `src/utils/workspace-lookup.ts`, `src/commands/skill-run.ts`, `src/commands/crew-env-map-database.ts`.
    - **List for the manager to FILE** (do not fix): cross-cutting sites such as `src/utils/mcp.ts`'s `MCP request failed with HTTP ${status}` (the transport for `doc push`/`doc pull`), and calls to non-SolidActions hosts (GitHub, git remotes), each with a one-line reason.

- [ ] **Step 2: Write the failing tests.**
  - `tests/host-display-guard.test.ts`:
    - Put the check in an exported pure function in the test file, `findRawHostInterpolations(source: string): Array<{ line: number; expr: string }>`. It examines **each `${…}` interpolation separately** (ruling 11), never the line as a whole.
    - An interpolation whose expression matches `/([Hh]ost|keyHome)/` is a finding unless:
      - **that expression** is a `displayHost(…)` call;
      - or it **starts a request URL**: the template text right after it begins with `/api/`, `/oauth/` or `/mcp`, AND the template is an argument of `axios.`, `fetch(`, `new URL(` or `projectStatusUrl(`;
      - or it is on an explicit `ALLOWLIST` (file + expression, a reason comment per entry).
    - The test runs the function over every `src/**/*.ts` file and expects no findings.
    - Fixture cases the function must flag (ruling 11):
      - `` console.error(`Cannot reach ${host}/api/v1`) `` (a printed template that merely looks like a URL);
      - `` console.log(`${displayHost(host)} and ${config.host}`) `` (one sanitised, one raw);
      - `` `  Host: ${config.host.padEnd(50)}` ``.
    - Fixture cases it must not flag: `` axios.get(`${config.host}/api/v1/x`) `` and `` console.log(`on ${displayHost(config.host)}`) ``.
    - Pure cases:
      - `displayHost('http://u:p@localhost:8007')` is `http://localhost:8007`;
      - `displayHost('http://localhost:8007')` is `http://localhost:8007`;
      - `displayHost('not a url')` is `not a url`.
  - `tests/host-userinfo-output.test.ts` (spawned): a config with host `http://someuser:somepass@127.0.0.1:<port>`, and a server answering the workspace list, project lookups and a variable write.
    - Run `whoami`; a mutating command that prints the workspace banner (`env set <project> K v -e production --yes`); and `whoami` with `SOLIDACTIONS_DEBUG=1`.
    - Assert stdout+stderr never contain `somepass` or `someuser`, and the Host line shows `http://127.0.0.1:<port>`.
  - `tests/workspace-override-401.test.ts` (spawned): a config with a made-up key; the server answers 401 to everything.
    - Run `-w some-workspace project list`.
    - Assert exit 1, stderr contains `Authentication failed against http://127.0.0.1:<port>`, and the output lacks `Failed to list workspaces`.
    - With userinfo in the host, stderr also lacks it.
  - `tests/one-line-401-sites.test.ts` (spawned): a 401 from the server for the `skill run` call and the `crew env map … database` call. Read the two commands for their exact arguments. Each prints the host-safe 401 line and exits 1.

Run: `npm run build && npx vitest run --project unit tests/host-display-guard.test.ts tests/host-userinfo-output.test.ts tests/workspace-override-401.test.ts tests/one-line-401-sites.test.ts 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-2-red.log`
Expected: FAIL. The guard lists today's raw prints, including login.ts:566; `whoami` prints the userinfo; `-w` prints `Failed to list workspaces: Unauthenticated.`; the two 401 sites print the raw message.

- [ ] **Step 3: Implement.**
  - Create `src/utils/host-display.ts` with the existing `displayHost` body (cut from api.ts). In api.ts, add `import { displayHost } from './host-display';` and `export { displayHost };`.
  - Wrap every class-(c) hit in `displayHost(...)`. For `whoami`, use `displayHost(config.host).padEnd(50)`.
  - In `resolveWorkspaceInput` (workspace-lookup.ts):

```ts
} catch (error: any) {
    const status = error.response?.status;
    if (status === 401) {
        console.error(chalk.red(authFailedLine(config.host)));
    } else if (status) {
        console.error(chalk.red(formatApiFailure(status, error.response.data)));
    } else {
        console.error(chalk.red(`Connection failed: ${error.message}`));
    }
    process.exit(1);
}
```

`authFailedLine` and `formatApiFailure` come from `./api`. The import cycle with api.ts resolves at call time under CommonJS (m9); report it only if it breaks at load time.
  - In skill-run.ts and crew-env-map-database.ts, add the same `status === 401` branch ahead of their existing message, keeping every other path unchanged.

- [ ] **Step 4: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/host-display-guard.test.ts tests/host-userinfo-output.test.ts tests/workspace-override-401.test.ts tests/one-line-401-sites.test.ts tests/no-raw-error-body.test.ts tests/api-failure-one-line.test.ts tests/whoami-workspace.test.ts tests/workspace-list-401.test.ts tests/login-env-host.test.ts 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-2-green.log`
Expected: PASS.

- [ ] **Step 5: Report (do not commit).** Include: paths, both audit tables with each hit's class and decision, the FILE list (cross-cutting 401 sites, with file:line and why), and runs with counts and logs.

---

### Task 3: `workflow view` says which environment is missing (cli#179)

**Files (file scope):**
- Modify: `src/commands/workflow-view.ts` (its error printer, ~line 83-107, and `workflowViewWithConfig` ~109-140)
- Create: `tests/workflow-view-env-hint.test.ts` (spawned)

**Interfaces:**
- Consumes: `lookupProjectFamilyEnvironments(config, projectName)` from `src/utils/api.ts`. Read its exact signature and return shape there first and use it as it is.

- [ ] **Step 1: Write the failing spawned tests.** Set up a server where:
  - `GET /api/v1/projects`, the family lookup, lists project `CliTrustSmoke` with only `production`, and **also a second project whose name contains a newline**, `Cli\nTrust`, with only `production` (m2);
  - the workflow route answers 404 `{ "message": "Project 'x-dev' not found in your active workspace 'ws'." }` for any `-dev` slug, and 200 (a minimal workflow body; copy one from `tests/workflow-view.test.ts`) for `/projects/clitrustsmoke/workflows/hello`;
  - every request path is recorded.

  Cases:
  1. `workflow view CliTrustSmoke Hello`: exit 1, stderr contains `Project "CliTrustSmoke" has no dev environment (exists in: production). Pass -e <env> to target a different environment.`, and lacks `active workspace`.
  2. `workflow view CliTrustSmoke hello -e production`: exit 0, prints `Workflow:`. The first request is the workflow route on the canonical slug `clitrustsmoke`. No `GET /api/v1/projects/<slug>` single-project lookup is made, because the command does not use the resolver (cli#179's read-only regression).
  3. With `GET /api/v1/projects*` answering 403 (a read-only token), `workflow view CliTrustSmoke hello -e production` still exits 0 with the workflow printed.
  4. A project absent from the family (`NoSuch`): stderr shows the server's message, and the exit status is unchanged from today.
  5. `workflow view $'Cli\nTrust' hello`, with the newline in the argument:
     - the hint IS printed (assert `has no dev environment`);
     - the hint's text contains no raw newline between `Project "` and `" has no`, because the name went through `display()`;
     - assert the exact sanitised form `display()` produces (read `display()` first).

Run: `npm run build && npx vitest run --project unit tests/workflow-view-env-hint.test.ts 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-3-red.log`
Expected: FAIL (tests 1 and 5: no hint today).

- [ ] **Step 2: Implement.** The printer is synchronous today, and `environment` is scoped inside `workflowViewWithConfig`'s first `try` (m3). Hoist `environment` out of that `try`, make the printer `async`, and `await` it. Pass it `config`, `project` and `environment`. In the 404 path, before falling back to today's message:

```ts
if (error.response.status === 404) {
    try {
        const family = await lookupProjectFamilyEnvironments(config, project);
        const envs = family?.environments ?? [];
        if (envs.length > 0 && !envs.includes(environment)) {
            console.error(chalk.red(`Project "${display(project)}" has no ${display(environment)} environment (exists in: ${envs.map((e) => display(e)).join(', ')}). Pass -e <env> to target a different environment.`));
            process.exitCode = 1;
            return;
        }
    } catch {
        // fall through to today's message
    }
}
```

Match the printer's existing exit behaviour (`process.exit(1)` or `process.exitCode`), whichever it uses today. Do not call `resolveProjectSlug`.

- [ ] **Step 3: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/workflow-view-env-hint.test.ts tests/workflow-view.test.ts 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-3-green.log`
Expected: PASS.

- [ ] **Step 4: Report (do not commit).**

---

### Task 4: `doc pull` never writes outside the destination or through a link (cli#169)

**Files (file scope):**
- Modify: `src/commands/doc-pull.ts`:
  - a new `resolveOrExplain`, with every `physicalTargetPath` call in `report()` routed through it (today ~828 and ~849);
  - a new `checkPlannedWrites`, called after the rename block and before the unpushed-local-changes check.
- Create: `tests/doc-pull-write-safety.test.ts` (spawned; Task 5 adds to it)
- Modify: `tests/doc-pull-rename-matrix.test.ts` only if a row's expected message changes. It should not, because the rename block runs first. Name any change and why.

**Interfaces:**
- Produces, for Task 5: `checkPlannedWrites(destination: string, planned: PlannedDoc[], previousManifest: DocsManifest | null, options: DocPullOptions, renameMoves: RenameMove[]): void`. Task 4 uses only the first two parameters; Task 5 uses the rest. Hoist the `RenameMove` interface (today declared inside `report()`) to module scope so the signature can name it.
- Placement, stated outright: `checkPlannedWrites` is called **after** the existing rename block (which ends before `handledOldPaths`, ~line 954) and **before** the unpushed-local-changes check and `commitDocs`. The rename block keeps its own messages for rename cases.

- [ ] **Step 1: Write the failing spawned tests** in `tests/doc-pull-write-safety.test.ts`.
  - Reuse the stub server and pull runner pattern of `tests/doc-pull-rename-matrix.test.ts` (copy what you need: list, bulk_read and read_doc responses for a folder with a markdown doc `Note`, a media doc `pic.png`, and a markdown doc `Deep` in subfolder `sub/deeper`).
  - Every case asserts exit status and stderr, every involved file's bytes before and after (including files outside the destination), that no directory was created outside the destination, and that the manifest bytes are unchanged on refusal.
    1. The destination holds `Note.md` as a symlink to a file outside the destination: refuses, with or without `--overwrite`, and the outside file is unchanged.
    2. The destination holds `sub/` as a symlink to a directory outside, and `Deep` lives in `sub/deeper`: refuses with or without `--overwrite`, and no `deeper` directory appears outside.
    3. A symlink inside the destination pointing to another file inside it (`Note.md -> other.md`): refuses, with or without `--overwrite`.
    4. The destination itself is a symlink to a real directory, with no links below it: the pull succeeds and writes into the real directory.
    5. **I1:** the destination does not exist yet and its **parent** is a symlink to a real directory: the pull succeeds.
    6. **I2:** `sub/` links outside, and `pic.png` (planned under `sub/`) fails to download (the stub answers its blob 503): refuses, and no directory is created outside.
    7. **I3:** `Note.md` is a self-referential symlink (`ln -s Note.md Note.md`):
       - (a) no previous manifest: exit 1 with the **symbolic link** message (rule 2);
       - (b) a previous manifest present (from a prior pull, then the self-link created): the same symbolic-link message;
       - (c) **ELOOP pinned (ruling 10).** A previous manifest tracks media doc `pic.png` at `pic.png`. The server now returns it under a new title, so it is renamed to `pic2.png`, and its blob download fails (503). `pic.png` is replaced by a self-referential link (`ln -s pic.png pic.png`). The failed-download path resolves the old path for its cross-doc claim check (`plannedTargetForSource`), so the expected result is exit 1, stderr `cannot resolve pic.png: too many symbolic links (ELOOP)`, nothing written and the manifest unchanged. This case must FAIL on the unfixed code: an uncaught ELOOP stack trace, not the one-line message. A successful replacement never resolves the old path, so it is not used here.
    8. A tracked doc at an unchanged path whose file was replaced by a symlink: refuses, with or without `--overwrite`.

Run: `npm run build && npx vitest run --project unit tests/doc-pull-write-safety.test.ts 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-4-red.log`
Expected: FAIL (cases 1-3, 6, 7 and 8 write through or crash; 4 and 5 may already pass, which is fine; say which).

- [ ] **Step 2: Implement** in doc-pull.ts:

```ts
function linkOnTheWay(destination: string, rel: string): string | null {
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) {
        const abs = path.join(destination, ...parts.slice(0, i));
        try {
            if (fs.lstatSync(abs).isSymbolicLink()) return parts.slice(0, i).join('/');
        } catch {
            return null; // the rest does not exist yet
        }
    }
    return null;
}

function refuseLink(rel: string, link: string, doc: { id: number; title: string }): never {
    const where = link === rel ? '' : ` (or sits under one: ${link})`;
    process.stderr.write(chalk.red(`error: ${rel} is a symbolic link${where}; this pull would write doc ${doc.id} ("${doc.title}") through it.\n`));
    process.stderr.write(chalk.red('Replace it with a regular file or folder and pull again.\n'));
    process.exit(1);
}

/** physicalTargetPath, but a resolution error becomes one line (spec §2.3). A planned target with a link on the way gets rule 2's message. */
function resolveOrExplain(destination: string, rel: string, target?: { id: number; title: string }): string {
    const abs = path.resolve(destination, ...rel.split('/'));
    try {
        return physicalTargetPath(abs);
    } catch (error) {
        if (target) {
            const link = linkOnTheWay(destination, rel);
            if (link !== null) refuseLink(rel, link, target);
        }
        const code = (error as NodeJS.ErrnoException).code ?? 'ERROR';
        const reason = code === 'ELOOP' ? 'too many symbolic links (ELOOP). Fix or remove the link and pull again.' : `${code} ${(error as Error).message}.`;
        process.stderr.write(chalk.red(`error: cannot resolve ${rel}: ${reason}\n`));
        process.exit(1);
    }
}

function checkPlannedWrites(destination: string, planned: PlannedDoc[] /* , previousManifest, options, renameMoves (Task 5) */): void {
    const realDest = physicalTargetPath(path.resolve(destination));
    for (const p of planned) {
        // Every planned doc, including a failed media download: commitDocs still creates its directory (I2).
        const link = linkOnTheWay(destination, p.relPath);
        if (link !== null) refuseLink(p.relPath, link, p.doc);
        const physical = resolveOrExplain(destination, p.relPath, p.doc);
        if (physical !== realDest && !physical.startsWith(realDest + path.sep)) {
            process.stderr.write(chalk.red(`error: ${p.relPath} resolves outside the destination (${physical}); this pull would write doc ${p.doc.id} ("${p.doc.title}") there.\n`));
            process.exit(1);
        }
    }
}
```

In the rename block, replace the `physicalTargetPath(path.resolve(destination, ...p.relPath.split('/')))` call (planned targets) with `resolveOrExplain(destination, p.relPath, p.doc)`. Replace the old-path call (`m.oldRel`, inside `plannedTargetForSource`) with `resolveOrExplain(destination, m.oldRel)`, with no target: an old path is not a write target, so its ELOOP gets the "cannot resolve" line. Case 7c reaches it through the failed-download loop (ruling 10).

- [ ] **Step 3: Run GREEN, the rename matrix and the doc-pull tests.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull-write-safety.test.ts tests/doc-pull-rename-matrix.test.ts tests/doc-pull.test.ts 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-4-green.log`
Expected: PASS. If an older doc-pull test fails because it relied on writing through a link, convert that test to the spawned harness with the new expectation, and name it.

- [ ] **Step 4: Report (do not commit).**

---

### Task 5: `doc pull` never overwrites bytes it does not own (cli#167, cli#169 M2), the prompt text and the README

**Files (file scope):**
- Modify: `src/commands/doc-pull.ts`:
  - `checkPlannedWrites` from Task 4 (rule 4);
  - failed-download recording (rule 5);
  - the rename-cleanup warning (M2);
  - the "not empty" prompt text (~line 578).
- Modify: `tests/doc-pull-write-safety.test.ts` (Task 4 created it)
- Modify: `tests/doc-pull.test.ts` only to convert an older test whose expectation changes (spawned harness). Name each one, and count them in the report.
- Modify: `tests/doc-pull-rename-matrix.test.ts` only for the M2 warning on its cross-alias hard-link row (~lines 747-759). Name the row.
- Modify: `README.md` (`### doc` section only)

**Interfaces:**
- Consumes: `checkPlannedWrites(destination, planned, previousManifest, options, renameMoves)` from Task 4, whose signature already carries these parameters; fill in their use; and the module-scope `RenameMove`, with its `sourceIdentity` and `targetIsSource` fields.

- [ ] **Step 1: Write the failing spawned tests** (add to `tests/doc-pull-write-safety.test.ts`):
  1. A first pull (no manifest) into a destination holding `Note.md` with different bytes, run with `-y`:
     - exit 1;
     - stderr `1 file exists locally but is not tracked:`, then `  Note.md`, then the `--overwrite` hint;
     - `Note.md` is unchanged and no manifest is written.
  2. The same with `--overwrite`: exit 0, and `Note.md` holds the server's body.
  3. A first pull into a destination holding `Note.md` with exactly the server's bytes, run with `-y`: exit 0, adopted, and the manifest tracks `Note.md` with its hash.
  4. A tracked entry with `body_sha256: null` whose file exists with other bytes: refuses without `--overwrite` (same message).
  5. **I4:** an unmodified tracked `Page.md` renamed by the server to `page.md` (a case-only retitle with a changed body), where `page.md` is a hard link to `Page.md`:
     - this stands in for a case-insensitive filesystem; copy how the matrix's same-file row (tests/doc-pull-rename-matrix.test.ts ~629-637) builds it;
     - no `--overwrite`: exit 0, outcome (a) as in the matrix, and **not** the "not tracked" refusal.
  6. A new media doc `pic.png` whose download fails (the stub answers the blob 503), while `pic.png` holds an untracked local file:
     - exit 0, with the warning `! doc <id> ("pic.png") failed to download and pic.png holds a local file; not tracking it`;
     - the manifest has no `pic.png` entry, and the local file is unchanged.
  7. **I5:** the cross-alias hard-link case from the matrix (doc 5's old `page.md` is a hard link of doc 6's new target `other.html`) under `--overwrite` prints `! kept page.md: it is the same file as other.html (a link)`. It names `other.html`, not doc 5's own new path.
  8. **I5:** the matrix's same-file case (`targetIsSource`) prints **no** "kept … same file" warning.
  9. **m7:** a pull into a non-empty destination without `-y`/`--overwrite`, with stdin closed: stdout contains `Pulling overwrites tracked files; local files the folder doesn't track are refused unless --overwrite.` (Prompt handling with no terminal is cli#176, not this task; assert only the printed text.)

Run: `npm run build && npx vitest run --project unit tests/doc-pull-write-safety.test.ts 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-5-red.log`
Expected: FAIL (cases 1, 4, 6, 7 and 9; 5 and 8 must pass both before and after).

- [ ] **Step 2: Implement.**
  - **Rule 4 (spec §2.4), in `checkPlannedWrites`.** Unless `options.overwrite`, collect each planned write that meets all of these:
    - it is not a failed media download;
    - its target is a regular file;
    - `previousManifest?.docs[p.relPath]` is undefined or has `body_sha256 == null`;
    - its current bytes' `sha256Hex` differs from `p.bodySha256`;
    - it is **not** the same file (`dev:ino`) as this doc's own tracked rename source. Look up `renameMoves.find((m) => m.id === p.doc.id)?.sourceIdentity`; this is I4.

    If any were collected, print and exit 1:

```ts
const one = untracked.length === 1;
process.stderr.write(chalk.red(`${untracked.length} ${one ? 'file exists' : 'files exist'} locally but ${one ? 'is' : 'are'} not tracked:\n`));
for (const rel of untracked) process.stderr.write(chalk.red(`  ${rel}\n`));
process.stderr.write(chalk.red('Move them aside and pull again, or pass --overwrite to replace them.\n'));
process.exit(1);
```

  The rename block's own untracked-target check stays as it is (it runs first, with its rename-specific message).
  - **Rule 5, in `report()` after `commitDocs`:** handle a planned media doc with `mediaBytes === null` that is not a rename (renames keep the existing restore-old-entry behaviour). If its target holds a regular file that the previous manifest does not track for that same doc id with a hash, delete its `manifestDocs` entry and write `! doc <id> ("<title>") failed to download and <rel> holds a local file; not tracking it — pull again later` to stderr in yellow.
  - **M2 (I5), in rename cleanup.**
    - Build `writtenPathByIdentity: Map<string, string>` next to `writtenIdentities`.
    - Before the `isSafeToRemoveTrackedFile` skip, when `!m.targetIsSource` and the old path's `dev:ino` is in `writtenPathByIdentity`, write the warning to stderr:

```ts
process.stderr.write(chalk.yellow(`! kept ${m.oldRel}: it is the same file as ${writtenPath} (a link); the extra name is not tracked — remove it yourself if you don't need it\n`));
```

  - **m7:** change `'Pulling will overwrite existing files.'` to `"Pulling overwrites tracked files; local files the folder doesn't track are refused unless --overwrite."`.

- [ ] **Step 3: README** (`### doc` section). Add one paragraph after the "`doc pull --overwrite` is destructive" paragraph:

  "**`doc pull` never writes through a link or over bytes it does not own.** It refuses before writing anything when a target is a symbolic link, sits under a linked folder inside the destination, or resolves outside it, with or without `--overwrite`. A local file the destination does not track (or tracks without a recorded hash) is replaced only with `--overwrite`; `-y` only answers the confirmation. A file that already holds exactly the server's bytes is simply adopted. A media doc whose download fails is not tracked over a local file."

- [ ] **Step 4: Run GREEN, the rename matrix, the doc-pull tests and the README contract.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull-write-safety.test.ts tests/doc-pull-rename-matrix.test.ts tests/doc-pull.test.ts tests/readme-contract.test.ts 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-5-green.log`
Expected: PASS. Older doc-pull tests that pulled with `-y` over an untracked, different-bytes file now refuse: convert each to the spawned harness with the new expectation (or add `--overwrite` where its intent was to overwrite). Name each in the report and give the count.

- [ ] **Step 5: Report (do not commit).**

---

## Self-review (manager)

- **Spec coverage:**
  - §1 → Task 1;
  - §2.1-2.3 and the placement → Task 4;
  - §2.4-2.6, the prompt text and the README → Task 5;
  - §3 and §4 → Task 2;
  - §5 → Task 3;
  - §6 → no task.
- **Plan review coverage:** I1, I2 and I3 → Task 4; I4 and I5 → Task 5; I6 and I7 → Task 2; I8 → Task 1; m1, m4 and m5 → Task 1; m2 and m3 → Task 3; m7 → Task 5; m10 → commit lines removed from task text. m6 and m8 are filed by the manager; m9 and m11 need no change.
- **Shared files:**
  - `src/commands/login.ts`: Tasks 1 and 2 (serial; Task 2 only wraps prints).
  - `src/utils/api.ts`: Task 2 only.
  - `src/commands/doc-pull.ts` and `tests/doc-pull-write-safety.test.ts`: Tasks 4 then 5.
  - `README.md`: Tasks 1 (login section) and 5 (doc section).
- **Filtered runs only; no commit steps:** every `Run:` line is filtered, and every task ends with Report.

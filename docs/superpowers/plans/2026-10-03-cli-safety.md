# Wave cli-safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sa-subagent-driven-development to implement this plan task-by-task (the wave's build step). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The CLI sends a key only to the host it was told, never prints a host's userinfo, names the host on the last 401 path, says which environment `workflow view` is missing, and `doc pull` never writes through a link, outside its destination, or over bytes it does not own.

**Architecture:**
- `login`'s host resolution gains `SOLIDACTIONS_HOST` and a disagreement refusal.
- One dependency-free `displayHost` helper renders every printed host, with a static guard test.
- The `-w` lookup uses the shared 401 line.
- `workflow view` gains the family-lookup hint without the shared resolver.
- `doc pull`'s pre-write checks in `report()` extend from rename targets to every planned write.

**Tech Stack:** TypeScript (Node 20+), commander, axios, vitest 4 (`unit` and `live` projects in `vitest.config.mts`).

**Spec:** `docs/superpowers/specs/2026-10-03-cli-safety-design.md` (cited as "spec §N"; it wins over this plan on any conflict).

**Issues:** cli#170, cli#169, cli#167, cli#163, cli#181, cli#179, cli#173 (SolidActions/solidactions-cli). Approved by Peter in CrewOps ask task-startthenextcli-767c ("Approve: start it now", 2026-10-03). cli#173 is already fixed on main (spec §6) and has no task.

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
- **Style:** 4-space indent, single quotes, chalk colours as the surrounding code uses them; status text to stderr, a command's own output to stdout.
- **Report, never commit:** your last step lists every changed path and the test commands you ran with their pass/fail counts and log paths.

## Review Focus

1. **A destination that is itself a symlink** (`~/docs -> /data/docs`) must still pull normally: containment is measured against `realpath(destination)`, and only links *below* the destination refuse (spec §2.1-2). Task 4 pins it.
2. **`--overwrite` never writes through a link:** a symlinked target or parent refuses even with `--overwrite` (spec §2.2). Task 4 pins it.
3. **Same host spelled differently:** `SOLIDACTIONS_HOST=http://LocalHost:8002/` with `--host http://localhost:8002` must not refuse (spec §1). Task 1 pins it.
4. **A first pull into a folder holding same-named files:** different bytes refuse without `--overwrite`, even with `-y`; identical bytes are adopted silently (spec §2.4). Task 5 pins both.
5. **Hosts without userinfo print exactly as before:** `displayHost('http://localhost:8007')` is `http://localhost:8007` (no trailing-slash or case change). Task 2 pins it.

---

### Task 1: `login` honours SOLIDACTIONS_HOST and refuses a disagreeing --host (cli#170)

**Files (file scope — the only paths this task may touch):**
- Modify: `src/commands/login.ts` (`resolveLoginHost`, `login`)
- Modify: `src/commands/device-login.ts` (its `resolveLoginHost` call, and the refusal before any request)
- Modify: `tests/login-host-hint.test.ts` (pure tests of `resolveLoginHost`; update for the new env parameter)
- Create: `tests/login-env-host.test.ts`
- Modify: `README.md` (`### \`solidactions login\` flags` only)

**Interfaces:**
- Produces:
  - `resolveLoginHost(options: { dev?: boolean; host?: string }, env?: NodeJS.ProcessEnv): { host: string; isDefault: boolean }`. `env` defaults to `process.env`. It throws `LoginHostConflictError` on a disagreement.
  - `export class LoginHostConflictError extends Error { flag: string; envHost: string }`.
  - `export function sameHost(a: string, b: string): boolean`.

- [ ] **Step 1: Write the failing spawned tests** in `tests/login-env-host.test.ts`. Use the `runCli` pattern from `tests/workspace-list-401.test.ts`, extended so the child env can carry `SOLIDACTIONS_HOST` and proxy variables. Two servers:
  - `api`: answers `GET /api/v1/workspaces` with `{ "workspaces": { "Org": [{ "id": "ws-1", "slug": "ws-1", "name": "WS", "tenant_name": "Org" }] }, "scope": null }` and records every request path.
  - `proxy`: records every request it receives (method + url) and answers 502.

  For every spawned call, set in the child env: `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy` = `http://127.0.0.1:<proxyPort>`, and `NO_PROXY`/`no_proxy` = `127.0.0.1,localhost`. axios then sends any request for another host (the cloud) through `proxy`.
  1. `SOLIDACTIONS_HOST=http://127.0.0.1:<apiPort>`, `login --stdin --global`, key `sk-test` on stdin.
     - Expect exit 0, and `proxy` saw **0** requests.
     - Expect `api` saw `GET /api/v1/workspaces`, and stdout contains `Host: http://127.0.0.1:<apiPort>`.
     - Expect `<HOME>/.solidactions/config.json`'s `host` to be `http://127.0.0.1:<apiPort>`.
  2. `SOLIDACTIONS_HOST=http://127.0.0.1:<apiPort>` plus `--host https://other.example`: exit 1, stderr contains both `https://other.example` and `SOLIDACTIONS_HOST=http://127.0.0.1:<apiPort>`, and `proxy` and `api` saw 0 requests. No config file was written.
  3. `SOLIDACTIONS_HOST=http://127.0.0.1:<apiPort>/` plus `--host http://127.0.0.1:<apiPort>`: exit 0 (same host).
  4. `SOLIDACTIONS_HOST` set plus `--dev`: exit 1, stderr names `--dev (http://localhost:8000)`.
  5. `--device` with `SOLIDACTIONS_HOST=http://127.0.0.1:<apiPort>` and `--host https://other.example`: exit 1 with the same refusal, before any request.

- [ ] **Step 2: Run them and watch them fail.** Test 1 must show a `proxy` hit (the old code goes to the cloud).
Run: `npm run build && npx vitest run --project unit tests/login-env-host.test.ts 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-1-red.log`
Expected: FAIL. Test 1 records ≥1 proxy request; tests 2, 4 and 5 exit 0 or try the network.

- [ ] **Step 3: Implement** in `src/commands/login.ts`:

```ts
export class LoginHostConflictError extends Error {
    constructor(public flag: string, public envHost: string) {
        super(`${flag} disagrees with SOLIDACTIONS_HOST=${displayHost(envHost)}; refusing to send the API key.`);
    }
}

function normalizeHost(host: string): string {
    const trimmed = host.trim().replace(/\/+$/, '');
    try {
        const url = new URL(trimmed);
        url.protocol = url.protocol.toLowerCase();
        url.hostname = url.hostname.toLowerCase();
        return url.toString().replace(/\/+$/, '');
    } catch {
        return trimmed;
    }
}

export function sameHost(a: string, b: string): boolean {
    return normalizeHost(a) === normalizeHost(b);
}

export function resolveLoginHost(
    options: { dev?: boolean; host?: string },
    env: NodeJS.ProcessEnv = process.env,
): { host: string; isDefault: boolean } {
    const envHost = env.SOLIDACTIONS_HOST?.trim() || undefined;
    const explicit = options.host
        ? { host: options.host, flag: `--host ${displayHost(options.host)}` }
        : options.dev
            ? { host: 'http://localhost:8000', flag: '--dev (http://localhost:8000)' }
            : undefined;
    if (explicit && envHost && !sameHost(explicit.host, envHost)) {
        throw new LoginHostConflictError(explicit.flag, envHost);
    }
    if (explicit) return { host: explicit.host, isDefault: false };
    if (envHost) return { host: envHost, isDefault: false };
    return { host: 'https://app.solidactions.com', isDefault: true };
}
```

`displayHost` is imported from `../utils/api`. Task 2 later moves it to `../utils/host-display`, and api.ts keeps re-exporting it.

In `login()` and in `device-login.ts`'s caller, wrap the first `resolveLoginHost(options)` call. Make it the first statement, before any prompt, request or file write:

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
    throw error;
}
```

Keep the existing `--stdin`/prompt order otherwise. Reading the key from stdin or the prompt before the refusal is fine. What must not happen before it is any network request or any config/backup file write. `src/index.ts` is not in your scope; you should not need it.

- [ ] **Step 4: Update `tests/login-host-hint.test.ts`.** Pass an explicit `env` (`{}`) in its existing `resolveLoginHost` calls so they don't depend on the runner's environment. Add pure cases:
  - `resolveLoginHost({}, { SOLIDACTIONS_HOST: 'http://h:1' })` gives `{ host: 'http://h:1', isDefault: false }`.
  - `{ host: 'http://H:1/' }` with env `http://h:1` gives no throw.
  - `{ host: 'https://x' }` with env `http://h:1` throws `LoginHostConflictError`.
  - `sameHost('http://LocalHost:8002/', 'http://localhost:8002')` is true.

  These are pure-function tests, which ruling 14 allows.

- [ ] **Step 5: README.** Under `### \`solidactions login\` flags`, add two bullets:
  - "`login` uses `SOLIDACTIONS_HOST` when no `--host` is given, and refuses to run when `--host` names a different host than `SOLIDACTIONS_HOST`."
  - "An agent that should be credited as itself in SolidActions (for example, docs it pushes are recorded as Agent) logs the CLI in with its own agent token, not a person's key."

- [ ] **Step 6: Run GREEN.**
Run: `npm run build && npx vitest run --project unit tests/login-env-host.test.ts tests/login-host-hint.test.ts 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-1-green.log`
Expected: PASS. Then run the neighbours: `npx vitest run --project unit $(ls tests/*login*.test.ts tests/*device*.test.ts 2>/dev/null) 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-1-neighbours.log`. Every test must pass. Any older test that now fails because of the env parameter is fixed within your file scope; name it in the report.

- [ ] **Step 7: Report (do not commit).** List every changed path, each run with its counts and log path, and anything you had to stop on. The manager commits with `git add -- <paths> && git commit -m "fix: login sends the key only to SOLIDACTIONS_HOST or a matching --host (#170)" -- <paths>`.

---

### Task 2: one host display, everywhere; the `-w` lookup names the host on a 401 (cli#163, cli#181)

**Files (file scope):**
- Create: `src/utils/host-display.ts`
- Modify: `src/utils/api.ts` (`displayHost` moves out and is re-exported; the mutation banner line ~636)
- Modify: `src/commands/login.ts` (whoami Host line ~566; `login`'s host messages)
- Modify: `src/utils/config.ts` (host values in refusal messages)
- Modify: `src/utils/workspace-lookup.ts` (`resolveWorkspaceInput`'s catch, ~line 365)
- Modify: any other `src/**/*.ts` file the Step 1 audit finds printing a host or a raw 401. List each in the report; this list is the audit's output.
- Create: `tests/host-display-guard.test.ts` (static guard + pure `displayHost` cases)
- Create: `tests/host-userinfo-output.test.ts` (spawned)
- Create: `tests/workspace-override-401.test.ts` (spawned)

**Interfaces:**
- Consumes: `resolveLoginHost` from Task 1 (unchanged).
- Produces: `export function displayHost(host: string): string` in `src/utils/host-display.ts`, re-exported by `src/utils/api.ts`.

- [ ] **Step 1: Audit and save it.**
Run: `grep -rnE "(console\.|process\.(stderr|stdout)\.write|chalk\.|announce\()" src | grep -E "\\$\{(config\.host|host|resolved\.host|conflict\.host)\}" | grep -v displayHost | tee .superpowers/sdd/2026-10-03-cli-safety/task-2-audit-host.log`
Run: `grep -rnE "Unauthenticated|Authentication failed\.|Failed to list workspaces|response\?\.data\?\.message \|\| error\.message" src | tee .superpowers/sdd/2026-10-03-cli-safety/task-2-audit-401.log`
List every hit in the report with the decision for it: fixed, or not a host/401 print (with why).

- [ ] **Step 2: Write the failing tests.**
  - `tests/host-display-guard.test.ts`: reads every `src/**/*.ts` file line by line. It fails if a line matches the print pattern of the first grep above, interpolates one of the four host values, and does not contain `displayHost(`. Pure cases: `displayHost('http://u:p@localhost:8007')` is `http://localhost:8007`; `displayHost('http://localhost:8007')` is `http://localhost:8007`; `displayHost('not a url')` is `not a url`.
  - `tests/host-userinfo-output.test.ts` (spawned): a config with host `http://someuser:somepass@127.0.0.1:<port>` and a server answering the workspace list and a variable write. Run `whoami`, and a mutating command that prints the workspace banner (`env set <project> K v -e production --yes` against a server answering the project lookup and the write). Assert stdout+stderr never contain `somepass` or `someuser`, and the Host line shows `http://127.0.0.1:<port>`.
  - `tests/workspace-override-401.test.ts` (spawned): a config with a made-up key; the server answers 401 to everything. Run `-w some-workspace project list`. Assert exit 1, stderr contains `Authentication failed against http://127.0.0.1:<port>`, and the output lacks `Failed to list workspaces`. With userinfo in the host, stderr also lacks it.
Run: `npm run build && npx vitest run --project unit tests/host-display-guard.test.ts tests/host-userinfo-output.test.ts tests/workspace-override-401.test.ts 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-2-red.log`
Expected: FAIL (the guard lists today's raw prints; whoami prints the userinfo; `-w` prints `Failed to list workspaces: Unauthenticated.`).

- [ ] **Step 3: Implement.**
  - Create `src/utils/host-display.ts` with the existing `displayHost` body (cut from api.ts). In api.ts, add `import { displayHost } from './host-display';` and `export { displayHost };`.
  - Wrap every audited print in `displayHost(...)`. Request URLs (`${config.host}/api/...` passed to axios) are not prints: leave them.
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

`authFailedLine` and `formatApiFailure` come from `./api`. If that import creates a cycle that breaks at load time, report it rather than restructuring modules.
  - Fix every other 401 hit from the audit the same way (`authFailedLine(config.host)`).

- [ ] **Step 4: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/host-display-guard.test.ts tests/host-userinfo-output.test.ts tests/workspace-override-401.test.ts tests/no-raw-error-body.test.ts tests/api-failure-one-line.test.ts tests/whoami-workspace.test.ts tests/workspace-list-401.test.ts 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-2-green.log`
Expected: PASS.

- [ ] **Step 5: Report (do not commit).** Paths, the audit lists with each decision, runs with counts and logs. Manager's commit: `fix: hosts print without userinfo; the -w lookup names the host on a 401 (#163, #181)`.

---

### Task 3: `workflow view` says which environment is missing (cli#179)

**Files (file scope):**
- Modify: `src/commands/workflow-view.ts` (the 404 branch of its error printer, ~line 103)
- Create: `tests/workflow-view-env-hint.test.ts` (spawned)

**Interfaces:**
- Consumes: `lookupProjectFamilyEnvironments(config, projectName): Promise<{ environments: string[] } | null>` from `src/utils/api.ts`. Read its exact signature there first and use it as it is.

- [ ] **Step 1: Write the failing spawned tests.** A server whose `GET /api/v1/projects` (the family lookup) lists project `CliTrustSmoke` with only `production`, and whose workflow route answers 404 `{ "message": "Project 'clitrustsmoke-dev' not found in your active workspace 'ws'." }` for `/projects/clitrustsmoke-dev/...` and 200 for `/projects/clitrustsmoke/workflows/hello`. Record request paths.
  1. `workflow view CliTrustSmoke Hello`: exit 1, stderr contains `Project "CliTrustSmoke" has no dev environment (exists in: production). Pass -e <env> to target a different environment.`, and lacks `active workspace`.
  2. `workflow view CliTrustSmoke hello -e production`: exit 0, prints `Workflow:`. The first request is the workflow route on the canonical slug `clitrustsmoke`. No `GET /api/v1/projects/<slug>` single-project lookup is made, because the command does not use the resolver (cli#179's read-only regression).
  3. With `GET /api/v1/projects/*` answering 403 (a read-only token), `workflow view CliTrustSmoke hello -e production` still exits 0 with the workflow printed.
  4. A project absent from the family (`NoSuch`): stderr shows the server's message, and the exit status is unchanged from today.
  5. A project name containing a newline (`'Cli\nTrustSmoke'`) never prints a raw newline inside the hint line: the hint goes through `display()`.
Run: `npm run build && npx vitest run --project unit tests/workflow-view-env-hint.test.ts 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-3-red.log`
Expected: FAIL (tests 1 and 5).

- [ ] **Step 2: Implement.** In the 404 path, before falling back to the server message:

```ts
if (error.response.status === 404) {
    try {
        const family = await lookupProjectFamilyEnvironments(config, project);
        const envs = family?.environments ?? [];
        if (envs.length > 0 && !envs.includes(environment)) {
            console.error(chalk.red(`Project "${display(project)}" has no ${display(environment)} environment (exists in: ${envs.map((e) => display(e)).join(', ')}). Pass -e <env> to target a different environment.`));
            process.exit(1);
            return;
        }
    } catch {
        // fall through to today's message
    }
}
```

Thread `config`, `project` and the resolved `environment` into the printer if it lacks them. Keep its exit status. Do not call `resolveProjectSlug`.

- [ ] **Step 3: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/workflow-view-env-hint.test.ts tests/workflow-view.test.ts 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-3-green.log`
Expected: PASS.

- [ ] **Step 4: Report (do not commit).** Manager's commit: `fix: workflow view names the missing environment without the project resolver (#179)`.

---

### Task 4: `doc pull` never writes outside the destination or through a link (cli#169)

**Files (file scope):**
- Modify: `src/commands/doc-pull.ts` (`report()`'s pre-write checks; a resolution-error wrapper around `physicalTargetPath` calls)
- Create: `tests/doc-pull-write-safety.test.ts` (spawned; Task 5 adds to it)
- Modify: `tests/doc-pull-rename-matrix.test.ts` only if a row's expected outcome changes (it should not). Name any change and why.

**Interfaces:**
- Produces, used by Task 5: a pre-write pass in `report()` over every planned doc. Task 5 adds its rules to the same pass. Name the helper `checkPlannedWrites(destination, planned, previousManifest, options)` and call it before the existing unpushed-local-changes check.

- [ ] **Step 1: Write the failing spawned tests** in `tests/doc-pull-write-safety.test.ts`.
  - Reuse the stub server and pull runner pattern of `tests/doc-pull-rename-matrix.test.ts` (copy what you need: list/bulk_read/read_doc responses for a folder with one markdown doc `Note` and one media doc `pic.png`).
  - Cases, each asserting exit status, stderr, every file's bytes before and after, and the manifest bytes unchanged on refusal:
    1. The destination holds `Note.md` as a symlink to a file outside the destination: refuses, with or without `--overwrite`, and the outside file is unchanged.
    2. The destination holds `sub/` as a symlink to a directory outside, and a doc lives in `sub`: refuses, with or without `--overwrite`.
    3. A symlink inside the destination pointing to another file inside it (`Note.md -> other.md`): refuses (rule 2), with or without `--overwrite`.
    4. The destination itself is a symlink to a real directory, with no links below it: the pull succeeds and writes into the real directory.
    5. `Note.md` is a self-referential symlink (`ln -s Note.md Note.md`): exit 1, stderr `cannot resolve Note.md: too many symbolic links (ELOOP)`, nothing written.
    6. A tracked doc at an unchanged path whose file was replaced by a symlink: refuses, with or without `--overwrite`.
Run: `npm run build && npx vitest run --project unit tests/doc-pull-write-safety.test.ts 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-4-red.log`
Expected: FAIL (cases 1-3, 5 and 6 write through or crash; case 4 already passes, which is fine).

- [ ] **Step 2: Implement** `checkPlannedWrites` in doc-pull.ts, called in `report()` before the unpushed-local-changes check and before `commitDocs`:

```ts
function resolveOrExplain(abs: string, rel: string): string {
    try {
        return physicalTargetPath(abs);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'ERROR';
        const reason = code === 'ELOOP' ? 'too many symbolic links (ELOOP). Fix or remove the link and pull again.' : `${code} ${(error as Error).message}.`;
        process.stderr.write(chalk.red(`error: cannot resolve ${rel}: ${reason}\n`));
        process.exit(1);
    }
}

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

function checkPlannedWrites(destination: string, planned: PlannedDoc[]): void {
    const realDest = fs.existsSync(destination) ? fs.realpathSync(destination) : path.resolve(destination);
    for (const p of planned) {
        if (p.isMedia && p.mediaBytes === null) continue; // nothing will be written
        const abs = path.join(destination, ...p.relPath.split('/'));
        const link = linkOnTheWay(destination, p.relPath);
        if (link !== null) {
            const where = link === p.relPath ? '' : ` (or sits under one: ${link})`;
            process.stderr.write(chalk.red(`error: ${p.relPath} is a symbolic link${where}; this pull would write doc ${p.doc.id} ("${p.doc.title}") through it.\n`));
            process.stderr.write(chalk.red('Replace it with a regular file or folder and pull again.\n'));
            process.exit(1);
        }
        const physical = resolveOrExplain(abs, p.relPath);
        if (physical !== realDest && !physical.startsWith(realDest + path.sep)) {
            process.stderr.write(chalk.red(`error: ${p.relPath} resolves outside the destination (${physical}); this pull would write doc ${p.doc.id} ("${p.doc.title}") there.\n`));
            process.exit(1);
        }
    }
}
```

Every other `physicalTargetPath` call in `report()` must also go through `resolveOrExplain` (or run after `checkPlannedWrites`, which has already resolved each planned path), so an ELOOP never escapes as a stack trace. The existing rename symlink check stays; it is now also covered by this pass.

- [ ] **Step 3: Run GREEN, plus the rename matrix and doc-pull tests.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull-write-safety.test.ts tests/doc-pull-rename-matrix.test.ts tests/doc-pull.test.ts 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-4-green.log`
Expected: PASS. If an older doc-pull test fails because it relied on writing through a link, convert that test to the spawned harness with the new expectation, and name it.

- [ ] **Step 4: Report (do not commit).** Manager's commit: `fix: doc pull never writes outside its destination or through a symlink (#169)`.

---

### Task 5: `doc pull` never overwrites bytes it does not own (cli#167, cli#169 M2) and the README

**Files (file scope):**
- Modify: `src/commands/doc-pull.ts` (`checkPlannedWrites` from Task 4; failed-download recording; rename cleanup's skip warning)
- Modify: `tests/doc-pull-write-safety.test.ts` (Task 4 created it)
- Modify: `tests/doc-pull.test.ts` only to convert an older test whose expectation changes (spawned harness). Name each one.
- Modify: `tests/doc-pull-rename-matrix.test.ts` only for the M2 warning on its cross-alias hard-link row (`(c)`/`(a)` rows near the "cross-alias" name). Name the row.
- Modify: `README.md` (`### doc` section only)

**Interfaces:**
- Consumes: `checkPlannedWrites(destination, planned)` from Task 4. Extend its signature to `checkPlannedWrites(destination, planned, previousManifest, options)` and update its single call site.

- [ ] **Step 1: Write the failing spawned tests** (add to `tests/doc-pull-write-safety.test.ts`):
  1. A first pull (no manifest) into a destination holding `Note.md` with different bytes, run with `-y`: exit 1, stderr `1 file exists locally but is not tracked:` then `  Note.md`, then the `--overwrite` hint. `Note.md` is unchanged and no manifest is written.
  2. The same with `--overwrite`: exit 0, and `Note.md` holds the server's body.
  3. A first pull into a destination holding `Note.md` with exactly the server's bytes, run with `-y`: exit 0, adopted, and the manifest tracks `Note.md` with its hash.
  4. A tracked entry with `body_sha256: null` whose file exists with other bytes: refuses without `--overwrite` (same message).
  5. A new media doc `pic.png` whose download fails (the stub answers the blob 503), while `pic.png` holds an untracked local file: exit 0, the warning `doc <id> ("pic.png") failed to download and pic.png holds a local file; not tracking it`. The manifest has no `pic.png` entry and the local file is unchanged.
  6. M2: the cross-alias hard-link case from the matrix (doc 5's old `page.md` is a hard link of doc 6's new target) under `--overwrite` prints `warn: kept page.md: it is the same file as <new> (a link); …`.
Run: `npm run build && npx vitest run --project unit tests/doc-pull-write-safety.test.ts 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-5-red.log`
Expected: FAIL (cases 1, 4, 5 and 6).

- [ ] **Step 2: Implement.**
  - **Rule 4 (spec §2.4), in `checkPlannedWrites`.** Unless `options.overwrite`, collect every planned write whose target is a regular file where `previousManifest?.docs[p.relPath]` is undefined or has `body_sha256 == null`, and whose current bytes' `sha256Hex` differs from `p.bodySha256`. If any were collected, print the plural-aware message and exit 1:

```ts
const noun = untracked.length === 1 ? 'file exists' : 'files exist';
process.stderr.write(chalk.red(`${untracked.length} ${noun} locally but ${untracked.length === 1 ? 'is' : 'are'} not tracked:\n`));
for (const rel of untracked) process.stderr.write(chalk.red(`  ${rel}\n`));
process.stderr.write(chalk.red('Move them aside and pull again, or pass --overwrite to replace them.\n'));
process.exit(1);
```

  The existing rename-target untracked check can stay; this pass covers it too. Remove the duplicate only if it is byte-for-byte redundant, and keep the matrix green.
  - **Rule 5, in `report()` after `commitDocs`:** for a planned media doc with `mediaBytes === null` whose target holds a file the previous manifest does not track with a hash for that same doc id, delete its `manifestDocs` entry and add the warning. A renamed doc's failed download keeps the existing restore-old-entry behaviour.
  - **M2, in rename cleanup:** before the `isSafeToRemoveTrackedFile` skip, when the old path's `dev:ino` is in `writtenIdentities`, write the warning to stderr in the existing yellow `!` style:

```ts
process.stderr.write(chalk.yellow(`! kept ${m.oldRel}: it is the same file as ${m.newRel} (a link); the extra name is not tracked — remove it yourself if you don't need it\n`));
```

- [ ] **Step 3: README** (`### doc` section). Add one paragraph after the "`doc pull --overwrite` is destructive" paragraph:

  "**`doc pull` never writes through a link or over bytes it does not own.** It refuses before writing anything when a target is a symbolic link, sits under a linked folder inside the destination, or resolves outside it, with or without `--overwrite`. A local file the destination does not track (or tracks without a recorded hash) is replaced only with `--overwrite`; `-y` only answers the confirmation. A file that already holds exactly the server's bytes is simply adopted. A media doc whose download fails is not tracked over a local file."

- [ ] **Step 4: Run GREEN, the rename matrix, the doc-pull tests and the README contract.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull-write-safety.test.ts tests/doc-pull-rename-matrix.test.ts tests/doc-pull.test.ts tests/readme-contract.test.ts 2>&1 | tee .superpowers/sdd/2026-10-03-cli-safety/task-5-green.log`
Expected: PASS. Older doc-pull tests that pulled with `-y` over an untracked, different-bytes file now refuse. Convert each to the spawned harness with the new expectation (or add `--overwrite` where its intent was to overwrite), and name each in the report.

- [ ] **Step 5: Report (do not commit).** Manager's commit: `fix: doc pull never overwrites a local file it does not own (#167, #169)`.

---

## Self-review (manager)

- **Spec coverage:** §1 → Task 1; §2.1-2.3 → Task 4; §2.4-2.6 and the README → Task 5; §3 and §4 → Task 2; §5 → Task 3; §6 → no task.
- **Shared files:**
  - `src/commands/login.ts`: Tasks 1 and 2 (serial; Task 2 only wraps prints).
  - `src/utils/api.ts`: Task 2 only.
  - `src/commands/doc-pull.ts` and `tests/doc-pull-write-safety.test.ts`: Tasks 4 then 5.
  - `README.md`: Tasks 1 (login section) and 5 (doc section).
- **Filtered runs only; no commit steps:** every `Run:` line is filtered, and every task ends with Report.

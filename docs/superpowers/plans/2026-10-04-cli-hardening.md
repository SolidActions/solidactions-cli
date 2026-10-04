# Wave cli-hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sa-subagent-driven-development to implement this plan task-by-task (the wave's build step). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `DEBUG=*` never prints the API key, a host with `user:pass@` is refused with one clear line, `doc pull` sanitises the server text it prints, and every remaining 401 (MCP transport, doc media, database, `dev`) prints the host line.

**Architecture:**
- A side-effect module imported first by `src/index.ts` turns off the `follow-redirects` debug namespace before `debug` loads.
- `hostHasUserinfo` joins `displayHost` in `src/utils/host-display.ts`. The config funnel (`requireResolvedConfig`), `whoami` and `resolveLoginHost` refuse a userinfo host.
- Each remaining 401 site prints `authFailedLine(config.host)`: one branch in the MCP transport, two doc media sites, the database error builders, and `runDev`'s two fetches.
- `doc pull` routes its server text through the shared `sanitizeDisplayText`, which also strips C1 controls now.

**Tech Stack:** TypeScript (Node 20+), commander, axios 1.x (follow-redirects, debug 4), vitest 4 (`unit` and `live` projects in `vitest.config.mts`).

**Spec:** `docs/superpowers/specs/2026-10-04-cli-hardening-design.md` (cited as "spec §N"; it wins over this plan on any conflict).

**Issues:** cli#194, cli#195, cli#189, cli#184, cli#185, cli#186, cli#187 (SolidActions/solidactions-cli). Approved by Peter in CrewOps ask task-startcliwavestop-e529 ("Approve: start the wave", 2026-10-04). cli#195's design is Peter's ruling on ask task-cliahostwithuser-922c: "Refuse with a clear message" (recorded on cli#195).

## Global Constraints

- **Where:** the CLI wave slot `/home/mercer/projects/solid/solidactions-cli/__worktrees/wave-a`, branch `wave/2026-10-04-cli-hardening`. Work only there. Every path below is relative to that folder.
- **File scope:** touch only the paths in your task's **Files** block. A change that needs another path is a plan defect: stop and report it.
- **Never commit, stage, stash, switch branches, reset or rebase.** Never create a worktree. The manager commits after the task review.
- **Build before tests:** run `npm run build` after every source change and before every test run (the tests spawn `dist/index.js`).
- **Filtered runs only:** run only the test files your task names (`npx vitest run --project unit tests/<file>.test.ts …`). Never the full suite, never `tests/live/`.
- **Real tests (PM ruling 14 of wave cli-trust, still binding):** new or changed command tests spawn the built binary.
  - Spawn with async `child_process.spawn` of `node dist/index.js …`, against a real in-process `http.createServer` on `127.0.0.1`.
  - Use a temp `HOME` (`makeTmpEnv`/`writeGlobal`/`writeLocal` from `tests/helpers.ts`) whose `~/.solidactions/config.json` points at that server and carries a `workspaceId`, so no workspace lookup runs.
  - Remove `SOLIDACTIONS_HOST` / `SOLIDACTIONS_API_KEY` / `SOLIDACTIONS_WORKSPACE_ID` / `DEBUG` / `NODE_DEBUG` / `FORCE_COLOR` from the child env unless the test sets them on purpose.
  - Assert real stdout, stderr, exit status, and files on disk.
  - Never use `process.exit` / `console` / output-sink substitutions in new or changed tests. No `vi.fn` or `vi.spyOn`; never mock `axios`, `fs` or a module.
  - Pure functions may be unit-tested directly. Existing older tests you don't change keep their helpers. An older test whose expectation you must change is converted to the spawned harness.
  - The spawn pattern to copy: `tests/one-line-401-sites.test.ts` (`runCli`, its server and temp HOME).
- **The 401 line** is always `authFailedLine(config.host)` from `src/utils/api.ts`: `Authentication failed against <host>. Run "solidactions login --global" to re-configure.` Never re-word it, never build it by hand. A 403 at the same site keeps its old text (spec §8).
- **Evidence:** save the raw output of every test run you cite to a log in `/home/mercer/projects/solid/solidactions-cli/__worktrees/wave-a/.superpowers/sdd/2026-10-04-cli-hardening/` (`… 2>&1 | tee <log>`), and cite the log next to each count. RED before GREEN for every behaviour change. Describe product diagnostics in passing output accurately; never call output "pristine" when it isn't.
- **No secrets in output:** never print an API key or a config file's `apiKey`. Test keys are fake literals (`sk-test-…`).
- **Style:** 4-space indent, single quotes, chalk colours as the surrounding code uses them; status text to stderr, a command's own output to stdout.
- **Report, never commit:** your last step lists every changed path and the test commands you ran with their pass/fail counts and log paths.

## Review Focus

1. **A user who names the leaking namespace or Node's own debug** (`DEBUG=follow-redirects`, `DEBUG=*,follow-redirects`, `NODE_DEBUG=http,https,net,tls`) still never sees the key or a host password (spec §1). Task 1 pins all three.
2. **Ordinary hosts keep working** after the userinfo refusal: `http://127.0.0.1:<port>`, `http://localhost:8000`, `https://app.solidactions.com` and the opaque `localhost:8000` are not userinfo, and `http://u@h` (username only) is (spec §2). Task 2 pins them as pure cases and one spawned success.
3. **A 401 after earlier calls succeeded** (doc pull: `list` answers, the next MCP call 401s) prints the host line, writes no file and leaves no manifest (spec §3). Task 3 pins it.
4. **C1 controls and bidi overrides in a doc title** (`\x9b`, `‮`) are stripped from doc pull's messages, not only ESC (spec §5). Task 5 pins both.
5. **`--json` database commands on a 401** print the host line on stderr, nothing on stdout, and exit 1 (spec §6). Task 6 pins `database list --json`.

---

### Task 1: `DEBUG=*` never prints the API key (cli#194)

**Files (file scope — the only paths this task may touch):**
- Create: `src/utils/debug-guard.ts`
- Modify: `src/index.ts` (one import line, first after the shebang)
- Create: `tests/debug-no-secrets.test.ts`
- Modify: `README.md` (the `SOLIDACTIONS_DEBUG=1` paragraph only, ~line 298)

**Interfaces:**
- Consumes: nothing.
- Produces: `guardDebugNamespaces(env?: NodeJS.ProcessEnv): void` in `src/utils/debug-guard.ts`; the module calls it on load.

- [ ] **Step 1: Write the failing tests** in `tests/debug-no-secrets.test.ts`.
  - Server: answers `GET /api/v1/projects` (and any other GET) 200 with `{ "data": [] }`, records every request.
  - Temp HOME with global config `{ host: 'http://127.0.0.1:<port>', apiKey: 'sk-test-DEBUGLEAK-0123456789', workspaceId: 'ws-1', workspace: 'ws-1' }`.
  - Spawned cases, each `node dist/index.js project list`, asserting `stderr` and `stdout` do **not** contain `sk-test-DEBUGLEAK-0123456789` and do not contain `DEBUGLEAK`:
    1. `DEBUG=*`: also expect the server saw ≥1 request (the request really ran).
    2. `DEBUG=follow-redirects`.
    3. `DEBUG=*,follow-redirects`.
    4. `NODE_DEBUG=http,https,net,tls` (no `DEBUG`).
  - Userinfo case: global config host `http://user:pw-DEBUGLEAK@127.0.0.1:<port>`, `DEBUG=*`, `project list`: stderr and stdout contain neither `pw-DEBUGLEAK` nor the key. Assert nothing about the exit code or the server: Task 2 makes this host refuse before any request, and this test must stay green after it.
  - Pure cases for `guardDebugNamespaces` (import from `../src/utils/debug-guard`, pass an env object):
    - `{}` stays `{}` (no `DEBUG` key added).
    - `{ DEBUG: '' }` and `{ DEBUG: '  ' }` are unchanged.
    - `{ DEBUG: '*' }` becomes `'*,-follow-redirects'`.
    - `{ DEBUG: '*,-follow-redirects' }` is unchanged (idempotent: `dev`'s tsx re-exec loads the guard twice).
    - `{ DEBUG: 'express:* -follow-redirects' }` is unchanged (debug splits on spaces and commas).

- [ ] **Step 2: Run them and watch them fail.**
Run: `npm run build && npx vitest run --project unit tests/debug-no-secrets.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-1-red.log`
Expected: FAIL. Case 1 finds the key in stderr (`Authorization: 'Bearer sk-test-DEBUGLEAK…'` from follow-redirects); the pure cases fail on the missing module. If case 1 does not show the key on the unfixed build, stop and report: the RED is the evidence the fix is real.

- [ ] **Step 3: Implement** `src/utils/debug-guard.ts`:

```ts
/**
 * cli#194: axios sends every request through follow-redirects, whose `debug`
 * namespace dumps the request options (the Authorization header with the API
 * key, and a URL's userinfo). `debug` reads DEBUG once, when it first loads,
 * and a skip (`-name`) beats any match (`*`), so appending the skip here —
 * before anything can load `debug` — keeps the key out of DEBUG output while
 * every other namespace still works. src/index.ts imports this module first.
 */
const SKIP = '-follow-redirects';

export function guardDebugNamespaces(env: NodeJS.ProcessEnv = process.env): void {
    const value = env.DEBUG;
    if (value === undefined || value.trim() === '') {
        return;
    }
    if (value.split(/[\s,]+/).includes(SKIP)) {
        return;
    }
    env.DEBUG = `${value},${SKIP}`;
}

guardDebugNamespaces();
```

In `src/index.ts`, make this the first import, directly under `#!/usr/bin/env node` and above `import chalk from 'chalk';`:

```ts
// Must stay first: it edits DEBUG before any dependency can load `debug` (cli#194).
import './utils/debug-guard';
```

Check `dist/index.js` after the build: its first `require(...)` must be `./utils/debug-guard`.

- [ ] **Step 4: README.** Append to the paragraph that starts "Set `SOLIDACTIONS_DEBUG=1` on any command" (~line 298): "Node's generic `DEBUG` variable never prints your API key: the CLI turns off the HTTP library's `follow-redirects` debug output, which would dump request headers."

- [ ] **Step 5: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/debug-no-secrets.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-1-green.log`
Then: `npx vitest run --project unit tests/readme-contract.test.ts tests/host-display-guard.test.ts tests/dev-relative-entry.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-1-neighbours.log`
Expected: PASS.

- [ ] **Step 6: Report (do not commit).** List every changed path, each run with its counts and log path, and anything you had to stop on.

---

### Task 2: a host with `user:pass@` is refused with one clear line (cli#195)

**Files (file scope):**
- Modify: `src/utils/host-display.ts` (add `hostHasUserinfo`)
- Modify: `src/utils/config.ts` (add `userinfoHostMessage`, next to `credentialConflictMessage`)
- Modify: `src/utils/api.ts` (`requireResolvedConfig`, ~331-344)
- Modify: `src/commands/login.ts` (`LoginHostUserinfoError`, `resolveLoginHost` ~125-153, `resolveLoginHostOrExit` ~159-174, `whoami` ~585-596)
- Modify: `tests/login-host-hint.test.ts` (pure `resolveLoginHost` cases)
- Create: `tests/host-userinfo-refused.test.ts` (spawned, plus pure `hostHasUserinfo` cases)
- Modify: `tests/host-userinfo-output.test.ts` (only if a case now refuses; Step 6 says how)
- Modify: `README.md` (`### \`solidactions login\` flags` only)

**Interfaces:**
- Consumes: `displayHost(host: string): string` (src/utils/host-display.ts); `describeSource` (private, src/utils/config.ts); `ConfigSource` type.
- Produces:
  - `export function hostHasUserinfo(host: string): boolean` in src/utils/host-display.ts.
  - `export function userinfoHostMessage(host: string, source: ConfigSource): string` in src/utils/config.ts.
  - `export class LoginHostUserinfoError extends Error { label: string; host: string }` in src/commands/login.ts.

- [ ] **Step 1: Write the failing tests** in `tests/host-userinfo-refused.test.ts`.
  - Pure `hostHasUserinfo`:
    - false: `http://127.0.0.1:8002`, `http://localhost:8000`, `https://app.solidactions.com`, `localhost:8000`, `http://h/path@x` (the `@` is in the path, not the authority).
    - true: `http://u:p@h`, `http://u@h`, `http://u:p@h:bad-port`, `u:secret@host`.
  - Spawned. The server records every request and answers `GET /api/v1/projects` 200 `{ "data": [] }`, `GET /api/v1/workspaces` 200 with one workspace, and `POST /mcp` 200 with an empty folder (`{ jsonrpc: '2.0', id: 1, result: { isError: false, content: [{ type: 'text', text: '{"folders":[],"docs":[]}' }] } }`).
    1. Global config host `http://user:pw-SECRET@127.0.0.1:<port>`, `project list`: exit 1. Stderr contains `the host "http://127.0.0.1:<port>"` and `contains a username/password` and `remove "user:pass@"`. Stderr and stdout have no `pw-SECRET`. The server saw **0** requests.
    2. The same config, `doc pull Some/Folder <tmp>/out` (MCP path): exit 1 with the same line, 0 requests, `<tmp>/out` not created.
    3. The same config, `whoami`: exit 1, same line, no `pw-SECRET`.
    4. No config file, env `SOLIDACTIONS_HOST=http://user:pw-SECRET@127.0.0.1:<port>` and `SOLIDACTIONS_API_KEY=sk-test-x`, `project list`: exit 1, the line names `$SOLIDACTIONS_HOST` as the source, 0 requests.
    5. Username only: global config host `http://user@127.0.0.1:<port>`, `project list`: exit 1, 0 requests.
    6. `login --stdin --global --host http://user:pw-SECRET@127.0.0.1:<port>`, key `sk-test-x` on stdin: exit 1, stderr contains `--host "http://127.0.0.1:<port>" contains a username/password`, 0 requests, no `<HOME>/.solidactions/config.json` written.
    7. `login --stdin --global` with env `SOLIDACTIONS_HOST=http://user:pw-SECRET@127.0.0.1:<port>`: exit 1, `SOLIDACTIONS_HOST "http://127.0.0.1:<port>"` in stderr, 0 requests, no config written.
    8. `login --device --global` with the same env: exit 1, same line, 0 requests.
    9. Control: global config host `http://127.0.0.1:<port>` (no userinfo), `project list`: exit 0 and the server saw `GET /api/v1/projects`.

- [ ] **Step 2: Run them and watch them fail.**
Run: `npm run build && npx vitest run --project unit tests/host-userinfo-refused.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-2-red.log`
Expected: FAIL. Cases 1-8 send requests or write config (and the pure cases fail on the missing export). Case 9 passes.

- [ ] **Step 3: Implement.**

`src/utils/host-display.ts`, below `displayHost`:

```ts
/**
 * True when a host carries userinfo (`user:pass@`, `user@`). axios turns URL
 * userinfo into a Basic Authorization header that replaces the Bearer key, so
 * such a host can never authenticate; config resolution and login refuse it
 * (cli#195, Peter's ruling on CrewOps ask task-cliahostwithuser-922c).
 */
export function hostHasUserinfo(host: string): boolean {
    try {
        const url = new URL(host);
        if (url.host !== '') {
            return url.username !== '' || url.password !== '';
        }
    } catch {
        // Not a URL `new URL` accepts: look at the authority by hand below.
    }
    return /^([a-z][a-z0-9+.-]*:\/\/)?[^/?#]*@/i.test(host);
}
```

`src/utils/config.ts`, next to `credentialConflictMessage` (it already imports `displayHost`):

```ts
/** The refusal for a resolved host that carries userinfo (cli#195). Never includes the userinfo. */
export function userinfoHostMessage(host: string, source: ConfigSource): string {
    return `error: the host "${displayHost(host)}" (from ${describeSource(source, 'SOLIDACTIONS_HOST')}) contains a username/password; remove "user:pass@" — the CLI authenticates with your API key.`;
}
```

`src/utils/api.ts` `requireResolvedConfig`, after the `credentialConflict` block and before the "Not initialized" check:

```ts
    if (resolved && hostHasUserinfo(resolved.config.host)) {
        console.error(chalk.red(userinfoHostMessage(resolved.config.host, resolved.sources.host)));
        process.exit(1);
    }
```

(import `hostHasUserinfo` from `./host-display` and `userinfoHostMessage` from `./config`.)

`src/commands/login.ts` `whoami`: the same block after its `credentialConflict` block.

`src/commands/login.ts`, next to `LoginHostInvalidError`:

```ts
export class LoginHostUserinfoError extends Error {
    constructor(public label: string, public host: string) {
        super(`${label} "${displayHost(host)}" contains a username/password; remove "user:pass@" — the CLI authenticates with your API key.`);
    }
}
```

In `resolveLoginHost`, check each supplied value right after `usable(...)` returns it, before the disagreement check:

```ts
    const noUserinfo = (host: string, label: string): string => {
        if (hostHasUserinfo(host)) throw new LoginHostUserinfoError(label, host);
        return host;
    };
    const envHost = rawEnv !== undefined && rawEnv.trim() !== ''
        ? noUserinfo(usable(rawEnv, 'SOLIDACTIONS_HOST'), 'SOLIDACTIONS_HOST')
        : undefined;
    const explicitHostFlag = (raw: string) => {
        const host = noUserinfo(usable(raw, '--host'), '--host');
        return { host, flag: `--host ${displayHost(host)}` };
    };
```

In `resolveLoginHostOrExit`, add the third branch:

```ts
        if (error instanceof LoginHostUserinfoError) {
            console.error(chalk.red(`error: ${error.message}`));
            process.exit(1);
        }
```

- [ ] **Step 4: Pure cases** in `tests/login-host-hint.test.ts` (keep the explicit `env` argument its existing calls pass):
  - `resolveLoginHost({}, { SOLIDACTIONS_HOST: 'http://u:p@h:1' })` throws `LoginHostUserinfoError` whose message has no `p@` and names `http://h:1`.
  - `resolveLoginHost({ host: 'http://u@h:1' }, {})` throws `LoginHostUserinfoError`.
  - `resolveLoginHost({ host: 'http://u:p@h:1' }, { SOLIDACTIONS_HOST: 'https://other' })` throws `LoginHostUserinfoError` (the userinfo refusal comes before the disagreement).
  - `resolveLoginHost({ host: 'http://localhost:8000' }, {})` returns `{ host: 'http://localhost:8000', isDefault: false }`.

- [ ] **Step 5: README.** Under `### \`solidactions login\` flags`, add one bullet (do not name `--host`, which stays hidden): "A host with a username and password in it (`http://user:pass@host`) is refused: the CLI authenticates with your API key."

- [ ] **Step 6: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/host-userinfo-refused.test.ts tests/login-host-hint.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-2-green.log`
Then: `npx vitest run --project unit tests/debug-no-secrets.test.ts tests/host-display-guard.test.ts tests/host-userinfo-output.test.ts tests/login-env-host.test.ts tests/readme-contract.test.ts tests/workspace-list-401.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-2-neighbours.log`
Expected: PASS. `tests/host-userinfo-output.test.ts` (wave cli-safety) prints hosts with userinfo on purpose; if one of its cases now refuses instead of printing, convert that case to assert the refusal (still no password in output) and name it in the report.

- [ ] **Step 7: Report (do not commit).** List every changed path, each run with its counts and log path, and anything you had to stop on.

---

### Task 3: the MCP transport names the host on a 401 (cli#184)

**Files (file scope):**
- Modify: `src/utils/mcp.ts` (`postMcpTool`, the status checks after the 429 loop, ~123-129; imports)
- Create: `tests/mcp-401-host.test.ts` (spawned)

**Interfaces:**
- Consumes: `authFailedLine(host: string): string` from `src/utils/api.ts` (mcp.ts already imports `getApiHeaders` from there).
- Produces: nothing new. `postMcpTool` exits 1 on a 401 after printing the line, for every caller (`callDocsTool`, `callCrewsTool`, `callCrewsToolContent`).

- [ ] **Step 1: Write the failing tests** in `tests/mcp-401-host.test.ts`. The server answers `POST /mcp` by a per-test mode:
  - `'401'`: status 401, body `{"message":"RAW-401-BODY"}`.
  - `'403'`: status 403, body `{"message":"RAW-403-BODY"}`.
  - `'list-then-401'`: the first `/mcp` call answers 200 with one doc (`{"folders":[],"docs":[{"id":7,"title":"Doc","folder_path":"F","updated_at":"2026-10-01T00:00:00Z"}]}` as the text block; copy the exact `list` shape from `tests/doc-pull.test.ts`), every later call answers 401.

  Temp HOME, global config `{ host: 'http://127.0.0.1:<port>', apiKey: 'sk-test-x', workspaceId: 'ws-1', workspace: 'ws-1' }`. Expected line: `Authentication failed against http://127.0.0.1:<port>. Run "solidactions login --global" to re-configure.`
  1. Mode 401, `doc pull F <tmp>/out`: exit 1, stderr contains the line, no `RAW-401-BODY`, no `MCP request failed`. `<tmp>/out` has no files.
  2. Mode 401, `skill list`: exit 1, the line, no raw body.
  3. Mode 401, `role pull some-role <tmp>/role`: exit 1, the line, no raw body.
  4. Mode 401, `doc push <tmp>/docs` where `<tmp>/docs/a.md` exists: exit 1, the line, no raw body.
  5. Mode `list-then-401`, `doc pull F <tmp>/out`: exit 1, the line. No file under `<tmp>/out` and no manifest written (Review Focus 3).
  6. Mode 403, `skill list`: exit 1 and stderr still contains `MCP request failed with HTTP 403` (unchanged), and no `Authentication failed`.
  - A userinfo host in the config would now refuse before any request (Task 2), so these tests use a plain host.
  - Confirm each command name and argument shape with `node dist/index.js <group> <cmd> --help` before writing the case.

- [ ] **Step 2: Run them and watch them fail.**
Run: `npm run build && npx vitest run --project unit tests/mcp-401-host.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-3-red.log`
Expected: FAIL on cases 1-5 (`MCP request failed with HTTP 401: {"message":"RAW-401-BODY"}`); case 6 passes.

- [ ] **Step 3: Implement** in `src/utils/mcp.ts`. Add `import chalk from 'chalk';`, extend the api import to `import { authFailedLine, getApiHeaders } from './api';`, and put the branch first among the status checks:

```ts
    if (last.status === 401) {
        // One transport-level 401 branch for every MCP caller (cli#184): the host
        // line every other command prints, never the raw body.
        process.stderr.write(`${chalk.red(authFailedLine(config.host))}\n`);
        process.exit(1);
    }
    if (last.status === 404) {
```

- [ ] **Step 4: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/mcp-401-host.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-3-green.log`
Then: `npx vitest run --project unit tests/mcp-retry-after.test.ts tests/skill-list.test.ts tests/doc-pull.test.ts tests/doc-push.test.ts tests/no-raw-error-body.test.ts tests/one-line-401-sites.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-3-neighbours.log`
Expected: PASS. An older in-process test that now dies on `process.exit` because it stubs a 401 is a finding: stop and report it with the test name, do not edit it.

- [ ] **Step 5: Report (do not commit).** List every changed path, each run with its counts and log path, and anything you had to stop on.

---

### Task 4: doc media requests name the host on a 401 (cli#185)

**Files (file scope):**
- Modify: `src/commands/doc-push.ts` (the tracked media upload catch, ~614-632)
- Modify: `src/commands/doc-pull.ts` (`resolveMedia`, the `confirm.status !== 200` branch, ~125-139). Task 5 edits other lines of this file later.
- Create: `tests/doc-media-401.test.ts` (spawned)

**Interfaces:**
- Consumes: `authFailedLine(host: string): string` from `src/utils/api.ts` (add it to each file's existing `../utils/api` import).
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests** in `tests/doc-media-401.test.ts`. Build the fixtures the way `tests/doc-pull.test.ts` and `tests/doc-push.test.ts` build a media doc and a tracked media file (manifest shape, MCP `list`/`bulk_read` answers, the `/api/v1/docs/<id>/media` routes). Expected line as in Task 3.
  1. `doc pull` of a folder holding one media doc, where `GET /api/v1/docs/<id>/media` answers 401 `{"code":"unauthenticated","message":"RAW-401"}`: exit 1, stderr has the line, no `unknown_error`, no `unauthenticated:`, no `RAW-401`. No file written under the destination.
  2. The same with the confirm answering 403 `{"code":"forbidden","message":"nope"}`: exit 1 and stderr still has `error: forbidden: nope`.
  3. `doc push` of a folder with a tracked media file (manifest entry with `id`), where `POST /api/v1/docs/<id>/media` answers 401 `{"message":"RAW-401"}`: exit 1, the line, no `RAW-401`, no `error: <file>:` line.
  4. The same upload answering 500 `{"message":"boom"}`: exit 1 and stderr still has `error: <relPath>: boom`.

- [ ] **Step 2: Run them and watch them fail.**
Run: `npm run build && npx vitest run --project unit tests/doc-media-401.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-4-red.log`
Expected: FAIL on 1 and 3; 2 and 4 pass.

- [ ] **Step 3: Implement.**

`src/commands/doc-pull.ts` `resolveMedia`, before the `confirm.status !== 200` branch:

```ts
    if (confirm.status === 401) {
        process.stderr.write(`${chalk.red(authFailedLine(config.host))}\n`);
        process.exit(1);
    }
```

`src/commands/doc-push.ts`, in the upload catch, after the 404 `doc_not_found` branch and before the generic `error: ${relPath}: …` line:

```ts
            if (status === 401) {
                process.stderr.write(`${chalk.red(authFailedLine(config.host))}\n`);
                process.exit(1);
            }
```

- [ ] **Step 4: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/doc-media-401.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-4-green.log`
Then: `npx vitest run --project unit tests/doc-pull.test.ts tests/doc-push.test.ts tests/doc-pull-write-safety.test.ts tests/doc-pull-rename-matrix.test.ts tests/host-display-guard.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-4-neighbours.log`
Expected: PASS.

- [ ] **Step 5: Report (do not commit).** List every changed path, each run with its counts and log path, and anything you had to stop on.

---

### Task 5: `doc pull` sanitises the server text it prints (cli#189)

**Files (file scope):**
- Modify: `src/commands/doc-pull.ts` (every message that interpolates server text; see the list in Step 3). Task 4 edited `resolveMedia` earlier; keep its 401 branch.
- Modify: `src/utils/source-provenance.ts` (`DISPLAY_FORMATTING`, ~39)
- Create: `tests/doc-pull-display-text.test.ts` (spawned, plus pure `sanitizeDisplayText` cases)

**Interfaces:**
- Consumes: `sanitizeDisplayText(value: unknown, maxLength?: number): string | null` from `src/utils/source-provenance.ts`.
- Produces: a module-private helper `shown(value: unknown): string` in doc-pull.ts.

- [ ] **Step 1: Write the failing tests** in `tests/doc-pull-display-text.test.ts`. Spawn with `FORCE_COLOR=0`, so the only control characters in stderr can come from the server. Use the title `T` = `'Evil\x1b[31mRED\x07\x9b2J‮X'`.
  - Pure: `sanitizeDisplayText(T)` equals `'Evil[31mRED2JX'` (ESC, BEL, C1 CSI and the bidi override removed).
  - Spawned, each asserting stderr contains `Evil[31mRED2JX` and contains none of `\x1b`, `\x07`, `\x9b`, `‮`:
    1. **The "not a regular file" refusal:** a doc titled `T` whose target path (derive it from the sanitised file name the pull writes; run the pull once into an empty folder to see it) is a **directory** in the destination. Exit 1.
    2. **A bulk_read skip warning:** `bulk_read` answers the doc with `status: 'error\x1b[2J'`. Stderr has the `warn: skipping doc` line with the title and status both sanitised.
    3. **A failed media download warning:** a media doc titled `T` whose signed download URL answers 500. Stderr has the `warn: failed to download media` line with the title sanitised.
    4. **The media confirm error:** the confirm answers 403 `{"code":"forbidden\x1b[2J","message":"no\x9bpe"}`. Stderr has `error: forbidden[2J: nope`.
  - Reuse the MCP and media fixtures from `tests/doc-pull.test.ts`.

- [ ] **Step 2: Run them and watch them fail.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull-display-text.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-5-red.log`
Expected: FAIL. Raw control characters reach stderr; the pure case keeps `\x9b`.

- [ ] **Step 3: Implement.**

`src/utils/source-provenance.ts`: add the C1 range to the class:

```ts
const DISPLAY_FORMATTING = /[\x00-\x1f\x7f-\x9f؜​-‏‪-‮⁠⁦-⁩﻿]/g;
```

`src/commands/doc-pull.ts`: import `sanitizeDisplayText` from `../utils/source-provenance`, and add near the top-level helpers:

```ts
/** Server text (a title, a status, an error code or message) as printed in a message (cli#189). */
function shown(value: unknown): string {
    return sanitizeDisplayText(value, 255) ?? '(untitled)';
}
```

Wrap every interpolation of server text in a printed message with `shown(…)`. Today (line numbers from c0c7866; find each by its text):
- ~137: `` `error: ${code}: ${message}` `` → `` `error: ${shown(code)}: ${shown(message)}` ``
- ~145: `(${doc.title})` in the media download warning
- ~264: `(${original.title})` and `"${row.status ?? 'unknown'}"`
- ~278: `(${requested.title})`
- ~310: `(${doc.title})`
- ~728: `("${doc.title}")`
- ~796: `("${p.doc.title}")`
- ~983-984: `oldTitle` (the manifest's title, written from a server title) and `taker.doc.title`
- ~996: `m.title` and `taker.doc.title`
- ~1011, ~1045, ~1075: `m.title`
- ~1115: `(${p.doc.title})`
- ~1142: `("${p.doc.title}")`

Then grep the file for any other `title}`, `.message`, `.code` or `status` inside a printed template that comes from the server, and wrap it too; list each one in the report. Do not change file names: they already come from `sanitizeTitle`/`sanitizeSegment`.

- [ ] **Step 4: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull-display-text.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-5-green.log`
Then: `npx vitest run --project unit tests/doc-pull.test.ts tests/doc-pull-write-safety.test.ts tests/doc-pull-rename-matrix.test.ts tests/doc-media-401.test.ts tests/workflow-view.test.ts $(ls tests/*provenance*.test.ts 2>/dev/null) 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-5-neighbours.log`
Expected: PASS. A matrix row whose expected message quoted a title still matches, because its titles are plain text.

- [ ] **Step 5: Report (do not commit).** List every changed path, each run with its counts and log path, and anything you had to stop on.

---

### Task 6: database commands name the host on a 401 (cli#186)

**Files (file scope):**
- Modify: `src/utils/database-data-plane.ts` (`safeDatabaseRequestError` ~135-157 and its two callers ~250, ~286)
- Modify: `src/commands/database-export.ts` (`operation` ~195-210, `startExport` ~212-227)
- Create: `tests/database-401-host.test.ts` (spawned)

**Interfaces:**
- Consumes: `authFailedLine(host: string): string` from `src/utils/api.ts` (database-data-plane.ts already imports `getApiHeaders` from `./api`).
- Produces: `safeDatabaseRequestError(error: unknown, host: string): DatabaseOperationError`. On a 401 its result has `status` 401, `code` the server's code or `'unauthenticated'`, and `message` `authFailedLine(host)`. Task 7 relies on `status === 401` reaching `dev`.

- [ ] **Step 1: Write the failing tests** in `tests/database-401-host.test.ts`. The server answers `POST /api/v1/databases` by mode: `'401'` gives 401 `{"code":"unauthenticated","message":"RAW-401"}`; `'403'` gives 403 `{"code":"forbidden","message":"Not allowed here."}`. Expected line as in Task 3.
  1. Mode 401, `database list`: exit 1, stderr has the line, no `RAW-401`, no `Database request failed.`, no `Run solidactions login to authenticate again`.
  2. Mode 401, `database list --json`: exit 1, the line on stderr, stdout empty (Review Focus 5).
  3. Mode 401, `database show main`: exit 1, the line.
  4. Mode 401, `database dump main` (the stream request): exit 1, the line, no dump file written.
  5. Mode 401, `database export main --no-wait`: exit 1, the line.
  6. Mode 401, `database export main --resume exp-1`: exit 1, the line.
  7. Mode 403, `database list`: exit 1 and stderr still has `Not allowed here.`, and no `Authentication failed`.
  - Confirm each command's arguments with `node dist/index.js database <cmd> --help`. If `dump` needs an output path, give it one under the test's temp folder.

- [ ] **Step 2: Run them and watch them fail.**
Run: `npm run build && npx vitest run --project unit tests/database-401-host.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-6-red.log`
Expected: FAIL on 1-6; 7 passes.

- [ ] **Step 3: Implement.**

`src/utils/database-data-plane.ts`:

```ts
export function safeDatabaseRequestError(error: unknown, host: string): DatabaseOperationError {
    const augmented = augmentTokenMissingAbilityMessage(error);
    const response = (augmented as any)?.response;
    const status = typeof response?.status === 'number' ? response.status : undefined;
    const codeCandidate = typeof response?.data?.code === 'string'
        ? response.data.code.trim()
        : '';
    const stableCode = codeCandidate.length > 0 ? codeCandidate : null;
    if (status === 401) {
        // The one-line, host-naming 401 every command prints (cli#186).
        return new DatabaseOperationError(stableCode ?? 'unauthenticated', authFailedLine(host), 401);
    }
    // … the rest of the function unchanged …
}
```

Both callers: `throw safeDatabaseRequestError(error, config.host);`.

`src/commands/database-export.ts`, in both catches (`operation` and `startExport`), first thing after reading the response:

```ts
        if (error?.response?.status === 401) {
            const code = typeof error.response.data?.code === 'string' ? error.response.data.code : 'unauthenticated';
            throw new ExportCommandError(code, authFailedLine(config.host), 401);
        }
```

(import `authFailedLine` from `../utils/api`.)

- [ ] **Step 4: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/database-401-host.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-6-green.log`
Then: `npx vitest run --project unit tests/database-lifecycle-commands.test.ts tests/database-export.test.ts tests/database-import-command.test.ts tests/one-line-401-sites.test.ts tests/no-raw-error-body.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-6-neighbours.log`
Expected: PASS. `tests/database-lifecycle-commands.test.ts` ~757-772 expects `{ code: 'unauthenticated', status: 401 }`, which still holds. A test that calls `safeDatabaseRequestError` directly with one argument fails to type-check; stop and report its name (it is outside your scope).

- [ ] **Step 5: Report (do not commit).** List every changed path, each run with its counts and log path, and anything you had to stop on.

---

### Task 7: `dev` names the host on a 401 (cli#187)

**Files (file scope):**
- Modify: `src/commands/dev.ts` (`SaApiClient` ~113-129, `buildSaApiClient` ~150, `runDev`'s platform-vars catch ~603-611 and database-credential catch ~699-701, `dev()`'s result printing ~1058-1078)
- Create: `tests/dev-401-host.test.ts` (spawned)

**Interfaces:**
- Consumes: `authFailedLine(host: string): string` from `src/utils/api.ts` (dev.ts lazy-imports `../utils/api`; a static import of `authFailedLine` is fine, since api.ts is already loaded by every command). It also relies on Task 6: a database-credential 401 arrives as a `DatabaseOperationError` with `status === 401`.
- Produces: `SaApiClient.host?: string`. `RunDevResult.result` may be `{ status: 'failed', phase: 'auth', error: { name: 'AuthenticationError', message: string } }`.

- [ ] **Step 1: Write the failing tests** in `tests/dev-401-host.test.ts`, spawning `node dist/index.js dev <entry> --env production`. Build the project folder the way `tests/dev-database-env.test.ts` and `tests/dev.test.ts` do: a temp project folder with `solidactions.yaml`, a project-local `.solidactions/config.json` (`writeLocal`) pointing at the test server with a `workspaceId`, and an entry copied from `fixtures/echo.ts` (or `fixtures/echo-db.ts` for the database case). Expected line as in Task 3.
  1. `GET /api/v1/projects/<slug>/variable-mappings…` answers 401 `{"message":"RAW-401"}`: exit 1, stderr has the line, no `failed to fetch platform vars`, no `Request failed with status code 401`, no `✗ failed`. The workflow did not run (no `✓ completed`, and the echo fixture's output is absent).
  2. The mappings answer 200 with one database mapping (copy the shape from `tests/dev-database-env.test.ts`), and `POST /api/v1/databases` answers 401 `{"code":"unauthenticated","message":"RAW-401"}`: exit 1, the line, no `failed to resolve database`, the workflow did not run.
  3. The mappings answer 404 `{"message":"nope"}` with `--env staging`: unchanged. Stderr still has `failed to fetch platform vars` and the free-plan hint.

- [ ] **Step 2: Run them and watch them fail.**
Run: `npm run build && npx vitest run --project unit tests/dev-401-host.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-7-red.log`
Expected: FAIL on 1 and 2; 3 passes.

- [ ] **Step 3: Implement** in `src/commands/dev.ts`.
  - `SaApiClient`: add `/** The API host, for the 401 line (cli#187). */ host?: string;`.
  - `buildSaApiClient`: set `host: config.host` on the client object.
  - In `runDev`, a local helper next to `out`/`err`:

```ts
    const isUnauthenticated = (e: any) => e?.response?.status === 401 || e?.status === 401;
    const authFailed = (): RunDevResult => ({
        stdout: stdoutLines.join('\n'),
        stderr: stderrLines.join('\n'),
        result: {
            status: 'failed',
            phase: 'auth',
            error: { name: 'AuthenticationError', message: authFailedLine(apiClient?.host ?? 'the configured host') },
        },
    });
```

  Match the `stdout`/`stderr` joining to what `runDev`'s other returns do.
  - Platform-vars catch: first line `if (isUnauthenticated(e)) return authFailed();`.
  - Database-credential catch: first line `if (isUnauthenticated(e)) return authFailed();`.
  - `dev()`: before the `// failed` print, add:

```ts
    if (r.status === 'failed' && r.phase === 'auth') {
        console.error(chalk.red(r.error.message));
        process.exit(1);
    }
```

- [ ] **Step 4: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/dev-401-host.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-7-green.log`
Then: `npx vitest run --project unit tests/dev-env-404-hint.test.ts tests/dev-database-env.test.ts tests/dev-reveal.test.ts tests/dev-config-guard.test.ts tests/dev.test.ts tests/database-401-host.test.ts tests/host-display-guard.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-7-neighbours.log`
Expected: PASS.

- [ ] **Step 5: Report (do not commit).** List every changed path, each run with its counts and log path, and anything you had to stop on.

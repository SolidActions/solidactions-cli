# Wave cli-hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sa-subagent-driven-development to implement this plan task-by-task (the wave's build step). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Debug output never prints the API key, a host with `user:pass@` is refused with one clear line, `doc pull` sanitises every piece of server-derived text it prints, and every remaining 401 (MCP transport, doc media, database, `dev`) prints the host line.

**Architecture:**
- A side-effect module imported first by `src/index.ts` turns off the `follow-redirects` debug namespace before `debug` loads. It also refuses to run when `NODE_DEBUG` enables Node's network debug sections, which cannot be turned off once the process is running.
- `hostHasUserinfo` joins `displayHost` in `src/utils/host-display.ts`. The config funnel (`requireResolvedConfig`), `whoami` and `resolveLoginHost` refuse a userinfo host.
- Each remaining 401 site prints `authFailedLine(config.host)`: one branch in the MCP transport, two doc media sites, the database error builders, and `runDev`'s two fetches.
- `doc pull` routes every printed piece of server-derived text (titles, codes, messages, paths built from titles and folder names) through the shared `sanitizeDisplayText`, which now also strips C1 controls. A static guard test enforces it.

**Tech Stack:** TypeScript (Node 20+, target ES2022, CommonJS), commander, axios 1.x (follow-redirects, debug 4), vitest 4 (`unit` and `live` projects in `vitest.config.mts`).

**Spec:** `docs/superpowers/specs/2026-10-04-cli-hardening-design.md` (cited as "spec §N"; it wins over this plan on any conflict).

**Issues:** cli#194, cli#195, cli#189, cli#184, cli#185, cli#186, cli#187 (SolidActions/solidactions-cli). Approved by Peter in CrewOps ask task-startcliwavestop-e529 ("Approve: start the wave", 2026-10-04). cli#195's design is Peter's ruling on ask task-cliahostwithuser-922c: "Refuse with a clear message" (recorded on cli#195).

**Plan review:** Sol (task-planreviewcli-d79e) REQUEST CHANGES b8e62e5. The PM's rulings 1-6 (plan card task-planclihardening-b6e8, also on cli#194) are folded into this revision, cited as "C1/I<n>/m<n>". The `NODE_DEBUG` choice (refuse) is recorded on cli#194 (issuecomment-5981138866).

**Mandatory build rulings 7-8** (PM, build card task-buildcli-58ef, from Sol's plan re-check task-planrecheckcli-8b4b). They are folded into Task 2 below:
- 7 (N1): Task 2's negative assertions check the configured username and password **values** (`uname-SECRET`, `pw-SECRET`), never the literal text `user:`. The refusal line keeps its literal `remove "user:pass@"` guidance.
- 8 (N2): `tests/workspace-override-401.test.ts` is in Task 2's Files. Its userinfo case asserts the refusal; its 401 case already uses a userinfo-free host.

**Card rule (I5, for the manager):** every developer card carries this plan's **Global Constraints** section verbatim, the spec path, and its own task text. Each task below states its own expected lines and does not refer to another task's text.

## Global Constraints

- **Where:** the CLI wave slot `/home/mercer/projects/solid/solidactions-cli/__worktrees/wave-a`, branch `wave/2026-10-04-cli-hardening`. Work only there. Every path below is relative to that folder.
- **Spec:** `/home/mercer/projects/solid/solidactions-cli/__worktrees/wave-a/docs/superpowers/specs/2026-10-04-cli-hardening-design.md`. Read the section your task cites.
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
- **The 401 line** comes from `authFailedLine(config.host)` in `src/utils/api.ts`. For a test server at `http://127.0.0.1:<port>` it is exactly:
  `Authentication failed against http://127.0.0.1:<port>. Run "solidactions login --global" to re-configure.`
  Never re-word it, never build it by hand in `src/`. A 403 at the same site keeps its old text (spec §8).
- **Evidence:** save the raw output of every test run you cite to a log in `/home/mercer/projects/solid/solidactions-cli/__worktrees/wave-a/.superpowers/sdd/2026-10-04-cli-hardening/` (`… 2>&1 | tee <log>`), and cite the log next to each count. RED before GREEN for every behaviour change. Describe product diagnostics in passing output accurately; never call output "pristine" when it isn't.
- **No secrets in output:** never print an API key or a config file's `apiKey`. Test keys are fake literals (`sk-test-…`).
- **Style:** 4-space indent, single quotes, chalk colours as the surrounding code uses them; status text to stderr, a command's own output to stdout.
- **Report, never commit:** your last step lists every changed path and the test commands you ran with their pass/fail counts and log paths.

## Review Focus

1. **A user who names the leaking channel** (`DEBUG=follow-redirects`, `DEBUG=axios,follow-redirects`, `NODE_DEBUG=http,https,net,tls`, `NODE_DEBUG=*`) never sees the key or a host password, on both the axios path and the MCP transport (spec §1). Task 1 pins them.
2. **Ordinary hosts keep working** after the userinfo refusal: `http://127.0.0.1:<port>`, `http://localhost:8000`, `https://app.solidactions.com` and the opaque `localhost:8000` are not userinfo, and `http://u@h` (username only) is (spec §2). Task 2 pins them as pure cases and one spawned success.
3. **A 401 after earlier calls succeeded** (doc pull: `list` answers, the next MCP call 401s) prints the host line, writes no file and leaves no manifest (spec §3). Task 3 pins it.
4. **C1 controls, OSC sequences and bidi overrides** in a doc title or folder name are stripped from everything doc pull prints, stdout included, while the files on disk keep their names (spec §5). Task 5 pins them.
5. **`--json` database commands on a 401** print the host line on stderr, nothing on stdout, and exit 1 (spec §6). Task 6 pins `database list --json`.

---

### Task 1: debug output never prints the API key (cli#194)

**Files (file scope — the only paths this task may touch):**
- Create: `src/utils/debug-guard.ts`
- Modify: `src/index.ts` (one import line, first after the shebang)
- Create: `tests/debug-guard.test.ts` (pure tests of the guard's functions)
- Create: `tests/debug-no-secrets.test.ts` (spawned; imports nothing from `src/`)
- Modify: `README.md` (the `SOLIDACTIONS_DEBUG=1` paragraph only, ~line 298). Task 2 also edits README.md, in a different section (`### \`solidactions login\` flags`).

**Interfaces:**
- Consumes: nothing.
- Produces, in `src/utils/debug-guard.ts`:
  - `guardDebugNamespaces(env?: NodeJS.ProcessEnv): void`
  - `nodeDebugNetworkSection(value: string | undefined): string | null`
  - `refuseNetworkNodeDebug(env?: NodeJS.ProcessEnv): void` (prints the refusal and exits 1)
  - The module calls `refuseNetworkNodeDebug()` then `guardDebugNamespaces()` on load.

**Spec:** §1. The refusal line, for `NODE_DEBUG=http,https,net,tls`, is exactly:
`error: NODE_DEBUG="http,https,net,tls" turns on Node's "http" debug output, which prints request headers including your API key. Remove http, https, http2, net and tls from NODE_DEBUG (or unset it) and run again.`

- [ ] **Step 1: Write the failing spawned tests** in `tests/debug-no-secrets.test.ts`. This file must not import anything from `src/`, so it still collects and runs on the unfixed build (m: RED stays collectable).
  - Server: answers `GET /api/v1/projects` (and any other GET) 200 `{ "data": [] }`, and `POST /mcp` 200 `{ jsonrpc: '2.0', id: 1, result: { isError: false, content: [{ type: 'text', text: '{"skills":[]}' }] } }` (check `tests/skill-list.test.ts` for the list shape `skill list` expects). It records every request.
  - Two configs, each in its own temp HOME:
    - **plain:** `{ host: 'http://127.0.0.1:<port>', apiKey: 'sk-test-DEBUGLEAK-0123456789', workspaceId: 'ws-1', workspace: 'ws-1' }`
    - **userinfo:** the same with host `http://user:pw-DEBUGLEAK@127.0.0.1:<port>`
  - Secrets to look for, in stdout and stderr: `sk-test-DEBUGLEAK-0123456789`, `DEBUGLEAK`, `pw-DEBUGLEAK`, and the Basic-auth form `Buffer.from('user:pw-DEBUGLEAK').toString('base64')`.
  - Matrix: for each env in `DEBUG=*`, `DEBUG=axios,follow-redirects`, `DEBUG=follow-redirects`, `NODE_DEBUG=http,https,net,tls`, `NODE_DEBUG=*`; for each command in `project list` (axios) and `skill list` (MCP transport); for each config (plain, userinfo):
    - assert none of the secrets appears in stdout or stderr.
  - Extra assertions:
    - plain config with a `DEBUG=…` env: exit 0, and the server saw the request (`GET /api/v1/projects`, or `POST /mcp` for `skill list`), so the request really ran.
    - plain config with a `NODE_DEBUG=…` env: exit 1, stderr contains `error: NODE_DEBUG="<value>" turns on Node's "http" debug output, which prints request headers including your API key.`, and the server saw **0** requests.
    - userinfo config: assert nothing about the exit code or the server. Task 2 makes this host refuse before any request, and this test must stay green after it.
  - Controls: `NODE_DEBUG=module` with the plain config and `project list`: exit 0, the request ran, no refusal line. `solidactions --version` with `NODE_DEBUG=net`: exit 1 with the refusal naming `"net"`.

- [ ] **Step 2: Write the pure tests** in `tests/debug-guard.test.ts` (import from `../src/utils/debug-guard`; importing runs the module's load-time calls against the real `process.env`, so make sure the vitest process has no network `NODE_DEBUG`):
  - `guardDebugNamespaces` (pass an env object):
    - `{}` stays `{}` (no `DEBUG` key added).
    - `{ DEBUG: '' }` and `{ DEBUG: '  ' }` are unchanged.
    - `{ DEBUG: '*' }` becomes `'*,-follow-redirects'`.
    - `{ DEBUG: 'axios,follow-redirects' }` becomes `'axios,follow-redirects,-follow-redirects'`.
    - `{ DEBUG: '*,-follow-redirects' }` is unchanged (idempotent: `dev`'s tsx re-exec loads the guard twice).
    - `{ DEBUG: 'express:* -follow-redirects' }` is unchanged (debug splits on spaces and commas).
  - `nodeDebugNetworkSection`:
    - `undefined` and `''` → `null`.
    - `'http'` → `'http'`; `'HTTP'` → `'http'`; `'https'` → `'https'`; `'http2'` → `'http2'`; `'tls'` → `'tls'`.
    - `'fs,net'` → `'net'`; `'*'` → `'http'`; `'ht*'` → `'http'`; `'n*t'` → `'net'`.
    - `'module'`, `'httpx'`, `'fs,module'` and `' http'` (a leading space; Node does not trim either) → `null`.

- [ ] **Step 3: Run them and watch them fail.**
Run: `npm run build && npx vitest run --project unit tests/debug-no-secrets.test.ts tests/debug-guard.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-1-red.log`
Expected: FAIL.
  - `debug-no-secrets`: the plain-config `DEBUG=*`, `DEBUG=axios,follow-redirects` and `DEBUG=follow-redirects` cases on `project list` find the key (`Authorization: 'Bearer sk-test-DEBUGLEAK…'` from follow-redirects). The `NODE_DEBUG` cases find the key on both `project list` and `skill list` (Node's `net` debug dumps the connection options). The refusal assertions fail.
  - `debug-guard`: fails on the missing module.
  - If a plain-config `DEBUG=*` case or a `NODE_DEBUG` case does **not** show the key on the unfixed build, stop and report it with the log: the RED is the evidence that the fix is real.

- [ ] **Step 4: Implement** `src/utils/debug-guard.ts`:

```ts
import chalk from 'chalk';

/**
 * cli#194: keep the API key out of every debug channel.
 *
 * - `DEBUG` (the `debug` package): axios sends every request through
 *   follow-redirects, whose `debug` namespace dumps the request options (the
 *   Authorization header, a URL's userinfo). `debug` reads DEBUG once, when it
 *   first loads, and a skip (`-name`) beats any match, so appending the skip
 *   here turns that namespace off while every other one keeps working.
 * - `NODE_DEBUG` (Node's util.debuglog): the http/net/tls sections dump
 *   connection options, headers included, for the axios path and the MCP
 *   transport. Node fixes the enabled sections during bootstrap, before any
 *   user code, so they cannot be turned off here: refuse to run instead
 *   (recorded on cli#194).
 *
 * src/index.ts imports this module first, before anything can load `debug`
 * or make a request.
 */
const DEBUG_SKIP = '-follow-redirects';
const NETWORK_SECTIONS = ['http', 'https', 'http2', 'net', 'tls'];

export function guardDebugNamespaces(env: NodeJS.ProcessEnv = process.env): void {
    const value = env.DEBUG;
    if (value === undefined || value.trim() === '') {
        return;
    }
    if (value.split(/[\s,]+/).includes(DEBUG_SKIP)) {
        return;
    }
    env.DEBUG = `${value},${DEBUG_SKIP}`;
}

/** The first network section NODE_DEBUG enables, matched exactly as Node's initializeDebugEnv does; null when none. */
export function nodeDebugNetworkSection(value: string | undefined): string | null {
    if (!value) {
        return null;
    }
    const pattern = value
        .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/,/g, '$|^');
    const enabled = new RegExp(`^${pattern}$`, 'i');
    return NETWORK_SECTIONS.find((section) => enabled.test(section)) ?? null;
}

export function refuseNetworkNodeDebug(env: NodeJS.ProcessEnv = process.env): void {
    const section = nodeDebugNetworkSection(env.NODE_DEBUG);
    if (section === null) {
        return;
    }
    process.stderr.write(`${chalk.red(`error: NODE_DEBUG=${JSON.stringify(env.NODE_DEBUG)} turns on Node's "${section}" debug output, which prints request headers including your API key. Remove http, https, http2, net and tls from NODE_DEBUG (or unset it) and run again.`)}\n`);
    process.exit(1);
}

refuseNetworkNodeDebug();
guardDebugNamespaces();
```

In `src/index.ts`, make this the first import, directly under `#!/usr/bin/env node` and above `import chalk from 'chalk';`:

```ts
// Must stay first: it edits DEBUG before any dependency can load `debug`, and refuses a network NODE_DEBUG (cli#194).
import './utils/debug-guard';
```

After the build, check that the first `require(...)` in `dist/index.js` is `./utils/debug-guard`.

- [ ] **Step 5: README.** Append to the paragraph that starts "Set `SOLIDACTIONS_DEBUG=1` on any command" (~line 298): "Node's generic `DEBUG` variable never prints your API key: the CLI turns off the HTTP library's `follow-redirects` debug output, which would dump request headers. The CLI refuses to run when `NODE_DEBUG` turns on Node's network debug output (`http`, `https`, `http2`, `net`, `tls`), which would print them too."

- [ ] **Step 6: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/debug-no-secrets.test.ts tests/debug-guard.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-1-green.log`
Then: `npx vitest run --project unit tests/readme-contract.test.ts tests/host-display-guard.test.ts tests/dev-relative-entry.test.ts tests/skill-list.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-1-neighbours.log`
Expected: PASS.

- [ ] **Step 7: Report (do not commit).** List every changed path, each run with its counts and log path, and anything you had to stop on.

---

### Task 2: a host with `user:pass@` is refused with one clear line (cli#195)

**Files (file scope):**
- Modify: `src/utils/host-display.ts` (add `hostHasUserinfo`)
- Modify: `src/utils/config.ts` (add `userinfoHostMessage`, next to `credentialConflictMessage`)
- Modify: `src/utils/api.ts` (`requireResolvedConfig`, ~331-344)
- Modify: `src/commands/login.ts` (`LoginHostUserinfoError`, `resolveLoginHost` ~125-153, `resolveLoginHostOrExit` ~159-174, `whoami` ~585-596)
- Modify: `tests/login-host-hint.test.ts` (pure `resolveLoginHost` cases)
- Create: `tests/host-userinfo-refused.test.ts` (spawned, plus pure `hostHasUserinfo` cases)
- Modify: `tests/workspace-list-401.test.ts` (move its 401 case to a userinfo-free host; I2)
- Modify: `tests/one-line-401-sites.test.ts` (move all its cases to a userinfo-free host; I2)
- Modify: `tests/host-userinfo-output.test.ts` (cases that ran a command against a userinfo host now assert the refusal)
- Modify: `tests/workspace-override-401.test.ts` (its userinfo case asserts the refusal; ruling 8)
- Modify: `README.md` (`### \`solidactions login\` flags` only). Task 1 also edits README.md, in the `SOLIDACTIONS_DEBUG` paragraph.

**Interfaces:**
- Consumes: `displayHost(host: string): string` (src/utils/host-display.ts); `describeSource` (private, src/utils/config.ts); the `ConfigSource` type.
- Produces:
  - `export function hostHasUserinfo(host: string): boolean` in src/utils/host-display.ts.
  - `export function userinfoHostMessage(host: string, source: ConfigSource): string` in src/utils/config.ts.
  - `export class LoginHostUserinfoError extends Error { label: string; host: string }` in src/commands/login.ts.

**Spec:** §2. For a server at `http://127.0.0.1:<port>`, the lines are exactly:
- config resolution (global config file `<HOME>/.solidactions/config.json`):
  `error: the host "http://127.0.0.1:<port>" (from <HOME>/.solidactions/config.json) contains a username/password; remove "user:pass@" — the CLI authenticates with your API key.`
  The `(from …)` part is whatever `describeSource` gives for the host's source: the config file path, or `$SOLIDACTIONS_HOST` for the env. Assert the fixed parts, and the source with `toContain`.
- login, flag: `error: --host "http://127.0.0.1:<port>" contains a username/password; remove "user:pass@" — the CLI authenticates with your API key.`
- login, env: `error: SOLIDACTIONS_HOST "http://127.0.0.1:<port>" contains a username/password; remove "user:pass@" — the CLI authenticates with your API key.`

- [ ] **Step 1: Write the failing tests** in `tests/host-userinfo-refused.test.ts`.
  - Pure `hostHasUserinfo`:
    - false: `http://127.0.0.1:8002`, `http://localhost:8000`, `https://app.solidactions.com`, `localhost:8000`, `http://h/path@x` (the `@` is in the path, not the authority).
    - true: `http://u:p@h`, `http://u@h`, `http://u:p@h:bad-port`, `u:secret@host`.
  - Every spawned case below that configures userinfo also asserts that stdout and stderr contain neither `pw-SECRET` nor `uname-SECRET` (ruling 7).
  - Spawned. The server records every request and answers `GET /api/v1/projects` 200 `{ "data": [] }`, `GET /api/v1/workspaces` 200 with one workspace (copy the body from `tests/workspace-list-401.test.ts`), and `POST /mcp` 200 with an empty folder (`{ jsonrpc: '2.0', id: 1, result: { isError: false, content: [{ type: 'text', text: '{"folders":[],"docs":[]}' }] } }`).
    1. Global config host `http://uname-SECRET:pw-SECRET@127.0.0.1:<port>` (with `apiKey` and `workspaceId`), `project list`: exit 1. Stderr has the config-resolution line, containing `(from ` and the config path. Stderr and stdout contain neither `pw-SECRET` nor `uname-SECRET` (ruling 7: check the values, never the literal `user:`, which the refusal's own guidance contains). The server saw **0** requests.
    2. The same config, `doc pull Some/Folder <tmp>/out` (MCP path): exit 1, the same line, 0 requests, `<tmp>/out` not created.
    3. The same config, `whoami`: exit 1, the same line, no `pw-SECRET`.
    4. **Project-local config:** the global config has a plain host; `writeLocal(cwd, { host: 'http://uname-SECRET:pw-SECRET@127.0.0.1:<port>', apiKey: 'sk-test-x', workspaceId: 'ws-1' })`, `project list` run in that cwd: exit 1, the line names the local config file as the source, 0 requests.
    5. No config file, env `SOLIDACTIONS_HOST=http://uname-SECRET:pw-SECRET@127.0.0.1:<port>` and `SOLIDACTIONS_API_KEY=sk-test-x` (and `SOLIDACTIONS_WORKSPACE_ID=ws-1`), `project list`: exit 1, the line contains `(from $SOLIDACTIONS_HOST)`, 0 requests.
    6. Username only: global config host `http://user@127.0.0.1:<port>`, `project list`: exit 1, 0 requests.
    7. `login --stdin --global --host http://uname-SECRET:pw-SECRET@127.0.0.1:<port>`, key `sk-test-x` on stdin: exit 1, stderr has the login flag line, 0 requests, no `<HOME>/.solidactions/config.json` written.
    8. `login --stdin --global` with env `SOLIDACTIONS_HOST=http://uname-SECRET:pw-SECRET@127.0.0.1:<port>`: exit 1, the login env line, 0 requests, no config written.
    9. `login --stdin --global --dev` with env `SOLIDACTIONS_HOST=http://uname-SECRET:pw-SECRET@127.0.0.1:<port>`: exit 1, the login env line (the userinfo refusal comes before the `--dev` disagreement), 0 requests.
    10. `login --device --global` with the same env: exit 1, the login env line, 0 requests.
    11. Control: global config host `http://127.0.0.1:<port>` (no userinfo), `project list`: exit 0 and the server saw `GET /api/v1/projects`.

- [ ] **Step 2: Migrate the four older tests (I2, ruling 8).**
  - `tests/workspace-list-401.test.ts`, the case "a 401 prints the host line without userinfo and exits 1" (~87-99): write the global config with host `http://127.0.0.1:${port}` (no userinfo). Rename it "a 401 prints the host line and exits 1". Keep its expected line exactly: `Authentication failed against http://127.0.0.1:${port}. Run "solidactions login --global" to re-configure.` Drop the `not.toContain('secret')` assertion, since the userinfo refusal is covered by `tests/host-userinfo-refused.test.ts`.
  - `tests/one-line-401-sites.test.ts`, its `beforeEach` (~116-122): host `http://127.0.0.1:${port}`. Keep every case's 401 assertions (`expectedLine()`). Drop the `someuser`/`somepass` assertions only where they now say nothing.
  - `tests/host-userinfo-output.test.ts`: in both `describe` blocks (`http://someuser:somepass@127.0.0.1:<port>` and the malformed `http://someuser:somepass@localhost:invalid-port`):
    - the `whoami` and mutation-banner cases now expect exit 1, and stderr containing `error: the host "<shownHost()>"` and `contains a username/password`, still with no `someuser` and no `somepass`;
    - the `SOLIDACTIONS_DEBUG` dump case still expects the dump's `host:` line to show `shownHost()` (the dump runs before the command). It now expects exit 1, and still no `someuser`/`somepass`.
    - Name each changed case in the report.
  - `tests/workspace-override-401.test.ts` (ruling 8): its first case ("prints the one-line 401 naming the host…", ~80-90) already uses `http://127.0.0.1:${port}`; keep it unchanged. Its second case "never prints the userinfo of the host" (~92-101), with host `http://someuser:somepass@127.0.0.1:${port}`, now expects exit 1, stderr containing `error: the host "http://127.0.0.1:${port}"` and `contains a username/password`, and still no `someuser` and no `somepass`. Rename it "refuses a host with userinfo and never prints it".
  - These four files must be green at the end of this task (Step 7).

- [ ] **Step 3: Run the new tests and watch them fail.**
Run: `npm run build && npx vitest run --project unit tests/host-userinfo-refused.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-2-red.log`
Expected: FAIL. Cases 1-10 send requests or write config, and the pure cases fail on the missing export. Case 11 passes.

- [ ] **Step 4: Implement.**

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

`src/utils/api.ts` `requireResolvedConfig`, after the `credentialConflict` block and before the "Not initialized" check (import `hostHasUserinfo` from `./host-display` and `userinfoHostMessage` from `./config`):

```ts
    if (resolved && hostHasUserinfo(resolved.config.host)) {
        console.error(chalk.red(userinfoHostMessage(resolved.config.host, resolved.sources.host)));
        process.exit(1);
    }
```

`src/commands/login.ts` `whoami`: the same block, after its `credentialConflict` block.

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

In `resolveLoginHostOrExit`, add a third branch:

```ts
        if (error instanceof LoginHostUserinfoError) {
            console.error(chalk.red(`error: ${error.message}`));
            process.exit(1);
        }
```

- [ ] **Step 5: Pure cases** in `tests/login-host-hint.test.ts` (keep the explicit `env` argument its existing calls pass):
  - `resolveLoginHost({}, { SOLIDACTIONS_HOST: 'http://u:p@h:1' })` throws `LoginHostUserinfoError`, whose message names `http://h:1` and does not contain `u:p`.
  - `resolveLoginHost({ host: 'http://u@h:1' }, {})` throws `LoginHostUserinfoError`.
  - `resolveLoginHost({ host: 'http://u:p@h:1' }, { SOLIDACTIONS_HOST: 'https://other' })` throws `LoginHostUserinfoError` (the userinfo refusal comes before the disagreement).
  - `resolveLoginHost({ dev: true }, { SOLIDACTIONS_HOST: 'http://u:p@h:1' })` throws `LoginHostUserinfoError`.
  - `resolveLoginHost({ host: 'http://localhost:8000' }, {})` returns `{ host: 'http://localhost:8000', isDefault: false }`.

- [ ] **Step 6: README.** Under `### \`solidactions login\` flags`, add one bullet. Do not name `--host`, which stays hidden (app#994): "A host with a username and password in it (`http://user:pass@host`) is refused: the CLI authenticates with your API key."

- [ ] **Step 7: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/host-userinfo-refused.test.ts tests/login-host-hint.test.ts tests/workspace-list-401.test.ts tests/one-line-401-sites.test.ts tests/host-userinfo-output.test.ts tests/workspace-override-401.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-2-green.log`
Then: `npx vitest run --project unit tests/debug-no-secrets.test.ts tests/host-display-guard.test.ts tests/login-env-host.test.ts tests/readme-contract.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-2-neighbours.log`
Expected: PASS. A neighbour that configures a userinfo host and now refuses is a finding: stop and report it with the test name, do not edit it.

- [ ] **Step 8: Report (do not commit).** List every changed path, each run with its counts and log path, each migrated case by name, and anything you had to stop on.

---

### Task 3: the MCP transport names the host on a 401 (cli#184)

**Files (file scope):**
- Modify: `src/utils/mcp.ts` (`postMcpTool`, the status checks after the 429 loop, ~123-129; imports)
- Create: `tests/mcp-401-host.test.ts` (spawned)

**Interfaces:**
- Consumes: `authFailedLine(host: string): string` from `src/utils/api.ts` (mcp.ts already imports `getApiHeaders` from there).
- Produces: nothing new. `postMcpTool` prints the line and exits 1 on a 401, for every caller (`callDocsTool`, `callCrewsTool`, `callCrewsToolContent`).

**Spec:** §3. Expected line, for a server at `http://127.0.0.1:<port>`:
`Authentication failed against http://127.0.0.1:<port>. Run "solidactions login --global" to re-configure.`

- [ ] **Step 1: Write the failing tests** in `tests/mcp-401-host.test.ts`. The server answers `POST /mcp` by a per-test mode:
  - `'401'`: status 401, body `{"message":"RAW-401-BODY"}`.
  - `'403'`: status 403, body `{"message":"RAW-403-BODY"}`.
  - `'list-then-401'`: the first `/mcp` call answers 200 with one doc in the `list` shape `tests/doc-pull.test.ts` uses (folder path `F`, doc id 7, title `Doc`), and every later call answers 401.

  Temp HOME, global config `{ host: 'http://127.0.0.1:<port>', apiKey: 'sk-test-x', workspaceId: 'ws-1', workspace: 'ws-1' }`. Use a plain host: a userinfo host is refused before any request.
  1. Mode 401, `doc pull F <tmp>/out`: exit 1, stderr contains the expected line, no `RAW-401-BODY`, no `MCP request failed`. `<tmp>/out` has no files.
  2. Mode 401, `skill list`: exit 1, the line, no raw body.
  3. Mode 401, `role pull some-role <tmp>/role`: exit 1, the line, no raw body.
  4. Mode 401, `doc push <tmp>/docs` where `<tmp>/docs/a.md` exists: exit 1, the line, no raw body.
  5. Mode `list-then-401`, `doc pull F <tmp>/out`: exit 1, the line. No file under `<tmp>/out` and no manifest written (Review Focus 3).
  6. Mode 403, `skill list`: exit 1, stderr still contains `MCP request failed with HTTP 403`, and no `Authentication failed`.
  - Confirm each command name and argument shape with `node dist/index.js <group> <cmd> --help` before writing the case.

- [ ] **Step 2: Run them and watch them fail.**
Run: `npm run build && npx vitest run --project unit tests/mcp-401-host.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-3-red.log`
Expected: FAIL on cases 1-5 (`MCP request failed with HTTP 401: {"message":"RAW-401-BODY"}`); case 6 passes.

- [ ] **Step 3: Implement** in `src/utils/mcp.ts`. Add `import chalk from 'chalk';`, change the api import to `import { authFailedLine, getApiHeaders } from './api';`, and put this branch first among the status checks:

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
Then: `npx vitest run --project unit tests/mcp-retry-after.test.ts tests/skill-list.test.ts tests/doc-pull.test.ts tests/doc-push.test.ts tests/no-raw-error-body.test.ts tests/one-line-401-sites.test.ts tests/debug-no-secrets.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-3-neighbours.log`
Expected: PASS. An older in-process test that now dies on `process.exit` because it stubs a 401 is a finding: stop and report it with the test name, do not edit it.

- [ ] **Step 5: Report (do not commit).** List every changed path, each run with its counts and log path, and anything you had to stop on.

---

### Task 4: doc media requests name the host on a 401 (cli#185)

**Files (file scope):**
- Modify: `src/commands/doc-push.ts` (the tracked media upload catch, ~614-632)
- Modify: `src/commands/doc-pull.ts` (`resolveMedia`, the `confirm.status !== 200` branch, ~125-139). Task 5 later edits other lines of this file.
- Create: `tests/doc-media-401.test.ts` (spawned)

**Interfaces:**
- Consumes: `authFailedLine(host: string): string` from `src/utils/api.ts` (add it to each file's existing `../utils/api` import).
- Produces: nothing new.

**Spec:** §4. Expected line, for a server at `http://127.0.0.1:<port>`:
`Authentication failed against http://127.0.0.1:<port>. Run "solidactions login --global" to re-configure.`

- [ ] **Step 1: Write the failing tests** in `tests/doc-media-401.test.ts`. Build the fixtures the way `tests/doc-pull.test.ts` and `tests/doc-push.test.ts` build a media doc and a tracked media file (manifest shape, MCP `list`/`bulk_read` answers, the `/api/v1/docs/<id>/media` routes). Global config with a plain host `http://127.0.0.1:<port>`, `apiKey`, `workspaceId`.
  1. `doc pull` of a folder holding one media doc, where `GET /api/v1/docs/<id>/media` answers 401 `{"code":"unauthenticated","message":"RAW-401"}`: exit 1. Stderr has the expected line, and no `unknown_error`, no `unauthenticated:`, no `RAW-401`. No file written under the destination.
  2. The same with the confirm answering 403 `{"code":"forbidden","message":"nope"}`: exit 1, and stderr still has `error: forbidden: nope`.
  3. `doc push` of a folder with a tracked media file (a manifest entry with an `id`), where `POST /api/v1/docs/<id>/media` answers 401 `{"message":"RAW-401"}`: exit 1, the expected line, no `RAW-401`, no `error: <file>:` line.
  4. The same upload answering 500 `{"message":"boom"}`: exit 1, and stderr still has `error: <relPath>: boom`.

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

### Task 5: `doc pull` sanitises every piece of server-derived text it prints (cli#189)

**Files (file scope):**
- Modify: `src/commands/doc-pull.ts` (every printed template that interpolates a value; see Step 4). Task 4 edited `resolveMedia` earlier: keep its 401 branch.
- Modify: `src/utils/source-provenance.ts` (`DISPLAY_FORMATTING`, ~39)
- Create: `tests/doc-pull-display-text.test.ts` (spawned, plus pure `sanitizeDisplayText` cases)
- Create: `tests/doc-pull-display-guard.test.ts` (static guard over doc-pull.ts)

**Interfaces:**
- Consumes: `sanitizeDisplayText(value: unknown, maxLength?: number): string | null` from `src/utils/source-provenance.ts`.
- Produces: a module-private helper `shown(value: unknown): string` in doc-pull.ts.

**Spec:** §5. Display-only: files and the manifest on disk keep their names (no migration).

Fixture values (JavaScript string literals) and how each appears:

| value | on disk (unchanged) | printed |
|---|---|---|
| title `T = 'Evil\x1b[31mRED\x07\x9b2J‮X'` | file `'Evil_[31mRED_\x9b2J‮X.md'` | title `Evil[31mRED2JX`, path `Evil_[31mRED_2JX.md` |
| folder `G = 'Fold‮er\x9b'` | directory `'Fold‮er\x9b'` | `Folder` |

`sanitizeSegment` turns C0 controls (ESC, BEL) into `_` for the file name and keeps C1/bidi characters. The display sanitiser then removes the C1/bidi ones and drops ESC/BEL from titles. If a printed form you observe differs from this table, derive the expectation from `sanitizeDisplayText(sanitizeSegment(...))`, and say so in the report.

- [ ] **Step 1: Write the failing spawned tests** in `tests/doc-pull-display-text.test.ts`. Spawn with `FORCE_COLOR=0`, so the only control characters in the output can come from the server. Every spawned case also asserts that **stdout and stderr** contain none of `\x1b`, `\x07`, `\x9b`, `\x9d`, `‮`. Reuse the MCP and media fixtures from `tests/doc-pull.test.ts`, with a plain global host. The per-case assertions:
  1. **Successful pull, folder and title (stdout):** the root folder holds subfolder `G`, which holds a doc titled `T`. Run `doc pull Root <tmp>/out`. Exit 0. Stdout lists `Folder/Evil_[31mRED_2JX.md`. The file exists on disk at `<tmp>/out/` + `G` + `/Evil_[31mRED_\x9b2J‮X.md`.
  2. **The "not a regular file" refusal:** before the pull, create a **directory** at `<tmp>/out/Evil_[31mRED_\x9b2J‮X.md` (the doc `T` sits in the root folder this time). Run `doc pull Root <tmp>/out --yes` (`--yes` skips the "destination is not empty" prompt, so the pull reaches the guard). Exit 1, and stderr has `"Evil_[31mRED_2JX.md" exists and is not a regular file — cannot write doc <id> (Evil[31mRED2JX).`
  3. **A bulk_read skip warning:** `bulk_read` answers the doc titled `T` with `status: 'error\x1b[2J'`. Stderr has `warn: skipping doc <id> (Evil[31mRED2JX): bulk_read returned status "error[2J"`.
  4. **The media confirm error (code and message only; this path prints no title):** a media doc whose confirm answers 403 `{"code":"forbidden\x1b[2J","message":"no\x9bpe"}`. Exit 1, and stderr has `error: forbidden[2J: nope`.
  5. **A failed media download warning:** a media doc titled `T` whose signed download URL answers 500. Stderr has `warn: failed to download media for doc <id> (Evil[31mRED2JX): HTTP 500`.
  6. **A tool error message:** every MCP call (the folder `list`, and the single-doc fallback's `read_doc` if the command makes one) answers `isError: true` with `{"code":"bad\x9b","message":"Osc\x1b]0;pwned\x07Y"}`, which reaches the root-failure lines at ~613-614/638. Exit 1, and every `error:` line in stderr reads `error: bad: Osc]0;pwnedY`.
- Pure cases for `sanitizeDisplayText` in the same file:
  - `T` → `'Evil[31mRED2JX'`.
  - `'a\x1b]0;x\x07b'` (an OSC sequence) → `'a]0;xb'`.
  - `'\x9d0;x\x9c'` (C1 OSC and ST) → `'0;x'`.
  - `'plain title'` is unchanged.

- [ ] **Step 2: Write the static guard** in `tests/doc-pull-display-guard.test.ts`. It reads `src/commands/doc-pull.ts` as text and, for every line that contains `process.stderr.write(`, `process.stdout.write(`, `console.log(`, `console.error(`, `warnings.push(` or `` warning: ` ``, extracts each `${…}` expression of its template literals (scan for balanced braces). It fails, naming the line and expression, unless the expression:
  - starts with `shown(`; or
  - ends in `.id` or `.length` (numbers); or
  - is a ternary whose two branches are string literals (`one ? 'is' : 'are'`, `files.length === 1 ? '' : 's'`); or
  - is a key of an `ALLOWED` map in the test file, whose value states why the name is safe. Start with `{ noun: 'string literal chosen from two', state: 'string literal', where: 'built from shown() parts in refuseLink', warning: 'built from shown() parts where it is pushed', DOCS_MANIFEST: 'constant file name' }`. Add an entry only for a value that holds no server or filesystem text, and list each one in the report.
  Also add one self-test: the guard's checker, run on the string ``process.stderr.write(`x ${doc.title}`)``, reports `doc.title`.

- [ ] **Step 3: Run them and watch them fail.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull-display-text.test.ts tests/doc-pull-display-guard.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-5-red.log`
Expected: FAIL. Raw control characters reach stdout and stderr. The pure cases keep `\x9b`/`\x9d`. The guard lists the unwrapped interpolations.

- [ ] **Step 4: Implement.**

`src/utils/source-provenance.ts`: add the C1 range (`\x80-\x9f`, next to DEL) to the class:

```ts
const DISPLAY_FORMATTING = /[\x00-\x1f\x7f-\x9f؜​-‏‪-‮⁠⁦-⁩﻿]/g;
```

`src/commands/doc-pull.ts`: import `sanitizeDisplayText` from `../utils/source-provenance`, and add near the top-level helpers:

```ts
/** Server-derived text (a title, code, message, or a path built from titles and folder names) as printed (cli#189). Display only. */
function shown(value: unknown): string {
    return sanitizeDisplayText(value, 1024) ?? '(untitled)';
}
```

Wrap with `shown(…)` every interpolated value in a printed template that is not a number (doc ids, counts) or a string literal. That includes paths, the user's own `destination`/`argument`/`folderPath`, and OS error text (which embeds paths). Today's sites (line numbers from c0c7866; find each by its text):
- ~138, ~252, ~613, ~614, ~638: `code`, `message`, `listResult.code`, `listResult.message`, `readCode`, `readMessage`
- ~145: `doc.title` in the media download warning
- ~264: `original.title` and `row.status ?? 'unknown'`
- ~278: `requested.title`; ~310: `doc.title`
- ~539-540: `destination`, `previousManifest.folder_path`, `argument`
- ~571, ~577: `destination`
- ~725-728 (`refuseLink`): `rel`, `link` inside `where`, `doc.title`
- ~737 (`explainUnresolvable`): `label` and `reason` (the OS error message embeds the path). Never wrap a value that can legitimately be empty, such as `where`: `shown('')` prints `(untitled)`. `where` is allowlisted because its parts are wrapped where it is built.
- ~796: `p.relPath`, `physical`, `p.doc.title`
- ~828: `rel`
- ~984-985, ~996, ~1004-1005, ~1011-1012: `m.oldRel`, `m.newRel`, `oldTitle`, `m.title`, `taker.doc.title`, `taker.relPath`
- ~1029: `first.relPath`, `second.relPath`
- ~1045-1046, ~1075-1076: `m.newRel`, `m.title`, `m.oldRel`
- ~1102: `file`; ~1115: `p.relPath`, `p.doc.title`; ~1142: `p.doc.title`, `p.relPath`
- ~1183, ~1185, ~1205: `m.oldRel`, `writtenPath`
- ~1247: `previousManifest.folder_path`, `folderPath`
- ~1289: `destination`; ~1291: `file.path`; ~1294, ~1297: `file`

The static guard is the checklist: it must pass. Do not change file names or manifest contents: they still come from `sanitizeTitle`/`sanitizeSegment` and the server data.

- [ ] **Step 5: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/doc-pull-display-text.test.ts tests/doc-pull-display-guard.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-5-green.log`
Then: `npx vitest run --project unit tests/doc-pull.test.ts tests/doc-pull-write-safety.test.ts tests/doc-pull-rename-matrix.test.ts tests/doc-media-401.test.ts tests/workflow-view.test.ts $(ls tests/*provenance*.test.ts 2>/dev/null) 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-5-neighbours.log`
Expected: PASS. Existing rows quote plain-text titles and paths, which `shown()` leaves unchanged. A row that now fails is a finding: stop and report it.

- [ ] **Step 6: Report (do not commit).** List every changed path, each run with its counts and log path, every `ALLOWED` entry with its reason, and anything you had to stop on.

---

### Task 6: database commands name the host on a 401 (cli#186)

**Files (file scope):**
- Modify: `src/utils/database-data-plane.ts` (`safeDatabaseRequestError` ~135-157 and its two callers ~250, ~286)
- Modify: `src/commands/database-export.ts` (`operation` ~195-210, `startExport` ~212-227)
- Create: `tests/database-401-host.test.ts` (spawned)

**Interfaces:**
- Consumes: `authFailedLine(host: string): string` from `src/utils/api.ts` (database-data-plane.ts already imports `getApiHeaders` from `./api`).
- Produces: `safeDatabaseRequestError(error: unknown, host: string): DatabaseOperationError`. On a 401 its result has `status` 401, `code` the server's code (else `'unauthenticated'`), and `message` `authFailedLine(host)`. `dev` (cli#187) relies on `status === 401` arriving on that error.

**Spec:** §6. Expected line, for a server at `http://127.0.0.1:<port>`:
`Authentication failed against http://127.0.0.1:<port>. Run "solidactions login --global" to re-configure.`

- [ ] **Step 1: Write the failing tests** in `tests/database-401-host.test.ts`. The server answers `POST /api/v1/databases` by **`body.operation`**, from a per-test map (default 200), and records the operations it saw:
  - a 401 answer is `{"code":"unauthenticated","message":"RAW-401"}`; a 403 answer is `{"code":"forbidden","message":"Not allowed here."}`;
  - `show` answers 200 with a database record: the analytical one from `tests/database-export.test.ts` ~58 (`kind: 'duckdb'`) for export cases, the same with `kind: 'libsql'` for the dump case.
  Global config with a plain host `http://127.0.0.1:<port>`, `apiKey`, `workspaceId`. Each 401 case asserts exit 1, stderr contains the expected line, no `RAW-401`, no `Database request failed.`, no `Run solidactions login to authenticate again`, **and that the server saw the operation under test** (I4).
  1. `list` → 401; `database list`.
  2. `list` → 401; `database list --json`: also stdout is empty (Review Focus 5).
  3. `show` → 401; `database show main`.
  4. `show` → 200 libsql, `dump` → 401; `database dump main` (give an output path under the test's temp folder if the command needs one): no dump file written.
  5. `show` → 200 duckdb, `export` → 401; `database export main --no-wait` (reaches `startExport`).
  6. `show` → 200 duckdb, `export_status` → 401; `database export main --resume exp-1` (reaches the resume `operation`).
  7. `list` → 403; `database list`: exit 1, stderr still has `Not allowed here.`, no `Authentication failed`.
  - Confirm each command's arguments with `node dist/index.js database <cmd> --help`.

- [ ] **Step 2: Run them and watch them fail.**
Run: `npm run build && npx vitest run --project unit tests/database-401-host.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-6-red.log`
Expected: FAIL on 1-6; 7 passes. Cases 5 and 6 must fail because the export handler printed `RAW-401` (the server's message), not because `show` failed. The log shows the server saw `export` / `export_status`. If either case fails for another reason, fix the fixture before going on.

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

`src/commands/database-export.ts` (import `authFailedLine` from `../utils/api`), in both catches (`operation` and `startExport`), first thing:

```ts
        if (error?.response?.status === 401) {
            const code = typeof error.response.data?.code === 'string' ? error.response.data.code : 'unauthenticated';
            throw new ExportCommandError(code, authFailedLine(config.host), 401);
        }
```

- [ ] **Step 4: Run GREEN and the neighbours.**
Run: `npm run build && npx vitest run --project unit tests/database-401-host.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-6-green.log`
Then: `npx vitest run --project unit tests/database-lifecycle-commands.test.ts tests/database-export.test.ts tests/database-import-command.test.ts tests/one-line-401-sites.test.ts tests/no-raw-error-body.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-6-neighbours.log`
Expected: PASS. `tests/database-lifecycle-commands.test.ts` ~757-772 expects `{ code: 'unauthenticated', status: 401 }`, which still holds. A test that calls `safeDatabaseRequestError` directly with one argument fails to type-check: stop and report its name (it is outside your scope).

- [ ] **Step 5: Report (do not commit).** List every changed path, each run with its counts and log path, and anything you had to stop on.

---

### Task 7: `dev` names the host on a 401 (cli#187)

**Files (file scope):**
- Modify: `src/commands/dev.ts` (`SaApiClient` ~113-129, `buildSaApiClient` ~150, `runDev`'s platform-vars catch ~603-611 and database-credential catch ~699-701, `dev()`'s result printing ~1058-1078)
- Create: `tests/dev-401-host.test.ts` (spawned)

**Interfaces:**
- Consumes: `authFailedLine(host: string): string` from `src/utils/api.ts` (a static import is fine). A database-credential 401 arrives as a `DatabaseOperationError` with `status === 401` (src/utils/database-data-plane.ts, changed earlier in this wave for cli#186).
- Produces: `SaApiClient.host?: string`. `RunDevResult.result` may be `{ status: 'failed', phase: 'auth', error: { name: 'AuthenticationError', message: string } }`.

**Spec:** §7. Expected line, for a server at `http://127.0.0.1:<port>`:
`Authentication failed against http://127.0.0.1:<port>. Run "solidactions login --global" to re-configure.`

- [ ] **Step 1: Write the failing tests** in `tests/dev-401-host.test.ts`, spawning `node dist/index.js dev <entry> --env production`. Build the project folder the way `tests/dev-database-env.test.ts` and `tests/dev.test.ts` do: a temp project folder with `solidactions.yaml`, a project-local `.solidactions/config.json` (`writeLocal`) pointing at the test server (plain host, `apiKey`, `workspaceId`), and an entry copied from `fixtures/echo.ts` (or `fixtures/echo-db.ts` for the database case).
  1. `GET /api/v1/projects/<slug>/variable-mappings…` answers 401 `{"message":"RAW-401"}`: exit 1. Stderr has the expected line, and no `failed to fetch platform vars`, no `Request failed with status code 401`, no `✗ failed`. The workflow did not run (no `✓ completed`, and the echo fixture's output is absent).
  2. The mappings answer 200 with one database mapping (copy the shape from `tests/dev-database-env.test.ts`), and `POST /api/v1/databases` answers 401 `{"code":"unauthenticated","message":"RAW-401"}`: exit 1, the expected line, no `failed to resolve database`, and the workflow did not run.
  3. The mappings answer 404 `{"message":"nope"}` with `--env staging`: unchanged. Stderr still has `failed to fetch platform vars` and the free-plan hint.

- [ ] **Step 2: Run them and watch them fail.**
Run: `npm run build && npx vitest run --project unit tests/dev-401-host.test.ts 2>&1 | tee .superpowers/sdd/2026-10-04-cli-hardening/task-7-red.log`
Expected: FAIL on 1 and 2; 3 passes.

- [ ] **Step 3: Implement** in `src/commands/dev.ts`.
  - `SaApiClient`: add `/** The API host, for the 401 line (cli#187). */ host?: string;`.
  - `buildSaApiClient`: set `host: config.host` on the client object.
  - In `runDev`, add local helpers next to `out`/`err`, joining `stdout`/`stderr` the way `runDev`'s other returns do:

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

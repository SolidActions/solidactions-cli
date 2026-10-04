# Wave cli-hardening — design

**Wave:** cli-hardening (CrewOps wave card task-waveclihardening-acd8, run seq:sa-wave-cli:5acd138f), branch `wave/2026-10-04-cli-hardening`, cut from main at c0c7866 (wave cli-safety merged).
**Issues:** cli#194, cli#195, cli#189, cli#184, cli#185, cli#186, cli#187. Peter approved the wave in CrewOps ask task-startcliwavestop-e529 ("Approve: start the wave", 2026-10-04), recorded on each issue.
**Plan:** `docs/superpowers/plans/2026-10-04-cli-hardening.md`.

**Plan review:** Sol (task-planreviewcli-d79e) REQUEST CHANGES b8e62e5. The PM's rulings 1-6 are on plan card task-planclihardening-b6e8 and cli#194. They are folded in below and cited as "plan review C1/I<n>".

This spec records the design calls the issues leave open. Cited later as "spec §N".

## 1. cli#194 — debug output never prints the API key

Two independent debug channels can print the request headers (`Authorization: Bearer <key>`) and a URL's `auth`:

- **`DEBUG` (the `debug` package).** axios's Node adapter sends every request through `follow-redirects`, which logs its request options under the namespace `follow-redirects` (node_modules/follow-redirects/index.js, `debug("options", options)`). `debug` reads `DEBUG` once, when it first loads, and a skip (`-name`) beats any match (`*`, `follow-redirects`).
- **`NODE_DEBUG` (Node's own `util.debuglog`).** Node's `http` agent passes the connection options, headers included, to `net.createConnection`, whose `net` debug logger dumps them; Node itself warns that HTTP debug can expose tokens and headers. This affects the axios path and the MCP transport (src/utils/mcp.ts, raw `http`/`https`). Node reads `NODE_DEBUG` during bootstrap, before any user code (`initializeDebugEnv`, lib/internal/util/debuglog.js in Node v24.14.1), so the CLI cannot turn a section off once the process is running. (Plan review C1; the first draft's "NODE_DEBUG prints no headers" was wrong.)

**Fix**, in one module, `src/utils/debug-guard.ts`, which is the **first** import of `src/index.ts`:
- **`DEBUG`:** append `,-follow-redirects` to a non-empty `DEBUG` before `debug` can load. Do nothing when `DEBUG` is unset or blank, or already holds `-follow-redirects` (the tsx re-exec of `dev` loads the guard twice). Every other namespace keeps working.
- **`NODE_DEBUG`:** when it enables any of `http`, `https`, `http2`, `net` or `tls`, matched exactly as Node matches it (comma-separated, `*` wildcard, case-insensitive), the CLI refuses to run. Every command refuses, `--help` and `--version` included. It prints one red line to stderr and exits 1, before any request:
  `error: NODE_DEBUG="<value>" turns on Node's "<section>" debug output, which prints request headers including your API key. Remove http, https, http2, net and tls from NODE_DEBUG (or unset it) and run again.`
  `<section>` is the first of `http, https, http2, net, tls` that the value enables. Other sections (`NODE_DEBUG=module`, `fs`) run normally. The choice (refuse rather than neutralise, which Node does not allow) is recorded on cli#194 (issuecomment-5981138866), under PM ruling 1 there.
- Child processes the CLI spawns (`dev`'s tsx re-exec and shim) inherit the guarded `DEBUG`.
- **README** (the `SOLIDACTIONS_DEBUG` paragraph): two sentences. "Node's generic `DEBUG` variable never prints your API key: the CLI turns off the HTTP library's `follow-redirects` debug output, which would dump request headers. The CLI refuses to run when `NODE_DEBUG` turns on Node's network debug output (`http`, `https`, `http2`, `net`, `tls`), which would print them too."
- **Tests:** spawned. Run `DEBUG=*`, `DEBUG=axios,follow-redirects` and `NODE_DEBUG=http,https,net,tls`, each once with a real key and a plain host and once with a `user:pass@` host. Cover the axios path (`project list`) and the MCP transport (`skill list`). Assert that neither the key nor the password appears in stdout or stderr. RED shows the key on the unfixed build for both DEBUG and NODE_DEBUG.

## 2. cli#195 — a host with userinfo is refused (Peter: option A)

The issue left the choice open. Peter ruled on CrewOps ask task-cliahostwithuser-922c: "Refuse with a clear message" (recorded on cli#195, 2026-10-04T14:23:18Z). Config resolution and `login` refuse a host containing `user:pass@` before any request, with one clear line.

Today axios turns URL userinfo into a Basic `Authorization` header that replaces the Bearer key, so every authenticated request from such a host fails. Nothing that works today breaks.

- **Detection:** `hostHasUserinfo(host)` in `src/utils/host-display.ts`. It is true when the value parses as a URL with an authority and a username or a password, or when it does not parse and its authority (before the first `/`, `?` or `#`) contains `@`. `http://h`, `http://localhost:8000`, `https://app.solidactions.com` and the opaque `localhost:8000` are false. `http://u:p@h`, `http://u@h`, `http://u:p@h:bad-port` and `u:secret@host` are true.
- **Config resolution:** `requireResolvedConfig` (src/utils/api.ts, the funnel for `requireConfig` and `requireConfigWithWorkspace`) refuses a resolved host with userinfo, after the existing credential-conflict check and before any request. `whoami` refuses the same way, as it does for a credential conflict. One red line to stderr, exit 1:
  `error: the host "<displayHost(host)>" (from <source>) contains a username/password; remove "user:pass@" — the CLI authenticates with your API key.`
  `<source>` is the host's source as `credentialConflictMessage` already describes it (`describeSource(…, 'SOLIDACTIONS_HOST')`).
- **`login` and `login --device`:** `resolveLoginHost` throws `LoginHostUserinfoError` for a `--host` or `SOLIDACTIONS_HOST` value with userinfo, before the disagreement check, and `resolveLoginHostOrExit` prints it. This happens before any request or config write:
  `error: --host "<displayHost>" contains a username/password; remove "user:pass@" — the CLI authenticates with your API key.` (`SOLIDACTIONS_HOST "<displayHost>"` for the env value.)
- No message prints the password (every host goes through `displayHost`, and the cli-safety host guard test stays green).
- **README** (`### solidactions login flags`): one bullet. "A host with a username and password in it (`http://user:pass@host`) is refused: the CLI authenticates with your API key."
- Out of scope: real basic-auth proxy support (no issue asks for it).

## 3. cli#184 — the MCP transport names the host on a 401

`postMcpTool` (src/utils/mcp.ts) is the one transport behind `callDocsTool`, `callCrewsTool` and `callCrewsToolContent`. Today a 401 throws `MCP request failed with HTTP 401: <raw body>`.

- **Fix:** one branch in `postMcpTool`, after the 429 retry loop and before the 404 branch. On a 401 it writes `chalk.red(authFailedLine(config.host))` and a newline to stderr and exits 1. The existing `ensureWorkspaceSelected` in api.ts prints and exits the same way.
- Every other status keeps today's behaviour, including 403 and 500.
- A 401 on a later call (for example doc pull's `bulk_read` after its `list` succeeded) exits the same way. Nothing is written, because `doc pull` writes only after all its reads.
- The raw body never reaches the terminal on a 401.

## 4. cli#185 — doc media requests name the host on a 401

- `doc push`'s tracked media upload (src/commands/doc-push.ts, the `axios.post(…/media)` catch, ~614-632): a 401 prints `authFailedLine(config.host)` (red) and exits 1, before the existing `error: <file>: <message>` line. 409 `stale_revision` and 404 `doc_not_found` keep their handling, and other failures keep `error: <file>: <message>`.
- `doc pull`'s media confirm (src/commands/doc-pull.ts `resolveMedia`, ~125-139): when `confirm.status === 401`, print `authFailedLine(config.host)` (red) and exit 1. Other non-200 statuses keep `error: <code>: <message>` (with the code and message sanitised by §5). The 404 `media_not_found` fallback is unchanged.

## 5. cli#189 — doc pull sanitises server text in its messages

Every message `doc pull` prints (stdout and stderr) that interpolates text derived from the server goes through the shared sanitiser `sanitizeDisplayText` (src/utils/source-provenance.ts). That covers doc titles, the `bulk_read` row status, tool and media-confirm `code`/`message` values, and titles read back from the manifest (written from a server title on an earlier pull). It also covers **every printed path built from server titles or folder names**: `relPath`, `oldRel`/`newRel`, the paths listed after a successful pull and in cleanup, the physical path in the containment refusal, the written path in the hard-link warning, and folder paths from the manifest (plan review I3).

- One local helper in doc-pull.ts: `shown(value: unknown): string`, defined as `sanitizeDisplayText(value, 1024) ?? '(untitled)'`. It is display-only.
- A static guard test fails on any interpolation in doc-pull.ts's printed templates that is not `shown(…)`, a numeric id or count, a ternary of string literals, or an allowlisted name with a stated reason.
- The sanitiser's class (`DISPLAY_FORMATTING`) gains the C1 controls `\x80-\x9f`, so a title carrying `\x9b` (single-byte CSI) is stripped too. Every caller of the shared sanitiser (`workflow view`, deploy provenance) gets the same stronger stripping, and their existing tests stay green.
- File names and manifest data on disk are unchanged; no migration. `sanitizeSegment` replaces C0 controls with `_` but keeps C1 and bidi characters, so the on-disk name can still hold them. Only the printed form is sanitised. For example, title `Evil\x1b[31mRED\x07\x9b2J\u202eX` is written as `Evil_[31mRED_\x9b2J\u202eX.md` and printed as `Evil_[31mRED_2JX.md`.

## 6. cli#186 — database commands name the host on a 401

- `safeDatabaseRequestError(error, host)` (src/utils/database-data-plane.ts) gains a required `host` parameter. Its two callers, `requestDatabaseOperation` and `requestDatabaseDumpStream`, pass `config.host`. On `response.status === 401` it returns `new DatabaseOperationError(<server code, else 'unauthenticated'>, authFailedLine(host), 401)`. Every other status is unchanged.
- The error reaches the top-level handler in src/index.ts, which prints its message in red and exits 1. Every `database *` command, `database push` and `dev`'s database mapping therefore print the host line.
- `database export`'s local `operation()` and `startExport()` (src/commands/database-export.ts ~195-226): on a 401 they throw `new ExportCommandError(<code, else 'unauthenticated'>, authFailedLine(config.host), 401)`.
- `database export`, `dump`, `schema`, `query` and the other SQLite-only verbs look the record up first (`operation: 'show'`). Their tests answer that lookup successfully and return 401 only for the operation under test (`export`, `export_status`, `dump`), so each changed handler is reached (plan review I4).
- Out of scope: a 401 from the libsql data-plane driver (`safeDirectClientError`, a database token, not the API key), whose host is the database URL.

## 7. cli#187 — `dev` names the host on a 401

`runDev` (src/commands/dev.ts) never exits; it returns a result. `dev()` prints it.

- `SaApiClient` gains an optional `host?: string`, which `buildSaApiClient` sets to `config.host`.
- In `runDev`, when the platform-vars fetch (~605) or a database-credential mint (~699) fails with HTTP 401 (`e.response?.status === 401` or `e.status === 401`), `runDev` stops before invoking the workflow. It returns `result: { status: 'failed', phase: 'auth', error: { name: 'AuthenticationError', message: authFailedLine(apiClient.host ?? 'the configured host') } }`, and that line is not added to `stderr`.
- `dev()` prints a `phase: 'auth'` result as that one red line and exits 1 (no `✗ failed (…)` prefix).
- Every other failure keeps today's text (`failed to fetch platform vars: …`, with the 404 free-plan hint; `<VAR>: failed to resolve database …`), and the run continues as today.

## 8. Shared rules

- The host line is always `authFailedLine(config.host)` from src/utils/api.ts. It is never re-worded and never printed with userinfo.
- Every 401 site has a spawned-binary test asserting the line, exit 1, and that the raw body or axios text (`Request failed with status code 401`) is absent. A 403 at the same site keeps its old text.

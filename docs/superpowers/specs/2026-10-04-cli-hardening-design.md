# Wave cli-hardening — design

**Wave:** cli-hardening (CrewOps wave card task-waveclihardening-acd8, run seq:sa-wave-cli:5acd138f), branch `wave/2026-10-04-cli-hardening`, cut from main at c0c7866 (wave cli-safety merged).
**Issues:** cli#194, cli#195, cli#189, cli#184, cli#185, cli#186, cli#187. Peter approved the wave in CrewOps ask task-startcliwavestop-e529 ("Approve: start the wave", 2026-10-04), recorded on each issue.
**Plan:** `docs/superpowers/plans/2026-10-04-cli-hardening.md`.

This spec records the design calls the issues leave open. Cited later as "spec §N".

## 1. cli#194 — `DEBUG=*` never prints the API key

axios's Node adapter sends every request through `follow-redirects`, which logs its request options (headers, including `Authorization: Bearer <key>`, and the URL's `auth`) under the `debug` namespace `follow-redirects` (node_modules/follow-redirects/index.js, `debug("options", options)`). The `debug` package reads `DEBUG` once, when it is first loaded, and a skip (`-name`) beats any match (`*`).

- **Fix:** a new module, `src/utils/debug-guard.ts`, is the **first** import of `src/index.ts`. On load it appends `,-follow-redirects` to a non-empty `DEBUG`, before `debug` can load. It does nothing when `DEBUG` is unset or blank, and nothing when the value already holds `-follow-redirects` (the tsx re-exec of `dev` loads the guard twice).
- Every other namespace keeps working (`DEBUG=*` still shows the rest).
- Child processes the CLI spawns (`dev`'s tsx re-exec and shim) inherit the guarded value.
- The MCP transport (src/utils/mcp.ts) uses raw `http`/`https`, which has no `debug` logging; Node's own `NODE_DEBUG=http,https,net,tls` does not print headers. The spawned test pins both.
- **README** (the `SOLIDACTIONS_DEBUG` paragraph): one sentence. "Node's generic `DEBUG` variable never prints your API key: the CLI turns off the HTTP library's `follow-redirects` debug output, which would dump request headers."
- **Test:** spawned, `DEBUG=*` and a known key against a local server. RED shows the key on stderr; GREEN shows neither the key nor a host password.

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

Every message `doc pull` prints that interpolates server-controlled text goes through the shared sanitiser `sanitizeDisplayText` (src/utils/source-provenance.ts). That covers doc titles, the `bulk_read` row status, the media confirm `code`/`message`, and titles read back from the manifest (written from a server title on an earlier pull).

- One local helper in doc-pull.ts: `shown(value: unknown): string`, defined as `sanitizeDisplayText(value, 255) ?? '(untitled)'`.
- The sanitiser's class (`DISPLAY_FORMATTING`) gains the C1 controls `\x80-\x9f`, so a title carrying `\x9b` (single-byte CSI) is stripped too. Every caller of the shared sanitiser (`workflow view`, deploy provenance) gets the same stronger stripping, and their existing tests stay green.
- File names are unchanged: they already come from `sanitizeTitle`/`sanitizeSegment`.

## 6. cli#186 — database commands name the host on a 401

- `safeDatabaseRequestError(error, host)` (src/utils/database-data-plane.ts) gains a required `host` parameter. Its two callers, `requestDatabaseOperation` and `requestDatabaseDumpStream`, pass `config.host`. On `response.status === 401` it returns `new DatabaseOperationError(<server code, else 'unauthenticated'>, authFailedLine(host), 401)`. Every other status is unchanged.
- The error reaches the top-level handler in src/index.ts, which prints its message in red and exits 1. Every `database *` command, `database push` and `dev`'s database mapping therefore print the host line.
- `database export`'s local `operation()` and `startExport()` (src/commands/database-export.ts ~195-226): on a 401 they throw `new ExportCommandError(<code, else 'unauthenticated'>, authFailedLine(config.host), 401)`.
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

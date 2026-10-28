# Wave cli-connect-links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sa-subagent-driven-development to implement this plan task-by-task (the wave's build step). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an AI working in a terminal can ask a person to connect an app: `solidactions connection connect` mints a connect link and prints it, `solidactions connection wait` waits until the person used it, `--reconnect` refreshes an existing connection, device login asks for the `connections:request` ability, and `connection list` shows whether each connection may be used as a data source.

**Architecture:**
- The server side shipped in app v0.243.0 (app PR #2220): `POST /api/v1/connections/requests` (mint) and `GET /api/v1/connections/requests/{id}` (status), both behind the `connections:request` token ability, workspace-scoped by `X-Workspace-Id`.
- One small shared module, `src/utils/connect-link.ts` (Task 1), holds the wire type, the `--bind` parser, the control-character filter and the shared failure line. Two command files use it: `src/commands/connection-connect.ts` (Task 1) and `src/commands/connection-wait.ts` (Task 2).
- Login: `requestDeviceCode` asks for `connections:request` first and falls back through the older scope lists on `invalid_scope` (Task 3). A 403 `token_missing_ability` naming `connections:request` gets a re-login hint in the existing axios interceptor (Task 3).
- `connection list` gains a DATA SOURCE column from the `allow_source_use` field the server already returns (Task 4).

**Tech Stack:** TypeScript (Node 20+, CommonJS), commander 11, axios, chalk 4, vitest 4 (`unit` project). Tests run only in CI (`check.yml`, GitHub-hosted runners).

**Spec:** no wave spec; the binding design is app#2181 §3.2 and the app's `docs/superpowers/specs/2026-10-23-connect-links-design.md` §3 (wire shape, codes) and `docs/api/v1/openapi.yaml` ("Connect Links" tag, `ConnectLink`, `ConnectLinkError`, `TokenMissingAbilityError`) on app `origin/main` (6828c60e3). Every value this plan needs from them is copied below.

**Issues:** cli#219 (SolidActions/solidactions-cli). Approved by Peter 2026-10-28 (ask task-approvewave-eb2a), recorded on the issue (https://github.com/SolidActions/solidactions-cli/issues/219#issuecomment-6468026862): "Approved by Peter 2026-10-28 (ask task-approvewave-eb2a), size normal: wave 2026-10-28-cli-connect-links in the CLI lane."

**Plan review:** Fable task-planreviewwave-51a8, REQUEST CHANGES at b9fbd64 (no Critical). PM adjudication on plan card task-plan20261028cli-d015: (1) Ctrl-C in `wait` exits 130 with a resume line, plus a SIGINT row (Task 2 row 16, M3); (2) rows for three missing exit paths of `connect` (Task 1 rows 12-14); (3) the four minors: `status unknown (last check failed)` (Task 2 row 17), `formatExpiry` for every printed expiry (Task 1), the `requested_by` example (Wire contract), and the switch note (Task 2). A delta check by Fable follows.

**Card rule (for the manager):** every developer card carries this plan's **Global Constraints** and **Wire contract** sections verbatim, plus the task's text.

## The issue, verbatim (cli#219 body, the binding scope)

> Step 2 of SolidActions/solidactions-app#2181 (connect links; steps 1, 3 and 4 shipped in app v0.243.0, PR #2220). The server side exists: `POST /api/v1/connections/requests` and `GET /api/v1/connections/requests/{id}` with ability `connections:request`.
>
> CLI scope (design #2181 section 3.2):
> - `sa connection connect <platform> --name NAME [--bind PROJECT:VAR]...` mints a request and prints the single-use link plus `sa connection wait <id>`.
> - `sa connection wait <id>` polls status until connected, cancelled or expired, with a timeout and clear exit codes.
> - `sa connection connect --reconnect NAME` mints a reconnect request for an existing connection.
> - `connections:request` is added to the CLI's default login scopes; older tokens get a plain 're-run sa login' error.
> - The `allow_source_use` column in `sa connection list` (follow-up from app#2189) can ride along if trivial.
> - Tests spawn the built binary (npm run build first).

From app#2181 §3.2 (the design cli#219 cites):

> - `sa connection wait REQUEST [--timeout 15m]` polls every 5 s and exits 0 on connected, 1 on expired or cancelled, printing the connection name and the bindings made.
> - Output always includes the one-line human text, the URL, the request id and the expiry, so any AI can relay it without formatting work.

## Manager rulings (recorded on cli#219 before dispatch: https://github.com/SolidActions/solidactions-cli/issues/219#issuecomment-6468166672)

- **M1 — binary name.** Printed commands say `solidactions …`, not `sa …`: the package ships only the `solidactions` bin (`package.json` `"bin": {"solidactions": "./dist/index.js"}`), and every existing hint in `src/` names `solidactions`. The issue's `sa` is shorthand.
- **M2 — reconnect form.** `solidactions connection connect --reconnect NAME` exactly as cli#219 says (app#2181's older `sa connection reconnect NAME` is not added). The platform argument is optional with `--reconnect`: when omitted, the CLI reads the connection's `provider` from `GET /api/v1/connections` (the REST mint requires `platform`).
- **M3 — wait exit codes.** 0 connected; 1 expired, cancelled, or an error; **2** the `--timeout` passed while the link is still open (the person may still click it; re-running `wait` keeps waiting). Default timeout 15m, poll every 5 s (app#2181 §3.2). `--timeout` accepts `30s`, `15m`, `1h` or bare seconds, from 1s to 24h (the link lives 24 h). **130** on Ctrl-C (SIGINT), with one line `Still waiting: resume with solidactions connection wait <id>`; the link stays open on the server (PM adjudication of the plan review, card task-plan20261028cli-d015; recorded on cli#219: https://github.com/SolidActions/solidactions-cli/issues/219#issuecomment-6468336014).
- **M4 — open requests in `connection list`.** app#2181 §3.2 also says "`sa connection list` also shows open requests". Not built: cli#219's scope does not list it, and the server has no REST route that lists requests (only `POST` and `GET {id}`). Filed only if the PM wants it.
- **M5 — DATA SOURCE column.** `allow_source_use` ships as a `DATA SOURCE` column with `yes` / `no`, and `-` when the server sends no such field (an older server). The app labels the switch "Allow use as a data source".
- **M6 — device scopes.** Three scope lists tried in order, each retry only on a 400 `invalid_scope` (a server without `connections:request` registered, then one without `env:reveal`): at most 3 requests.

## Global Constraints

- **Where:** the CLI wave slot `/home/mercer/projects/solid/solidactions-cli/__worktrees/wave-a`, branch `wave/2026-10-28-2026-10-28-cli-connect-links`. Work only there. Every path below is relative to that folder.
- **File scope:** touch only the paths in your task's **Files** block. A change that needs another path is a plan defect: stop and report it on your card.
- **Never commit, stage, stash, switch branches, reset or rebase.** Never create a worktree. The manager commits after the task review.
- **No tests on this box (Peter 2026-10-22).** Do not run vitest at all, not even one file. Write the tests; CI (`check.yml`) runs them on the pushed head. Your checks are static: `npm run build` (tsc, plus the command manifest) must succeed after your change. Paste its last lines into your report.
- **Expected-RED table:** your report lists, per new or changed test, the assertion that must fail on the base commit (`dea4081`) and why. The per-task reviewer checks each row against the test code.
- **Real tests (PM ruling 14 of wave cli-trust, still binding):** command tests spawn the built binary.
  - Async `child_process.spawn(process.execPath, [CLI_BINARY, ...args])` with `CLI_BINARY = path.resolve(__dirname, '../dist/index.js')`, against a real in-process `http.createServer` on `127.0.0.1` (copy `runCli` and the server setup from `tests/connection-list.test.ts`, lines 1-60 and 191-226).
  - A temp `HOME` (`writeGlobal` from `tests/helpers.ts`) whose `~/.solidactions/config.json` has a plain host (`http://127.0.0.1:<port>`), `apiKey: 'test-key'`, `workspaceId: 'workspace-1'`.
  - Delete `SOLIDACTIONS_HOST`, `SOLIDACTIONS_API_KEY`, `SOLIDACTIONS_WORKSPACE_ID`, `DEBUG`, `NODE_DEBUG`, `FORCE_COLOR`, `SOLIDACTIONS_TEST_HOOKS` from the child env unless the test sets one on purpose.
  - Assert real stdout, stderr, exit status, and the requests the server received (method, url, headers, parsed JSON body).
  - No `vi.fn`, `vi.spyOn`, module mocks, axios mocks, or `process.exit`/`console` substitution. A pure exported function (a parser, the interceptor's `augmentTokenMissingAbilityMessage`) may be tested directly.
- **One-line errors (wave cli-polish):** every refusal or failure is ONE red line on stderr (`console.error(chalk.red(line))`), then `process.exit(1)` (or 2 where M3 says). Never print a raw response body or a stack. A 401 prints `authFailedLine(config.host)` from `src/utils/api.ts`; any other HTTP failure prints `formatApiFailure(status, data)`; no response prints `Connection failed: <error.message>`. The one existing exception stays: the ability hints in `augmentTokenMissingAbilityMessage` append a second paragraph to the server message.
- **Display:** every string that came from the server or from the user passes through `plainText()` (Task 1) before it is printed. Never interpolate a host into a template literal; use `displayHost()` / `authFailedLine()` (`tests/host-display-guard.test.ts` enforces it).
- **Style:** 4-space indent, single quotes, semicolons, chalk as the surrounding code uses it (`chalk.red` errors on stderr, `chalk.gray` for secondary lines). Match `src/commands/connection-list.ts`.
- **Size cap:** about 1000 formatted diff lines per task (`git diff --stat -- <your paths>` plus `wc -l` of new files). Above it, stop and ask on the card.
- **Report, never commit:** your last step lists the test paths and the source paths separately, the expected-RED table, the `npm run build` tail, and every older test you changed (by name, old and new expectation).

Secret-bearing host paths this plan's code reads: `~/.solidactions/config.json` and `./.solidactions/config.json` (the API key, through the existing `requireConfigWithWorkspace()`; no new reader).

## Wire contract (frozen; copied from app `docs/api/v1/openapi.yaml` at 6828c60e3)

Mint: `POST {host}/api/v1/connections/requests`, headers from `getApiHeaders(config, 'application/json')` (Bearer key, `Accept: application/json`, `X-Workspace-Id`). Body:

```json
{"platform": "gmail", "name": "gmail-main", "mode": "connect", "bindings": [{"project": "newsletter", "var": "GMAIL_KEY"}]}
```

`mode` is `connect` or `reconnect`; the CLI always sends `mode` and `bindings` (an empty array when there are none). Responses:
- `201` a `ConnectLink` with `url` and `text`.
- `403` `{code: "token_missing_ability", message, required_ability: "connections:request"}` (an older token) or `{code: "forbidden", message}` (the user cannot build in Automate).
- `422` `{code, message}` with code `platform_unknown`, `name_taken`, `name_not_found`, `platform_mismatch`, `project_not_found`, `var_not_declared`, `too_many_bindings`; or Laravel validation `{message, errors}`.
- `429` `{code: "rate_limited" | "too_many_open_requests", message}`.

Status: `GET {host}/api/v1/connections/requests/{id}` (id URL-encoded) → `200` a `ConnectLink` without `url`/`text`; `404` `{code: "request_not_found", message}`; `403` `token_missing_ability` as above.

`ConnectLink` (status values: `requested`, `opened`, `connected`, `cancelled`, `expired`; the server reports a link past `expires_at` as `expired`):

```json
{
  "id": "01JB...",
  "status": "requested",
  "mode": "connect",
  "platform": "gmail",
  "platform_name": "Gmail",
  "name": "gmail-main",
  "bindings": [{"project": "newsletter", "var": "GMAIL_KEY"}],
  "expires_at": "2026-10-29T19:00:00Z",
  "url": "https://app.solidactions.com/connect/<token>",
  "text": "Connect Gmail for this workspace:\n  https://app.solidactions.com/connect/<token>\nThe link works for 24 hours and once. Request id: 01JB... (expires 2026-10-29 19:00 UTC).",
  "requested_by": {"type": "user", "label": "CLI (Pat Doe)"},
  "requested_at": "2026-10-28T19:00:00Z",
  "connection": null,
  "connected_by": null,
  "connected_at": null
}
```

Once connected, a status read fills `connection: {id: number, name, status}`, `connected_by: {name}`, `connected_at`.

`requested_by` is `{type: 'user', label: 'CLI (<name>)'}` for a device-login token and `{type: 'api_token', label: 'API key "<key name>"'}` for an API key (app `ConnectionRequestApiController.php` lines 77-88). The CLI never reads it; don't assert on it.

`GET {host}/api/v1/connections` (existing, used by `connection list` and by `--reconnect` without a platform): `{data: [{id, name, provider, broker, status, error_message, last_used_at, allow_source_use: boolean, ...}]}`.

## Review Focus

1. **A blip while waiting.** A 5xx, a 429 or a dropped connection during `wait` must not end the wait: it retries on the next tick, and gives up with exit 1 only after 5 failed checks in a row. Task 2 pins it (503, 503, connected → exit 0; always 503 → exit 1 after exactly 5 requests).
2. **Exit 0 only on `connected`.** A timeout while the link is still open exits 2 and says how to keep waiting; Ctrl-C exits 130 with the resume line and sends no further request; expired and cancelled exit 1; an unknown status string exits 1 (never treated as success). Task 2 pins each.
3. **An older token.** A token minted before `connections:request` gets one plain re-login instruction from both `connect` and `wait`, never the 401 "login --global" line. Tasks 3 and 2 pin it.
4. **Mistyped input never reaches the server.** `--bind newsletter`, `--bind :VAR`, `--bind proj:`, an 11th `--bind`, `--name` together with `--reconnect`, no `--name`, and a missing platform are refused locally with zero requests sent; `--reconnect` of a name not in the workspace sends no POST. Task 1 pins it.
5. **Server text is printed, not executed.** A server string carrying terminal escape sequences (`\u001b]52;…`, `\u001b[2J`) is printed with the control characters removed. Tasks 1 and 2 pin it.

## Tasks and dependencies

| Task | Issue | Depends on | Files (summary) |
|---|---|---|---|
| 1 `connection connect` and the shared module | cli#219 | none | `src/utils/connect-link.ts`, `src/commands/connection-connect.ts`, `src/index.ts` (connection block), `src/utils/mutating-commands.ts`, 2 tests |
| 2 `connection wait` | cli#219 | Tasks 1 and 3 | `src/commands/connection-wait.ts`, `src/index.ts` (connection block), `src/utils/mutating-commands.ts`, 2 tests |
| 3 login scope and re-login hint | cli#219 | none | `src/commands/device-login.ts`, `src/utils/api.ts`, 3 tests |
| 4 DATA SOURCE column | cli#219 | none | `src/commands/connection-list.ts`, `tests/connection-list.test.ts` |

Tasks 1, 3 and 4 run in parallel (disjoint files). Task 2 starts after Tasks 1 and 3 are committed: it edits `src/index.ts` and `src/utils/mutating-commands.ts` after Task 1, and its old-token test needs Task 3's hint. Open PRs in SolidActions/solidactions-cli at plan time: none (`gh pr list --state open` empty), so no merge-order constraint.

---

### Task 1: `connection connect` and the shared connect-link module (cli#219)

**Files (file scope — the only paths this task may touch):**
- Create: `src/utils/connect-link.ts`
- Create: `src/commands/connection-connect.ts`
- Modify: `src/index.ts` (the `// connection <subcommand>` block, around lines 974-984, and its import list; nothing else). Task 2 edits the same block after this task is committed.
- Modify: `src/utils/mutating-commands.ts` (add `'connection connect'` to `MUTATING_COMMANDS`; nothing else). Task 2 edits this file after this task is committed.
- Create: `tests/connect-link.test.ts` (direct tests of the pure functions)
- Create: `tests/connection-connect.test.ts` (spawned)

Existing tests that read these files and must stay green (no edit expected): `tests/mutating-commands.test.ts` (every built leaf command must be classified; it walks `dist/command-manifest.json`), `tests/command-manifest.test.ts`, `tests/command-manifest-artifact.test.ts`, `tests/command-tree-export.test.ts`, `tests/host-display-guard.test.ts`.

**Interfaces:**
- Consumes: `requireConfigWithWorkspace`, `getApiHeaders`, `authFailedLine`, `formatApiFailure` from `src/utils/api.ts` (existing).
- Produces (Task 2 imports these exact names from `src/utils/connect-link.ts`):

```ts
export interface ConnectLinkBinding { project: string; var: string }
export interface ConnectLink {
    id: string;
    status: string;
    mode: 'connect' | 'reconnect';
    platform: string;
    platform_name: string;
    name: string;
    bindings: ConnectLinkBinding[];
    expires_at: string;
    url?: string;
    text?: string;
    requested_by: { type: string; label: string } | null;
    requested_at?: string;
    connection: { id: number; name: string; status: string } | null;
    connected_by: { name: string } | null;
    connected_at: string | null;
}
export const CONNECT_LINK_MAX_BINDINGS = 10;
/** 'PROJECT:VAR' → {project, var}; split at the first ':'; both sides trimmed and non-empty, else throws Error with a one-line message. */
export function parseBinding(value: string): ConnectLinkBinding;
/** Removes C0/C1 control characters (U+0000-U+0008, U+000B-U+001F, U+007F-U+009F), keeping '\n' and '\t'. */
export function plainText(value: string): string;
/** '/api/v1/connections/requests' or '/api/v1/connections/requests/<encodeURIComponent(id)>'. */
export function connectLinkPath(id?: string): string;
/** 'solidactions connection wait <id>' */
export function waitCommandLine(id: string): string;
/** '2026-10-29T19:00:00Z' → '2026-10-29 19:00 UTC' (the server's own `text` format); a value Date cannot parse → plainText(value). */
export function formatExpiry(iso: string): string;
/** The one line for a failed request: 401 → authFailedLine(host); a response → formatApiFailure(status, data); none → 'Connection failed: <message>'. */
export function connectLinkFailureLine(error: any, host: string): string;
```

- [ ] **Step 1: Write the pure-function tests** in `tests/connect-link.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { connectLinkFailureLine, connectLinkPath, formatExpiry, parseBinding, plainText, waitCommandLine } from '../src/utils/connect-link';

describe('parseBinding', () => {
    it('splits PROJECT:VAR at the first colon and trims', () => {
        expect(parseBinding('newsletter:GMAIL_KEY')).toEqual({ project: 'newsletter', var: 'GMAIL_KEY' });
        expect(parseBinding(' newsletter-dev : GMAIL_KEY ')).toEqual({ project: 'newsletter-dev', var: 'GMAIL_KEY' });
    });
    it.each(['newsletter', ':GMAIL_KEY', 'newsletter:', ':', '', '  :  '])('refuses %j with one line naming PROJECT:VAR', (value) => {
        expect(() => parseBinding(value)).toThrow(/PROJECT:VAR/);
    });
});

describe('plainText', () => {
    it('removes terminal control sequences but keeps newlines and tabs', () => {
        expect(plainText('a\u001b]52;c;ZXZpbA==\u0007b\u001b[2Jc\n\td\u009be')).toBe('a]52;c;ZXZpbA==b[2Jc\n\tde');
    });
});

describe('connectLinkPath and waitCommandLine', () => {
    it('encodes the id', () => {
        expect(connectLinkPath()).toBe('/api/v1/connections/requests');
        expect(connectLinkPath('01JB/../x')).toBe('/api/v1/connections/requests/01JB%2F..%2Fx');
        expect(waitCommandLine('01JBXYZ')).toBe('solidactions connection wait 01JBXYZ');
    });
});

describe('formatExpiry', () => {
    it('renders an ISO time the way the server text does', () => {
        expect(formatExpiry('2026-10-29T19:00:00Z')).toBe('2026-10-29 19:00 UTC');
        expect(formatExpiry('2026-10-29T19:05:59.000000Z')).toBe('2026-10-29 19:05 UTC');
        expect(formatExpiry('not a date')).toBe('not a date');
    });
});

describe('connectLinkFailureLine', () => {
    it('renders 401, other statuses and network errors as one line', () => {
        expect(connectLinkFailureLine({ response: { status: 401, data: {} } }, 'http://127.0.0.1:9')).toContain('Authentication failed against');
        expect(connectLinkFailureLine({ response: { status: 422, data: { code: 'name_taken', message: 'gmail-main already exists in this workspace (status error); use reconnect' } } }, 'http://h'))
            .toBe('Failed: 422 gmail-main already exists in this workspace (status error); use reconnect');
        expect(connectLinkFailureLine({ message: 'connect ECONNREFUSED' }, 'http://h')).toBe('Connection failed: connect ECONNREFUSED');
    });
});
```

- [ ] **Step 2: Write the spawned command tests** in `tests/connection-connect.test.ts`. The server records every request (method, url, headers, parsed body) in an array and answers from a per-test handler. Rows (each its own `it`):
  1. `connection connect gmail --name gmail-main --bind newsletter:GMAIL_KEY --bind crm-dev:GMAIL_KEY` with a 201 `ConnectLink` (the Wire contract example, `text` as given) → exit 0; exactly one request, `POST /api/v1/connections/requests`, `authorization: Bearer test-key`, `x-workspace-id: workspace-1`, body `{platform: 'gmail', name: 'gmail-main', mode: 'connect', bindings: [{project: 'newsletter', var: 'GMAIL_KEY'}, {project: 'crm-dev', var: 'GMAIL_KEY'}]}`; stdout contains the server `text` lines, then `When it is done, run:` and `  solidactions connection wait 01JBTEST`; stderr empty.
  2. No `--bind` → body `bindings: []`, `mode: 'connect'`.
  3. `connection connect gmail --reconnect gmail-main` → one request, POST body `{platform: 'gmail', name: 'gmail-main', mode: 'reconnect', bindings: []}`; no `GET /api/v1/connections`.
  4. `connection connect --reconnect gmail-main` (no platform), the server's `GET /api/v1/connections` answering `{data: [{name: 'gmail-other', provider: 'slack'}, {name: 'gmail-main', provider: 'gmail'}]}` → two requests in order: `GET /api/v1/connections`, then the POST with `platform: 'gmail'`, `mode: 'reconnect'`.
  5. `connection connect --reconnect missing-one` with the list not containing it → exit 1; stderr is one line containing `No connection named missing-one` and `solidactions connection list`; only the GET was sent (no POST).
  6. Local refusals, zero requests each, exit 1, one stderr line: `--bind newsletter`; `--bind :GMAIL_KEY`; 11 `--bind p:V` options; `--name a --reconnect b`; `gmail` with no `--name`; `--name gmail-main` with no platform.
  7. 422 `{code: 'name_taken', message: 'gmail-main already exists in this workspace (status error); use reconnect'}` → exit 1; stderr exactly `Failed: 422 gmail-main already exists in this workspace (status error); use reconnect\n`; stdout empty.
  8. 429 `{code: 'too_many_open_requests', message: 'This workspace already has 10 open connect links.'}` → exit 1, stderr `Failed: 429 This workspace already has 10 open connect links.`
  9. 401 → exit 1, stderr contains `Authentication failed against 127.0.0.1:`.
  10. A 201 whose `text` contains `\u001b]52;c;ZXZpbA==\u0007` and whose `id` contains `\u001b[2J` → stdout contains no `\u001b` and no `\u0007` character.
  11. A 201 with no `text` (only `url`, `id`, `expires_at: '2026-10-29T19:00:00Z'`) → stdout contains `Connect link: <url>` and `Request id: 01JBTEST (expires 2026-10-29 19:00 UTC)` and the wait line.
  12. (plan review Important 2a) A 201 with body `{}` → exit 1; stderr exactly `Failed: the server answered without a connect link.\n`; stdout empty.
  13. (plan review Important 2b) 403 `{code: 'forbidden', message: 'You cannot build automations in this workspace.'}` → exit 1; stderr exactly `Failed: 403 You cannot build automations in this workspace.\n` (no `login --device` hint: this is not `token_missing_ability`); stdout empty.
  14. (plan review Important 2c) No server: the config's host is `http://127.0.0.1:<port>` of a server that was started, its port read, then closed before the spawn → exit 1; stderr is one line starting `Connection failed:`; stderr contains no `    at ` (no stack trace) and no `AxiosError`; stdout empty.

- [ ] **Step 3: Write `src/utils/connect-link.ts`** with exactly the Produces block above. Implementation notes:
  - `plainText`: `value.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')`.
  - `parseBinding`: refusal message `--bind must be PROJECT:VAR (got "<plainText(value)>")`.
  - `formatExpiry`: `const d = new Date(iso); if (Number.isNaN(d.getTime())) return plainText(iso); return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;`
  - `connectLinkFailureLine`: `error?.response?.status === 401` → `authFailedLine(host)`; `error?.response` → `formatApiFailure(error.response.status, error.response.data)`; else `` `Connection failed: ${error?.message ?? String(error)}` ``.

- [ ] **Step 4: Write `src/commands/connection-connect.ts`:**

```ts
import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import {
    CONNECT_LINK_MAX_BINDINGS,
    ConnectLink,
    ConnectLinkBinding,
    connectLinkFailureLine,
    connectLinkPath,
    formatExpiry,
    parseBinding,
    plainText,
    waitCommandLine,
} from '../utils/connect-link';

export interface ConnectionConnectOptions {
    name?: string;
    reconnect?: string;
    bind?: string[];
}

function fail(line: string): never {
    console.error(chalk.red(plainText(line)));
    process.exit(1);
}

export async function connectionConnect(platform: string | undefined, options: ConnectionConnectOptions): Promise<void> {
    if (options.name !== undefined && options.reconnect !== undefined) {
        fail('connection connect: give --name NAME for a new connection or --reconnect NAME for an existing one, not both.');
    }
    const reconnect = options.reconnect !== undefined;
    const name = (reconnect ? options.reconnect : options.name)?.trim() ?? '';
    if (name === '') {
        fail('connection connect: --name NAME is required (or --reconnect NAME to refresh an existing connection).');
    }
    let resolvedPlatform = platform?.trim() ?? '';
    if (!reconnect && resolvedPlatform === '') {
        fail('connection connect: give the platform, e.g. solidactions connection connect gmail --name gmail-main (solidactions oauth-action platforms lists them).');
    }
    const rawBindings = options.bind ?? [];
    if (rawBindings.length > CONNECT_LINK_MAX_BINDINGS) {
        fail(`connection connect: at most ${CONNECT_LINK_MAX_BINDINGS} --bind options.`);
    }
    let bindings: ConnectLinkBinding[] = [];
    try {
        bindings = rawBindings.map(parseBinding);
    } catch (error: any) {
        fail(`connection connect: ${error.message}`);
    }

    const config = await requireConfigWithWorkspace();

    if (resolvedPlatform === '') {
        let connections: Array<{ name?: string; provider?: string }> = [];
        try {
            const response = await axios.get(`${config.host}/api/v1/connections`, { headers: getApiHeaders(config) });
            connections = response.data?.data ?? [];
        } catch (error: any) {
            fail(`${connectLinkFailureLine(error, config.host)} (looking up ${name}'s platform; give it to skip the lookup: solidactions connection connect <platform> --reconnect ${name})`);
        }
        const match = connections.find((connection) => connection.name === name);
        if (!match?.provider) {
            fail(`No connection named ${name} in this workspace; solidactions connection list shows the names.`);
        }
        resolvedPlatform = match.provider;
    }

    let link: ConnectLink;
    try {
        const response = await axios.post(
            `${config.host}${connectLinkPath()}`,
            { platform: resolvedPlatform, name, mode: reconnect ? 'reconnect' : 'connect', bindings },
            { headers: getApiHeaders(config, 'application/json') },
        );
        link = response.data;
    } catch (error: any) {
        fail(connectLinkFailureLine(error, config.host));
    }
    if (!link?.id || !link?.url) {
        fail('Failed: the server answered without a connect link.');
    }

    const text = typeof link.text === 'string' && link.text.trim() !== ''
        ? link.text
        : `Connect link: ${link.url}\nRequest id: ${link.id} (expires ${formatExpiry(link.expires_at)}).`;
    console.log(plainText(text));
    console.log('When it is done, run:');
    console.log(`  ${waitCommandLine(plainText(link.id))}`);
}
```

  (If tsc's definite-assignment analysis rejects `link`/`match` after `fail()` despite the `never` return, restructure with early returns; keep the behaviour.)

- [ ] **Step 5: Register the command** in `src/index.ts`, inside the `// connection <subcommand>` block after `connection list`, and add `import { connectionConnect } from './commands/connection-connect';` next to the `connectionList` import:

```ts
connection
    .command('connect [platform]')
    .description('Mint a connect link a person clicks to connect an app, then print it and the wait command')
    .option('--name <name>', 'Name of the new connection')
    .option('--reconnect <name>', 'Refresh an existing connection instead (its platform is looked up when omitted)')
    .option('--bind <project:var>', 'Bind a project variable to the connection once it is connected (repeatable, up to 10)', (value: string, previous: string[] = []) => [...previous, value], [])
    .action((platform, options) => {
        connectionConnect(platform, options);
    });
```

- [ ] **Step 6: Classify it** in `src/utils/mutating-commands.ts`: add `'connection connect',` to `MUTATING_COMMANDS` with the comment `// POSTs a connect-link request (a row the workspace counts against its open-link limit).`

- [ ] **Step 7: Static check.** `npm run build` must succeed (it also regenerates `dist/command-manifest.json`, which `tests/mutating-commands.test.ts` reads). Do not run vitest.

- [ ] **Step 8: Report (do not commit).** Test paths, source paths, expected-RED table (every row fails on the base because `connection connect` and `src/utils/connect-link.ts` do not exist; name each row 1-14 and each pure-function test), the build tail. The manager commits with `git add -- <paths>` then `git commit -m "feat(connection): connect mints a connect link (cli#219)" -- <paths>`.

---

### Task 2: `connection wait` (cli#219)

**Depends on:** Task 1 (committed: `src/utils/connect-link.ts`, the connection block in `src/index.ts`, `src/utils/mutating-commands.ts`) and Task 3 (committed: the `connections:request` hint).

**Files (file scope — the only paths this task may touch):**
- Create: `src/commands/connection-wait.ts`
- Modify: `src/index.ts` (the `// connection <subcommand>` block and its import list only; Task 1 edited it before)
- Modify: `src/utils/mutating-commands.ts` (add `'connection wait'` to `READONLY_COMMANDS` only; Task 1 edited `MUTATING_COMMANDS` before)
- Create: `tests/connection-wait.test.ts` (spawned, plus direct `parseWaitTimeout` rows)
- Create: `tests/connect-link-old-token.test.ts` (spawned: `connect` and `wait` with an older token)

Existing tests that must stay green: `tests/mutating-commands.test.ts`, `tests/command-manifest*.test.ts`, `tests/command-tree-export.test.ts`, `tests/host-display-guard.test.ts`, `tests/connection-connect.test.ts`.

**Interfaces:**
- Consumes (from Task 1, `src/utils/connect-link.ts`): `ConnectLink`, `connectLinkFailureLine`, `connectLinkPath`, `formatExpiry`, `plainText`, `waitCommandLine` — exact signatures in Task 1's Produces block.
- Produces (`src/commands/connection-wait.ts`):

```ts
export const WAIT_POLL_INTERVAL_MS = 5_000;
export const WAIT_DEFAULT_TIMEOUT = '15m';
export const WAIT_MAX_FAILED_CHECKS = 5;
export const WAIT_EXIT_TIMEOUT = 2;
export const WAIT_EXIT_INTERRUPTED = 130;
/** '30s' | '15m' | '1h' | '90' (seconds) → milliseconds; 1s..24h; else throws Error with a one-line message. */
export function parseWaitTimeout(value: string): number;
export interface ConnectionWaitOptions { timeout?: string }
export async function connectionWait(requestId: string, options: ConnectionWaitOptions): Promise<void>;
```

Poll interval in tests: when `SOLIDACTIONS_TEST_HOOKS === '1'` and `SOLIDACTIONS_CONNECTION_WAIT_INTERVAL_MS` is a positive integer, it replaces the 5 s interval (the repo's test-hook pattern, `src/utils/doc-pull-writes.ts` `faultsFromEnv`). Never documented for users.

- [ ] **Step 1: Write the tests** in `tests/connection-wait.test.ts`. Spawned rows set `SOLIDACTIONS_TEST_HOOKS=1` and `SOLIDACTIONS_CONNECTION_WAIT_INTERVAL_MS=50`. The server answers `GET /api/v1/connections/requests/<id>` from a per-test queue of responses (the last one repeats) and records each request.
  1. `parseWaitTimeout`: `'30s'` → 30000, `'15m'` → 900000, `'1h'` → 3600000, `'90'` → 90000, `'24h'` → 86400000; `'0s'`, `'25h'`, `'abc'`, `'15 m'`, `'-5'`, `''` throw with a message containing `--timeout`.
  2. Queue: `requested`, `opened`, then `connected` with `connection: {id: 7, name: 'gmail-main', status: 'active'}`, `connected_by: {name: 'Pat Doe'}`, bindings `[{project: 'newsletter', var: 'GMAIL_KEY'}]` → exit 0; stdout contains `Connected: gmail-main (Gmail), by Pat Doe.` and `  project newsletter uses it as GMAIL_KEY`; every request is `GET /api/v1/connections/requests/01JBTEST` with `authorization: Bearer test-key` and `x-workspace-id: workspace-1`; 3 requests.
  3. Connected with `bindings: []` → stdout contains `Bindings: none.`
  4. `expired` (mode `connect`, platform `gmail`, name `gmail-main`) → exit 1; stderr one line containing `expired` and `solidactions connection connect gmail --name gmail-main`. Mode `reconnect` → the line contains `solidactions connection connect gmail --reconnect gmail-main`.
  5. `cancelled` → exit 1; stderr one line containing `was cancelled`.
  6. Always `requested` (`expires_at: '2026-10-29T19:00:00Z'`), `--timeout 1s` → exit **2**; stderr one line containing `Still waiting after 1s`, `is requested`, `link expires 2026-10-29 19:00 UTC` and `solidactions connection wait 01JBTEST`; stdout's waiting line also shows `2026-10-29 19:00 UTC`; at least 2 requests.
  7. 503, 503, then connected → exit 0, stdout `Connected: …`.
  8. Always 503 → exit 1 after **exactly 5** requests; stderr one line starting `Failed: 503` and containing `5 failed checks in a row`.
  9. 404 `{code: 'request_not_found', message: 'Connect link not found.'}` → exit 1 after exactly 1 request; stderr `Failed: 404 Connect link not found.`
  10. 401 → exit 1 after 1 request; stderr contains `Authentication failed against`.
  11. Status `"weird"` → exit 1; stderr contains `unknown status`; never exit 0.
  12. `--timeout 15 m` (invalid) → exit 1, zero requests, stderr contains `--timeout`.
  13. Connected payload whose `connection.name` contains `\u001b[2J` → stdout has no `\u001b`.
  16. (plan review Important 1) Ctrl-C: always `requested`, `--timeout 1h`. This row needs the child handle, so use a `spawnCli` variant of `runCli` that returns `{child, done}` (`done` resolves `{stdout, stderr, status, signal}` on `close`). Poll until the server has recorded at least 1 request (give up after 5 s), then `child.kill('SIGINT')`. Assert: `status === 130` and `signal === null`; stderr contains `Still waiting: resume with solidactions connection wait 01JBTEST`; stderr has no `Failed` and no `    at `; after `close`, wait 300 ms (6 intervals) and assert the request count is unchanged. Mark it `it.skipIf(process.platform === 'win32')('… (SIGINT to a child is not deliverable on Windows; CI unit tests run on Linux)', …)`.
  17. (plan review Minor 1) The timeout line never prints `unknown` as if it were a status. Both cases use `SOLIDACTIONS_CONNECTION_WAIT_INTERVAL_MS=400` and `--timeout 1s`, so checks run at about 0, 0.4, 0.8 and 1.0 s (at most 4 failures, under the limit of 5). (a) Queue `requested`, then 503 forever → exit 2; stderr contains `is requested`. (b) 503 forever → exit 2; stderr contains `status unknown (last check failed)` and does not contain `is unknown`.

  In `tests/connect-link-old-token.test.ts` (spawned; the server answers 403 `{code: 'token_missing_ability', message: "This API key does not have the 'connections:request' ability.", required_ability: 'connections:request'}`):
  14. `connection connect gmail --name gmail-main` → exit 1; stderr contains `Failed: 403`, `does not have the 'connections:request' ability` and `solidactions login --device`; stderr does not contain `Authentication failed`.
  15. `connection wait 01JBTEST` → the same three assertions, after exactly 1 request.

- [ ] **Step 2: Write `src/commands/connection-wait.ts`:**

```ts
import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { ConnectLink, connectLinkFailureLine, connectLinkPath, formatExpiry, plainText, waitCommandLine } from '../utils/connect-link';

export const WAIT_POLL_INTERVAL_MS = 5_000;
export const WAIT_DEFAULT_TIMEOUT = '15m';
export const WAIT_MAX_FAILED_CHECKS = 5;
export const WAIT_EXIT_TIMEOUT = 2;
export const WAIT_EXIT_INTERRUPTED = 130;

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };
const MAX_TIMEOUT_MS = 24 * 3_600_000;

export interface ConnectionWaitOptions {
    timeout?: string;
}

export function parseWaitTimeout(value: string): number {
    const match = /^(\d+)([smh]?)$/.exec(value.trim());
    if (!match) {
        throw new Error(`--timeout must look like 30s, 15m or 1h (got "${value}").`);
    }
    const ms = Number(match[1]) * UNIT_MS[match[2] || 's'];
    if (ms < 1_000 || ms > MAX_TIMEOUT_MS) {
        throw new Error('--timeout must be between 1s and 24h.');
    }
    return ms;
}

function pollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
    if (env.SOLIDACTIONS_TEST_HOOKS === '1') {
        const override = Number(env.SOLIDACTIONS_CONNECTION_WAIT_INTERVAL_MS);
        if (Number.isInteger(override) && override > 0) return override;
    }
    return WAIT_POLL_INTERVAL_MS;
}

function isTransient(error: any): boolean {
    const status = error?.response?.status;
    return status === undefined || status === 429 || status >= 500;
}

function fail(line: string, code = 1): never {
    console.error(chalk.red(plainText(line)));
    process.exit(code);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryCommand(link: ConnectLink): string {
    const flag = link.mode === 'reconnect' ? '--reconnect' : '--name';
    return `solidactions connection connect ${link.platform} ${flag} ${link.name}`;
}

function printConnected(link: ConnectLink): void {
    const name = link.connection?.name ?? link.name;
    const by = link.connected_by?.name ? `, by ${link.connected_by.name}` : '';
    console.log(plainText(`Connected: ${name} (${link.platform_name})${by}.`));
    if (!link.bindings || link.bindings.length === 0) {
        console.log('Bindings: none.');
        return;
    }
    for (const binding of link.bindings) {
        console.log(plainText(`  project ${binding.project} uses it as ${binding.var}`));
    }
}

export async function connectionWait(requestId: string, options: ConnectionWaitOptions): Promise<void> {
    const timeoutText = (options.timeout ?? WAIT_DEFAULT_TIMEOUT).trim();
    let timeoutMs = 0;
    try {
        timeoutMs = parseWaitTimeout(timeoutText);
    } catch (error: any) {
        fail(`connection wait: ${error.message}`);
    }

    const config = await requireConfigWithWorkspace();

    // Ctrl-C: the link stays open on the server; say how to pick the wait up again.
    process.once('SIGINT', () => {
        console.error(chalk.gray(plainText(`Still waiting: resume with ${waitCommandLine(requestId)}`)));
        process.exit(WAIT_EXIT_INTERRUPTED);
    });

    const interval = pollIntervalMs();
    const deadline = Date.now() + timeoutMs;
    let failedChecks = 0;
    let last: ConnectLink | null = null;
    let announced = false;

    while (true) {
        try {
            const response = await axios.get(`${config.host}${connectLinkPath(requestId)}`, { headers: getApiHeaders(config) });
            failedChecks = 0;
            last = response.data as ConnectLink;
            switch (last.status) {
                case 'connected':
                    printConnected(last);
                    return;
                case 'expired':
                    fail(`Connect link ${last.id} expired before anyone connected ${last.name}. Ask for a new one: ${retryCommand(last)}`);
                case 'cancelled':
                    fail(`Connect link ${last.id} for ${last.name} was cancelled.`);
                case 'requested':
                case 'opened':
                    if (!announced) {
                        console.log(plainText(`Waiting for someone to connect ${last.platform_name} as ${last.name} (request ${last.id}, link expires ${formatExpiry(last.expires_at)}).`));
                        announced = true;
                    }
                    break;
                default:
                    fail(`Failed: connect link ${requestId} has an unknown status "${String(last.status)}".`);
            }
        } catch (error: any) {
            if (!isTransient(error)) {
                fail(connectLinkFailureLine(error, config.host));
            }
            failedChecks += 1;
            if (failedChecks >= WAIT_MAX_FAILED_CHECKS) {
                fail(`${connectLinkFailureLine(error, config.host)} (gave up after ${WAIT_MAX_FAILED_CHECKS} failed checks in a row)`);
            }
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            const state = last ? `is ${last.status}` : 'status unknown (last check failed)';
            const expires = last?.expires_at ? ` (link expires ${formatExpiry(last.expires_at)})` : '';
            fail(`Still waiting after ${timeoutText}: connect link ${requestId} ${state}${expires}. Run ${waitCommandLine(requestId)} again to keep waiting.`, WAIT_EXIT_TIMEOUT);
        }
        await sleep(Math.min(interval, remaining));
    }
}
```

  Note: `fail()` inside `try` calls `process.exit`, which does not throw, so the `catch` never sees it. A `switch` case that calls `fail()` needs no `break`: `fail()` returns `never`, and this repo's `tsconfig.json` does not enable `noFallthroughCasesInSwitch`, so keep the code as shown.

- [ ] **Step 3: Register** in `src/index.ts`, in the connection block after `connect`, and add `import { connectionWait } from './commands/connection-wait';`:

```ts
connection
    .command('wait <request-id>')
    .description('Wait until a connect link is used: exit 0 connected, 1 expired, cancelled or failed, 2 still open at --timeout, 130 on Ctrl-C')
    .option('--timeout <duration>', 'How long to wait, e.g. 30s, 15m, 1h', '15m')
    .action((requestId, options) => {
        connectionWait(requestId, options);
    });
```

- [ ] **Step 4: Classify** in `src/utils/mutating-commands.ts`: add `'connection wait',` to `READONLY_COMMANDS` right after `'connection list',`.

- [ ] **Step 5: Static check.** `npm run build` succeeds. Do not run vitest.

- [ ] **Step 6: Report (do not commit).** Test paths, source paths, expected-RED table (rows 2-17 fail on the base because `connection wait` does not exist; row 14 also fails on Task 1's head without Task 3; row 1 because `parseWaitTimeout` does not exist), the build tail. The manager commits with `git commit -m "feat(connection): wait for a connect link (cli#219)" -- <paths>`.

---

### Task 3: device login asks for `connections:request`; older tokens get a re-login line (cli#219)

**Files (file scope — the only paths this task may touch):**
- Modify: `src/commands/device-login.ts` (the scope constants, lines 18-35, and `requestDeviceCode`, lines 51-74, only)
- Modify: `src/utils/api.ts` (`augmentTokenMissingAbilityMessage`, lines 159-207, only)
- Modify: `tests/device-login-scope-fallback.test.ts` (the test "retries once with the legacy scope list when the server rejects env:reveal with invalid_scope": it now sees 3 requests; plus new rows)
- Modify: `tests/database-device-auth-contract.test.ts` (the test "requests the coarse databases scope during device authorization": its exact sorted scope list gains `connections:request`)
- Create: `tests/connect-link-ability-hint.test.ts`

Callers and doubles of the changed functions, grepped at plan time (`grep -rn "requestDeviceCode\|augmentTokenMissingAbilityMessage" src tests`): `src/commands/device-login.ts` (definition and its caller in the device login flow), `src/utils/api.ts` (definition and the axios interceptor), `tests/device-login-scope-fallback.test.ts`, `tests/database-device-auth-contract.test.ts`, `tests/env-reveal-ability-hint.test.ts`, `tests/env-set-no-reveal.test.ts`, `tests/env-pull-reveal-denied.test.ts`, `tests/dev-reveal.test.ts`, `tests/database-lifecycle-commands.test.ts`, `tests/dev-database-env.test.ts`, `tests/workflow-view.test.ts`. Only the first two tests change; the rest must stay green (the `databases` and `env:reveal` branches are untouched).

**Interfaces:**
- Produces: `requestDeviceCode(host)` keeps its signature. `augmentTokenMissingAbilityMessage(error)` keeps its signature and gains a `connections:request` branch. The hint text below is frozen (Task 2's old-token test asserts `solidactions login --device`).

- [ ] **Step 1: Write the tests.**
  - `tests/device-login-scope-fallback.test.ts`, new rows:
    - a server that answers 400 `invalid_scope` to any scope string containing `connections:request` → `requestDeviceCode` resolves; 2 requests; `requests[0].scope` contains `connections:request`; `requests[1].scope` contains `env:reveal` and not `connections:request`.
    - a server that accepts everything → 1 request whose scope contains `connections:request` and `env:reveal`.
    - change the existing "retries once with the legacy scope list…" row: the server rejects any scope containing `env:reveal` → 3 requests; `requests[2].scope` contains neither `env:reveal` nor `connections:request`. Rename it to "falls back to the legacy scope list when the server rejects env:reveal with invalid_scope". Keep "does not retry … invalid_client" (1 request).
  - `tests/database-device-auth-contract.test.ts`: the expected sorted list becomes `['connections:request', 'databases', 'deploy', 'docs', 'env', 'env:reveal', 'runs']`; extend the comment: "`connections:request` joined in cli#219 (connect links)."
  - `tests/connect-link-ability-hint.test.ts` (direct, like `tests/env-reveal-ability-hint.test.ts`): a 403 `{code: 'token_missing_ability', message: "This API key does not have the 'connections:request' ability.", required_ability: 'connections:request'}` → the message keeps the server sentence and contains `solidactions login --device` and `Settings → API keys`; applying it twice does not double the hint; a 403 `forbidden` and a 403 naming `env` are returned unchanged.

- [ ] **Step 2: Change the scopes** in `src/commands/device-login.ts`:

```ts
// `connections:request` (cli#219, connect links) is granted with the token
// like the other CLI scopes. It comes first; a server that has not
// registered it rejects the whole request with `invalid_scope`, and the
// next list is tried.
const CLI_SCOPES_WITH_CONNECT_LINKS = 'env env:reveal deploy runs docs databases connections:request';
const CLI_SCOPES_WITH_REVEAL = 'env env:reveal deploy runs docs databases';
const CLI_SCOPES_LEGACY = 'env deploy runs docs databases';

// Tried in order; each retry only on 400 `invalid_scope`.
const CLI_SCOPE_LISTS = [CLI_SCOPES_WITH_CONNECT_LINKS, CLI_SCOPES_WITH_REVEAL, CLI_SCOPES_LEGACY];
```

and `requestDeviceCode`:

```ts
export async function requestDeviceCode(host: string): Promise<DeviceCodeResponse> {
    for (let i = 0; ; i++) {
        try {
            const response = await axios.post(`${host}/oauth/device/code`, {
                client_id: CLI_OAUTH_CLIENT_ID,
                scope: CLI_SCOPE_LISTS[i],
            });
            return response.data;
        } catch (e: any) {
            const invalidScope = e?.response?.status === 400 && e.response.data?.error === 'invalid_scope';
            if (invalidScope && i < CLI_SCOPE_LISTS.length - 1) {
                continue;
            }
            throw e;
        }
    }
}
```

  Keep the existing comments on `env:reveal` and the legacy list; update the function's doc comment to describe the three lists.

- [ ] **Step 3: Add the hint branch** in `augmentTokenMissingAbilityMessage` (`src/utils/api.ts`), after the `env:reveal` branch:

```ts
    if (
        response?.status === 403
        && response.data?.code === 'token_missing_ability'
        && requiredAbility === 'connections:request'
    ) {
        const hint = "Connect links need the 'connections:request' ability. "
            + 'Run `solidactions login --device` again to get it, or create an API key with '
            + "'connections:request' checked at Settings → API keys and `solidactions login` with that key.";
        const message = typeof response.data.message === 'string' && response.data.message.length > 0
            ? response.data.message
            : "This session does not have the 'connections:request' ability.";
        if (!message.includes('Connect links need')) {
            response.data.message = `${message}\n\n${hint}`;
        }
    }
```

  Update the function's doc comment to name the three abilities it handles.

- [ ] **Step 4: Static check.** `npm run build` succeeds. Do not run vitest.

- [ ] **Step 5: Report (do not commit).** Test paths, source paths, the two changed older tests with old and new expectations, the expected-RED table, the build tail. The manager commits with `git commit -m "feat(login): request connections:request; re-login hint for older tokens (cli#219)" -- <paths>`.

---

### Task 4: `connection list` shows DATA SOURCE (cli#219, app#2189 follow-up)

**Files (file scope — the only paths this task may touch):**
- Modify: `src/commands/connection-list.ts`
- Modify: `tests/connection-list.test.ts` (the test "GETs the workspace connections endpoint and renders the connection summary table", plus one new row)

`tests/config-credential-pair.test.ts` also spawns `connection list` (with empty data); it must stay green and is not edited.

**Interfaces:** none shared. `OAuthConnection` gains `allow_source_use?: boolean`.

- [ ] **Step 1: Write the tests.** In the existing render test, give `Primary Gmail` `allow_source_use: true` and `Team Slack` `allow_source_use: false`; assert the header line contains `DATA SOURCE`, the stdout line containing `Primary Gmail` matches `/\byes\b/`, and the line containing `Team Slack` matches `/\bno\b/`. New row: a connection without the field (`name: 'Old Server Row'`) → its line ends with ` -` after trimming trailing spaces, or matches `/\s-\s*$/` (DATA SOURCE is the last column).

- [ ] **Step 2: Implement** in `src/commands/connection-list.ts`:

```ts
function sourceUse(connection: OAuthConnection): string {
    if (connection.allow_source_use === true) return 'yes';
    if (connection.allow_source_use === false) return 'no';
    return '-';
}
```

  Add `sourceUse(connection)` as the last cell of each row and `'DATA SOURCE'` as the last header (`['NAME', 'PROVIDER', 'STATUS', 'LAST USED', 'DATA SOURCE']`). Leave `minWidths` as is.

- [ ] **Step 3: Static check.** `npm run build` succeeds. Do not run vitest.

- [ ] **Step 4: Report (do not commit).** Test path, source path, the changed older test with old and new expectation, the expected-RED table (the header and `yes`/`no`/`-` assertions fail on the base: no such column), the build tail. The manager commits with `git commit -m "feat(connection): list shows whether a connection may be a data source (cli#219)" -- <paths>`.

---

## Verify (for the manager, not a developer task)

- Live smoke: `npm run build` in the slot, then the built CLI (`node dist/index.js`) against the app main checkout's `sa-dev` stack (`/home/mercer/projects/solid/solidactions-app`, `docker compose -p sa-dev start`), never `sa-dev-wave-a`, never production. Check first that the stack's code has the connect-link routes (`git -C /home/mercer/projects/solid/solidactions-app log -1` at or after the app v0.243.0 merge, PR #2220); if not, say so on the verify card and mail the PM. Exercise: device login (scope includes `connections:request`), `connection connect` (connect and `--reconnect`, with and without platform, a `--bind`), `connection wait` (timeout exit 2 while open; connected after completing the link in a browser if the stack's Pica sandbox allows; otherwise cancel from the Connections page → exit 1), `connection list` (DATA SOURCE), an older token (a PAT without `connections:request`) → the re-login line.
- Cleanroom: qa drives the CLI cold against `sa-dev` with goal-only prompts ("ask a teammate to connect Gmail for project X and find out when it is done"; "refresh a broken connection"; "see which connections dashboards may use").

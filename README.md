# SolidActions CLI

Deploy and manage workflow automation with SolidActions.

Public setup guides: [www.solidactions.com/docs](https://www.solidactions.com/docs)

## Prerequisites

- Node.js 24 for generated workflow projects (`@solidactions/sdk` requires Node 24)
- A SolidActions account, workspace, and API key

## Installation

```bash
npm install -g @solidactions/cli
```

## Quick Start

Create an API key in the SolidActions app under **Settings → API Keys**, then run:

```bash
# The API key is requested in a masked prompt and is not placed in shell history.
solidactions login --global

# Choose one agent target. init creates the project and installs local skills.
solidactions init my-project --claude
# Or: solidactions init my-project --agents

cd my-project
npm install
solidactions project deploy my-project -e production
solidactions run start my-project hello -e production -i '{"name":"Ada"}' --wait
```

The generated `hello` workflow requires no third-party credentials. A successful
run completes with a greeting of `Hello, Ada!`; use the run ID printed by the
command with `solidactions run view <run-id>` (accepts the numeric run id or
the run UUID) or open the run in the app.

For non-interactive automation, explicitly read the key from stdin instead of
placing it in argv:

```bash
printenv SOLIDACTIONS_API_KEY | solidactions login --stdin --global
```

Automation that does not need to write a config file can set
`SOLIDACTIONS_API_KEY` and `SOLIDACTIONS_WORKSPACE_ID` directly.

### Verify the generated AI tooling

`solidactions init` installs all five current SolidActions skills plus the SDK
reference:

- `solidactions-getting-started`
- `solidactions-workflow-coding`
- `solidactions-deploy-and-config`
- `solidactions-oauth-actions`
- `solidactions-crew-skills`

For `--claude`, skills are written to `.claude/skills/`; for `--agents`, they
are written to `.agents/skills/`. Each skill is a flat `solidactions-*.md` file.
Both targets receive `.solidactions/sdk-reference.md` and a pointer block in
`CLAUDE.md` or `AGENTS.md`.

```bash
# Use the directory matching the target selected above.
find .claude/skills -maxdepth 1 -name 'solidactions-*.md' -print
test -f .solidactions/sdk-reference.md
```

Restart the coding-agent session after installation so it reloads project
instructions. Then ask: “Which SolidActions skills are installed, and which
one should you use to deploy this workflow?” The answer should identify the
installed skills and select `solidactions-deploy-and-config` for deployment.

For an existing project, install the same tooling with
`solidactions ai init --claude` or `solidactions ai init --agents`. Installed
skill directories carry a `.solidactions-version` stamp; when the CLI reports
that stamp is stale, run `solidactions ai init --update` to refresh the existing
helper target.

### Agent freshness notices

The CLI may print four kinds of one-line `AGENT NOTE` notices to stderr: a cached
daily outdated-CLI notice, a missing- or stale-skills prompt, and a notice in a
Claude Cowork sandbox that its project skills are not auto-loaded. The npm
registry refresh runs detached and silently; normal invocations read only its
daily cache. These notices never alter stdout, including `--json` output.

Set `SOLIDACTIONS_NO_AGENT_NUDGES=1` to suppress all four notices and the
background update refresh.

## Database CLI

Use the singular `solidactions database` group to manage databases in the
active workspace. The complete command surface is:

```bash
solidactions database list --json
solidactions database create analytics --from backup.sql --json
solidactions database delete analytics --yes --json
solidactions database undelete analytics --json
solidactions database schema analytics --json
solidactions database query analytics "SELECT * FROM events" --json
solidactions database exec analytics "DELETE FROM events WHERE expired = 1" --yes --json
solidactions database dump analytics backup.sql --yes
solidactions database pull analytics .solidactions/databases/analytics.db --yes
solidactions database pull analytics --writable
solidactions database import analytics backup.sql --yes
solidactions database import analytics backup.sql --resume <checkpoint> --yes
solidactions database push analytics complete.db --yes
solidactions database create analytics --kind duckdb --json
solidactions database list --kind duckdb --json
solidactions database show analytics --json
solidactions database ingest analytics data.parquet --table events --json
solidactions database ingest analytics data.csv --table events --mode replace --json
solidactions database export analytics --table events --table orders --output ./snapshot
solidactions database export analytics --no-wait --json
solidactions database export analytics --resume <export-id>
solidactions database drop-table analytics events --yes --json
solidactions database optimize analytics --wait --json
solidactions database connect analytics --json
solidactions database wake analytics --json
solidactions database query analytics "select category, sum(amount) from events group by 1" --limit 1000 --json
```

`--json` produces machine-readable output where supported. `delete`, `exec`,
`dump` overwrites, `pull` overwrites, `drop-table`, and `import` prompt before
changing data; use `--yes` only when that change is already approved. A
database `delete` is a soft-delete, and its output shows the purge clock
during which `undelete` can restore it (either kind).

`create --kind` defaults to the standard (SQLite) kind; pass `--kind duckdb`
for an analytical database (waits for provisioning unless `--no-wait`).
`--from` only applies to the standard kind — `create --kind duckdb --from
<file>` is rejected up front, before the database is created, since SQL
import is meaningless for an analytical database; load one with `ingest`
after creation. Analytical verbs — `ingest`, `export`, `drop-table`, `optimize`,
`connect`, `wake` — only work against a `duckdb` database. `dump`, `pull`,
`push`, `import`, and `exec` are for the standard (SQLite) kind only and
refuse an analytical name with a one-line hint.

`ingest --mode replace` overwrites a table's contents with no `--yes` prompt
(unlike `drop-table`, which is a separate, rarer, schema-shaped operation) —
this is the normal, expected way to refresh an analytical table from an
unattended pipeline, so it is not gated behind confirmation.

`database export <name>` takes a point-in-time analytical snapshot as one
ZSTD Parquet file per selected table plus `manifest.json`. With no `--table`
it exports every user table; repeat `--table` for an exact subset. The default
waits, verifies every byte length and SHA-256, and writes a new deterministic
directory. Use `--no-wait` to keep only the accepted export id, `--resume <id>`
after an interruption, `--output <directory>` to choose the target, and
`--replace` for non-interactive replacement of a non-reusable ready export.
`--json` provides machine-readable accepted or verified-terminal output.
Artifacts expire 24 hours after preparation completes. While the snapshot is prepared, new loads
pause and the awake database uses organisation credits.

`query` is read-only SQL; use `exec` for writes. `schema`, `query`, `exec`,
`pull --writable`, and imports use ephemeral scoped access held only in memory.
No durable credential or credential sidecar is written locally.

By default, `pull` atomically publishes a read-only local replica at
`.solidactions/databases/<safe-stem>.db`, or at an explicit path. Reuse that
file for local analytics and transformations. `pull --writable` instead opens a
foreground session: writes go to the live workspace database.

`database push` replaces the complete remote database from a local SQLite file.
It requires `--yes`, never changes the source file, and normalizes a private
snapshot to UTF-8 SQLite with 4096-byte pages, no auto-vacuum, and WAL mode.
The normalized snapshot can have a different byte size from the source.
Quiesce writers before starting: replacement invalidates the old database URL
and credentials. Empty databases additionally require `--allow-empty`; use
`--idempotency-key <uuid>` to safely replay an interrupted operation.
Reported countable rows include ordinary user tables; internal, virtual, and
shadow tables are excluded.
No offline merge or background write-back continues after exit.

`dump` publishes only a complete SQL file through an owned temporary path and
refuses unsafe symlink or unapproved overwrite destinations. The CLI rejects
any import containing `-- DOWNLOAD INCOMPLETE` before making changes. Use
`create --from <file.sql>` to preflight, create, and load in one flow.

Imports commit bounded batches and atomically record a source-bound checkpoint
under `.solidactions/imports/`. After a partial failure, copy the exact printed
`--resume <checkpoint>` command to continue without replaying completed
batches; do not restart the same checkpointed source with a plain import.

## Configuration

The CLI stores `host`, `apiKey`, and `workspaceId` in a JSON config file. Two locations are supported:

- **Global** — `~/.solidactions/config.json`. Used by default, shared across all folders for a single user.
- **Local** — `./.solidactions/config.json`. Scoped to a project folder; takes precedence over the global file when running commands from inside that folder (or any subdirectory — the CLI walks up looking for it).

### Resolution order

Each field is looked up in this order, and the first layer that sets it wins:

1. Environment variables: `SOLIDACTIONS_HOST`, `SOLIDACTIONS_API_KEY`, `SOLIDACTIONS_WORKSPACE_ID`
2. Nearest local `./.solidactions/config.json` (walking up from cwd)
3. Global `~/.solidactions/config.json`

**An API key is only ever sent to the host configured with it.** If a layer above the one that supplies the key sets a *different* `host` (for example a local file with only `"host"`, or `SOLIDACTIONS_HOST` on its own), the CLI refuses instead of sending that key to the other host, and says which file or variable to change. A key from `SOLIDACTIONS_API_KEY` without `SOLIDACTIONS_HOST` goes only to the host in the global config (`~/.solidactions/config.json`), or to `https://app.solidactions.com` when no file names a host. It is never sent to a host that a project folder's `.solidactions/config.json` names (unless that is the same host as the global one), so a cloned repository cannot redirect an exported key; set `SOLIDACTIONS_HOST` as well to use another host. A layer may still set only the workspace (`workspace set --local`, or `SOLIDACTIONS_WORKSPACE_ID`) and use the credentials from the layer below.

Hosts are compared exactly, ignoring only surrounding space, trailing slashes and letter case: `https://example.com` and `https://example.com:443` count as different hosts and are refused rather than guessed at. Write the host the same way in every file.

### Workspace safety

Resolution order layers 2 and 3 mean the active workspace can come from *where you are
standing*: a `./.solidactions/config.json` in the current folder or any ancestor. That's
convenient in a single project, but running a command from the wrong directory can silently
target a different workspace than the one you last used.

The CLI remembers the workspace it last **wrote** to in `~/.solidactions/state.json` (a
cosmetic/advisory file — deleting it just means the next command has nothing to compare
against). Read-only commands never update it — a read must never consume the change that
gates a write, so the warning below keeps firing until you actually write. When a
CWD-inferred workspace differs from that last-written-to one, the CLI warns:

```
warn: workspace changed to <name> — organization <org> (<workspaceId>) — inferred from <path>; last used was <last-used-name-or-id>. Pin it with -w <workspaceId>.
```

On a fresh install (or a fresh CI container) there's no `state.json` yet, so a CWD-inferred
write has nothing to compare against. A **write** in that case still warns — once, on that
first write — even though nothing has "changed":

```
warn: about to write to <name> — organization <org> (<workspaceId>) — inferred from <path>; no previously recorded workspace to compare against. Pin it with -w <workspaceId>.
```

This warns and proceeds; it never confirms or refuses. That first write records `state.json`,
so this line cannot fire again — from then on there is a baseline, and a later CWD-inferred
write against a *different* workspace gets the `workspace changed to …` treatment above.

For commands that **write** to the server, it also asks for confirmation before proceeding:

```
This command WRITES to <name> — organization <org> (<workspaceId>). Proceed?
```

Consent to a workspace is exactly two things: stating it explicitly with
`-w <id-or-slug-or-name>` or `SOLIDACTIONS_WORKSPACE_ID` (either of which skips the prompt
entirely), or answering the prompt. A command's **own** `--yes` is not workspace consent — it
acknowledges that command's own destructive act (`database push` requires `-y`, `database
pull --yes` means "overwrite the local file") and says nothing about which workspace you meant. A
non-interactive shell is refused rather than guessed:

```
re-run with -w <workspaceId> to confirm the target workspace
```

**Breaking change for existing non-interactive automation.** A script, cron job, or CI step
that writes from a directory whose `.solidactions/config.json` supplies the workspace, without
passing `-w` or setting `SOLIDACTIONS_WORKSPACE_ID`, now **exits 1** as soon as
`~/.solidactions/state.json` records a different workspace as the last one written to. On a
persistent runner that is not only the first run: any run after the box has written to some
other workspace — a second project's job, a manual command in another folder — will refuse,
because the guard compares against whatever was written last, not against a per-directory
memory. Passing `-w <id>` (or exporting `SOLIDACTIONS_WORKSPACE_ID`) restores the previous
behaviour and is the recommended fix for every non-interactive caller; it is also what the
refusal message tells you to do. Deleting `state.json` silences one run, not the next.

Read-only commands are never prompted — at most they print the `warn:` line above. Every
mutating command prints its resolved workspace, organization-qualified, as its first output
line:

```
Workspace: <name> — organization <org> (<workspaceId>)
```

### `solidactions login` flags

- With no positional argument, `login` securely prompts for the API key using
  masked input. This is the recommended interactive flow.
- `--stdin` — read the API key from stdin for explicitly non-interactive use.
- `--local` — write config to `./.solidactions/config.json` in the current folder.
- `--global` — write config to `~/.solidactions/config.json` (today's default).
- `--gitignore` — with `--local`, auto-add `.solidactions/` to `.gitignore` without prompting.

In interactive shells, `login` without `--local`/`--global` prompts for a location. In non-interactive contexts, one of the flags is required.

If the target config file already exists and its contents would change, `login` writes a timestamped backup (e.g. `config.json.bak-2026-07-05T12-30-00Z`) alongside it before overwriting, and prints the backup path. Non-interactive runs proceed automatically (with the backup); an interactive TTY additionally asks a y/N confirmation first.

### `solidactions logout` flags

- `--local` — remove only the nearest local config (walks up from cwd).
- `--global` — remove only the global config.
- Bare `logout` — removes the nearest local if present, otherwise removes global.

### Debugging resolution

Set `SOLIDACTIONS_DEBUG=1` on any command to print the resolved configuration and per-field sources to stderr before the command runs. `solidactions whoami` also shows this information.

### Use case: multiple AI agents in parallel

If you run multiple AI coding agents in different project folders simultaneously, either:

- Run `solidactions login --local` interactively in each folder so each has its own config, or
- Set `SOLIDACTIONS_API_KEY` / `SOLIDACTIONS_WORKSPACE_ID` in the environment each agent uses (no files to share or stomp).

### Deploy bundle exclusions (`solidactions.yaml`)

When you run `solidactions project deploy`, the CLI bundles your project directory and uploads it. You can control what goes into that bundle with an optional `deploy:` block in `solidactions.yaml`:

```yaml
deploy:
  exclude:            # additive, gitignore-style patterns
    - web/            # a large local-only sub-app you don't deploy
    - "*.tmp"
  gitignore: true     # opt-in: also honor this project's .gitignore
```

- **`deploy.exclude`** — a list of gitignore-style patterns (anchoring, `*.log`-at-any-depth, and `!` negation all work). Use it to keep large local-only directories (e.g. a `.venv` or a legacy `web/` app) out of the upload — this avoids `413 Request Entity Too Large` failures. Additive on top of the always-excluded defaults: `node_modules/`, `.git/`, `dist/`, `vendor/`.
- **`deploy.gitignore`** — `false` by default. Set to `true` to also apply your project's root `.gitignore` to the bundle. This is opt-in so deploys don't silently change behavior.
- **`.env` and `.env.*` are always excluded**, regardless of config, and no `!` negation can re-include them. Secrets must come from `solidactions env set` (they are injected at runtime), and must never be baked into the deploy bundle.

The CLI prints a one-line summary of what it bundled, e.g. `Bundling 312 files (.env excluded; .gitignore applied; 2 exclude rules)`, and warns about any symlinks it skipped.

Deploys also transmit client-reported Git provenance when it can be collected:
commit, branch/tag, subject/date, sanitized remote repository URL (with
credentials stripped), and whether the deployed subtree was dirty. The CLI
prints the local revision before upload and confirms the server-recorded
revision after the build. Use `--no-git-metadata` or
`SOLIDACTIONS_NO_GIT_METADATA=1` to opt out. Deploying a non-Git directory
continues normally without revision metadata.

### Env declarations (`solidactions.yaml`)

Declare the variables a workflow needs with an `env:` list in `solidactions.yaml`. Each entry uses one of four forms:

```yaml
env:
  - LOG_LEVEL                    # plain: declared only, configure with `env set`
  - API_KEY: SHARED_API_KEY      # global mapping: defaults to a workspace global variable
  - GCAL_TOKEN:
      oauth: "Google Calendar"   # defaults to a workspace OAuth connection
  - ANALYTICS_DB:
      database: "analytics"      # defaults to a workspace database
```

- A global key, an `oauth:` name, and a `database:` name are **mutually exclusive**: bind each variable to exactly one. The platform enforces that server-side (HTTP 422), but do not rely on seeing that error: through CLI v3.6.0 the YAML parser keeps only the first form it recognizes — `oauth:` beats `database:` — so a declaration carrying both deploys silently as the wrong binding instead of failing.
- `project deploy` (including `--config-only`) syncs the *complete* `env:` list to the server on every run. Any previously YAML-sourced mapping whose name no longer appears in the list is deleted — removing or emptying `env:` prunes those mappings on the next deploy. Only mappings that were never YAML-declared survive: overriding a YAML-declared variable with `env set`/`env map` doesn't change its provenance, so removing its declaration still deletes the mapping.
- Create the workspace database first with `solidactions database create <name>` or in the web UI. Workspace-database bindings require `@solidactions/sdk >=0.8.0`.
- For a `database:` entry, the workflow receives a typed `DatabaseVar` at `ctx.vars.<NAME>` at runtime, typically wrapped with the SDK's `createDatabaseClient()`. The private transport payload uses `read_only`; SDK 0.8.0+ normalizes it to the public `DatabaseVar.readOnly` property. Use the typed SDK object rather than parsing the transport payload. See the SDK reference's [Workspace Databases](https://github.com/SolidActions/solidactions-ts-sdk/blob/main/docs/sdk-reference.md#workspace-databases) section for details.

## Commands

Use `solidactions <command> --help` for full flag details on any command.

### Top-level

| Command | Description |
|---------|-------------|
| `login` | Authenticate via a masked API-key prompt (`--stdin` for automation) |
| `logout` | Remove saved credentials |
| `whoami` | Show current configuration |
| `init [directory]` | Scaffold a new project (files + AI skills) |
| `dev <file>` | Run a workflow locally (no deploy needed) |

### project

| Command | Key Flags | Description |
|---------|-----------|-------------|
| `project create <name>` | `-e` | Create an empty project (no source/build); `-e` defaults to `production` |
| `project deploy <name> [path]` | `-e`, `--create`, `--config-only`, `--paused`, `--no-git-metadata` | Deploy or sync config only; optionally land YAML schedules paused |
| `project enable <project>` | `-e` (default `dev`) | Allow new starts through this project gate |
| `project disable <project>` | `-e` (default `dev`) | Block new root starts without cancelling existing roots |
| `project view <project>` | `-e` (default `dev`), `--json` | View status, `Enabled: on|off`, and client-reported deployed revision, incl. an `N behind origin/<branch> at deploy` drift clause when the deployment is behind the default branch |
| `project pull <name> [path]` | `-y` | Pull source (warns before overwriting) |
| `project logs <name>` | | View build logs |
| `project list` | `--json` | List project families; environments render as `environment:on/off` |

For `project view`, `<project>` is a project family slug or name and omitting
`--env` targets dev (`billing` resolves to `billing-dev`). Use `--env production`
to pass the supplied production name/slug unchanged; `--env staging` and
`--env dev` derive the same suffixed slug as deploy.

This changes exact-suffixed positional input: `project view billing-dev` now
targets `billing-dev-dev`. Use `project view billing` for the dev target, or
pass `--env production` when `billing-dev` is the legitimate production slug.

Project enable/disable is an explicit, non-interactive operator action. It does
not cascade to workflows or schedules, and deploy does not undo the manual
state.

### workflow

| Command | Key Flags | Description |
|---------|-----------|-------------|
| `workflow view <project> <workflow>` | `-e` (default `dev`), `--json` | Inspect stored workflow/project gates, retirement, enabled source, and effective state |
| `workflow enable <project> <workflow>` | `-e` (default `dev`) | Enable the workflow gate; direct starts still require the project, and scheduled starts also require the schedule |
| `workflow disable <project> <workflow>` | `-e` (default `dev`) | Block new root starts without cancelling existing roots |

Workflow view/enable/disable accepts an exact workflow slug or an exact name and
does not prompt. View defaults to dev like the mutation commands, and reports
`Enabled source: manual override (deploy will not change it)` or
`Enabled source: YAML declaration`; use `--json` for the unmodified
machine-queryable state.
The manual state is sticky across deploys; enabling a workflow does not enable
its project or schedule.

### run

| Command | Key Flags | Description |
|---------|-----------|-------------|
| `run start <project> <workflow>` | `-e`, `-i`, `--wait` | Trigger a workflow run |
| `run list [project]` | `--json`, `--detailed`, `--status`, `--since`, `--workflow`, `--limit`, `--offset` | List and filter runs |
| `run view <run-id>` | `--json`, `--timeline`, `--steps`, `--logs` | Inspect a run (accepts the numeric run id or the run UUID), incl. the deployed revision (`Revision (latest session): ...`, or `deployed_revision` under `--json`) |

### env

| Command | Key Flags | Description |
|---------|-----------|-------------|
| `env set <key> <value> --global` | `-s`, `-y`, `--staging-value`, `--dev-value`, `--global` | Set global variable (warns before overwriting) |
| `env set <project> <key> <value>` | `-e`, `-s`, `-y` | Set project variable (warns before overwriting) |
| `env list [project]` | `-e` | List variables |
| `env delete <key-or-project> [key]` | `-y` | Delete a variable |
| `env map <project> <key> <global-key>` | `-y` | Map global to project key (warns before overwriting) |
| `env pull <project>` | `-e`, `-o`, `-y`, `--update-oauth` | Pull resolved env vars to .env file |
| `env push <project> [path]` | `-e`, `-y`, `--new-only`, `--include-undeclared` | Push .env values to project |

### schedule

| Command | Key Flags | Description |
|---------|-----------|-------------|
| `schedule set <project> <cron>` | `--workflow`, `-i`, `-z`, `-e`, `--paused`, `-y` | Set cron schedule and optional IANA timezone (warns if exists) |
| `schedule list <project>` | `-e` | List effective state and operator/YAML disagreement |
| `schedule enable <project> <id>` | `-e` | Enable a schedule with a sticky override |
| `schedule disable <project> <id>` | `-e` | Disable a schedule with a sticky override |
| `schedule reset <project> <id>` | `-e` | Return a schedule to its last declared YAML state |
| `schedule delete <project> <id>` | `-e`, `-y` | Delete a schedule |

```bash
solidactions schedule set my-project '0 9 * * 1-5' --workflow daily-summary --timezone America/Chicago
solidactions project deploy my-project -e production --paused
solidactions schedule enable my-project 42 -e production
```

### webhook

| Command | Key Flags | Description |
|---------|-----------|-------------|
| `webhook list <project>` | `-e`, `--format table|json`, `--show-secrets` | List webhook URLs and state: `retired`, `off`, `blocked (project off)`, or `on` |

### skill

Manage agent skills on the crews SOP surface. `push` is an idempotent upsert (create, or update on name collision).

| Command | Key Flags | Description |
|---------|-----------|-------------|
| `skill push <dir>` | `--role <name>`, `--in-crew <crew>`, `--dry-run`, `--publish`, `--json`, `--force` | Push a skill folder, or a whole plugin dir — recursive: pushes every `skills/*/SKILL.md`, converts `commands/*.md` → skills, and ingests each skill's `references/`. `--role` scopes to a role instead of the shared library; `--in-crew` names the crew that holds the role (with `--role`, to disambiguate a role name that exists in several crews). `--publish` snapshots the skill after pushing so it goes live for agents. Drift-guarded against the local `.solidactions-skill.json` sidecar revision; `--force` skips the guard |
| `skill publish <name>` | `--role <name>`, `--in-crew <crew>`, `--json` | Publish (snapshot) a skill so its latest pushed revision goes live for agents. With `--role`, publishes that role's role-scoped skill instead of a shared-library skill; `--in-crew` disambiguates the role across crews |
| `skill list` | `--json`, `--limit <n>` | List skills in the library |
| `skill view <name>` | `--json` | Show one skill |
| `skill pull <name> [dest]` | `--role <role>`, `--in-crew <crew>`, `--json` | Fetch a skill to a local folder for editing (inverse of push); `dest` defaults to `./<name>/`. `--role` pulls a role-scoped skill of that role instead of a shared-library skill; `--in-crew` disambiguates the role across crews. Writes a `.solidactions-skill.json` provenance sidecar used by `push`'s drift guard. `--json` prints the raw read result and writes no files |
| `skill delete <name>` | `--json` | Delete a skill (Admin only) |
| `skill exec <name> --target sandbox -- <cmd>` (`--target` required) | `--role <name>`, `--in-crew <crew>`, `--environment <env>` (default `production`) | Execute the server-stored skill in its server sandbox (post-push smoke; default env production) |
| `skill exec <name> --target host -- <cmd>` (`--target` required) | `--role <name>`, `--in-crew <crew>`, `--crew <nameOrId>`, `--environment <env>` (default `production`), `--env-file <path>` | Execute the server-stored skill on THIS machine via a transparent revision-checked cache — no pull step; crew vars fetched from the platform (default env production; secrets need `env:reveal`) |
| `skill dev <dir> -- <cmd>` | `--crew <nameOrId>`, `--environment <env>` (default `dev`), `--env-file <path>` | Run your local working copy (the folder you're editing) with platform crew vars (default env dev). Replaces `skill run` (deprecated) |

`skill exec` always executes the **server-stored** skill — `--target` only picks
where it runs (`sandbox` = server, `host` = your machine, cached under
`~/.solidactions/cache/skills/`, refreshed automatically when the skill's
published revision changes). `skill dev` always runs the **folder you're
editing**. Passing a directory to `exec` or a bare name to `dev` is an error
that points at the right command. Both `exec` targets default to `production`
variables; `dev` defaults to `dev`.

For `skill dev` / `skill exec`, pass the command as separate words after `--` (e.g. `-- python script.py --flag`); to run a single preformed shell string, wrap it explicitly with `sh -c '...'`.

**Frontmatter keys.** Frontmatter keys outside the server schema are stored under `metadata` (values that aren't strings are JSON-encoded), and push prints which keys were folded.

### role

| Command | Key Flags | Description |
|---------|-----------|-------------|
| `role push <dir>` | `--in-crew <crew>`, `--replace-links`, `--dry-run`, `--json` | Push a role definition (create or update). `--in-crew` names the crew that holds the role; it is **required to create** a role, and disambiguates the name when it exists in several crews. Without it, an existing role that has that name in exactly one crew is updated in place |
| `role pull <name> [dir]` | `--in-crew <crew>`, `--no-skills` | Fetch a role and its role-scoped skills to a local folder (inverse of push); `dir` defaults to `./<name>/`. Writes `SKILL.md`, a `.solidactions-role.json` provenance sidecar and `skills/<skill>/` for each role-scoped skill. `--no-skills` pulls the role only. `--in-crew` disambiguates a role name that exists in several crews |

**`skill pull` and `role pull` replace the destination atomically.** A pull builds the new folder as `<dest>.tmp-*` beside the destination and then swaps it in, so a failed pull leaves the previous copy untouched. If the process is killed mid-swap, `<dest>.old-*` is the previous copy (rename it back to `<dest>`) and `<dest>.tmp-*` can be deleted. A pull refuses to replace an existing non-empty folder unless it carries the marker file from an earlier pull — `.solidactions-skill.json` for `skill pull`, `.solidactions-role.json` for `role pull` — so a directory that is not a pulled skill or role is never overwritten (nor is the current directory or one of its parents, nor a plain file). The check runs before any network call or write; remove the folder or choose another destination to proceed.

**`role pull` pulls the role's published version, with effective values.** A versioned role must have a snapshot (or use `version_mode: live`). Properties the role inherits (`inherits_from`) are merged by the server and pulled as the *effective* value; for such a role, pushing the pulled folder back would store the inherited values on the child, so `role pull` prints a warning. The role's skill preload settings are exported too: `always_load_skills` and `available_skills` are written to the `SKILL.md` frontmatter as skill identifiers (for example `shared/triage`), in the server's order, and `role push` sends them back. Skills in the role's own `skills/` folder are found by the server automatically, so they are not listed in `available_skills`; they travel in `skills/`. Like properties, these lists are the effective merged values.

**Creating a role requires `--in-crew`; updating one usually does not.** `role push <dir> --in-crew <crew>` creates the role in that crew if it does not exist and updates it if it does; the crew is never read from the folder's frontmatter. Without `--in-crew`, `role push` looks the role up by name first: if exactly one role has that name it is updated (in its own crew), if none does the push stops and asks for `--in-crew` (a create needs a crew), and if several crews have a role with that name it stops and asks you to choose with `--in-crew`. `--dry-run` follows the same lookup and reports the same result (or the same error) as the real push.

**Skill links are preserved on push unless you change them.** `role pull` records the `always_load_skills` and `available_skills` it wrote in `.solidactions-role.json`, along with the role's crew (normalised) and doc id. When you push that folder back to the same role, a link list that still equals the recorded one is kept as it is on the server: it is left out of the update, so every link survives, including skills you cannot see. `role push --dry-run` says which lists it keeps. If you edit a list (a reorder counts, and so does a blank `always_load_skills:`), `role push` exits 1 unless you pass `--replace-links`, because replacing the list deletes links you cannot see. With `--replace-links`, a list you removed from the frontmatter (or left blank) is cleared on the server. Creating a role, or pushing a folder with no `.solidactions-role.json`, sends the lists as written. `--dry-run` applies the same check.

**Rate limits.** The server throttles the MCP endpoint that `skill` and `role` use to 60 calls per minute per token. On HTTP 429 the CLI waits the `Retry-After` interval (in seconds or an HTTP date, capped at 60s; 5s if the header is missing or invalid), prints `rate limited by server (429); retrying in <N>s` to stderr, and tries up to 3 times in total before failing with `MCP request failed with HTTP 429`.

**Frontmatter keys.** Frontmatter keys outside the server schema are stored under `metadata` (values that aren't strings are JSON-encoded), and push prints which keys were folded.

### doc

Manage docs in SA-Docs (the app's built-in documentation vault). `push` is drift-guarded for files previously pulled: a tracked file whose server revision has moved since the pull fails with `re-pull to merge, or pass --force to overwrite` rather than silently clobbering it; untracked files always go through the existing bulk-create path.

| Command | Key Flags | Description |
|---------|-----------|-------------|
| `doc pull <folder> [dest]` | `-y`, `--overwrite`, `--json` | Download a Docs folder tree (markdown + media) to `dest` (defaults to `./<last-segment>/`); visual docs arrive as `<title>.html`, canvases as `<title>.canvas.json`, other docs as `<title>.md`. Writes a `.solidactions-docs.json` revision manifest (including a `body_sha256` content hash per file) used by `push`'s drift guard. Falls back to fetching a single doc if `folder` is a doc path, not a folder |
| `doc push <path>` | `--on-conflict`, `--type`, `--folder`, `--replace`, `--dry-run`, `--force`, `--json` | Upload a directory of docs (walked recursively) or one file: `<title>.md` becomes a markdown doc, `<title>.html` a visual doc, `<title>.canvas.json` or `<title>.canvas` a canvas. Each file must be at most 1 MiB. Manifest-tracked files (from a prior `pull`) are written with a `base_revision` guard and reported separately as written/drifted/unchanged; files whose content hash still matches the last pull are skipped as unchanged (no write, no revision bump). Tracked media files whose bytes changed are replaced the same way, under the same guard; a tracked media file missing locally is left alone — `push` never deletes. An untracked binary in the tree is warned about, never uploaded (use `doc upload`). `--force` skips the drift guard (unchanged files are still skipped). `--dry-run` previews without writing. Untracked files are created under the manifest's `folder_path` when `<dir>` came from a `doc pull` (pass `--folder` to override); docs the push creates are recorded in the directory's manifest (a directory push with no manifest starts one with the pushed folder), so pushing again updates them — unless `--folder` points outside the manifest's folder, in which case nothing is recorded and the push says so; an untracked file whose title already exists in the target folder is skipped per `--on-conflict` (default `skip`, reported as `duplicate_title`) |
| `doc upload <files...>` | `--folder`, `--title`, `--replace <doc-id-or-path>` | Upload one or more media files to SA-Docs (requires a token with the "docs" ability); `--title` only valid for a single file. `--replace` swaps the bytes behind an existing media doc instead of creating a new one — see below |

`doc upload <file> --replace <doc-id-or-path>` swaps the bytes behind an existing media doc, keeping its id, title, and folder, so embeds and references keep resolving — the old image stays in the doc's version history. Single file only; cannot be combined with `--title` or `--folder`. A purely numeric argument is a doc id; anything else is a docs path (`marketing/hero.png`), resolved against the doc's **title** — which `doc pull` may have sanitized, so for path-based work on a pulled folder prefer `doc push` instead:

```bash
solidactions doc upload logo-v2.png --replace 482
solidactions doc upload logo-v2.png --replace marketing/logo.png
```

`doc push <file> --replace <doc-id>` replaces the body of an existing doc by its numeric id. It first reads the doc and refuses unless the kinds match: an `.html` file replaces only a visual doc, a `.canvas.json` / `.canvas` file only a canvas, and a `.md` file any doc that is not visual, canvas or media. There is no drift guard (you named the doc). It takes one file and cannot be combined with `--folder`, `--type` or `--on-conflict`. Like `doc upload --replace`, it does not update a pulled directory's manifest.

**Visual docs and canvases round-trip through `doc pull` and `doc push`.** `doc pull` writes visual docs as `<title>.html` and canvases as `<title>.canvas.json`; every other non-media doc stays `<title>.md`. `doc push` records the docs it creates in the directory's manifest (when they land in the directory's tracked folder), so pushing the same directory again updates them by id instead of skipping them — a second push of an unchanged file sends nothing. When a pulled doc's local path changes (e.g. `page.md` becomes `page.html`), an unmodified old file is removed after the new one is written; if the old file was edited, the pull refuses unless `--overwrite`, which keeps the edited file untracked with a warning.

**`doc pull` propagates deletions, within limits.** A file is removed locally only when its doc was deleted on the server *and* the file's bytes still match what the last pull gave it (the manifest's `body_sha256`) — anything you've edited locally is kept, with a warning that it's now untracked (re-create a markdown doc with `doc push`, a media doc with `doc upload`). Deletions only propagate when the destination's existing manifest `folder_path` matches the folder you're pulling (so pulling a different folder into a directory holding an old manifest deletes nothing), and never on the single-doc pull path; a single-doc pull (`doc pull <folder>/<doc>`) records the doc's folder as the manifest's `folder_path` and, in a directory that already tracks that folder, adds or updates just that one entry; when propagation is skipped for either reason, `pull` says so. Nothing outside the destination directory is removed: every candidate path is resolved physically (so a symlinked subdirectory cannot lead the delete outside), and a file the same pull just wrote is never deleted, even if a case-only rename makes it look orphaned on a case-insensitive filesystem.

**`doc pull --overwrite` is destructive.** If a manifest-tracked file still exists on the server *and* your local copy no longer matches the `body_sha256` recorded at the last pull (i.e. you've edited it and haven't pushed yet), a plain `doc pull` — even with `-y`/`--yes` — refuses with exit 1, naming every modified file, rather than silently discarding your edits. Nothing is written before that refusal. `-y`/`--yes` only bypasses the generic "destination is not empty" prompt; it does not cover locally-modified tracked files. Pass `--overwrite` to discard those local changes and re-pull server content anyway (it also implies `--yes`).

You do **not** need `--overwrite` to keep an edited file whose doc was deleted on the server — that case is handled by deletion propagation above, on the default path, and the file is kept with a warning.

**Getting a doc id.** `doc upload --replace` accepts a docs path (`marketing/hero.png`), so you rarely need an id. If you want one, `doc pull` records it per file in the destination's `.solidactions-docs.json` sidecar, and `import_outputs` returns the ids it created. Note that `--replace` does not update a pulled directory's manifest. If you replace a tracked image out-of-band and leave the local file untouched, the next `doc push` reports it as **unchanged** and does nothing — the content hash matches, so `push` never asks the server. (Edit the local file too, and the drift guard fires as expected.) Re-pull to resync the manifest.

**`doc push` and deleted docs.** If a tracked file's doc was deleted on the server, `push` names it per file (`doc <id> no longer exists (deleted remotely) — re-pull to untrack it, then push to re-create`) and carries on with the other files. Note the deleted doc still holds its title until it leaves the trash, so re-creating it needs the trashed copy restored or purged first — `push` says so if you hit it. `push` exits 1 on drift (a tracked doc moved on since your pull) and on any per-file server error; a deleted doc alone is not an error.

**`doc pull` refuses to replace another folder's manifest.** If the destination already tracks a different folder, pulling into it would leave the previously tracked files untracked — and untracked files are not protected from being overwritten by a later pull. `pull` refuses (exit 1, before anything is written) and names both folders. Pull into a different directory, or pass `--overwrite` to replace the manifest anyway. This also covers the single-doc pull path, whose one-entry manifest would otherwise clobber a folder's.

### workspace

| Command | Description |
|---------|-------------|
| `workspace list` | List all workspaces |
| `workspace set <id>` | Set active workspace (by ID, slug, or name) |

**A name that's ambiguous is refused, not guessed.** If the name is shared across two organizations, or is also the name of an organization that owns other workspaces, `workspace set` refuses (exit 1) and lists the candidates — re-run with the workspace's slug or ID instead. Slugs are unique only within an organization, so when the candidates don't have distinct slugs of their own — including when the ambiguous input *was* a slug shared by two organizations — the refusal asks for the ID specifically, which is the only handle that can separate them.

### ai

| Command | Key Flags | Description |
|---------|-----------|-------------|
| `ai init` | `--claude`, `--agents`, `--update` | Install or refresh AI skills and SDK reference in an **existing** project (use `init` for new projects) |
| `ai examples [names...]` | `--all`, `--overwrite` | Install example workflows |

`ai init` installs five auto-activating SolidActions skills and a
full SDK reference into your project:

- Skills go to `.claude/skills/` (for `--claude` / Claude Code) or
  `.agents/skills/` (for `--agents` / Codex, Cursor, Gemini, Windsurf).
  Codex auto-discovers the `.agents/skills/` path — see
  https://developers.openai.com/codex/skills.
- The SDK reference is saved to `.solidactions/sdk-reference.md`.
- A slim pointer section is injected into `CLAUDE.md` or `AGENTS.md`
  listing the skills and inlining the highest-cost hard rules
  (determinism, step discipline, messaging) as a safety net.

## Development

```bash
git clone https://github.com/SolidActions/solidactions-cli.git
cd solidactions-cli
npm install
npm run build
npm test          # vitest run
```

## Release Checklist

Run these before publishing a new version. `npm run check:release` covers the
first three in one command.

1. **Build** — `npm run build` (must be clean; `tsc` errors block the release).
2. **Unit tests** — `npm test`. Covers config resolution, command wiring, and
   the `oauth-action view` snippet renderer (the highest-risk regression
   surface — array query-param serialization and the proxy-managed header
   filter both have fixture-backed tests under `tests/fixtures/`).
3. **Init smoke** — `npm run smoke:init` scaffolds a project end to end.

   It serves template content from local `solidactions-examples` /
   `solidactions-ts-sdk` checkouts, discovered beside your `solidactions-cli`
   checkout (override with `SOLIDACTIONS_EXAMPLES_DIR` /
   `SOLIDACTIONS_SDK_DIR`). Files are read from git **at the ref the CLI pins
   to**, not from the checkout's working tree, so the branch a sibling happens
   to be parked on does not affect the result; a pinned ref the checkout lacks
   is fetched on demand.

   **If a checkout is missing, the smoke SKIPs with a notice and exits 0** so a
   clean clone can still run `check:release`. That means a local green does not
   by itself prove the smoke ran. Set `SOLIDACTIONS_SMOKE_REQUIRE_SOURCES=1` to
   turn a missing checkout back into a hard failure — CI's `release-candidate`
   job sets it, so the release gate can never be skipped silently. Use it
   locally too when you are verifying a release:

   ```bash
   SOLIDACTIONS_SMOKE_REQUIRE_SOURCES=1 npm run check:release
   ```
4. **oauth-action smoke** — `bash scripts/smoke.sh` exercises
   `oauth-action list|search|view` (plus the 404 path) against a real local
   stub server, so it needs no credentials:

   ```bash
   npm run build && bash scripts/smoke.sh
   ```

   To smoke a deployed server instead, pass `--live` with real credentials:

   ```bash
   SOLIDACTIONS_HOST=https://app.solidactions.com \
   SOLIDACTIONS_API_KEY=... \
   SOLIDACTIONS_WORKSPACE_ID=... \
   bash scripts/smoke.sh --live
   ```

   The script exits non-zero on the first failed check.
5. **SDK docs pin** — `ai init` fetches `docs/sdk-reference.md` from a
   `solidactions-ts-sdk` tag, not from that repo's `main`. The tag is derived
   at runtime from the `@solidactions/sdk` version this package declares (see
   `src/utils/sdk-version.ts`), so bumping that dependency moves the docs ref
   with it — nothing to update by hand. `tests/sdk-docs-ref.test.ts` fails if
   the declared range has no explicit minimum version to derive from.
6. **Examples pin** — every `solidactions-examples` fetch (`init`'s project
   template, the installed skills, the `CLAUDE.md`/`AGENTS.md` helper content,
   and `ai examples`) goes through `EXAMPLES_REF` in
   `src/utils/examples-ref.ts`, so a scaffold never drifts with that repo's
   `main`. Unlike the SDK pin above this is **not** derived — the examples repo
   does not tag in step with the SDK — so it is a commit SHA that must be
   bumped by hand when you want a newer template. To bump: set the constant to
   the new commit and run `SOLIDACTIONS_SMOKE_REQUIRE_SOURCES=1 npm run
   check:release`, which serves content at exactly that ref and so fails on a
   bad or unreachable pin. `tests/examples-ref.test.ts` fails if any call site
   stops passing the ref.
7. **Version** — the GitHub release **tag** is the single source of truth for
   the published npm version. The publish flow from #78 has landed:
   `.github/workflows/publish.yml` asserts the tag is a literal semver, then
   derives the version from it with `npm version --no-git-tag-version`
   immediately before publishing — deliberately *not* relying on a
   `package.json` bump commit, so a release whose `package.json` was never
   bumped can no longer collide with the registry and fail `npm publish`
   silently (#77).

   Consequences worth knowing before you cut a release:

   - **`package.json`'s version is not the source of truth** and has drifted
     from the published one. Read the registry (`npm view @solidactions/cli
     version`) or the tag list, not the file.
   - **Feature PRs do not bump it** — see PR #81, the `docs` → `doc` breaking
     rename, which shipped without touching `package.json`.
   - **A breaking change ships as a major tag.** Nothing in `check:release`
     enforces this — the release destination is recorded in the PR and its
     issue, and the releaser applies it when tagging. There is no changelog
     file in this repo.

## License

MIT

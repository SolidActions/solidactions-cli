# SolidActions CLI

Deploy and manage workflow automation with SolidActions.

## Installation

```bash
npm install -g @solidactions/cli
```

## Quick Start

```bash
solidactions login <api-key>                          # Authenticate (prompts for workspace)
solidactions init my-project                          # Scaffold a new project (files + AI skills)
cd my-project
solidactions project deploy my-project -e production  # Deploy it
solidactions run start my-project <workflow>          # Trigger a workflow
solidactions run view <run-id>                        # Inspect a run
```

## Configuration

The CLI stores `host`, `apiKey`, and `workspaceId` in a JSON config file. Two locations are supported:

- **Global** — `~/.solidactions/config.json`. Used by default, shared across all folders for a single user.
- **Local** — `./.solidactions/config.json`. Scoped to a project folder; takes precedence over the global file when running commands from inside that folder (or any subdirectory — the CLI walks up looking for it).

### Resolution order

For each field (`host`, `apiKey`, `workspaceId`), the CLI resolves independently in this order:

1. Environment variables: `SOLIDACTIONS_HOST`, `SOLIDACTIONS_API_KEY`, `SOLIDACTIONS_WORKSPACE_ID`
2. Nearest local `./.solidactions/config.json` (walking up from cwd)
3. Global `~/.solidactions/config.json`

You can mix: e.g., set only `SOLIDACTIONS_WORKSPACE_ID` in the environment while letting `host` and `apiKey` come from a file.

### `solidactions login` flags

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

- Run `solidactions login <key> --local` in each folder so each has its own config, or
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

## Commands

Use `solidactions <command> --help` for full flag details on any command.

### Top-level

| Command | Description |
|---------|-------------|
| `login <api-key>` | Authenticate CLI with API key |
| `logout` | Remove saved credentials |
| `whoami` | Show current configuration |
| `init [directory]` | Scaffold a new project (files + AI skills) |
| `dev <file>` | Run a workflow locally (no deploy needed) |

### project

| Command | Key Flags | Description |
|---------|-----------|-------------|
| `project create <name>` | `-e` | Create an empty project (no source/build); `-e` defaults to `production` |
| `project deploy <name> [path]` | `-e`, `--create`, `--config-only` | Deploy or sync config only |
| `project pull <name> [path]` | `-y` | Pull source (warns before overwriting) |
| `project logs <name>` | | View build logs |
| `project list` | | List all projects |

### run

| Command | Key Flags | Description |
|---------|-----------|-------------|
| `run start <project> <workflow>` | `-e`, `-i`, `-w` | Trigger a workflow run |
| `run list [project]` | `--json`, `--detailed`, `--status`, `--since`, `--workflow`, `--limit`, `--offset` | List and filter runs |
| `run view <run-id>` | `--json`, `--timeline`, `--steps`, `--logs` | Inspect a run |

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
| `schedule set <project> <cron>` | `-w`, `-i`, `-y` | Set cron schedule (warns if exists) |
| `schedule list <project>` | | List schedules |
| `schedule delete <project> <id>` | `-y` | Delete a schedule |

### webhook

| Command | Key Flags | Description |
|---------|-----------|-------------|
| `webhook list <project>` | `-e`, `--show-secrets` | List webhook URLs |

### skill

Manage agent skills on the crews SOP surface. `push` is an idempotent upsert (create, or update on name collision).

| Command | Key Flags | Description |
|---------|-----------|-------------|
| `skill push <dir>` | `--role <name>`, `--dry-run`, `--json` | Push a skill folder, or a whole plugin dir — recursive: pushes every `skills/*/SKILL.md`, converts `commands/*.md` → skills, and ingests each skill's `references/`. `--role` scopes to a role instead of the shared library |
| `skill list` | `--json`, `--limit <n>` | List skills in the library |
| `skill view <name>` | `--json` | Show one skill |
| `skill pull <name> [dest]` | `--json` | Fetch a skill to a local folder for editing (inverse of push) |
| `skill delete <name>` | `--json` | Delete a skill (Admin only) |

### role

| Command | Key Flags | Description |
|---------|-----------|-------------|
| `role push <dir>` | `--dry-run`, `--json` | Push a role definition (create or update) |

### workspace

| Command | Description |
|---------|-------------|
| `workspace list` | List all workspaces |
| `workspace set <id>` | Set active workspace (by ID, slug, or name) |

### ai

| Command | Key Flags | Description |
|---------|-----------|-------------|
| `ai init` | `--claude`, `--agents` | Install AI skills and SDK reference into an **existing** project (use `init` for new projects) |
| `ai examples [names...]` | `--all`, `--overwrite` | Install example workflows |

`ai init` installs three auto-activating SolidActions skills and a
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
```

## License

MIT

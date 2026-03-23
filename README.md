# SolidActions CLI

Deploy and manage workflow automation with SolidActions.

## Installation

```bash
npm install -g @solidactions/cli
```

## Quick Start

```bash
solidactions init <api-key>                          # Initialize (prompts for workspace)
solidactions init <api-key> --workspace <name>       # Initialize with workspace
solidactions project deploy <project> <path>         # Deploy a project
solidactions run start <project> <workflow>           # Trigger a workflow
solidactions run view <run-id>                        # Inspect a run
```

## Commands

Use `solidactions <command> --help` for full flag details on any command.

### Top-level

| Command | Description |
|---------|-------------|
| `init <api-key>` | Initialize CLI with API key |
| `logout` | Remove saved credentials |
| `whoami` | Show current configuration |
| `dev <file>` | Run a workflow locally (no deploy needed) |

### project

| Command | Key Flags | Description |
|---------|-----------|-------------|
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
| `env set <key> <value>` | `-s`, `-y`, `--staging-value`, `--dev-value` | Set global variable (warns before overwriting) |
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

### workspace

| Command | Description |
|---------|-------------|
| `workspace list` | List all workspaces |
| `workspace set <id>` | Set active workspace (by ID, slug, or name) |

### ai

| Command | Key Flags | Description |
|---------|-----------|-------------|
| `ai init` | `--claude`, `--agents` | Install AI helper docs |
| `ai examples [names...]` | `--all`, `--overwrite` | Install example workflows |

## Development

```bash
git clone https://github.com/SolidActions/solidactions-cli.git
cd solidactions-cli
npm install
npm run build
```

## License

MIT

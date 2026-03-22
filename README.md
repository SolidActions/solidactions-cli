# SolidActions CLI

Deploy and manage workflow automation with SolidActions.

## Installation

```bash
npm install -g @solidactions/cli
```

## Quick Start

```bash
# Initialize with your API key (prompts for workspace selection)
solidactions init <api-key>

# Initialize and set workspace directly (no prompt)
solidactions init <api-key> --workspace <name-or-id>

# Deploy a project
solidactions project deploy <project-name> <path>
```

## Commands

### Top-level Commands

| Command | Description |
|---------|-------------|
| `init <api-key>` | Initialize CLI with your API key (prompts for workspace selection) |
| `init <api-key> --workspace <name-or-id>` | Initialize and set workspace directly |
| `logout` | Remove saved credentials |
| `whoami` | Show current configuration |
| `dev <file>` | Run a workflow locally using an in-memory mock server (no deploy needed) |

### project

| Command | Description |
|---------|-------------|
| `project deploy <project-name> [path]` | Deploy a project to SolidActions |
| `project pull <project-name> [path]` | Pull project source from SolidActions |
| `project logs <project>` | View build/deployment logs for a project |
| `project list` | List all projects |

### run

| Command | Description |
|---------|-------------|
| `run start <project> <workflow>` | Trigger a workflow run |
| `run list [project]` | List recent workflow runs |
| `run view <run-id>` | View details, timeline, steps, or logs for a workflow run |

### env

| Command | Description |
|---------|-------------|
| `env set <key> <value>` | Set a global variable (create or update) |
| `env set <project> <key> <value>` | Set a project variable (create or update) |
| `env list [project]` | List environment variables |
| `env delete <key-or-project> [key]` | Delete an environment variable |
| `env map <project> <key> <global-key>` | Map a global variable to a project-specific key |
| `env pull <project>` | Pull resolved env vars (including OAuth tokens) to a local file |
| `env push <project> [path]` | Push .env values to a project |

### schedule

| Command | Description |
|---------|-------------|
| `schedule set <project> <cron>` | Set a cron schedule for a workflow |
| `schedule list <project>` | List schedules for a project |
| `schedule delete <project> <schedule-id>` | Delete a schedule |

### webhook

| Command | Description |
|---------|-------------|
| `webhook list <project>` | List webhook URLs for a project |

### workspace

| Command | Description |
|---------|-------------|
| `workspace list` | List all workspaces |
| `workspace set <workspace-id>` | Set the active workspace for CLI operations |

### ai

| Command | Description |
|---------|-------------|
| `ai init` | Install AI helper documentation (CLAUDE.md or AGENTS.md) for AI-assisted workflow development |
| `ai examples [names...]` | Install example workflows for AI reference |

See [docs/cli.md](docs/cli.md) for full documentation.

## Development

```bash
git clone https://github.com/SolidActions/solidactions-cli.git
cd solidactions-cli
npm install
npm run build
```

## License

MIT

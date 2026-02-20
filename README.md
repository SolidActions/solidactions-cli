# SolidActions CLI

Deploy and manage workflow automation with SolidActions.

## Installation

```bash
npm install -g @solidactions/cli
```

## Quick Start

```bash
# Initialize with your API key
solidactions init <api-key>

# Deploy a project
solidactions deploy <project-name> <path>
```

## Commands

| Command | Description |
|---------|-------------|
| `init <api-key>` | Initialize CLI with your API key |
| `logout` | Remove saved credentials |
| `whoami` | Show current configuration |
| `deploy <project> [path]` | Deploy a project to SolidActions |
| `pull <project> [path]` | Pull project source from SolidActions |
| `run <project> <workflow>` | Trigger a workflow run |
| `runs [project]` | List recent workflow runs |
| `logs <run-id>` | View logs for a workflow run |
| `logs:build <project>` | View build/deployment logs |
| `env:create <key> <value>` | Create a global environment variable |
| `env:list [project]` | List environment variables |
| `env:delete <key>` | Delete an environment variable |
| `env:map <project> <key> <global-key>` | Map a global variable to a project |
| `env:pull <project>` | Pull resolved env vars to a local file |
| `schedule:set <project> <cron>` | Set a cron schedule for a workflow |
| `schedule:list <project>` | List schedules for a project |
| `schedule:delete <project> <id>` | Delete a schedule |
| `webhooks <project>` | List webhook URLs for a project |

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

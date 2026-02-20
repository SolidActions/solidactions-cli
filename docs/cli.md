# SolidActions CLI Reference

The SolidActions CLI (`solidactions`) allows you to manage your workflow automation projects from the command line.

## Installation

```bash
npm install -g @solidactions/cli
```

Or use it locally from the repository:

```bash
./cli/dist/index.js <command>
```

## Quick Start

```bash
# Initialize with your API key
solidactions init <your-api-key>

# Deploy a project
solidactions deploy my-project ./src

# Trigger a workflow
solidactions run my-project my-workflow

# View recent runs
solidactions runs my-project
```

---

## Authentication

### `init <api-key>`

Initialize the CLI with your SolidActions API key.

```bash
solidactions init sk_live_abc123xyz
```

**Options:**
- `--dev` - Use local development server (http://localhost:8000)
- `--host <url>` - Custom API host URL

**Example:**
```bash
# Production
solidactions init sk_live_abc123xyz

# Local development
solidactions init sk_test_abc123xyz --dev
```

### `logout`

Remove saved credentials from your system.

```bash
solidactions logout
```

### `whoami`

Show current configuration and authenticated user.

```bash
solidactions whoami
```

---

## Project Management

### `deploy <project-name> [path]`

Deploy a project to SolidActions. Creates the project if it doesn't exist.

```bash
solidactions deploy my-project ./src
```

**Arguments:**
- `<project-name>` - Project name (will be created if it doesn't exist)
- `[path]` - Source directory to deploy (defaults to current directory)

**Options:**
- `-e, --env <environment>` - Target environment: production/staging/dev (default: `dev`)
- `--create` - Create environment project if it doesn't exist

**Example:**
```bash
# Deploy current directory (to dev by default)
solidactions deploy my-project

# Deploy a specific directory
solidactions deploy my-project ./workflows

# Deploy to production
solidactions deploy my-project --env production
```

### `pull <project-name> [path]`

Download project source from SolidActions.

```bash
solidactions pull my-project ./backup
```

**Arguments:**
- `<project-name>` - Project name
- `[path]` - Destination directory (defaults to current directory)

---

## Workflow Execution

### `run <project> <workflow>`

Trigger a workflow run.

```bash
solidactions run my-project daily-sync
```

**Arguments:**
- `<project>` - Project name
- `<workflow>` - Workflow name

**Options:**
- `-i, --input <json>` - JSON input for the workflow
- `-w, --wait` - Wait for the workflow to complete

**Examples:**
```bash
# Basic run
solidactions run my-project daily-sync

# Run with input
solidactions run my-project process-data -i '{"userId": 123}'

# Run and wait for completion
solidactions run my-project daily-sync --wait
```

### `runs [project]`

List recent workflow runs.

```bash
solidactions runs
solidactions runs my-project
```

**Arguments:**
- `[project]` - Filter by project name (optional)

**Options:**
- `-l, --limit <number>` - Number of runs to show (default: 20)

**Example output:**
```
Recent runs for "my-project":

ID                                     WORKFLOW                 STATUS      STARTED                DURATION
--------------------------------------------------------------------------------------------------------------
550e8400-e29b-41d4-a716-446655440000   daily-sync               completed   1/6/2026, 9:00:00 AM   45s
550e8400-e29b-41d4-a716-446655440001   process-data             running     1/6/2026, 9:05:00 AM   2m

Showing 2 run(s)
```

---

## Logs

### `logs <run-id>`

View logs for a workflow run.

```bash
solidactions logs 550e8400-e29b-41d4-a716-446655440000
```

**Arguments:**
- `<run-id>` - Run ID (from `runs` command)

**Options:**
- `-f, --follow` - Follow log output (tail -f style)

### `logs:build <project>`

View build/deployment logs for a project.

```bash
solidactions logs:build my-project
```

**Arguments:**
- `<project>` - Project name

---

## Environment Variables

### `env:create <key> <value>`

Create a global environment variable.

```bash
solidactions env:create DATABASE_URL "postgres://localhost/mydb"
```

**Arguments:**
- `<key>` - Variable name
- `<value>` - Variable value

**Options:**
- `-s, --secret` - Mark as encrypted secret (value will be hidden in listings)

**Examples:**
```bash
# Create a regular variable
solidactions env:create API_URL "https://api.example.com"

# Create a secret
solidactions env:create API_KEY "sk_live_secret123" --secret
```

### `env:list [project]`

List environment variables.

```bash
# List global variables
solidactions env:list

# List project variable mappings
solidactions env:list my-project
```

**Arguments:**
- `[project]` - Project name (omit for global variables)

**Options:**
- `-e, --env <environment>` - Filter by environment: production/staging/dev

**Example output (global):**
```
Global environment variables:

KEY                           VALUE                                   TYPE      CREATED
----------------------------------------------------------------------------------------------------
DATABASE_URL                  postgres://localhost/mydb               plain     1/6/2026
API_KEY                       ********                                secret    1/5/2026

2 variable(s)
```

**Example output (project):**
```
Environment variables for project "my-project":

KEY                           VALUE                         SOURCE      GLOBAL KEY
----------------------------------------------------------------------------------------------------
DATABASE_URL                  postgres://localhost/mydb     yaml        DATABASE_URL
CUSTOM_VAR                    local-value                   manual      (local)

2 variable(s)
```

### `env:delete <key-or-project> [key]`

Delete an environment variable.

```bash
# Delete a global variable
solidactions env:delete DATABASE_URL

# Delete a project variable mapping
solidactions env:delete my-project CUSTOM_VAR
```

**Arguments:**
- `<key-or-project>` - Variable key (for global) or project name
- `[key]` - Variable key (if first argument is project name)

**Options:**
- `-y, --yes` - Skip confirmation prompt

**Examples:**
```bash
# Delete global variable (with confirmation)
solidactions env:delete OLD_API_KEY

# Delete global variable (skip confirmation)
solidactions env:delete OLD_API_KEY --yes

# Delete project mapping
solidactions env:delete my-project UNUSED_VAR -y
```

### `env:map <project> <key> <global-key>`

Map a global variable to a project-specific key.

```bash
solidactions env:map my-project DB_URL DATABASE_URL
```

**Arguments:**
- `<project>` - Project name
- `<key>` - Project-specific variable name (how it appears in your workflow)
- `<global-key>` - Global variable name to map from

**Example:**
```bash
# Map DATABASE_URL global var to DB_CONNECTION in the project
solidactions env:map my-project DB_CONNECTION DATABASE_URL
```

### `env:pull <project>`

Pull resolved environment variables to a local file.

```bash
solidactions env:pull my-project
```

**Arguments:**
- `<project>` - Project name

**Options:**
- `-e, --env <environment>` - Environment: production/staging/dev (default: `dev`)
- `-o, --output <file>` - Output file path (defaults to `.env` or `.env.{environment}`)
- `-y, --yes` - Skip confirmation for secrets

**Examples:**
```bash
# Pull dev env vars (default)
solidactions env:pull my-project

# Pull production env vars
solidactions env:pull my-project --env production

# Pull to a specific file
solidactions env:pull my-project -o .env.local
```

---

## Webhooks

### `webhooks <project>`

List webhook URLs for a project.

```bash
solidactions webhooks my-project
```

**Arguments:**
- `<project>` - Project name

**Options:**
- `-e, --env <environment>` - Environment: production/staging/dev (default: `dev`)
- `--show-secrets` - Show webhook secrets

**Examples:**
```bash
# List dev webhooks (default)
solidactions webhooks my-project

# List production webhooks
solidactions webhooks my-project --env production

# Show webhook secrets
solidactions webhooks my-project --show-secrets
```

---

## Schedules

### `schedule:set <project> <cron>`

Set a cron schedule for a workflow.

```bash
solidactions schedule:set my-project "0 9 * * *"
```

**Arguments:**
- `<project>` - Project name
- `<cron>` - Cron expression (5 parts: minute hour day month weekday)

**Options:**
- `-w, --workflow <name>` - Workflow name (required if project has multiple workflows)
- `-i, --input <json>` - JSON input to pass to scheduled runs

**Examples:**
```bash
# Daily at 9am
solidactions schedule:set my-project "0 9 * * *"

# Every hour
solidactions schedule:set my-project "0 * * * *"

# With specific workflow
solidactions schedule:set my-project "0 9 * * *" --workflow daily-sync

# With input data
solidactions schedule:set my-project "0 9 * * *" -i '{"mode": "full"}'
```

**Common cron patterns:**
| Pattern | Description |
|---------|-------------|
| `* * * * *` | Every minute |
| `0 * * * *` | Every hour |
| `0 0 * * *` | Daily at midnight |
| `0 9 * * *` | Daily at 9am |
| `0 9 * * 1` | Every Monday at 9am |
| `0 0 1 * *` | First of every month |

### `schedule:list <project>`

List schedules for a project.

```bash
solidactions schedule:list my-project
```

**Arguments:**
- `<project>` - Project name

**Example output:**
```
Schedules for project "my-project":

ID      WORKFLOW                 CRON              ENABLED   NEXT RUN
-------------------------------------------------------------------------------------
1       daily-sync               0 9 * * *         yes       in 2h
2       weekly-report            0 0 * * 1         yes       in 3d

2 schedule(s)
```

### `schedule:delete <project> <schedule-id>`

Delete a schedule.

```bash
solidactions schedule:delete my-project 1
```

**Arguments:**
- `<project>` - Project name
- `<schedule-id>` - Schedule ID (from `schedule:list`)

**Options:**
- `-y, --yes` - Skip confirmation prompt

**Examples:**
```bash
# Delete with confirmation
solidactions schedule:delete my-project 1

# Delete without confirmation
solidactions schedule:delete my-project 1 --yes
```

---

## Common Workflows

### Setting up a new project

```bash
# 1. Initialize CLI
solidactions init sk_live_abc123

# 2. Create environment variables
solidactions env:create DATABASE_URL "postgres://..." --secret
solidactions env:create API_KEY "..." --secret

# 3. Deploy your project
solidactions deploy my-project ./src

# 4. Set up a schedule
solidactions schedule:set my-project "0 9 * * *"

# 5. Trigger a test run
solidactions run my-project main-workflow
```

### Managing environment variables

```bash
# View all global variables
solidactions env:list

# View project-specific mappings
solidactions env:list my-project

# Create a new secret
solidactions env:create NEW_API_KEY "secret123" --secret

# Map it to a project
solidactions env:map my-project API_KEY NEW_API_KEY

# Delete an old variable
solidactions env:delete OLD_VAR --yes
```

### Monitoring runs

```bash
# List recent runs
solidactions runs my-project

# View logs for a specific run
solidactions logs <run-id>

# Follow logs in real-time
solidactions logs <run-id> --follow
```

---

## Exit Codes

| Code | Description |
|------|-------------|
| 0 | Success |
| 1 | Error (authentication, validation, connection, etc.) |

## Getting Help

```bash
# General help
solidactions --help

# Command-specific help
solidactions env:create --help
solidactions schedule:set --help
```

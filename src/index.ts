#!/usr/bin/env node
import { Command } from 'commander';
import { deploy } from './commands/deploy';
import { init, logout, whoami } from './commands/init';
import { logs } from './commands/logs';
import { logsBuild } from './commands/logs-build';
import { run } from './commands/run';
import { runs } from './commands/runs';
import { pull } from './commands/pull';
import { envCreate } from './commands/env-create';
import { envList } from './commands/env-list';
import { envDelete } from './commands/env-delete';
import { envMap } from './commands/env-map';
import { envPull } from './commands/env-pull';
import { scheduleSet } from './commands/schedule-set';
import { scheduleList } from './commands/schedule-list';
import { scheduleDelete } from './commands/schedule-delete';
import { webhookList } from './commands/webhooks';
import { dev } from './commands/dev';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json');

const program = new Command();

program
    .name('solidactions')
    .description('SolidActions CLI - Deploy and manage workflow automation')
    .version(pkg.version);

// =============================================================================
// Authentication & Configuration
// =============================================================================

program
    .command('init')
    .description('Initialize the CLI with your API key')
    .argument('<api-key>', 'Your SolidActions API key')
    .option('--dev', 'Use local development server (http://localhost:8000)')
    .option('--host <url>', 'Custom API host URL')
    .action((apiKey, options) => {
        init(apiKey, options);
    });

program
    .command('logout')
    .description('Remove saved credentials')
    .action(() => {
        logout();
    });

program
    .command('whoami')
    .description('Show current configuration')
    .action(() => {
        whoami();
    });

// =============================================================================
// Project Management
// =============================================================================

program
    .command('deploy')
    .description('Deploy a project to SolidActions')
    .argument('<project-name>', 'Project name (will be created if it doesn\'t exist)')
    .argument('[path]', 'Source directory to deploy (defaults to current directory)')
    .option('-e, --env <environment>', 'Target environment (production/staging/dev)', 'dev')
    .option('--create', 'Create environment project if it doesn\'t exist')
    .action((projectName, path, options) => {
        deploy(projectName, path, options);
    });

program
    .command('pull')
    .description('Pull project source from SolidActions')
    .argument('<project-name>', 'Project name')
    .argument('[path]', 'Destination directory (defaults to current directory)')
    .action((projectName, path) => {
        pull(projectName, path);
    });

// =============================================================================
// Workflow Execution
// =============================================================================

program
    .command('run')
    .description('Trigger a workflow run')
    .argument('<project>', 'Project name')
    .argument('<workflow>', 'Workflow name')
    .option('-e, --env <environment>', 'Environment (production/staging/dev)', 'dev')
    .option('-i, --input <json>', 'JSON input for the workflow')
    .option('-w, --wait', 'Wait for the workflow to complete')
    .action((project, workflow, options) => {
        run(project, workflow, options);
    });

program
    .command('runs')
    .description('List recent workflow runs')
    .argument('[project]', 'Filter by project name')
    .option('-l, --limit <number>', 'Number of runs to show', parseInt)
    .action((project, options) => {
        runs(project, options);
    });

program
    .command('dev')
    .description('Run a workflow locally using an in-memory mock server (no deploy needed)')
    .argument('<file>', 'Workflow file to run (e.g., src/simple-steps.ts)')
    .option('-i, --input <json>', 'JSON input for the workflow', '{}')
    .action((file, options) => {
        dev(file, options);
    });

// =============================================================================
// Logs
// =============================================================================

program
    .command('logs')
    .description('View logs for a workflow run')
    .argument('<run-id>', 'Run ID')
    .option('-f, --follow', 'Follow log output (tail -f style)')
    .action((runId, options) => {
        logs(runId, options);
    });

program
    .command('logs:build')
    .description('View build/deployment logs for a project')
    .argument('<project>', 'Project name')
    .action((project) => {
        logsBuild(project);
    });

// =============================================================================
// Environment Variables
// =============================================================================

program
    .command('env:create')
    .description('Create a global environment variable')
    .argument('<key>', 'Variable name')
    .argument('<value>', 'Production value')
    .option('-s, --secret', 'Mark as encrypted secret')
    .option('--staging-value <value>', 'Staging environment value')
    .option('--dev-value <value>', 'Dev environment value')
    .option('--staging-inherit', 'Staging inherits from production')
    .option('--dev-inherit', 'Dev inherits from production')
    .option('--dev-inherit-staging', 'Dev inherits from staging')
    .action((key, value, options) => {
        envCreate(key, value, options);
    });

program
    .command('env:list')
    .description('List environment variables')
    .argument('[project]', 'Project name (omit for global variables)')
    .option('-e, --env <environment>', 'Filter by environment (production/staging/dev)')
    .action((project, options) => {
        envList(project, options);
    });

program
    .command('env:delete')
    .description('Delete an environment variable')
    .argument('<key-or-project>', 'Variable key (global) or project name')
    .argument('[key]', 'Variable key (if first arg is project)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action((keyOrProject, key, options) => {
        envDelete(keyOrProject, key, options);
    });

program
    .command('env:map')
    .description('Map a global variable to a project-specific key')
    .argument('<project>', 'Project name')
    .argument('<key>', 'Project-specific variable name')
    .argument('<global-key>', 'Global variable name to map from')
    .action((project, key, globalKey) => {
        envMap(project, key, globalKey);
    });

program
    .command('env:pull')
    .description('Pull resolved environment variables to a local file')
    .argument('<project>', 'Project name')
    .option('-e, --env <environment>', 'Environment (production/staging/dev)', 'dev')
    .option('-o, --output <file>', 'Output file path (defaults to .env or .env.{environment})')
    .option('-y, --yes', 'Skip confirmation for secrets')
    .option('--update-oauth', 'Only pull OAuth tokens and merge into existing .env file')
    .action((project, options) => {
        envPull(project, options);
    });

// =============================================================================
// Scheduling
// =============================================================================

program
    .command('schedule:set')
    .description('Set a cron schedule for a workflow')
    .argument('<project>', 'Project name')
    .argument('<cron>', 'Cron expression (e.g., "0 9 * * *" for daily at 9am)')
    .option('-w, --workflow <name>', 'Workflow name (if project has multiple)')
    .option('-i, --input <json>', 'JSON input to pass to scheduled runs')
    .action((project, cron, options) => {
        scheduleSet(project, cron, options);
    });

program
    .command('schedule:list')
    .description('List schedules for a project')
    .argument('<project>', 'Project name')
    .action((project) => {
        scheduleList(project);
    });

program
    .command('schedule:delete')
    .description('Delete a schedule')
    .argument('<project>', 'Project name')
    .argument('<schedule-id>', 'Schedule ID')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action((project, scheduleId, options) => {
        scheduleDelete(project, scheduleId, options);
    });

// =============================================================================
// Webhooks
// =============================================================================

program
    .command('webhooks')
    .description('List webhook URLs for a project')
    .argument('<project>', 'Project name')
    .option('-e, --env <environment>', 'Environment (production/staging/dev)')
    .option('--show-secrets', 'Show webhook secrets')
    .action((project, options) => {
        webhookList(project, options);
    });

program.parse();

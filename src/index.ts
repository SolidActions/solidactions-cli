#!/usr/bin/env node
import chalk from 'chalk';
import { Command } from 'commander';
import { deploy } from './commands/deploy';
import { login, logout, whoami } from './commands/login';
import { init } from './commands/init';
import { pull } from './commands/pull';
import { projectList } from './commands/project-list';
import { projectCreate } from './commands/project-create';
import { logsBuild } from './commands/project-logs';
import { run } from './commands/run-start';
import { runs } from './commands/run-list';
import { runView } from './commands/run-view';
import { envList } from './commands/env-list';
import { envDelete } from './commands/env-delete';
import { envMap } from './commands/env-map';
import { envPull } from './commands/env-pull';
import { envPush } from './commands/env-push';
import { envSet } from './commands/env-set';
import { scheduleSet } from './commands/schedule-set';
import { scheduleList } from './commands/schedule-list';
import { scheduleDelete } from './commands/schedule-delete';
import { webhookList } from './commands/webhook-list';
import { webhookSecret } from './commands/webhook-secret';
import { dev } from './commands/dev';
import { aiInit } from './commands/ai-init';
import { aiExamples } from './commands/ai-examples';
import { oauthActionsSearch } from './commands/oauth-actions-search';
import { oauthActionsList } from './commands/oauth-actions-list';
import { oauthActionsShow } from './commands/oauth-actions-show';
import { workspacesList, workspaceSet } from './commands/workspaces';
import { skillPush } from './commands/skill-push';
import { skillPull } from './commands/skill-pull';
import { skillList } from './commands/skill-list';
import { skillView } from './commands/skill-view';
import { skillDelete } from './commands/skill-delete';
import { rolePush } from './commands/role-push';
import { docsPush } from './commands/docs-push';
import { setCliWorkspaceOverride } from './utils/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json');

const program = new Command();

if (process.env.SOLIDACTIONS_DEBUG === '1') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveConfig } = require('./utils/config');
    const resolved = resolveConfig();
    if (resolved) {
        const fmt = (src: any) => {
            if (src === 'env') return '(from $SOLIDACTIONS_* env var)';
            if (src === null) return '(unset)';
            return `(from ${src})`;
        };
        process.stderr.write('[SOLIDACTIONS_DEBUG] resolved configuration:\n');
        process.stderr.write(`  host:        ${resolved.config.host} ${fmt(resolved.sources.host)}\n`);
        process.stderr.write(`  apiKey:      <redacted> ${fmt(resolved.sources.apiKey)}\n`);
        process.stderr.write(`  workspaceId: ${resolved.config.workspaceId ?? ''} ${fmt(resolved.sources.workspaceId)}\n`);
        process.stderr.write(`  activePath:  ${resolved.activePath}\n`);
    } else {
        process.stderr.write('[SOLIDACTIONS_DEBUG] no config resolvable\n');
    }
}

program
    .name('solidactions')
    .description('SolidActions CLI - Deploy and manage workflow automation')
    .version(pkg.version);

program.option('-w, --workspace <id-or-slug-or-name>', 'override active workspace for this command');

program.hook('preAction', (thisCommand, actionCommand) => {
    const opts = thisCommand.opts();
    const wsOverride: string | undefined = opts.workspace;
    if (wsOverride) {
        // workspace set is a write — -w is for read-paths only.
        const fullName = actionCommand.name();
        const parentName = actionCommand.parent?.name?.();
        const isWorkspaceSet = fullName === 'set' && parentName === 'workspace';
        if (isWorkspaceSet) {
            console.error(
                chalk.yellow('warn:') + ' -w/--workspace is ignored on `workspace set`; the positional argument is the new workspace.',
            );
            return;
        }
        setCliWorkspaceOverride(wsOverride);
    }
});

// =============================================================================
// Top-level commands
// =============================================================================

program
    .command('login')
    .description('Authenticate the CLI with your API key')
    .argument('<api-key>', 'Your SolidActions API key')
    .option('--dev', 'Use local development server (http://localhost:8000)')
    .option('--host <url>', 'Custom API host URL')
    .option('--workspace <name-or-id>', 'Set workspace by name, slug, or ID (skips interactive prompt)')
    .option('--local', 'Save config to ./.solidactions/config.json in the current folder')
    .option('--global', 'Save config to ~/.solidactions/config.json (default if prompted)')
    .option('--gitignore', 'With --local, add .solidactions/ to .gitignore without prompting')
    .action(async (apiKey, options) => {
        await login(apiKey, options);
    });

program
    .command('init')
    .description('Scaffold a new SolidActions project (files + AI skills)')
    .argument('[directory]', 'Directory to create (omit to scaffold in the current empty directory)')
    .option('--no-skills', 'Skip AI skills/SDK reference install (scaffold files only)')
    .option('--claude', 'Use CLAUDE.md for the AI helper file')
    .option('--agents', 'Use AGENTS.md for the AI helper file (Codex, Cursor, Gemini, Windsurf)')
    .action(async (directory, options) => {
        await init(directory, options);
    });

program
    .command('logout')
    .description('Remove saved credentials')
    .option('--local', 'Remove only the nearest local ./.solidactions/config.json')
    .option('--global', 'Remove only ~/.solidactions/config.json')
    .action((options) => {
        logout(options);
    });

program
    .command('whoami')
    .description('Show current configuration')
    .action(() => {
        whoami();
    });

program
    .command('dev')
    .description('Run a workflow locally using an in-memory mock server (no deploy needed)')
    .argument('<file>', 'Workflow file to run (e.g., src/simple-steps.ts)')
    .option('-i, --input <json>', 'JSON input for the workflow', '{}')
    .option('-e, --env <env>', 'Pull platform variables for this environment (e.g. dev, staging, production)')
    .action((file, options) => {
        // Unified in-process invoke path. With --env: fetch declared vars, build
        // ctx.vars, invoke locally. Without --env: NO platform fetch, ctx.vars is
        // empty {} (the host process.env is never leaked into the workflow).
        dev(file, options);
    });

// =============================================================================
// project <subcommand>
// =============================================================================

const project = program.command('project').description('Manage projects');

project
    .command('create')
    .description('Create an empty project (and environment) without deploying source')
    .argument('<name>', 'Project name')
    .option('-e, --env <environment>', 'Target environment (production/staging/dev). Defaults to production.')
    .action(async (name, options) => {
        await projectCreate(name, options);
    });

project
    .command('deploy')
    .description('Deploy a project to SolidActions')
    .argument('<project-name>', 'Project name (will be created if it doesn\'t exist)')
    .argument('[path]', 'Source directory to deploy (defaults to current directory)')
    .option('-e, --env <environment>', 'Target environment (production/staging/dev). Required on first deploy of a new project.')
    .option('--create', 'Create environment project if it doesn\'t exist')
    .option('--config-only', 'Sync YAML env declarations without building/deploying')
    .option('--no-cache', 'Force a fresh build, bypassing all build caches')
    .option('--force-rebuild', 'Force a fresh build, bypassing all build caches (alias for --no-cache)')
    .action((projectName, path, options) => {
        // Commander's negation convention maps --no-cache to options.cache === false
        // (NOT options.noCache). Normalize both flags to a single boolean.
        const noCache = options.cache === false || options.forceRebuild === true;
        deploy(projectName, path, { ...options, noCache });
    });

project
    .command('pull')
    .description('Pull project source from SolidActions')
    .argument('<project-name>', 'Project name')
    .argument('[path]', 'Destination directory (defaults to current directory)')
    .option('-y, --yes', 'Skip overwrite confirmation')
    .action((projectName, path, options) => {
        pull(projectName, path, options);
    });

project
    .command('logs')
    .description('View build/deployment logs for a project')
    .argument('<project>', 'Project name (or family name with -e)')
    .option('-e, --environment <environment>', 'Environment to resolve (production/staging/dev)')
    .action((projectName, options) => {
        logsBuild(projectName, options.environment);
    });

project
    .command('list')
    .description('List all projects')
    .action(() => {
        projectList();
    });

// =============================================================================
// run <subcommand>
// =============================================================================

const runCmd = program.command('run').description('Manage workflow runs');

runCmd
    .command('start')
    .description('Trigger a workflow run')
    .argument('<project>', 'Project name')
    .argument('<workflow>', 'Workflow name')
    .option('-e, --env <environment>', 'Environment (production/staging/dev)', 'dev')
    .option('-i, --input <json>', 'JSON input for the workflow')
    .option('-w, --wait', 'Wait for the workflow to complete')
    .action((projectName, workflow, options) => {
        run(projectName, workflow, options);
    });

runCmd
    .command('list')
    .description('List recent workflow runs')
    .argument('[project]', 'Filter by project name')
    .option('-l, --limit <number>', 'Number of runs to show', parseInt)
    .option('--offset <number>', 'Skip first N runs (pagination)', parseInt)
    .option('--status <status>', 'Filter by status (completed, failed, queued, running)')
    .option('--since <duration>', 'Filter to runs since (e.g., 1h, 30m, 2d, 1w)')
    .option('--workflow <name>', 'Filter by workflow name')
    .option('--detailed', 'Include timeline, steps, and logs per run (default limit: 5)')
    .option('--has-errors', 'Show only runs with errors (step errors, retries, or degraded results)')
    .option('--json', 'Output as JSON')
    .option('-e, --environment <environment>', 'Environment to filter by (production/staging/dev)')
    .action((projectName, options) => {
        runs(projectName, options);
    });

runCmd
    .command('view')
    .description('View details, timeline, steps, or logs for a workflow run')
    .argument('<run-id>', 'Run ID')
    .option('--timeline', 'Show only timeline data')
    .option('--steps', 'Show only step data')
    .option('--logs', 'Show raw logs')
    .option('--json', 'Output as JSON')
    .action((runId, options) => {
        runView(runId, options);
    });

// =============================================================================
// env <subcommand>
// =============================================================================

const env = program.command('env').description('Manage environment variables');

env
    .command('set')
    .description('Set an environment variable (create or update, global or project)')
    .argument('<key-or-project>', 'Variable key (global) or project name')
    .argument('<value-or-key>', 'Variable value (global) or variable key (project)')
    .argument('[value]', 'Variable value (when first arg is project)')
    .option('-s, --secret', 'Mark as encrypted secret')
    .option('-e, --env <environment>', 'Target environment (production/staging/dev)', 'dev')
    .option('--staging-value <value>', 'Staging environment value (global only)')
    .option('--dev-value <value>', 'Dev environment value (global only)')
    .option('--staging-inherit', 'Staging inherits from production (global only)')
    .option('--dev-inherit', 'Dev inherits from production (global only)')
    .option('--dev-inherit-staging', 'Dev inherits from staging (global only)')
    .option('-y, --yes', 'Skip overwrite confirmation')
    .action((keyOrProject, valueOrKey, value, options) => {
        envSet(keyOrProject, valueOrKey, value, options);
    });

env
    .command('list')
    .description('List environment variables')
    .argument('[project]', 'Project name (omit for global variables)')
    .option('-e, --env <environment>', 'Filter by environment (production/staging/dev)')
    .action((projectName, options) => {
        envList(projectName, options);
    });

env
    .command('delete')
    .description('Delete an environment variable')
    .argument('<key-or-project>', 'Variable key (global) or project name')
    .argument('[key]', 'Variable key (if first arg is project)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action((keyOrProject, key, options) => {
        envDelete(keyOrProject, key, options);
    });

env
    .command('map')
    .description('Map a global variable to a project-specific key')
    .argument('<project>', 'Project name')
    .argument('<key>', 'Project-specific variable name')
    .argument('<global-key>', 'Global variable name to map from')
    .option('-y, --yes', 'Skip overwrite confirmation')
    .action((projectName, key, globalKey, options) => {
        envMap(projectName, key, globalKey, options);
    });

env
    .command('pull')
    .description('Pull resolved environment variables to a local file')
    .argument('<project>', 'Project name')
    .option('-e, --env <environment>', 'Environment (production/staging/dev)', 'dev')
    .option('-o, --output <file>', 'Output file path (defaults to .env or .env.{environment})')
    .option('-y, --yes', 'Skip confirmation for secrets')
    .option('--update-oauth', 'Only pull OAuth tokens and merge into existing .env file')
    .action((projectName, options) => {
        envPull(projectName, options);
    });

env
    .command('push')
    .description('Push environment variables from .env file to a project')
    .argument('<project>', 'Project name')
    .argument('[path]', 'Source directory with solidactions.yaml and .env file', '.')
    .option('-e, --env <environment>', 'Target environment (production/staging/dev)', 'dev')
    .option('--new-only', 'Only push new or empty variables (skip existing)')
    .option('--include-undeclared', 'Also push vars not declared in solidactions.yaml')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action((projectName, path, options) => {
        envPush(projectName, path, options);
    });

// =============================================================================
// schedule <subcommand>
// =============================================================================

const schedule = program.command('schedule').description('Manage cron schedules');

schedule
    .command('set')
    .description('Set a cron schedule for a workflow')
    .argument('<project>', 'Project name')
    .argument('<cron>', 'Cron expression (e.g., "0 9 * * *" for daily at 9am)')
    .option('-w, --workflow <name>', 'Workflow name (if project has multiple)')
    .option('-i, --input <json>', 'JSON input to pass to scheduled runs')
    .option('-y, --yes', 'Skip confirmation if schedule already exists')
    .action((projectName, cron, options) => {
        scheduleSet(projectName, cron, options);
    });

schedule
    .command('list')
    .description('List schedules for a project')
    .argument('<project>', 'Project name')
    .action((projectName) => {
        scheduleList(projectName);
    });

schedule
    .command('delete')
    .description('Delete a schedule')
    .argument('<project>', 'Project name')
    .argument('<schedule-id>', 'Schedule ID')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action((projectName, scheduleId, options) => {
        scheduleDelete(projectName, scheduleId, options);
    });

// =============================================================================
// webhook <subcommand>
// =============================================================================

const webhook = program.command('webhook').description('Manage webhooks');

webhook
    .command('list')
    .description('List webhook URLs for a project')
    .argument('<project>', 'Project name')
    .option('-e, --env <environment>', 'Environment (production/staging/dev)')
    .option('--show-secrets', 'Show webhook secrets')
    .option('--format <format>', 'Output format: table or json', 'table')
    .action((projectName, options) => {
        webhookList(projectName, options);
    });

webhook
    .command('secret')
    .description('Print the webhook secret for a project (set this value in your sender)')
    .argument('<project>', 'Project name')
    .option('-e, --env <environment>', 'Environment (production/staging/dev)')
    .option('--workflow <name>', 'Filter to a specific workflow by name')
    .option('--format <format>', 'Output format: text or json', 'text')
    .action((projectName, options) => {
        webhookSecret(projectName, options);
    });

// =============================================================================
// workspace <subcommand>
// =============================================================================

const workspace = program.command('workspace').description('Manage workspaces');

workspace
    .command('list')
    .description('List your workspaces across all organizations')
    .action(() => {
        workspacesList();
    });

workspace
    .command('set')
    .description('Set the active workspace and pin it')
    .argument('<id-or-slug-or-name>', 'Workspace ID, slug, or name')
    .option('--local', 'pin to ./.solidactions/config.json')
    .option('--global', 'pin to ~/.solidactions/config.json')
    .option('--gitignore', 'auto-add .solidactions/ to local .gitignore (skip prompt)')
    .action(async (input, opts) => {
        await workspaceSet(input, opts);
    });

// =============================================================================
// oauth-actions <subcommand>
// =============================================================================

const oauthActionsCmd = program.command('oauth-actions').description('Discover OAuth-backed API operations callable via the SA proxy');

oauthActionsCmd
    .command('search <platform> [query]')
    .description('Search available actions for a connected platform')
    .option('--method <method>', 'Filter by HTTP method (GET, POST, etc.)')
    .option('--limit <n>', 'Maximum results to return', (v) => parseInt(v, 10))
    .option('--json', 'Emit raw JSON for AI/script consumption')
    .action((platform, query, options) => {
        oauthActionsSearch(platform, query, options);
    });

oauthActionsCmd
    .command('list <platform>')
    .description('List actions for a connected platform')
    .option('--limit <n>', 'Maximum results to return', (v) => parseInt(v, 10))
    .option('--json', 'Emit raw JSON for AI/script consumption')
    .action((platform, options) => {
        oauthActionsList(platform, options);
    });

oauthActionsCmd
    .command('show <platform> <action-id>')
    .description('Show full schema, example body, and a paste-ready fetch snippet for one action')
    .option('--json', 'Emit raw JSON for AI/script consumption')
    .option('--var <NAME>', 'ctx.vars variable name for the connection (default: YOUR_CONNECTION)')
    .option('--legacy-env', 'Emit the deprecated process.env-based snippet (will be removed in a future release)')
    .action((platform, actionId, options) => {
        oauthActionsShow(platform, actionId, options);
    });

// =============================================================================
// ai <subcommand>
// =============================================================================

const ai = program.command('ai').description('AI helper tools');

ai
    .command('init')
    .description('Install SolidActions AI skills and SDK reference for AI-assisted development')
    .option('--claude', 'Use CLAUDE.md (for Claude Code)')
    .option('--agents', 'Use AGENTS.md (for Codex, Cursor, Gemini, Windsurf, etc.)')
    .action((options) => { aiInit(options); });

ai
    .command('examples')
    .description('Install example workflows for AI reference')
    .argument('[names...]', 'Example names to install (omit for interactive selector)')
    .option('--all', 'Install all available examples')
    .option('--overwrite', 'Overwrite existing examples without warning')
    .action((names, options) => { aiExamples(names, options); });

// =============================================================================
// skill <subcommand>  (SOP surface — flat top-level noun per cli#34)
// =============================================================================

const skill = program.command('skill').description('Manage agent skills (crews SOP surface)');

skill
    .command('push')
    .description('Push a local skill folder into the library (create, or update if it already exists)')
    .argument('<dir>', 'Path to the skill directory (must contain SKILL.md)')
    .option('--role <name>', 'Scope the skill to a role instead of the shared library')
    .option('--json', 'Output result as JSON')
    .option('--dry-run', 'Preview create vs update without writing')
    .action(async (dir, options) => {
        await skillPush(dir, options);
    });

skill
    .command('pull')
    .description('Fetch a skill from the library to a local folder for editing (inverse of push)')
    .argument('<name>', 'Skill name or identifier')
    .argument('[dest]', 'Destination directory (defaults to ./<name>/)')
    .option('--json', 'Output raw read result as JSON (no file writes)')
    .action(async (name, dest, options) => {
        await skillPull(name, dest, options);
    });

skill
    .command('list')
    .description('List skills in the library')
    .option('--json', 'Output as JSON')
    .option('--limit <n>', 'Maximum number of skills to return', (v) => parseInt(v, 10))
    .action(async (options) => {
        await skillList(options);
    });

skill
    .command('view <name>')
    .description('Show one skill')
    .option('--json', 'Output as JSON')
    .action(async (name, options) => {
        await skillView(name, options);
    });

skill
    .command('delete <name>')
    .description('Delete a skill (Admin only)')
    .option('--json', 'Output as JSON')
    .action(async (name, options) => {
        await skillDelete(name, options);
    });

// =============================================================================
// role <subcommand>  (SOP surface — flat peer of skill, per cli#34)
// =============================================================================

const role = program.command('role').description('Manage roles (crews SOP surface)');

role
    .command('push <dir>')
    .description('Push a role definition (create or update)')
    .option('--dry-run', 'Preview create vs update without writing')
    .option('--json', 'Output result as JSON')
    .action(async (dir, options) => {
        await rolePush(dir, options);
    });

// =============================================================================
// docs <subcommand>  (SA-Docs surface)
// =============================================================================

const docs = program.command('docs').description('Manage docs in SA-Docs');

docs
    .command('push')
    .description('Recursively upload a local markdown tree into SA-Docs')
    .argument('<dir>', 'Path to the directory containing markdown files')
    .option('--on-conflict <mode>', 'Conflict resolution: skip|overwrite|rename (default: skip)', 'skip')
    .option('--type <slug>', 'Doc-type slug to apply to all uploaded docs')
    .option('--folder <base>', 'Nest the whole upload under this base folder path in SA-Docs')
    .option('--dry-run', 'Preview what would be created without writing')
    .option('--json', 'Output result as JSON')
    .action(async (dir, options) => {
        await docsPush(dir, { onConflict: options.onConflict, type: options.type, folder: options.folder, dryRun: options.dryRun, json: options.json });
    });

program.parseAsync().catch((err) => {
    console.error(chalk.red(err.message ?? String(err)));
    process.exit(1);
});

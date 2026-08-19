#!/usr/bin/env node
import chalk from 'chalk';
import { Command, Option } from 'commander';
import { deploy } from './commands/deploy';
import { login, logout, resolveLoginApiKey, whoami } from './commands/login';
import { init } from './commands/init';
import { pull } from './commands/pull';
import { projectList } from './commands/project-list';
import { projectCreate } from './commands/project-create';
import { projectView } from './commands/project-view';
import { logsBuild } from './commands/project-logs';
import { run } from './commands/run-start';
import { runs } from './commands/run-list';
import { runView } from './commands/run-view';
import { envList } from './commands/env-list';
import { envDelete } from './commands/env-delete';
import { envMap } from './commands/env-map';
import { envPull } from './commands/env-pull';
import { envPush } from './commands/env-push';
import { envReset } from './commands/env-reset';
import { envSet } from './commands/env-set';
import { scheduleSet } from './commands/schedule-set';
import { scheduleList } from './commands/schedule-list';
import { scheduleDelete } from './commands/schedule-delete';
import { scheduleDisable, scheduleEnable, scheduleReset } from './commands/schedule-state';
import { webhookList } from './commands/webhook-list';
import { webhookSecret } from './commands/webhook-secret';
import { dev } from './commands/dev';
import { aiInit } from './commands/ai-init';
import { aiExamples } from './commands/ai-examples';
import { oauthActionSearch } from './commands/oauth-action-search';
import { oauthActionList } from './commands/oauth-action-list';
import { oauthActionView } from './commands/oauth-action-view';
import { oauthActionPlatforms } from './commands/oauth-action-platforms';
import { connectionList } from './commands/connection-list';
import { workspacesList, workspaceSet } from './commands/workspaces';
import { skillPush } from './commands/skill-push';
import { skillPublish } from './commands/skill-publish';
import { skillPull } from './commands/skill-pull';
import { skillList } from './commands/skill-list';
import { skillView } from './commands/skill-view';
import { skillDelete } from './commands/skill-delete';
import { skillDev } from './commands/skill-dev';
import { skillExec } from './commands/skill-exec';
import { rolePush } from './commands/role-push';
import { docPush } from './commands/doc-push';
import { docPull } from './commands/doc-pull';
import { docUpload } from './commands/doc-upload';
import { crewEnvSet } from './commands/crew-env-set';
import { crewEnvList } from './commands/crew-env-list';
import { crewEnvDelete } from './commands/crew-env-delete';
import { crewEnvPush } from './commands/crew-env-push';
import { crewEnvMapDatabase } from './commands/crew-env-map-database';
import {
    projectDisable,
    projectEnable,
    workflowDisable,
    workflowEnable,
} from './commands/state';
import { workflowView } from './commands/workflow-view';
import {
    databaseCreate,
    databaseDelete,
    databaseDump,
    databaseExec,
    databaseImport,
    databaseList,
    databasePull,
    databaseQuery,
    databaseSchema,
    databaseUndelete,
} from './commands/database';
import { databasePush } from './commands/database-push';
import { setCliWorkspaceOverride } from './utils/config';
import { setActiveCommandPath, setAssumeYes } from './utils/mutating-commands';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json');

export const program = new Command();

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

// Long form is --workspace-override (NOT --workspace) — `login` already owns
// `--workspace` for its own purpose (set the workspace at login time), and
// commander silently drops a subcommand option whose long name collides with
// a parent option of the same name, so `login --workspace <x>` was being
// swallowed by this global flag instead of reaching login()'s own option.
// The short form `-w` is unaffected and remains the primary way to use this.
program.option('-w, --workspace-override <id-or-slug-or-name>', 'Override active workspace for this command (short form: -w; also skips the CWD-inference prompt)');

program.hook('preAction', (thisCommand, actionCommand) => {
    // Record the full commander path (e.g. ['project', 'deploy']) and the active
    // command's own --yes/-y flag, unconditionally — these feed the workspace guard
    // in requireConfigWithWorkspace() and must never be skipped by an early return
    // below (e.g. the `workspace set` -w warning).
    const commandPath: string[] = [];
    for (let cmd: Command | null = actionCommand; cmd && cmd !== program; cmd = cmd.parent) {
        commandPath.unshift(cmd.name());
    }
    setActiveCommandPath(commandPath);
    setAssumeYes(!!actionCommand.opts().yes);

    const opts = thisCommand.opts();
    const wsOverride: string | undefined = opts.workspaceOverride;
    if (wsOverride) {
        // workspace set is a write — -w is for read-paths only.
        const fullName = actionCommand.name();
        const parentName = actionCommand.parent?.name?.();
        const isWorkspaceSet = fullName === 'set' && parentName === 'workspace';
        if (isWorkspaceSet) {
            console.error(
                chalk.yellow('warn:') + ' -w/--workspace-override is ignored on `workspace set`; the positional argument is the new workspace.',
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
    .description('Authenticate the CLI (prompts securely for your API key, or via --device for browser-based login)')
    .argument('[api-key]', 'Legacy positional API key (prefer the masked prompt, --stdin, or --device)')
    .option('--stdin', 'Read the API key from stdin (for non-interactive automation)')
    .option('--device', 'Authenticate via browser using OAuth device authorization')
    .addOption(new Option('--dev', 'Use local development server (http://localhost:8000)').hideHelp())
    .addOption(new Option('--host <url>', 'Custom API host URL').hideHelp())
    .option('--workspace <name-or-id>', 'Set workspace by name, slug, or ID. A sole workspace is auto-selected; use --workspace to choose among multiple workspaces.')
    .option('--local', 'Save config to ./.solidactions/config.json in the current folder')
    .option('--global', 'Save config to ~/.solidactions/config.json (default if prompted)')
    .option('--gitignore', 'With --local, add .solidactions/ to .gitignore without prompting')
    .addHelpText('after', `
Environment:
  SOLIDACTIONS_API_KEY  When set, this key takes precedence over any saved
                        credentials and is used directly — you do not need to run
                        \`login\` (or \`login --device\`) at all in that setup.`)
    .action(async (apiKey, options) => {
        if (options.device) {
            const { deviceLogin } = await import('./commands/device-login');
            await deviceLogin(options);
            return;
        }
        const resolvedApiKey = await resolveLoginApiKey(apiKey, { stdin: options.stdin });
        await login(resolvedApiKey, options);
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
    .option('-e, --env <env>', 'Pull platform variables for this environment (e.g. production, staging, dev)')
    .action((file, options) => {
        // Unified in-process invoke path. With --env: fetch declared vars, build
        // ctx.vars, invoke locally. Without --env: NO platform fetch, ctx.vars is
        // empty {} (the host process.env is never leaked into the workflow).
        dev(file, options);
    });

// =============================================================================
// database <subcommand>
// =============================================================================

// Register the complete public surface up front so help and the generated
// command manifest stay authoritative while handlers land in focused slices.
const database = program.command('database').description('Manage workspace databases');

database
    .command('list')
    .description('List workspace databases')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
        await databaseList(options);
    });

database
    .command('create')
    .description('Create a workspace database')
    .argument('<name>', 'Database name')
    .option('--from <file.sql>', 'Import a SQL file after creation')
    .option('--json', 'Output as JSON')
    .action(async (name, options) => {
        await databaseCreate(name, options);
    });

database
    .command('delete')
    .description('Delete a workspace database')
    .argument('<name>', 'Database name')
    .option('-y, --yes', 'Skip confirmation')
    .option('--json', 'Output as JSON')
    .action(async (name, options) => {
        await databaseDelete(name, options);
    });

database
    .command('undelete')
    .description('Restore a deleted workspace database')
    .argument('<name>', 'Database name')
    .option('--json', 'Output as JSON')
    .action(async (name, options) => {
        await databaseUndelete(name, options);
    });

database
    .command('schema')
    .description('Show a database schema')
    .argument('<name>', 'Database name')
    .option('--json', 'Output as JSON')
    .action(async (name, options) => {
        await databaseSchema(name, options);
    });

database
    .command('query')
    .description('Run a read-only SQL query')
    .argument('<name>', 'Database name')
    .argument('<sql>', 'SQL query')
    .option('--json', 'Output as JSON')
    .action(async (name, sql, options) => {
        await databaseQuery(name, sql, options);
    });

database
    .command('exec')
    .description('Execute a SQL statement')
    .argument('<name>', 'Database name')
    .argument('<sql>', 'SQL statement')
    .option('-y, --yes', 'Skip confirmation')
    .option('--json', 'Output as JSON')
    .action(async (name, sql, options) => {
        await databaseExec(name, sql, options);
    });

database
    .command('dump')
    .description('Download a database SQL dump')
    .argument('<name>', 'Database name')
    .argument('[file]', 'Destination file')
    .option('-y, --yes', 'Overwrite without confirmation')
    .action(async (name, file, options) => {
        await databaseDump(name, file, options);
    });

database
    .command('pull')
    .description('Pull a database into a local file')
    .argument('<name>', 'Database name')
    .argument('[path]', 'Destination path')
    .option('-y, --yes', 'Overwrite without confirmation')
    .option('--writable', 'Open a foreground writable session')
    .action(async (name, destination, options) => {
        await databasePull(name, destination, options);
    });

database
    .command('import')
    .description('Import a SQL file into a database')
    .argument('<name>', 'Database name')
    .argument('<file.sql>', 'SQL file')
    .option('-y, --yes', 'Skip confirmation')
    .option('--resume <checkpoint>', 'Resume from a validated import checkpoint')
    .action(async (name, file, options) => {
        await databaseImport(name, file, options);
    });

database
    .command('push')
    .description('Replace from a private WAL/4096-byte/auto-vacuum NONE snapshot; source file is unchanged; countable rows exclude internal, virtual, and shadow tables')
    .argument('<database>', 'Database name')
    .argument('<file.db>', 'Complete SQLite database file')
    .requiredOption('-y, --yes', 'Acknowledge destructive replacement')
    .option('--allow-empty', 'Allow a database with zero countable rows')
    .option('--idempotency-key <uuid>', 'Reuse a bulk-load operation UUID')
    .addHelpText('after', `
The source file is unchanged. Push uploads a private normalized snapshot using
WAL mode, 4096-byte pages, and auto-vacuum NONE; its byte size can differ from
the source. Countable rows include ordinary user tables only. Internal,
virtual, and shadow tables are excluded from the count.`)
    .action(async (name, file, options) => {
        await databasePush(name, file, options);
    });

// =============================================================================
// project <subcommand>
// =============================================================================

const project = program.command('project').description('Manage projects');

project
    .command('view')
    .description('View project status and the client-reported deployed revision')
    .argument('<project>', 'Project family slug or name')
    .option('-e, --env <environment>', 'Target environment (production/staging/dev). Defaults to dev.', 'dev')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
Defaults to dev: <project> is normalized as a project family and "-dev" is
appended. Use --env staging for the "-staging" target. Use --env production to
pass the supplied production slug or name through unchanged.`)
    .action(async (projectName, options) => {
        await projectView(projectName, options);
    });

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
    .option('--paused', 'Deploy with all YAML-declared schedules initially paused')
    .option('--no-cache', 'Force a fresh build, bypassing all build caches')
    .option('--force-rebuild', 'Force a fresh build, bypassing all build caches (alias for --no-cache)')
    .option(
        '--no-git-metadata',
        'Do not transmit Git provenance (branch, commit subject, and sanitized remote repository URL; credentials are stripped); also available as SOLIDACTIONS_NO_GIT_METADATA=1',
    )
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
    .option('-e, --env <environment>', 'Environment to resolve (production/staging/dev)')
    .addOption(new Option('--environment <environment>', 'Alias of --env').hideHelp())
    .action((projectName, options) => {
        const environment = options.env ?? options.environment;
        logsBuild(projectName, environment);
    });

project
    .command('list')
    .description('List all projects')
    .option('--json', 'Output as JSON')
    .action((options) => {
        projectList(options);
    });

project
    .command('enable')
    .description('Allow new workflow starts for a project environment')
    .argument('<project>', 'Project name')
    .option('-e, --env <environment>', 'Environment (production/staging/dev). Defaults to dev.', 'dev')
    .action(async (projectName, options) => {
        await projectEnable(projectName, options);
    });

project
    .command('disable')
    .description('Block new workflow starts for a project environment')
    .argument('<project>', 'Project name')
    .option('-e, --env <environment>', 'Environment (production/staging/dev). Defaults to dev.', 'dev')
    .action(async (projectName, options) => {
        await projectDisable(projectName, options);
    });

// =============================================================================
// workflow <subcommand>
// =============================================================================

const workflow = program.command('workflow').description('Manage deployed workflows');

workflow
    .command('view')
    .description('View a deployed workflow\'s enabled state')
    .argument('<project>', 'Project name')
    .argument('<workflow>', 'Exact workflow slug or name')
    .option('-e, --env <environment>', 'Environment (production/staging/dev). Defaults to dev.', 'dev')
    .option('--json', 'Output the server workflow state as JSON')
    .addHelpText('after', `
The environment defaults to dev. The project argument is normalized and dev or
staging appends the corresponding "-<env>" suffix; production uses the base
slug. This matches \`project view\`, which also defaults to dev and normalizes
its project argument the same way.`)
    .action(async (projectName, workflowName, options) => {
        await workflowView(projectName, workflowName, options);
    });

workflow
    .command('enable')
    .description('Allow new starts for a deployed workflow')
    .argument('<project>', 'Project name')
    .argument('<workflow>', 'Workflow name or slug')
    .option('-e, --env <environment>', 'Environment (production/staging/dev). Defaults to dev.', 'dev')
    .action(async (projectName, workflowName, options) => {
        await workflowEnable(projectName, workflowName, options);
    });

workflow
    .command('disable')
    .description('Block new starts for a deployed workflow')
    .argument('<project>', 'Project name')
    .argument('<workflow>', 'Workflow name or slug')
    .option('-e, --env <environment>', 'Environment (production/staging/dev). Defaults to dev.', 'dev')
    .action(async (projectName, workflowName, options) => {
        await workflowDisable(projectName, workflowName, options);
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
    .option('--wait', 'Wait for the workflow to complete')
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
    .option('-e, --env <environment>', 'Environment to filter by (production/staging/dev)')
    .addOption(new Option('--environment <environment>', 'Alias of --env').hideHelp())
    .action((projectName, options) => {
        options.environment = options.env ?? options.environment;
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

const env = program.command('env').description('Manage variables');

env
    .command('set')
    .description('Set a variable (create or update, global or project)')
    .argument('<key-or-project>', 'Variable key (global) or project name')
    .argument('<value-or-key>', 'Variable value (global) or variable key (project)')
    .argument('[value]', 'Variable value (when first arg is project)')
    .option('-s, --secret', 'Mark as encrypted secret')
    .option('-e, --env <environment>', 'Target environment (production/staging/dev)', 'dev')
    .option('--oauth-connection <name>', 'Bind the project key to an OAuth connection')
    .option('--global', 'Set a global variable (no project) — required for the 2-arg form')
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
    .description('List variables')
    .argument('[project]', 'Project name (omit for global variables)')
    .option('-e, --env <environment>', 'Filter by environment (production/staging/dev)')
    .option('--json', 'Output as JSON')
    .action((projectName, options) => {
        envList(projectName, options);
    });

env
    .command('delete')
    .description('Delete a variable')
    .argument('<key-or-project>', 'Variable key (global) or project name')
    .argument('[key]', 'Variable key (if first arg is project)')
    .option('-e, --env <environment>', 'Environment to delete from', 'dev')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action((keyOrProject, key, options) => {
        envDelete(keyOrProject, key, options);
    });

env
    .command('reset')
    .description('Reset a project variable mapping to its YAML-declared source')
    .argument('<project>', 'Project name')
    .argument('<KEY>', 'Variable key')
    .allowExcessArguments(false)
    .option('-e, --env <environment>', 'Environment to reset in', 'dev')
    .action(async (projectName, key, options) => {
        await envReset(projectName, key, options);
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
    .description('Pull resolved variables to a local file')
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
    .description('Push variables from .env file to a project')
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
// crew env <subcommand>
// =============================================================================

const crew = program.command('crew').description('Manage crews');
const crewEnv = crew.command('env').description('Manage crew variables');

crewEnv
    .command('set')
    .description('Set a crew variable (create or update)')
    .argument('<crew>', 'Crew name or id')
    .argument('<key>', 'Variable key')
    .argument('<value>', 'Variable value')
    .option('-e, --env <environment>', 'Target environment (production/staging/dev/all)', 'all')
    .option('--no-secret', 'Do not mark as secret — crew variables are secret by default (unlike `env set`)')
    .action((crewArg, key, value, options) => {
        crewEnvSet(crewArg, key, value, options);
    });

crewEnv
    .command('list')
    .description('List crew variables')
    .argument('<crew>', 'Crew name or id')
    .option('--json', 'Output as JSON')
    .action((crewArg, options) => {
        crewEnvList(crewArg, options);
    });

crewEnv
    .command('map-database')
    .description('Map a workspace database into crew sandboxes')
    .argument('<crew>', 'Crew name or id')
    .argument('<key>', 'Variable key')
    .argument('<database>', 'Workspace database name or id')
    .action((crewArg, key, databaseArg) => {
        crewEnvMapDatabase(crewArg, key, databaseArg);
    });

crewEnv
    .command('delete')
    .description('Delete a crew variable')
    .argument('<crew>', 'Crew name or id')
    .argument('<key>', 'Variable key')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action((crewArg, key, options) => {
        crewEnvDelete(crewArg, key, options);
    });

crewEnv
    .command('push')
    .description('Push variables from a .env file to a crew')
    .argument('<crew>', 'Crew name or id')
    .argument('[file]', 'Source .env file', '.env')
    .option('-e, --env <environment>', 'Target environment (production/staging/dev/all)', 'all')
    .option('--no-secret', 'Do not mark pushed variables as secret — secret by default (unlike `env push`)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action((crewArg, file, options) => {
        crewEnvPush(crewArg, file, options);
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
    .option('--workflow <name>', 'Workflow name (if project has multiple)')
    .option('-i, --input <json>', 'JSON input to pass to scheduled runs')
    .option('-z, --timezone <iana>', 'IANA timezone the cron is evaluated in (e.g. America/Chicago); defaults to UTC')
    .option('-e, --env <environment>', 'Resolve an explicit environment (production/staging/dev)')
    .option('--paused', 'Create or replace the schedule disabled')
    .option('-y, --yes', 'Skip confirmation if schedule already exists')
    .action((projectName, cron, options) => {
        scheduleSet(projectName, cron, options);
    });

schedule
    .command('list')
    .description('List schedules for a project')
    .argument('<project>', 'Project name')
    .option('-e, --env <environment>', 'Resolve an explicit environment (production/staging/dev)')
    .action((projectName, options) => {
        scheduleList(projectName, options);
    });

schedule
    .command('enable')
    .description('Enable a schedule with a sticky operator override')
    .argument('<project>', 'Project name')
    .argument('<schedule-id>', 'Schedule ID')
    .option('-e, --env <environment>', 'Resolve an explicit environment (production/staging/dev)')
    .action((projectName, scheduleId, options) => {
        scheduleEnable(projectName, scheduleId, options);
    });

schedule
    .command('disable')
    .description('Disable a schedule with a sticky operator override')
    .argument('<project>', 'Project name')
    .argument('<schedule-id>', 'Schedule ID')
    .option('-e, --env <environment>', 'Resolve an explicit environment (production/staging/dev)')
    .action((projectName, scheduleId, options) => {
        scheduleDisable(projectName, scheduleId, options);
    });

schedule
    .command('reset')
    .description('Return a schedule to its last declared YAML configuration')
    .argument('<project>', 'Project name')
    .argument('<schedule-id>', 'Schedule ID')
    .option('-e, --env <environment>', 'Resolve an explicit environment (production/staging/dev)')
    .action((projectName, scheduleId, options) => {
        scheduleReset(projectName, scheduleId, options);
    });

schedule
    .command('delete')
    .description('Delete a schedule')
    .argument('<project>', 'Project name')
    .argument('<schedule-id>', 'Schedule ID')
    .option('-e, --env <environment>', 'Resolve an explicit environment (production/staging/dev)')
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
    .option('--local', 'pin to ./.solidactions/config.json (this folder only)')
    .option('--global', 'pin to ~/.solidactions/config.json (machine-wide)')
    .option('--gitignore', 'auto-add .solidactions/ to local .gitignore (skip prompt)')
    .addHelpText('after', `
Where the pin is saved (--local / --global):
  --local and --global choose the target file and are mutually exclusive.
  If neither is passed, you are prompted when interactive (default: global);
  in non-interactive/CI use, the command exits with an error asking you to pass one.`)
    .action(async (input, opts) => {
        await workspaceSet(input, opts);
    });

// =============================================================================
// oauth-action <subcommand>
// =============================================================================

const oauthActionCmd = program.command('oauth-action').description('Discover OAuth-backed API operations callable via the SA proxy');

oauthActionCmd
    .command('search <platform> [query]')
    .description('Search available actions for a connected platform')
    .option('--method <method>', 'Filter by HTTP method (GET, POST, etc.)')
    .option('--limit <n>', 'Maximum results to return', (v) => parseInt(v, 10))
    .option('--json', 'Emit raw JSON for AI/script consumption')
    .action((platform, query, options) => {
        oauthActionSearch(platform, query, options);
    });

oauthActionCmd
    .command('list <platform>')
    .description('List actions for a connected platform')
    .option('--limit <n>', 'Maximum results to return', (v) => parseInt(v, 10))
    .option('--json', 'Emit raw JSON for AI/script consumption')
    .action((platform, options) => {
        oauthActionList(platform, options);
    });

oauthActionCmd
    .command('view <platform> <action-id>')
    .description('Show full schema, example body, and a paste-ready fetch snippet for one action')
    .option('--json', 'Emit raw JSON for AI/script consumption')
    .option('--var <NAME>', 'ctx.vars variable name for the connection (default: YOUR_CONNECTION)')
    .option('--legacy-env', 'Emit the deprecated process.env-based snippet (will be removed in a future release)')
    .action((platform, actionId, options) => {
        oauthActionView(platform, actionId, options);
    });

oauthActionCmd
    .command('platforms')
    .description('List available OAuth-backed platforms')
    .option('--json', 'Emit raw JSON for AI/script consumption')
    .action((options) => {
        oauthActionPlatforms(options);
    });

// =============================================================================
// connection <subcommand>
// =============================================================================

const connection = program.command('connection').description('Manage OAuth connections');

connection
    .command('list')
    .description('List OAuth connections in the active workspace')
    .action(() => {
        connectionList();
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
    .option('--publish', 'Publish (snapshot) the skill after pushing, making it live for agents')
    .option('--force', 'Skip the drift guard: push without checking the remote against your local sidecar revision')
    .action(async (dir, options) => {
        await skillPush(dir, options);
    });

skill
    .command('publish')
    .description('Publish (snapshot) a skill so its latest pushed revision goes live for agents')
    .argument('<name>', 'Skill name/identifier (e.g. "my-skill" or "shared/my-skill")')
    .option('--json', 'Output result as JSON')
    .action(async (name, options) => {
        await skillPublish(name, options);
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

skill
    .command('dev')
    .description('Run YOUR WORKING COPY of a skill locally with crew variables fetched from the platform (dev loop; default env dev; secrets need env:reveal). To execute the server-stored skill instead: skill exec <name> --target sandbox|host')
    .argument('<dir>', 'Local skill directory (must contain SKILL.md)')
    .argument('<command...>', 'Command to run (after --), e.g. -- node scripts/q.js')
    .option('--crew <nameOrId>', 'Crew whose variables to fetch (omit for shared skills)')
    .option('--environment <env>', 'Variable environment: production|staging|dev', 'dev')
    .option('--env-file <path>', 'Local KEY=VALUE overrides (reserved names ignored)')
    .action(async (dir, commandParts, options) => {
        await skillDev(dir, commandParts, options);
    });

skill
    .command('run', { hidden: true })
    .description('[deprecated] alias of `skill dev` — removed in v2.0.0')
    .argument('<dir>', 'Local skill directory (must contain SKILL.md)')
    .argument('<command...>', 'Command to run (after --)')
    .option('--crew <nameOrId>', 'Crew whose variables to fetch (omit for shared skills)')
    .option('--environment <env>', 'Variable environment: production|staging|dev', 'dev')
    .option('--env-file <path>', 'Local KEY=VALUE overrides (reserved names ignored)')
    .action(async (dir, commandParts, options) => {
        process.stderr.write(chalk.yellow("warn: 'skill run' is deprecated — use 'skill dev' (alias removed in v2.0.0)\n"));
        await skillDev(dir, commandParts, options);
    });

skill
    .command('exec')
    .description('Execute the SERVER-STORED skill (never local edits — see `skill dev`). --target picks where: sandbox (server) or host (this machine, transparent cache). Default env production for both targets; secrets on host need env:reveal')
    .argument('<name>', 'Skill name or identifier (names only — directories are rejected)')
    .argument('<command...>', 'Command to run (after --), e.g. -- node scripts/q.js')
    .requiredOption('--target <target>', "Where to execute: 'sandbox' or 'host'")
    .option('--role <name>', 'Role-scoped skill (crew inferred from the role)')
    .option('--in-crew <crew>', 'Disambiguate when the role name exists in multiple crews')
    .option('--crew <nameOrId>', 'host+shared only: crew whose variables to fetch')
    .option('--environment <env>', 'Variable environment: production|staging|dev (default production)')
    .option('--env-file <path>', 'host only: local KEY=VALUE overrides (reserved names ignored)')
    .action(async (name, commandParts, options) => {
        await skillExec(name, commandParts, options);
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
// doc <subcommand>  (SA-Docs surface)
// =============================================================================

const doc = program.command('doc').description('Manage docs in SA-Docs');

doc
    .command('push')
    .description('Recursively upload a local markdown tree into SA-Docs')
    .argument('<dir>', 'Path to the directory containing markdown files')
    .option('--on-conflict <mode>', 'Conflict resolution: skip|overwrite|rename (default: skip)', 'skip')
    .option('--type <slug>', 'Doc-type slug to apply to all uploaded docs')
    .option('--folder <base>', 'Nest the whole upload under this base folder path in SA-Docs')
    .option('--dry-run', 'Preview what would be created without writing')
    .option('--force', 'Overwrite tracked docs (from a prior doc pull) without a base-revision drift guard')
    .option('--json', 'Output result as JSON')
    .action(async (dir, options) => {
        await docPush(dir, { onConflict: options.onConflict, type: options.type, folder: options.folder, dryRun: options.dryRun, force: options.force, json: options.json });
    });

doc
    .command('pull')
    .description('Download a Docs folder tree to a local directory for editing (inverse of push)')
    .argument('<folder>', 'Docs folder path (or a single doc path)')
    .argument('[dest]', 'Destination directory (defaults to ./<last-segment>/)')
    .option('-y, --yes', 'Overwrite a non-empty destination without confirmation')
    .option('--overwrite', 'DESTRUCTIVE: discard unpushed local changes (tracked files whose content no longer matches the last pull) and overwrite them; implies --yes')
    .option('--json', 'Machine-readable output')
    .action(async (folder, dest, options) => {
        await docPull(folder, dest, options);
    });

doc
    .command('upload <files...>')
    .description('Upload one or more media files to SA-Docs (requires a token with the "docs" ability)')
    .option('--folder <path>', 'Folder path to upload into (auto-created if missing)')
    .option('--title <title>', 'Title for the uploaded doc (only valid with a single file)')
    .option('--replace <doc-id-or-path>', 'replace the bytes of an existing media doc (by id, or by docs path)')
    .action(async (files, options) => {
        await docUpload(files, { folder: options.folder, title: options.title, replace: options.replace });
    });

// Only parse argv when this file IS the process entry point (the `solidactions`
// bin). The #1004 command-manifest generator requires this module to walk the
// assembled command tree; that must not consume the caller's argv or exit.
if (require.main === module) {
    program.parseAsync().catch((err) => {
        console.error(chalk.red(err.message ?? String(err)));
        process.exit(1);
    });
}

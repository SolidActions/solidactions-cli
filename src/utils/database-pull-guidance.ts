export const WORKFLOW_RUN_ENV_KEYS = ['SOLIDACTIONS_RUN_ID', 'STEPS_TRIGGER_ID'] as const;

export function isInsideWorkflowRun(env: NodeJS.ProcessEnv): boolean {
    return WORKFLOW_RUN_ENV_KEYS.some((key) => typeof env[key] === 'string' && env[key] !== '');
}

export const WORKFLOW_RUN_PULL_WARNING =
    'Warning: database pull is running inside a workflow run. A workflow or function can query the database directly (ctx.vars with createDatabaseClient); pulling a copy on every run downloads it again each time. Use pull only for local analysis and keep one copy.';

export const DATABASE_PULL_HELP = `
Pull is for analysing a database on your own machine. Inside a workflow or a function,
query the database directly instead (ctx.vars with createDatabaseClient); never pull per
run, per test or per preview. Pull once and reuse that copy.

A pull fetches only what changed since your last pull of the same database; the first pull
downloads everything. A hidden cache for each database lives in
~/.solidactions/cache/database-replicas (delete the folder to start over) and takes
roughly the database's size on disk. Your file is always a plain read-only copy.
Use --no-cache to leave the cache out of one pull.
`;

import axios from 'axios';
import chalk from 'chalk';
import { authFailedLine, formatApiFailure, getApiHeaders, lookupProjectFamilyEnvironments, requireConfigWithWorkspace } from '../utils/api';
import { resolveProjectSlug } from '../utils/project-ref';

interface SecretRow {
    kind?: string;
    workflow_name?: string;
    webhook_secret?: string;
}

function workflowRowsOnly(rows: SecretRow[]): SecretRow[] {
    return rows.filter((r) => r.kind !== 'function');
}

export function formatSecretOutput(rows: SecretRow[], workflowFilter?: string): string {
    const workflows = workflowRowsOnly(rows);
    if (workflowFilter) {
        const match = workflows.find((r) => r.workflow_name === workflowFilter);
        if (!match) return `No webhook named "${workflowFilter}" found.`;
        return match.webhook_secret ?? '(secret not returned — check your access level)';
    }
    if (workflows.length === 1) {
        return workflows[0].webhook_secret ?? '(secret not returned — check your access level)';
    }
    const lines = workflows.map(
        (r) => `${(r.workflow_name ?? '?').padEnd(32)}${r.webhook_secret ?? '(none)'}`
    );
    return ['WORKFLOW'.padEnd(32) + 'SECRET', '-'.repeat(80), ...lines].join('\n');
}

export function formatSecretJson(rows: SecretRow[], workflowFilter?: string): string {
    const workflows = workflowRowsOnly(rows);
    const out = workflowFilter
        ? workflows
              .filter((r) => r.workflow_name === workflowFilter)
              .map((r) => ({ workflow: r.workflow_name, secret: r.webhook_secret }))
        : workflows.map((r) => ({ workflow: r.workflow_name, secret: r.webhook_secret }));
    return JSON.stringify(out, null, 2);
}

interface WebhookSecretOptions {
    env?: string;
    workflow?: string;
    format?: string;
}

export async function webhookSecret(projectName: string, options: WebhookSecretOptions = {}) {
    const format = options.format ?? 'text';
    if (format !== 'text' && format !== 'json') {
        console.error(chalk.red(`Invalid --format: ${format}. Expected 'text' or 'json'.`));
        process.exit(1);
    }

    const config = await requireConfigWithWorkspace();

    const environment = options.env || 'dev';

    if (format === 'text') {
        process.stderr.write(
            chalk.dim(`(environment: ${environment} — pass -e <env> to change)\n`)
        );
    }

    try {
        const projectSlug = await resolveProjectSlug(config, projectName, environment);
        const response = await axios.get(`${config.host}/api/v1/projects/${projectSlug}/webhooks`, {
            headers: getApiHeaders(config),
            params: { show_secrets: 'true' },
        });

        const rows: SecretRow[] = workflowRowsOnly(response.data.data ?? []);

        if (rows.length === 0) {
            console.error(
                chalk.yellow(
                    `No webhook workflows found for project "${projectName}"${environment !== 'production' ? ` (${environment})` : ''}.`
                )
            );
            process.exit(1);
        }

        if (format === 'json') {
            console.log(formatSecretJson(rows, options.workflow));
            return;
        }

        console.log(formatSecretOutput(rows, options.workflow));
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(
                    chalk.red(authFailedLine(config.host))
                );
            } else if (error.response.status === 404) {
                const family = await lookupProjectFamilyEnvironments(config, projectName);
                const envs = family?.environments ?? [];
                if (envs.length > 0 && !envs.includes(environment)) {
                    console.error(chalk.red(
                        `Project "${projectName}" has no ${environment} environment (exists in: ${envs.join(', ')}). Pass -e <env> to target a different environment.`
                    ));
                } else {
                    console.error(chalk.red(formatApiFailure(404, error.response.data)));
                }
            } else {
                console.error(chalk.red(formatApiFailure(error.response.status, error.response.data)));
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

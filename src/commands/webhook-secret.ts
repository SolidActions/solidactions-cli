import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

interface SecretRow {
    workflow_name?: string;
    webhook_secret?: string;
}

export function formatSecretOutput(rows: SecretRow[], workflowFilter?: string): string {
    if (workflowFilter) {
        const match = rows.find((r) => r.workflow_name === workflowFilter);
        if (!match) return `No webhook named "${workflowFilter}" found.`;
        return match.webhook_secret ?? '(secret not returned — check your access level)';
    }
    if (rows.length === 1) {
        return rows[0].webhook_secret ?? '(secret not returned — check your access level)';
    }
    const lines = rows.map(
        (r) => `${(r.workflow_name ?? '?').padEnd(32)}${r.webhook_secret ?? '(none)'}`
    );
    return ['WORKFLOW'.padEnd(32) + 'SECRET', '-'.repeat(80), ...lines].join('\n');
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

    const environment = options.env ?? 'production';
    const projectSlug = environment === 'production' ? projectName : `${projectName}-${environment}`;

    try {
        const response = await axios.get(`${config.host}/api/v1/projects/${projectSlug}/webhooks`, {
            headers: getApiHeaders(config),
            params: { show_secrets: 'true' },
        });

        const rows: SecretRow[] = response.data.data ?? [];

        if (rows.length === 0) {
            console.error(
                chalk.yellow(
                    `No webhook workflows found for project "${projectName}"${environment !== 'production' ? ` (${environment})` : ''}.`
                )
            );
            process.exit(1);
        }

        if (format === 'json') {
            const out = options.workflow
                ? rows
                      .filter((r) => r.workflow_name === options.workflow)
                      .map((r) => ({ workflow: r.workflow_name, secret: r.webhook_secret }))
                : rows.map((r) => ({ workflow: r.workflow_name, secret: r.webhook_secret }));
            console.log(JSON.stringify(out, null, 2));
            return;
        }

        console.log(formatSecretOutput(rows, options.workflow));
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(
                    chalk.red('Authentication failed. Run "solidactions login <api-key>" to re-configure.')
                );
            } else if (error.response.status === 404) {
                console.error(chalk.red(`Project "${projectName}" not found.`));
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

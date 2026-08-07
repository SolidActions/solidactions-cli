import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { formatTable, formatJson, type WebhookRow } from '../utils/webhook-formatters';

interface WebhookListOptions {
    env?: string;
    showSecrets?: boolean;
    format?: string;
}

export async function webhookList(projectName: string, options: WebhookListOptions = {}) {
    const format = options.format ?? 'table';
    if (format !== 'table' && format !== 'json') {
        console.error(chalk.red(`Invalid --format: ${options.format}. Expected 'table' or 'json'.`));
        process.exit(1);
    }

    const config = await requireConfigWithWorkspace();

    const environment = options.env || 'dev';
    const projectSlug = environment === 'production' ? projectName : `${projectName}-${environment}`;

    if (format === 'table') {
        console.log(chalk.blue(`Webhooks for project "${projectName}"${environment !== 'production' ? ` (${environment})` : ''}:`));
    }

    try {
        const params: Record<string, any> = {};
        if (options.showSecrets) {
            params.show_secrets = 'true';
        }

        const response = await axios.get(`${config.host}/api/v1/projects/${projectSlug}/webhooks`, {
            headers: getApiHeaders(config),
            params,
        });

        const webhooks: WebhookRow[] = response.data.data || [];
        const showSecrets = options.showSecrets === true;

        if (format === 'json') {
            console.log(formatJson(webhooks, { showSecrets }));
            return;
        }

        // table mode
        if (webhooks.length === 0) {
            console.log(chalk.yellow('No webhooks found for project "' + projectName + '".'));
            return;
        }

        console.log('');
        for (const line of formatTable(webhooks, { showSecrets })) {
            console.log(line);
        }
        console.log('');
        console.log(chalk.gray(`${webhooks.length} webhook(s)`));
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions login --global" to re-configure.'));
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

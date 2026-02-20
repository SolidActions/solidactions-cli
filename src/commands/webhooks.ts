import axios from 'axios';
import chalk from 'chalk';
import { getConfig } from './init';

interface WebhookListOptions {
    env?: string;
    showSecrets?: boolean;
}

export async function webhookList(projectName: string, options: WebhookListOptions = {}) {
    const config = getConfig();
    if (!config?.apiKey) {
        console.error(chalk.red('Not initialized. Run "solidactions init <api-key>" first.'));
        process.exit(1);
    }

    const environment = options.env || 'production';
    const projectSlug = environment === 'production' ? projectName : `${projectName}-${environment}`;

    console.log(chalk.blue(`Webhooks for project "${projectName}"${environment !== 'production' ? ` (${environment})` : ''}:`));

    try {
        const params: Record<string, any> = {};
        if (options.showSecrets) {
            params.show_secrets = 'true';
        }

        const response = await axios.get(`${config.host}/api/v1/projects/${projectSlug}/webhooks`, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
            },
            params,
        });

        const webhooks = response.data || [];

        if (webhooks.length === 0) {
            console.log(chalk.yellow('No webhooks found for project "' + projectName + '".'));
            return;
        }

        console.log('');

        if (options.showSecrets) {
            console.log(chalk.gray('WORKFLOW'.padEnd(30) + 'URL'.padEnd(60) + 'SECRET'));
            console.log(chalk.gray('-'.repeat(120)));
        } else {
            console.log(chalk.gray('WORKFLOW'.padEnd(30) + 'URL'));
            console.log(chalk.gray('-'.repeat(90)));
        }

        for (const webhook of webhooks) {
            const name = webhook.name || webhook.slug || '?';
            const url = webhook.url || '?';

            let line = name.padEnd(30) + chalk.cyan(url.padEnd(60));

            if (options.showSecrets) {
                const secret = webhook.secret || '-';
                line += chalk.gray(secret);
            }

            console.log(line);
        }

        console.log('');
        console.log(chalk.gray(`${webhooks.length} webhook(s)`));
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions init <api-key>" to re-configure.'));
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

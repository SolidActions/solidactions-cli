import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

interface OAuthActionsSearchOptions {
    method?: string;
    json?: boolean;
    limit?: number;
}

interface OAuthAction {
    platform: string;
    method: string;
    path: string;
    title: string;
    action_id: string;
    tags?: string[];
}

export async function oauthActionsSearch(platform: string, query: string | undefined, options: OAuthActionsSearchOptions) {
    const config = await requireConfigWithWorkspace();

    try {
        const params: Record<string, string> = { platform };
        if (query) params.q = query;
        if (options.method) params.method = options.method;
        if (options.limit) params.limit = String(options.limit);

        const response = await axios.get(`${config.host}/api/v1/oauth-actions`, {
            headers: getApiHeaders(config),
            params,
        });

        const actions: OAuthAction[] = response.data.oauth_actions || [];

        if (options.json) {
            process.stdout.write(JSON.stringify(actions, null, 2) + '\n');
            return;
        }

        if (actions.length === 0) {
            console.log('No actions found.');
            return;
        }

        for (const a of actions) {
            const method = (a.method || 'GET').toUpperCase().padEnd(6);
            const path = a.path || '';
            const title = a.title || '';
            console.log(`${chalk.cyan(method)} ${chalk.white(path.padEnd(55))} ${chalk.gray('— ' + title)}`);
            if (a.tags?.length) {
                console.log(chalk.gray(`  tags: ${a.tags.join(', ')}`));
            }
            console.log(chalk.gray(`  action_id: ${a.action_id}`));
            console.log('');
        }

        console.log(chalk.gray(`${actions.length} action(s) found.`));
        console.log(chalk.gray(`Run 'solidactions oauth-actions show ${platform} <action_id>' for full schema + paste-ready snippet.`));
    } catch (error: any) {
        if (error.response?.status === 401) {
            console.error(chalk.red('Authentication failed. Run "solidactions login <api-key>" to re-configure.'));
        } else if (error.response) {
            console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

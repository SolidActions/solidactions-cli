import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

interface OAuthActionListOptions {
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

export async function oauthActionList(platform: string, options: OAuthActionListOptions) {
    const config = await requireConfigWithWorkspace();

    try {
        const params: Record<string, string> = { platform };
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
            console.log(`No actions found for platform "${platform}".`);
            return;
        }

        for (const a of actions) {
            const method = (a.method || 'GET').toUpperCase().padEnd(6);
            console.log(`${chalk.cyan(method)} ${chalk.white(a.path.padEnd(50))} ${chalk.gray('— ' + (a.title || ''))}`);
        }
        console.log('');
        console.log(chalk.gray(`${actions.length} action(s) — use "solidactions oauth-action search ${platform} <query>" to narrow, or "oauth-action view ${platform} <action_id>" for detail.`));
    } catch (error: any) {
        if (error.response?.status === 404 && error.response.data?.code === 'platform_unknown') {
            console.error(chalk.red(`Unknown platform "${platform}". Run \`solidactions oauth-action platforms\` to see available platforms.`));
        } else if (error.response?.status === 401) {
            console.error(chalk.red('Authentication failed. Run "solidactions login --global".'));
        } else if (error.response) {
            console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

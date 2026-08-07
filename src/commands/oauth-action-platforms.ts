import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

interface OAuthActionPlatformsOptions {
    json?: boolean;
}

export async function oauthActionPlatforms(options: OAuthActionPlatformsOptions) {
    const config = await requireConfigWithWorkspace();

    try {
        const response = await axios.get(`${config.host}/api/v1/oauth-actions/platforms`, {
            headers: getApiHeaders(config),
        });

        const platforms: string[] = response.data.platforms || [];

        if (options.json) {
            process.stdout.write(JSON.stringify(platforms, null, 2) + '\n');
            return;
        }

        if (platforms.length === 0) {
            console.log('No platforms available.');
            return;
        }

        for (const platform of platforms) {
            console.log(platform);
        }
    } catch (error: any) {
        if (error.response?.status === 401) {
            console.error(chalk.red('Authentication failed. Run "solidactions login --global".'));
        } else if (error.response) {
            console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

import axios from 'axios';
import chalk from 'chalk';
import { getConfig } from './init';

export async function logsBuild(projectName: string) {
    const config = getConfig();
    if (!config?.apiKey) {
        console.error(chalk.red('Not initialized. Run "solidactions init <api-key>" first.'));
        process.exit(1);
    }

    console.log(chalk.blue(`Fetching build logs for project "${projectName}"...`));

    try {
        const response = await axios.get(`${config.host}/api/v1/projects/${projectName}/build-log`, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
            },
        });

        const buildLog = response.data.build_log || response.data;

        if (!buildLog || buildLog.length === 0) {
            console.log(chalk.gray('No build logs available.'));
            return;
        }

        console.log(chalk.gray('---'));
        console.log(buildLog);
        console.log(chalk.gray('---'));
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

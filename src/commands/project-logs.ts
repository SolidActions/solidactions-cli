import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

export function buildBuildLogUrl(host: string, projectName: string, environment?: string): string {
    if (environment) {
        return `${host}/api/v1/projects/resolve/build-log`;
    }
    return `${host}/api/v1/projects/${projectName}/build-log`;
}

export function buildBuildLogRequest(
    host: string,
    projectName: string,
    environment?: string,
): { url: string; params?: Record<string, string> } {
    if (environment) {
        return {
            url: `${host}/api/v1/projects/resolve/build-log`,
            params: { name: projectName, environment },
        };
    }
    return { url: `${host}/api/v1/projects/${projectName}/build-log` };
}

export async function logsBuild(projectName: string, environment?: string): Promise<void> {
    const config = await requireConfigWithWorkspace();

    console.log(chalk.blue(`Fetching build logs for project "${projectName}"...`));

    const { url, params } = buildBuildLogRequest(config.host, projectName, environment);

    try {
        const response = await axios.get(url, {
            headers: getApiHeaders(config),
            params,
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
                console.error(chalk.red('Authentication failed. Run "solidactions login <api-key>" to re-configure.'));
            } else if (error.response.status === 404) {
                console.error(chalk.red(error.response.data?.message ?? `Project "${projectName}" not found.`));
                const envs: string[] | undefined = error.response.data?.available_environments;
                if (envs && envs.length > 0) {
                    console.error(chalk.yellow(`Available environments: ${envs.join(', ')}. Pass -e <env> to select one.`));
                }
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

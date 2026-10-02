import axios from 'axios';
import chalk from 'chalk';
import { authFailedLine, describeProjectEnvironments, formatApiFailure, getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { describeTerminalRun } from '../utils/run-status';

export async function run(projectName: string, workflowName: string, options: { input?: string; wait?: boolean; env?: string }) {
    const config = await requireConfigWithWorkspace();

    const environment = options.env || 'dev';
    const projectSlug = environment === 'production'
        ? projectName
        : `${projectName}-${environment}`;

    console.log(chalk.blue(`Running workflow "${workflowName}" in project "${projectName}" (${environment})...`));

    let inputData: Record<string, any> = {};
    if (options.input) {
        try {
            inputData = JSON.parse(options.input);
        } catch {
            console.error(chalk.red('Invalid JSON input.'));
            process.exit(1);
        }
    }

    try {
        const response = await axios.post(
            `${config.host}/api/v1/projects/${projectSlug}/workflows/${workflowName}/trigger`,
            { input: inputData },
            {
                headers: getApiHeaders(config, 'application/json'),
            }
        );

        const runData = response.data.run || response.data;
        console.log(chalk.green(`Workflow triggered! Run ID: ${runData.id}`));

        if (options.wait) {
            console.log(chalk.gray('Waiting for completion...'));

            let attempts = 0;
            const maxAttempts = 300; // 5 minutes max

            const poll = setInterval(async () => {
                try {
                    attempts++;

                    const statusResponse = await axios.get(`${config.host}/api/v1/runs/${runData.id}`, {
                        headers: getApiHeaders(config),
                    });

                    const outcome = describeTerminalRun(statusResponse.data ?? {});
                    if (outcome) {
                        clearInterval(poll);
                        if (outcome.exitCode === 0) {
                            console.log(chalk.green(`\n${outcome.message}`));
                        } else {
                            console.error(chalk.red(`\n${outcome.message}`));
                        }
                        process.exit(outcome.exitCode);
                    } else if (attempts >= maxAttempts) {
                        clearInterval(poll);
                        console.error(chalk.yellow('\nTimeout waiting for workflow. It may still be running.'));
                        process.exit(1);
                    } else {
                        process.stdout.write('.');
                    }
                } catch {
                    // Ignore transient errors
                }
            }, 1000);
        }
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red(authFailedLine(config.host)));
            } else if (error.response.status === 404) {
                const envsList = await describeProjectEnvironments(config, projectName);
                if (envsList) {
                    console.error(chalk.red(
                        `Project "${projectName}" has no ${environment} environment (exists in: ${envsList}). Pass -e <env> to target a different environment.`
                    ));
                } else {
                    console.error(chalk.red('Project or workflow not found.'));
                }
            } else if (error.response.status === 422) {
                console.error(chalk.red('Validation error:'), error.response.data.message);
            } else {
                console.error(chalk.red(formatApiFailure(error.response.status, error.response.data)));
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

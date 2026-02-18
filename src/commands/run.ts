import axios from 'axios';
import chalk from 'chalk';
import { getConfig } from './init';

export async function run(projectName: string, workflowName: string, options: { input?: string; wait?: boolean }) {
    const config = getConfig();
    if (!config?.apiKey) {
        console.error(chalk.red('Not initialized. Run "solidactions init <api-key>" first.'));
        process.exit(1);
    }

    console.log(chalk.blue(`Running workflow "${workflowName}" in project "${projectName}"...`));

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
            `${config.host}/api/v1/projects/${projectName}/workflows/${workflowName}/trigger`,
            { input: inputData },
            {
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
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
                        headers: {
                            'Authorization': `Bearer ${config.apiKey}`,
                            'Accept': 'application/json',
                        },
                    });

                    const status = statusResponse.data.status;

                    if (status === 'completed') {
                        clearInterval(poll);
                        console.log(chalk.green('\nWorkflow completed successfully!'));
                        process.exit(0);
                    } else if (status === 'failed') {
                        clearInterval(poll);
                        console.error(chalk.red('\nWorkflow failed!'));
                        process.exit(1);
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
                console.error(chalk.red('Authentication failed. Run "solidactions init <api-key>" to re-configure.'));
            } else if (error.response.status === 404) {
                console.error(chalk.red('Project or workflow not found.'));
            } else if (error.response.status === 422) {
                console.error(chalk.red('Validation error:'), error.response.data.message);
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

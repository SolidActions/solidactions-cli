import axios from 'axios';
import chalk from 'chalk';
import { getConfig } from './init';

export async function scheduleSet(projectName: string, cron: string, options: { workflow?: string; input?: string }) {
    const config = getConfig();
    if (!config?.apiKey) {
        console.error(chalk.red('Not initialized. Run "solidactions init <api-key>" first.'));
        process.exit(1);
    }

    console.log(chalk.blue(`Setting schedule for project "${projectName}"...`));

    // Parse input JSON if provided
    let inputData: Record<string, any> | undefined;
    if (options.input) {
        try {
            inputData = JSON.parse(options.input);
        } catch {
            console.error(chalk.red('Invalid JSON input.'));
            process.exit(1);
        }
    }

    try {
        const payload: Record<string, any> = {
            cron,
        };

        if (options.workflow) {
            payload.workflow = options.workflow;
        }

        if (inputData) {
            payload.input = inputData;
        }

        await axios.post(`${config.host}/api/v1/projects/${projectName}/schedules`, payload, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
        });

        console.log(chalk.green(`Schedule set successfully!`));
        console.log(chalk.gray(`  Cron: ${cron}`));
        if (options.workflow) {
            console.log(chalk.gray(`  Workflow: ${options.workflow}`));
        }
        if (inputData) {
            console.log(chalk.gray(`  Input: ${JSON.stringify(inputData)}`));
        }
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions init <api-key>" to re-configure.'));
            } else if (error.response.status === 404) {
                console.error(chalk.red(`Project "${projectName}" not found.`));
            } else if (error.response.status === 422) {
                console.error(chalk.red('Validation error:'), error.response.data.message || error.response.data.errors);
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

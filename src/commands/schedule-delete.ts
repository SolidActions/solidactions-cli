import axios from 'axios';
import chalk from 'chalk';
import prompts from 'prompts';
import { getConfig } from './init';

export async function scheduleDelete(projectName: string, scheduleId: string, options: { yes?: boolean } = {}) {
    const config = getConfig();
    if (!config?.apiKey) {
        console.error(chalk.red('Not initialized. Run "solidactions init <api-key>" first.'));
        process.exit(1);
    }

    console.log(chalk.blue(`Deleting schedule ${scheduleId} from project "${projectName}"...`));

    try {
        // First, get the schedule details for confirmation
        const listResponse = await axios.get(`${config.host}/api/v1/projects/${projectName}/schedules`, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
            },
        });

        const schedules = listResponse.data || [];
        const schedule = schedules.find((s: any) => s.id?.toString() === scheduleId);

        if (!schedule) {
            console.error(chalk.red(`Schedule ${scheduleId} not found in project "${projectName}".`));
            process.exit(1);
        }

        // Confirm deletion unless --yes flag is provided
        if (!options.yes) {
            const response = await prompts({
                type: 'confirm',
                name: 'confirm',
                message: `Delete schedule for workflow "${schedule.workflow_name || schedule.workflow_slug}" (${schedule.cron_expression})?`,
                initial: false,
            });

            if (!response.confirm) {
                console.log(chalk.gray('Cancelled.'));
                return;
            }
        }

        // Delete the schedule
        await axios.delete(`${config.host}/api/v1/projects/${projectName}/schedules/${scheduleId}`, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
            },
        });

        console.log(chalk.green(`Schedule ${scheduleId} deleted successfully.`));
        console.log(chalk.gray(`  Workflow: ${schedule.workflow_name || schedule.workflow_slug}`));
        console.log(chalk.gray(`  Cron: ${schedule.cron_expression}`));
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions init <api-key>" to re-configure.'));
            } else if (error.response.status === 404) {
                console.error(chalk.red(`Project "${projectName}" or schedule ${scheduleId} not found.`));
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

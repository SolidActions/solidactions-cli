import axios from 'axios';
import chalk from 'chalk';
import { getConfig } from './init';

export async function scheduleList(projectName: string) {
    const config = getConfig();
    if (!config?.apiKey) {
        console.error(chalk.red('Not initialized. Run "solidactions init <api-key>" first.'));
        process.exit(1);
    }

    console.log(chalk.blue(`Schedules for project "${projectName}":`));

    try {
        const response = await axios.get(`${config.host}/api/v1/projects/${projectName}/schedules`, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
            },
        });

        const schedules = response.data || [];

        if (schedules.length === 0) {
            console.log(chalk.gray('No schedules found.'));
            return;
        }

        console.log('');
        console.log(chalk.gray('ID'.padEnd(8) + 'WORKFLOW'.padEnd(25) + 'CRON'.padEnd(18) + 'ENABLED'.padEnd(10) + 'NEXT RUN'));
        console.log(chalk.gray('-'.repeat(95)));

        for (const schedule of schedules) {
            const id = schedule.id?.toString() || '?';
            const workflow = schedule.workflow_name || schedule.workflow_slug || '?';
            const cron = schedule.cron_expression || '?';
            const enabled = schedule.enabled;
            const nextRun = schedule.next_run_at ? formatRelativeTime(schedule.next_run_at) : '-';

            const enabledColor = enabled ? chalk.green : chalk.red;

            console.log(
                chalk.gray(id.padEnd(8)) +
                workflow.padEnd(25) +
                chalk.cyan(cron.padEnd(18)) +
                enabledColor((enabled ? 'yes' : 'no').padEnd(10)) +
                chalk.gray(nextRun)
            );
        }

        console.log('');
        console.log(chalk.gray(`${schedules.length} schedule(s)`));
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

function formatRelativeTime(isoDate: string): string {
    const date = new Date(isoDate);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();

    if (diffMs < 0) {
        return 'overdue';
    }

    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMinutes < 60) {
        return `in ${diffMinutes}m`;
    } else if (diffHours < 24) {
        return `in ${diffHours}h`;
    } else if (diffDays < 7) {
        return `in ${diffDays}d`;
    } else {
        return date.toLocaleDateString();
    }
}

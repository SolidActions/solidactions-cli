import axios from 'axios';
import chalk from 'chalk';
import { getConfig } from './init';

export async function runs(projectName?: string, options: { limit?: number } = {}) {
    const config = getConfig();
    if (!config?.apiKey) {
        console.error(chalk.red('Not initialized. Run "solidactions init <api-key>" first.'));
        process.exit(1);
    }

    const limit = options.limit || 20;

    console.log(chalk.blue(projectName ? `Recent runs for "${projectName}":` : 'Recent runs:'));

    try {
        const params: Record<string, any> = { limit };
        if (projectName) {
            params.project = projectName;
        }

        const response = await axios.get(`${config.host}/api/v1/runs`, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
            },
            params,
        });

        const runsList = response.data.data || response.data;

        if (!runsList || runsList.length === 0) {
            console.log(chalk.gray('No runs found.'));
            return;
        }

        console.log('');
        console.log(chalk.gray('ID'.padEnd(38) + 'WORKFLOW'.padEnd(25) + 'STATUS'.padEnd(12) + 'STARTED'.padEnd(22) + 'DURATION'));
        console.log(chalk.gray('-'.repeat(110)));

        for (const run of runsList) {
            const id = run.id || '?';
            const workflow = run.workflow?.name || run.workflow_name || '?';
            const status = run.status || '?';
            const startedAt = run.started_at ? new Date(run.started_at).toLocaleString() : '-';
            const duration = calculateDuration(run.started_at, run.completed_at);

            const statusColor = getStatusColor(status);
            console.log(
                chalk.gray(id.toString().padEnd(38)) +
                workflow.padEnd(25) +
                statusColor(status.padEnd(12)) +
                chalk.gray(startedAt.padEnd(22)) +
                chalk.gray(duration)
            );
        }

        console.log('');
        console.log(chalk.gray(`Showing ${runsList.length} run(s)`));
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions init <api-key>" to re-configure.'));
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

function calculateDuration(startedAt?: string, completedAt?: string): string {
    if (!startedAt) return '-';

    const start = new Date(startedAt).getTime();
    const end = completedAt ? new Date(completedAt).getTime() : Date.now();
    const durationMs = end - start;

    if (durationMs < 1000) return `${durationMs}ms`;
    if (durationMs < 60000) return `${Math.round(durationMs / 1000)}s`;
    if (durationMs < 3600000) return `${Math.round(durationMs / 60000)}m`;
    return `${Math.round(durationMs / 3600000)}h`;
}

function getStatusColor(status: string): (text: string) => string {
    switch (status.toLowerCase()) {
        case 'completed':
            return chalk.green;
        case 'running':
            return chalk.blue;
        case 'pending':
        case 'queued':
            return chalk.yellow;
        case 'failed':
            return chalk.red;
        default:
            return chalk.gray;
    }
}

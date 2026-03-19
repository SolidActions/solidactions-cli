import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

interface StepsOptions {
    step?: string;
    json?: boolean;
    follow?: boolean;
}

export async function steps(runId: string, options: StepsOptions) {
    const config = await requireConfigWithWorkspace();

    // Flag validation: --follow and --step are incompatible
    if (options.follow && options.step) {
        console.error(chalk.red('Cannot use --follow with --step.'));
        process.exit(1);
    }

    try {
        const response = await axios.get(`${config.host}/api/v1/runs/${runId}/steps`, {
            headers: getApiHeaders(config),
        });

        const data = response.data;

        // --json mode: output raw JSON and exit
        if (options.json) {
            if (options.step) {
                const allSteps = flattenSteps(data.workers);
                const found = allSteps.find(s => s.name === options.step);
                if (!found) {
                    console.log(JSON.stringify({
                        error: 'Step not found',
                        available: allSteps.map(s => s.name),
                    }, null, 2));
                    process.exit(1);
                }
                console.log(JSON.stringify(found, null, 2));
            } else {
                console.log(JSON.stringify(data, null, 2));
            }
            return;
        }

        // --step mode: show single step detail
        if (options.step) {
            const allSteps = flattenSteps(data.workers);
            const found = allSteps.find(s => s.name === options.step);
            if (!found) {
                console.error(chalk.red(`Step "${options.step}" not found.`));
                console.log(chalk.gray('Available steps:'));
                for (const s of allSteps) {
                    console.log(chalk.gray(`  - ${s.name}`));
                }
                process.exit(1);
            }
            displaySingleStep(found);
            return;
        }

        // Default mode: show all steps
        displayAllSteps(runId, data);

        // --follow mode
        if (options.follow) {
            console.log(chalk.gray('\n--- Following steps (Ctrl+C to stop) ---\n'));

            const pollInterval = setInterval(async () => {
                try {
                    const refreshResponse = await axios.get(`${config.host}/api/v1/runs/${runId}/steps`, {
                        headers: getApiHeaders(config),
                    });

                    const runStatus = await axios.get(`${config.host}/api/v1/runs/${runId}`, {
                        headers: getApiHeaders(config),
                    });

                    console.clear();
                    displayAllSteps(runId, refreshResponse.data);

                    if (['completed', 'failed', 'acknowledged'].includes(runStatus.data.status)) {
                        clearInterval(pollInterval);
                        console.log(chalk.gray(`\n--- Run ${runStatus.data.status} ---`));
                        process.exit(runStatus.data.status === 'completed' ? 0 : 1);
                    }
                } catch {
                    // Ignore transient errors during follow
                }
            }, 2000);
        }
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions init <api-key>" to re-configure.'));
            } else if (error.response.status === 404) {
                console.error(chalk.red('Run not found.'));
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

function flattenSteps(workers: any[]): any[] {
    const allSteps: any[] = [];
    for (const worker of workers) {
        for (const step of worker.steps || []) {
            allSteps.push(step);
        }
    }
    return allSteps;
}

function displaySingleStep(step: any) {
    const statusColor = getStatusColor(step.status);

    console.log(chalk.blue(`Step: ${step.name}`));
    console.log(`  Status:       ${statusColor(step.status)}`);
    console.log(`  Type:         ${step.type}`);
    console.log(`  Duration:     ${formatDuration(step.duration_ms)}`);
    console.log(`  Started:      ${step.started_at || '-'}`);
    console.log(`  Completed:    ${step.completed_at || '-'}`);

    if (step.output !== null && step.output !== undefined) {
        console.log(`  Output:`);
        console.log(JSON.stringify(step.output, null, 2));
    } else {
        console.log(`  Output:       ${chalk.gray('(no output)')}`);
    }

    if (step.error) {
        console.log(chalk.red(`  Error:`));
        console.log(chalk.red(JSON.stringify(step.error, null, 2)));
    }
}

function displayAllSteps(runId: string, data: any) {
    const workers = data.workers || [];
    const signalWaits = data.signal_waits || [];

    console.log(chalk.blue(`Steps for run: ${runId}`));
    console.log('');

    for (let i = 0; i < workers.length; i++) {
        const worker = workers[i];
        const workerStatus = getStatusColor(worker.status || 'unknown');
        const workerDuration = calculateDuration(worker.started_at, worker.completed_at);

        console.log(chalk.white.bold(`Worker ${i + 1}`) + ' ' + workerStatus(worker.status || 'unknown') + chalk.gray(` (${workerDuration})`));

        for (const step of worker.steps || []) {
            const statusColor = getStatusColor(step.status);
            const name = (step.name || '?').padEnd(30);
            const status = statusColor((step.status || '?').padEnd(10));
            const type = (step.type || '?').padEnd(10);
            const duration = formatDuration(step.duration_ms);

            console.log(`  ${name} ${status} ${type} ${chalk.gray(duration)}`);

            if (step.output !== null && step.output !== undefined) {
                const outputStr = JSON.stringify(step.output, null, 2);
                for (const line of outputStr.split('\n')) {
                    console.log(chalk.gray(`    ${line}`));
                }
            } else {
                console.log(chalk.gray('    (no output)'));
            }

            if (step.error) {
                console.log(chalk.red(`    Error: ${JSON.stringify(step.error, null, 2)}`));
            }
        }

        // Show signal waits between workers
        if (i < workers.length - 1) {
            const wait = signalWaits[i];
            if (wait) {
                console.log(chalk.yellow(`  ⏳ ${wait.signal_name} (${formatDuration(wait.duration_ms)})`));
            }
        }

        console.log('');
    }
}

function formatDuration(ms: number | null): string {
    if (ms === null || ms === undefined) return '-';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
    return `${Math.round(ms / 3600000)}h`;
}

function calculateDuration(startedAt?: string, completedAt?: string): string {
    if (!startedAt) return '-';
    const start = new Date(startedAt).getTime();
    const end = completedAt ? new Date(completedAt).getTime() : Date.now();
    return formatDuration(end - start);
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

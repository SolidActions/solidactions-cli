import axios from 'axios';
import chalk from 'chalk';
import { getConfig } from './init';

export async function logs(runId: string, options: { follow?: boolean }) {
    const config = getConfig();
    if (!config?.apiKey) {
        console.error(chalk.red('Not initialized. Run "solidactions init <api-key>" first.'));
        process.exit(1);
    }

    console.log(chalk.blue(`Fetching logs for run: ${runId}...`));

    try {
        // Get the run status first
        const runResponse = await axios.get(`${config.host}/api/v1/runs/${runId}`, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
            },
        });

        const runData = runResponse.data;
        console.log(chalk.gray(`Status: ${runData.status}`));
        console.log(chalk.gray('---'));

        // Get the logs for this run
        const logsResponse = await axios.get(`${config.host}/api/v1/runs/${runId}/logs`, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
            },
        });

        let logEntries = logsResponse.data.logs || [];
        displayLogs(logEntries);

        if (options.follow && runData.status === 'running') {
            console.log(chalk.gray('\n--- Following logs (Ctrl+C to stop) ---\n'));

            const pollInterval = setInterval(async () => {
                try {
                    const refreshResponse = await axios.get(`${config.host}/api/v1/runs/${runId}/logs`, {
                        headers: {
                            'Authorization': `Bearer ${config.apiKey}`,
                            'Accept': 'application/json',
                        },
                    });

                    const newLogs = refreshResponse.data.logs || [];
                    const newEntries = newLogs.slice(logEntries.length);
                    displayLogs(newEntries);
                    logEntries = newLogs;

                    // Check if run is complete
                    const runStatus = await axios.get(`${config.host}/api/v1/runs/${runId}`, {
                        headers: {
                            'Authorization': `Bearer ${config.apiKey}`,
                            'Accept': 'application/json',
                        },
                    });

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

function displayLogs(entries: any[]) {
    for (const entry of entries) {
        const timestamp = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '??:??:??';
        const stream = entry.stream || 'stdout';
        const message = entry.message || entry.content || '';

        let coloredMessage: string;
        if (stream === 'stderr') {
            coloredMessage = chalk.red(message);
        } else {
            coloredMessage = chalk.white(message);
        }

        const streamIndicator = stream === 'stderr' ? chalk.red('[err]') : chalk.gray('[out]');
        console.log(`${chalk.gray(`[${timestamp}]`)} ${streamIndicator} ${coloredMessage}`);
    }
}

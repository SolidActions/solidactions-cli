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

        const logData = logsResponse.data.logs || '';
        let printed = displayLogs(logData);

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

                    const newLogData = refreshResponse.data.logs || '';
                    if (newLogData.length > printed) {
                        const newContent = newLogData.substring(printed);
                        printed += displayLogs(newContent);
                    }

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

/**
 * Display log content. Handles both string logs and array-of-entry logs.
 * Returns the number of characters printed (for follow-mode diffing).
 */
function displayLogs(logData: string | any[]): number {
    if (typeof logData === 'string') {
        if (logData.trim()) {
            console.log(logData);
        }
        return logData.length;
    }

    // Handle array format in case the API changes
    for (const entry of logData) {
        const message = entry.message || entry.content || '';
        if (!message.trim()) continue;

        const timestamp = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '??:??:??';
        const stream = entry.stream || 'stdout';
        const streamIndicator = stream === 'stderr' ? chalk.red('[err]') : chalk.gray('[out]');
        const coloredMessage = stream === 'stderr' ? chalk.red(message) : chalk.white(message);
        console.log(`${chalk.gray(`[${timestamp}]`)} ${streamIndicator} ${coloredMessage}`);
    }
    return logData.length;
}

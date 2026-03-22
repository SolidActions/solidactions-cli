import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

interface RunViewOptions {
    timeline?: boolean;
    steps?: boolean;
    logs?: boolean;
}

export async function runView(runId: string, options: RunViewOptions) {
    const config = await requireConfigWithWorkspace();

    try {
        // Fetch run data (includes session timing after Phase 1 expansion)
        const runResponse = await axios.get(`${config.host}/api/v1/runs/${runId}`, {
            headers: getApiHeaders(config),
        });
        const runData = runResponse.data;

        // --logs mode: fetch and display raw logs only
        if (options.logs) {
            const logsResponse = await axios.get(`${config.host}/api/v1/runs/${runId}/logs`, {
                headers: getApiHeaders(config),
            });
            const logData = logsResponse.data.logs || '';
            if (typeof logData === 'string') {
                console.log(logData);
            } else {
                console.log(JSON.stringify(logData, null, 2));
            }
            return;
        }

        // Fetch steps data
        const stepsResponse = await axios.get(`${config.host}/api/v1/runs/${runId}/steps`, {
            headers: getApiHeaders(config),
        });
        const stepsData = stepsResponse.data;

        // Build timeline
        const triggeredAt = runData.triggered_at || runData.created_at;
        const sessionStartedMs = runData.session_started_at_epoch_ms;
        const sessionCompletedMs = runData.session_completed_at_epoch_ms;

        const triggeredMs = triggeredAt ? new Date(triggeredAt).getTime() : null;
        const totalMs = (triggeredMs && sessionCompletedMs)
            ? sessionCompletedMs - triggeredMs
            : null;

        const timeline = {
            triggered: triggeredAt || null,
            started: sessionStartedMs ? new Date(sessionStartedMs).toISOString() : null,
            completed: sessionCompletedMs ? new Date(sessionCompletedMs).toISOString() : null,
            totalMs,
        };

        // --timeline mode: output only timeline
        if (options.timeline) {
            console.log(JSON.stringify(timeline, null, 2));
            return;
        }

        // --steps mode: output only steps
        if (options.steps) {
            const flatSteps = flattenSteps(stepsData.workers || []);
            console.log(JSON.stringify(flatSteps, null, 2));
            return;
        }

        // Default: full JSON output
        const flatSteps = flattenSteps(stepsData.workers || []);

        // Fetch logs for the full view
        const logsResponse = await axios.get(`${config.host}/api/v1/runs/${runId}/logs`, {
            headers: getApiHeaders(config),
        });

        const output: Record<string, any> = {
            id: runData.id,
            workflow: runData.workflow_name,
            project: runData.project_name,
            status: runData.execution_status || runData.status,
            exitCode: runData.exit_code ?? null,
            timeline,
            steps: flatSteps,
            logs: logsResponse.data.logs || '',
        };

        if (runData.output) {
            output.output = runData.output;
        }
        if (runData.error) {
            output.error = runData.error;
        }

        console.log(JSON.stringify(output, null, 2));
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
    const steps: any[] = [];
    for (const worker of workers) {
        for (const step of worker.steps || []) {
            steps.push({
                name: step.name,
                startedAt: step.started_at || null,
                completedAt: step.completed_at || null,
                durationMs: step.duration_ms ?? null,
                output: step.output ?? null,
            });
        }
    }
    return steps;
}

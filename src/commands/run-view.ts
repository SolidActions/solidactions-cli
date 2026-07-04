import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

interface RunViewOptions {
    timeline?: boolean;
    steps?: boolean;
    logs?: boolean;
    json?: boolean;
}

export async function runView(runId: string, options: RunViewOptions) {
    const config = await requireConfigWithWorkspace();

    try {
        // Fetch run data (includes session timing)
        const runResponse = await axios.get(`${config.host}/api/v1/runs/${runId}`, {
            headers: getApiHeaders(config),
        });
        const runData = runResponse.data;

        // Build timeline
        // Duration = container start → container stop (not triggered → stop)
        const triggeredAt = runData.triggered_at || runData.created_at;
        const sessionStartedMs = runData.session_started_at_epoch_ms;
        const sessionCompletedMs = runData.session_completed_at_epoch_ms;
        const durationMs = (sessionStartedMs && sessionCompletedMs)
            ? sessionCompletedMs - sessionStartedMs
            : null;

        const timeline = {
            triggered: triggeredAt || null,
            started: sessionStartedMs ? new Date(sessionStartedMs).toISOString() : null,
            completed: sessionCompletedMs ? new Date(sessionCompletedMs).toISOString() : null,
            durationMs,
        };

        // --logs: fetch and display raw logs
        if (options.logs) {
            const logsResponse = await axios.get(`${config.host}/api/v1/runs/${runId}/logs`, {
                headers: getApiHeaders(config),
            });
            const logData = logsResponse.data.logs || '';
            // --logs always outputs raw text, even with --json (wrapping logs in JSON is pointless)
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
        const flatSteps = flattenSteps(stepsData.workers || []);

        // --timeline
        if (options.timeline) {
            if (options.json) {
                console.log(JSON.stringify(timeline, null, 2));
            } else {
                displayTimeline(runData, timeline);
            }
            return;
        }

        // --steps
        if (options.steps) {
            if (options.json) {
                console.log(JSON.stringify(flatSteps, null, 2));
            } else {
                displayStepsTable(flatSteps);
            }
            return;
        }

        // Full view
        // Fetch logs for the full view
        const logsResponse = await axios.get(`${config.host}/api/v1/runs/${runId}/logs`, {
            headers: getApiHeaders(config),
        });

        if (options.json) {
            // Full JSON output
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
            if (runData.output) output.output = runData.output;
            if (runData.error) output.error = runData.error;
            console.log(JSON.stringify(output, null, 2));
        } else {
            // Human-readable output
            displayFullView(runData, timeline, flatSteps, logsResponse.data);
        }
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions login <api-key>" to re-configure.'));
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

// ─── Display helpers ───────────────────────────────────────────────────────

function displayFullView(runData: any, timeline: any, steps: any[], logsData: any) {
    const status = runData.execution_status || runData.status;
    const exitCode = runData.exit_code;
    const statusColor = getStatusColor(status);

    console.log('');
    console.log(chalk.bold(`Run #${runData.id}`) + chalk.gray(` — ${runData.workflow_name} (${runData.project_name})`));
    console.log('');

    // Status line
    const exitStr = exitCode !== null && exitCode !== undefined ? ` (exit ${exitCode})` : '';
    console.log(`  Status:    ${statusColor(status)}${chalk.gray(exitStr)}`);
    console.log(`  Trigger:   ${chalk.gray(runData.triggered_by || '-')}`);

    // Timeline
    displayTimeline(runData, timeline, steps);

    // Steps
    if (steps.length > 0) {
        console.log('');
        console.log(chalk.bold('  Steps:'));
        displayStepsTable(steps, '    ');
    }

    // Output
    if (runData.output) {
        console.log('');
        console.log(chalk.bold('  Output:'));
        const outputStr = JSON.stringify(unwrapOutput(runData.output), null, 2);
        for (const line of outputStr.split('\n')) {
            console.log(chalk.gray(`    ${line}`));
        }
    }

    // Error
    if (runData.error) {
        console.log('');
        console.log(chalk.bold.red('  Error:'));
        console.log(chalk.red(`    ${errorMessage(runData.error)}`));
    }

    // Logs snippet
    const logs = logsData.logs || '';
    if (logs && typeof logs === 'string' && logs.trim()) {
        const logLines = logs.trim().split('\n');
        const showLines = logLines.length > 10 ? logLines.slice(-10) : logLines;
        console.log('');
        console.log(chalk.bold('  Logs:') + chalk.gray(logLines.length > 10 ? ` (last 10 of ${logLines.length} lines, use --logs for full)` : ''));
        for (const line of showLines) {
            console.log(chalk.gray(`    ${line}`));
        }
    }

    // Errors from workers
    const errors = logsData.errors || [];
    if (errors.length > 0) {
        console.log('');
        for (const err of errors) {
            console.log(chalk.red(`  Worker ${err.worker}: ${err.error}`));
        }
    }

    console.log('');
}

function displayTimeline(runData: any, timeline: any, steps: any[] = []) {
    const formatTs = (iso: string | null) => {
        if (!iso) return '-';
        const d = new Date(iso);
        return d.toLocaleString();
    };

    // Compute startup: triggered → first step start
    let startupMs: number | null = null;
    if (timeline.triggered && steps.length > 0 && steps[0].startedAt) {
        const triggeredMs = new Date(timeline.triggered).getTime();
        const firstStepMs = new Date(steps[0].startedAt).getTime();
        startupMs = firstStepMs - triggeredMs;
    }

    console.log(`  Created:   ${chalk.gray(formatTs(timeline.triggered))}`);
    console.log(`  Started:   ${chalk.gray(formatTs(timeline.started))}`);
    console.log(`  Completed: ${chalk.gray(formatTs(timeline.completed))}`);
    if (startupMs !== null && startupMs > 0) {
        console.log(`  Startup:   ${chalk.gray(formatDuration(startupMs))}`);
    }
    console.log(`  Duration:  ${chalk.gray(timeline.durationMs ? formatDuration(timeline.durationMs) : '-')}`);
}

export function displayStepsTable(steps: any[], indent: string = '  ') {
    if (steps.length === 0) {
        console.log(chalk.gray(`${indent}(no steps)`));
        return;
    }

    console.log(chalk.gray(`${indent}${'STEP'.padEnd(24)}${'STATUS'.padEnd(12)}${'DURATION'.padEnd(12)}OUTPUT`));
    console.log(chalk.gray(`${indent}${'─'.repeat(72)}`));

    for (const step of steps) {
        const name = (step.name || '?').padEnd(24);
        const status = stepDisplayStatus(step);
        const statusColor = getStatusColor(status);
        const duration = formatDuration(step.durationMs);
        // A failed step's error is more useful than its (null) output — show it, red.
        const output = step.error
            ? chalk.red(truncate(errorMessage(step.error).replace(/\s+/g, ' ').trim(), 40))
            : chalk.gray(step.output ? truncate(JSON.stringify(unwrapOutput(step.output)), 40) : '-');

        console.log(
            `${indent}${name}${statusColor(status.padEnd(12))}${chalk.gray(duration.padEnd(12))}${output}`
        );
    }

    // Untruncated first failure below the table: `run view` alone must be
    // enough to diagnose (Wall #5 — failed steps used to render "completed").
    const firstFailed = steps.find((s) => stepDisplayStatus(s).toLowerCase() === 'failed' && s.error);
    if (firstFailed) {
        console.log('');
        console.log(chalk.bold.red(`${indent}Step "${firstFailed.name}" failed:`));
        console.log(chalk.red(`${indent}  ${errorMessage(firstFailed.error)}`));
    }
}

// ─── Utility ───────────────────────────────────────────────────────────────

export function flattenSteps(workers: any[]): any[] {
    const steps: any[] = [];
    for (const worker of workers) {
        for (const step of worker.steps || []) {
            steps.push({
                name: step.name,
                startedAt: step.started_at || null,
                completedAt: step.completed_at || null,
                durationMs: step.duration_ms ?? null,
                output: step.output ?? null,
                status: step.status ?? null,
                error: step.error ?? null,
            });
        }
    }
    return steps;
}

/** Server-derived status wins; timestamp heuristic only for pre-status API responses. */
export function stepDisplayStatus(step: { status?: string | null; startedAt?: string | null; completedAt?: string | null }): string {
    return step.status ?? (step.completedAt ? 'completed' : step.startedAt ? 'running' : 'pending');
}

function unwrapOutput(output: any): any {
    if (output && output.__solidactions_serializer === 'superjson' && output.json) {
        return output.json;
    }
    return output;
}

/**
 * Normalize a step/run `error` field to a readable string. Errors arrive in
 * one of three shapes: a plain string (legacy servers), a superjson-wrapped
 * `{ json: { name, message, stack }, __solidactions_serializer: 'superjson' }`
 * object (steps endpoint), or that same shape JSON.stringified into a string
 * (run-level `error` field) — confirmed live via GET /api/v1/runs/{id} and
 * .../steps. Without this, a thrown Error renders as "[object Object]".
 */
export function errorMessage(error: unknown): string {
    if (error === null || error === undefined) return '';

    let value: any = error;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return value;
        }
    }

    if (value && typeof value === 'object' && value.__solidactions_serializer === 'superjson' && value.json) {
        const inner = value.json;
        if (inner && typeof inner === 'object' && (inner.name || inner.message)) {
            return inner.name && inner.message ? `${inner.name}: ${inner.message}` : String(inner.name || inner.message);
        }
        return JSON.stringify(inner);
    }

    return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function formatDuration(ms: number | null): string {
    if (ms === null || ms === undefined) return '-';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
    return `${Math.round(ms / 3600000)}h`;
}

function truncate(str: string, max: number): string {
    if (str.length <= max) return str;
    return str.substring(0, max - 3) + '...';
}

function getStatusColor(status: string): (text: string) => string {
    switch (status?.toLowerCase()) {
        case 'completed':
        case 'success':
            return chalk.green;
        case 'running':
            return chalk.blue;
        case 'pending':
        case 'queued':
            return chalk.yellow;
        case 'failed':
        case 'error':
            return chalk.red;
        default:
            return chalk.gray;
    }
}

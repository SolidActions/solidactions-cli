import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

interface RunListOptions {
    limit?: number;
    offset?: number;
    status?: string;
    since?: string;
    workflow?: string;
    detailed?: boolean;
    hasErrors?: boolean;
    json?: boolean;
    environment?: string;
}

/**
 * Build the params object for GET /api/v1/runs.
 * Extracted as a pure function so it can be unit-tested without mocking axios.
 */
export function buildRunListParams(projectName?: string, options: RunListOptions = {}): Record<string, any> {
    const defaultLimit = options.detailed ? 5 : 20;
    const limit = options.limit || defaultLimit;

    const params: Record<string, any> = { limit };

    if (projectName) params.project = projectName;
    if (options.environment) params.environment = options.environment;
    if (options.offset) params.offset = options.offset;
    if (options.status) params.status = options.status;
    if (options.since) params.since = parseSince(options.since);
    if (options.workflow) params.workflow = options.workflow;
    if (options.detailed) params.detailed = '1';
    if (options.hasErrors) params.has_errors = '1';

    return params;
}

export async function runs(projectName?: string, options: RunListOptions = {}) {
    const config = await requireConfigWithWorkspace();

    try {
        const params = buildRunListParams(projectName, options);

        const response = await axios.get(`${config.host}/api/v1/runs`, {
            headers: getApiHeaders(config),
            params,
        });

        const runsList = response.data.data || response.data;

        // Check server-side error fields FIRST (project_not_found comes back as 200 with data:[])
        const serverError = response.data.error;
        if (serverError === 'project_not_found') {
            console.error(chalk.red(response.data.message || `Project '${projectName}' not found.`));
            process.exit(1);
        }

        if (!runsList || runsList.length === 0) {
            if (options.json) {
                console.log('[]');
            } else {
                console.log(chalk.gray('No runs found.'));
            }
            return;
        }

        if (options.json) {
            console.log(JSON.stringify(runsList, null, 2));
            return;
        }

        // Human-readable output
        if (options.detailed) {
            displayDetailedList(runsList, projectName);
        } else {
            displaySummaryTable(runsList, projectName);
        }
    } catch (error: any) {
        if (error.response) {
            // ambiguous_project is 422 — axios throws, so handle here
            if (error.response.status === 422 && error.response.data?.error === 'ambiguous_project') {
                const envs = ((error.response.data.environments ?? []) as string[]).join(', ');
                console.error(chalk.yellow(`Ambiguous project '${projectName}': found in environments: ${envs}.`));
                console.error(chalk.yellow(`Pass -e <env> to disambiguate, e.g.: solidactions run list ${projectName} -e dev`));
            } else if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions login <api-key>" to re-configure.'));
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

// ─── Display modes ─────────────────────────────────────────────────────────

/**
 * Summary-table status label for a run. Recovered/degraded runs share SUCCESS's
 * execution_status, so without this they'd be indistinguishable from a clean success in
 * the summary view. Returns the label to display and whether it's an "attention" outcome
 * (rendered yellow). Falls back to the raw status for servers that don't send `outcome`.
 */
export function summaryStatusLabel(run: { outcome?: string; execution_status?: string; status?: string }): {
    label: string;
    attention: boolean;
} {
    if (run.outcome === 'recovered') return { label: 'recovered', attention: true };
    if (run.outcome === 'degraded') return { label: 'degraded', attention: true };
    return { label: run.execution_status || run.status || '?', attention: false };
}

/**
 * Detailed-view tag appended to a run header ('' when none). Prefers the API `outcome`;
 * falls back to the local hasRunErrors heuristic for servers that don't send `outcome`.
 */
export function detailedOutcomeTag(run: any): string {
    if (run.outcome === 'recovered') return ' [RECOVERED]';
    if (run.outcome === 'degraded') return ' [DEGRADED]';
    if (hasRunErrors(run) && isSuccessStatus(run.execution_status || run.status || '')) return ' [DEGRADED]';
    return '';
}

function displaySummaryTable(runsList: any[], projectName?: string) {
    const header = projectName ? `Recent runs for "${projectName}":` : 'Recent runs:';
    console.log(chalk.blue(header));
    console.log('');
    console.log(chalk.gray('ID'.padEnd(8) + 'WORKFLOW'.padEnd(25) + 'STATUS'.padEnd(12) + 'TRIGGERED'.padEnd(22) + 'TRIGGERED BY'));
    console.log(chalk.gray('-'.repeat(90)));

    for (const run of runsList) {
        const id = String(run.id || '?').padEnd(8);
        const workflow = truncate(run.workflow_name || '?', 24).padEnd(25);
        const { label: status, attention } = summaryStatusLabel(run);
        const statusColor = attention ? chalk.yellow : getStatusColor(status);
        const triggeredAt = run.triggered_at ? new Date(run.triggered_at).toLocaleString() : '-';
        const triggeredBy = run.triggered_by || '-';

        console.log(
            chalk.gray(id) +
            workflow +
            statusColor(status.padEnd(12)) +
            chalk.gray(triggeredAt.padEnd(22)) +
            chalk.gray(triggeredBy)
        );
    }

    console.log('');
    console.log(chalk.gray(`Showing ${runsList.length} run(s)`));
}

function displayDetailedList(runsList: any[], projectName?: string) {
    const header = projectName ? `Runs for "${projectName}" (detailed):` : 'Runs (detailed):';
    console.log(chalk.blue(header));

    for (const run of runsList) {
        const status = run.execution_status || run.status || '?';
        const statusColor = getStatusColor(status);
        const exitStr = run.exit_code !== null && run.exit_code !== undefined ? ` (exit ${run.exit_code})` : '';

        console.log('');
        const outcomeTag = detailedOutcomeTag(run);
        const silentTag = outcomeTag ? chalk.yellow(outcomeTag) : '';
        console.log(chalk.bold(`  Run #${run.id}`) + chalk.gray(` — ${run.workflow_name || '?'} (${run.project_name || '?'})`) + silentTag);
        console.log(`    Status:    ${statusColor(status)}${chalk.gray(exitStr)}`);
        console.log(`    Trigger:   ${chalk.gray(run.triggered_by || '-')}`);

        // Timeline
        if (run.timeline) {
            const formatTs = (iso: string | null) => iso ? new Date(iso).toLocaleString() : '-';
            console.log(`    Triggered: ${chalk.gray(formatTs(run.timeline.triggered))}`);
            console.log(`    Started:   ${chalk.gray(formatTs(run.timeline.started))}`);
            console.log(`    Completed: ${chalk.gray(formatTs(run.timeline.completed))}`);
        }

        // Steps detail
        if (run.steps && run.steps.length > 0) {
            displayStepsDetail(run.steps);
        }

        // Workflow output
        if (run.output) {
            const outputStr = JSON.stringify(unwrapOutput(run.output), null, 2);
            const lines = outputStr.split('\n');
            if (lines.length === 1) {
                console.log(`    Output:    ${chalk.gray(truncate(outputStr, 60))}`);
            } else {
                console.log(`    Output:`);
                for (const line of lines.slice(0, 5)) {
                    console.log(chalk.gray(`      ${line}`));
                }
                if (lines.length > 5) {
                    console.log(chalk.gray(`      ... (${lines.length - 5} more lines)`));
                }
            }
        }

        // Workflow error
        if (run.error) {
            const errMsg = typeof run.error === 'string' ? run.error : JSON.stringify(run.error);
            console.log(`    ${chalk.bold.red('Error:')}    ${chalk.red(truncate(errMsg, 60))}`);
        }

        // Logs snippet (first errors or last 3 lines)
        if (run.logs && typeof run.logs === 'string' && run.logs.trim()) {
            const lines = run.logs.trim().split('\n');
            const errorLines = lines.filter((l: string) => /error|fail|exception/i.test(l));
            if (errorLines.length > 0) {
                console.log(`    Logs:`);
                for (const line of errorLines.slice(0, 3)) {
                    console.log(chalk.red(`      ${truncate(line, 80)}`));
                }
            }
        }
    }

    console.log('');
    console.log(chalk.gray(`Showing ${runsList.length} run(s)`));
}

function displayStepsDetail(steps: any[]) {
    const completed = steps.filter((s: any) => s.completed_at || s.completed_at_epoch_ms).length;
    const totalDuration = steps.reduce((sum: number, s: any) => sum + (s.duration_ms || 0), 0);
    const errorCount = steps.filter((s: any) => s.error || s.status === 'error' || s.status === 'failed').length;
    const retryCount = steps.filter((s: any) => s.retried || s.status === 'retried').length;

    let summary = `${completed}/${steps.length} completed (${formatDuration(totalDuration)} total)`;
    if (errorCount > 0) summary += chalk.red(` · ${errorCount} errored`);
    if (retryCount > 0) summary += chalk.yellow(` · ${retryCount} retried`);
    console.log(`    Steps:     ${chalk.gray(summary)}`);

    // Per-step detail table
    console.log(chalk.gray(`      ${'NAME'.padEnd(24)}${'STATUS'.padEnd(12)}${'DURATION'.padEnd(10)}OUTPUT`));
    console.log(chalk.gray(`      ${'─'.repeat(70)}`));

    for (const step of steps) {
        const name = truncate(step.name || '?', 23).padEnd(24);
        const stepStatus = getStepStatus(step);
        const stepStatusColor = getStepStatusColor(stepStatus);
        const duration = formatDuration(step.duration_ms);
        const output = step.output ? truncate(JSON.stringify(unwrapOutput(step.output)), 40) : '-';

        console.log(
            `      ${name}${stepStatusColor(stepStatus.padEnd(12))}${chalk.gray(duration.padEnd(10))}${chalk.gray(output)}`
        );

        if (step.error) {
            const errMsg = typeof step.error === 'string' ? step.error : JSON.stringify(step.error);
            console.log(chalk.red(`        error: ${truncate(errMsg, 70)}`));
        }
    }
}

// ─── Utility ───────────────────────────────────────────────────────────────

function unwrapOutput(output: any): any {
    if (output && output.__solidactions_serializer === 'superjson' && output.json) {
        return output.json;
    }
    return output;
}

/**
 * Determine if a run has any errors (step errors, retries, or non-empty error arrays in output).
 */
function hasRunErrors(run: any): boolean {
    // Check step-level errors
    if (run.steps && run.steps.some((s: any) => s.error || s.status === 'error' || s.status === 'failed' || s.retried || s.status === 'retried')) {
        return true;
    }
    // Check workflow-level error
    if (run.error) return true;
    // Check output.errors array
    const output = unwrapOutput(run.output);
    if (output && Array.isArray(output.errors) && output.errors.length > 0) return true;
    return false;
}

function isSuccessStatus(status: string): boolean {
    const s = status?.toLowerCase();
    return s === 'completed' || s === 'success';
}

function getStepStatus(step: any): string {
    if (step.status) return step.status;
    if (step.error) return 'error';
    if (step.completed_at || step.completed_at_epoch_ms) return 'completed';
    if (step.started_at || step.started_at_epoch_ms) return 'running';
    return 'pending';
}

function getStepStatusColor(status: string): (text: string) => string {
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
        case 'retried':
            return chalk.yellow;
        default:
            return chalk.gray;
    }
}

/**
 * Parse --since value into epoch ms.
 * Accepts: "1h", "30m", "2d", "1w", or ISO date string.
 */
function parseSince(since: string): string {
    const match = since.match(/^(\d+)(m|h|d|w)$/);
    if (match) {
        const value = parseInt(match[1]);
        const unit = match[2];
        const multipliers: Record<string, number> = {
            m: 60 * 1000,
            h: 60 * 60 * 1000,
            d: 24 * 60 * 60 * 1000,
            w: 7 * 24 * 60 * 60 * 1000,
        };
        const ms = Date.now() - (value * multipliers[unit]);
        return String(ms);
    }
    // Assume ISO date string — let the backend parse it
    return since;
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

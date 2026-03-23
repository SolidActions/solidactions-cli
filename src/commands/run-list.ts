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
    json?: boolean;
}

export async function runs(projectName?: string, options: RunListOptions = {}) {
    const config = await requireConfigWithWorkspace();

    // Default limit is lower for --detailed (more data per run)
    const defaultLimit = options.detailed ? 5 : 20;
    const limit = options.limit || defaultLimit;

    try {
        const params: Record<string, any> = { limit };

        if (projectName) params.project = projectName;
        if (options.offset) params.offset = options.offset;
        if (options.status) params.status = options.status;
        if (options.since) params.since = parseSince(options.since);
        if (options.workflow) params.workflow = options.workflow;
        if (options.detailed) params.detailed = '1';

        const response = await axios.get(`${config.host}/api/v1/runs`, {
            headers: getApiHeaders(config),
            params,
        });

        const runsList = response.data.data || response.data;

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

// ─── Display modes ─────────────────────────────────────────────────────────

function displaySummaryTable(runsList: any[], projectName?: string) {
    const header = projectName ? `Recent runs for "${projectName}":` : 'Recent runs:';
    console.log(chalk.blue(header));
    console.log('');
    console.log(chalk.gray('ID'.padEnd(8) + 'WORKFLOW'.padEnd(25) + 'STATUS'.padEnd(12) + 'TRIGGERED'.padEnd(22) + 'TRIGGERED BY'));
    console.log(chalk.gray('-'.repeat(90)));

    for (const run of runsList) {
        const id = String(run.id || '?').padEnd(8);
        const workflow = truncate(run.workflow_name || '?', 24).padEnd(25);
        const status = run.execution_status || run.status || '?';
        const statusColor = getStatusColor(status);
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
        console.log(chalk.bold(`  Run #${run.id}`) + chalk.gray(` — ${run.workflow_name || '?'} (${run.project_name || '?'})`));
        console.log(`    Status:    ${statusColor(status)}${chalk.gray(exitStr)}`);
        console.log(`    Trigger:   ${chalk.gray(run.triggered_by || '-')}`);

        // Timeline
        if (run.timeline) {
            const formatTs = (iso: string | null) => iso ? new Date(iso).toLocaleString() : '-';
            console.log(`    Triggered: ${chalk.gray(formatTs(run.timeline.triggered))}`);
            console.log(`    Started:   ${chalk.gray(formatTs(run.timeline.started))}`);
            console.log(`    Completed: ${chalk.gray(formatTs(run.timeline.completed))}`);
        }

        // Steps summary
        if (run.steps && run.steps.length > 0) {
            const completed = run.steps.filter((s: any) => s.completed_at || s.completed_at_epoch_ms).length;
            const totalDuration = run.steps.reduce((sum: number, s: any) => sum + (s.duration_ms || 0), 0);
            console.log(`    Steps:     ${chalk.gray(`${completed}/${run.steps.length} completed (${formatDuration(totalDuration)} total)`)}`);
        }

        // Logs snippet (first errors or last 3 lines)
        if (run.logs && typeof run.logs === 'string' && run.logs.trim()) {
            const lines = run.logs.trim().split('\n');
            const errorLines = lines.filter((l: string) => /error|fail|exception/i.test(l));
            if (errorLines.length > 0) {
                console.log(`    Errors:`);
                for (const line of errorLines.slice(0, 3)) {
                    console.log(chalk.red(`      ${truncate(line, 80)}`));
                }
            }
        }
    }

    console.log('');
    console.log(chalk.gray(`Showing ${runsList.length} run(s)`));
}

// ─── Utility ───────────────────────────────────────────────────────────────

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

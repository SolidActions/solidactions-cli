import chalk from 'chalk';

/** solidactions-app RunTrigger::TERMINAL_STATUSES — a run in one of these never changes again. */
export const TERMINAL_RUN_STATUSES: readonly string[] = ['completed', 'failed', 'cancelled', 'dispatch_failed', 'skipped_no_credit'];

export function getStatusColor(status: string): (text: string) => string {
    switch (status?.toLowerCase()) {
        case 'completed':
        case 'success':
            return chalk.green;
        case 'running':
            return chalk.blue;
        case 'pending':
        case 'queued':
        case 'admission_pending':
            return chalk.yellow;
        case 'failed':
        case 'error':
        case 'dispatch_failed':
        case 'skipped_no_credit':
            return chalk.red;
        case 'cancelled':
        default:
            return chalk.gray;
    }
}

/** Status text for humans; `admission_pending` alone says nothing to a user (cli#99). */
export function formatRunStatusLabel(status: string): string {
    return status === 'admission_pending' ? 'admission_pending (waiting for a free run slot)' : status;
}

/** Why a run never started, from the run payload's `admission_denied_reason`; null when there is none. */
export function describeAdmissionDenied(reason: unknown): string | null {
    if (typeof reason !== 'string' || reason === '') return null;
    if (reason === 'ttl_expired') {
        return 'Run never started: it waited for a free run slot longer than its time limit (admission_denied_reason: ttl_expired).';
    }
    return `Run never started (admission_denied_reason: ${reason}).`;
}

/** The outcome `run start --wait` reports for a terminal run, or null while the run can still change. */
export function describeTerminalRun(run: { status?: unknown; admission_denied_reason?: unknown }): { exitCode: 0 | 1; message: string } | null {
    const status = typeof run.status === 'string' ? run.status : '';
    if (!TERMINAL_RUN_STATUSES.includes(status)) return null;
    if (status === 'completed') return { exitCode: 0, message: 'Workflow completed successfully!' };
    if (status === 'cancelled') return { exitCode: 1, message: 'Workflow was cancelled.' };
    if (status === 'failed') {
        return { exitCode: 1, message: describeAdmissionDenied(run.admission_denied_reason) ?? 'Workflow failed!' };
    }
    return { exitCode: 1, message: `Workflow did not run (status: ${status}).` };
}

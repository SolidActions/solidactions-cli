import chalk from 'chalk';
import { describe, expect, it } from 'vitest';
import { describeAdmissionDenied, describeTerminalRun, formatRunStatusLabel, getStatusColor } from '../src/utils/run-status';

describe('run status helpers (cli#99)', () => {
    it('completed is a success', () => {
        expect(describeTerminalRun({ status: 'completed' })).toEqual({ exitCode: 0, message: 'Workflow completed successfully!' });
    });

    it('cancelled is terminal', () => {
        expect(describeTerminalRun({ status: 'cancelled' })).toEqual({ exitCode: 1, message: 'Workflow was cancelled.' });
    });

    it.each(['dispatch_failed', 'skipped_no_credit'])('%s is terminal and named', (status) => {
        expect(describeTerminalRun({ status })).toEqual({ exitCode: 1, message: `Workflow did not run (status: ${status}).` });
    });

    it('a failed run with an admission reason explains it instead of a bare failure', () => {
        expect(describeTerminalRun({ status: 'failed', admission_denied_reason: 'ttl_expired' })).toEqual({
            exitCode: 1,
            message: 'Run never started: it waited for a free run slot longer than its time limit (admission_denied_reason: ttl_expired).',
        });
    });

    it('an unknown admission reason is shown verbatim', () => {
        expect(describeAdmissionDenied('plan_disabled')).toBe('Run never started (admission_denied_reason: plan_disabled).');
        expect(describeAdmissionDenied(null)).toBeNull();
        expect(describeAdmissionDenied('')).toBeNull();
    });

    it('a failed run without a reason is a plain failure', () => {
        expect(describeTerminalRun({ status: 'failed', admission_denied_reason: null })).toEqual({ exitCode: 1, message: 'Workflow failed!' });
    });

    it.each(['running', 'pending', 'queued', 'admission_pending', undefined])('%s is not terminal', (status) => {
        expect(describeTerminalRun({ status })).toBeNull();
    });

    it('admission_pending has a label and the pending colour', () => {
        expect(formatRunStatusLabel('admission_pending')).toBe('admission_pending (waiting for a free run slot)');
        expect(formatRunStatusLabel('running')).toBe('running');
        expect(getStatusColor('admission_pending')).toBe(chalk.yellow);
        expect(getStatusColor('cancelled')).toBe(chalk.gray);
        expect(getStatusColor('completed')).toBe(chalk.green);
        expect(getStatusColor('dispatch_failed')).toBe(chalk.red);
    });
});

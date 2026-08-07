import { describe, expect, it } from 'vitest';
import { detailedOutcomeTag, summaryStatusLabel } from '../src/commands/run-list';

describe('summaryStatusLabel', () => {
    it('labels a recovered run as an attention "recovered"', () => {
        expect(summaryStatusLabel({ outcome: 'recovered', execution_status: 'SUCCESS' }))
            .toEqual({ label: 'recovered', attention: true });
    });

    it('labels a degraded run as an attention "degraded"', () => {
        expect(summaryStatusLabel({ outcome: 'degraded', execution_status: 'SUCCESS' }))
            .toEqual({ label: 'degraded', attention: true });
    });

    it('shows the raw execution_status (no attention) for a clean success', () => {
        expect(summaryStatusLabel({ outcome: 'success', execution_status: 'SUCCESS' }))
            .toEqual({ label: 'SUCCESS', attention: false });
    });

    it('shows the raw status (no attention) for a hard failure', () => {
        expect(summaryStatusLabel({ outcome: 'failed', execution_status: 'ERROR' }))
            .toEqual({ label: 'ERROR', attention: false });
    });

    it('falls back to execution_status when outcome is absent (older server)', () => {
        expect(summaryStatusLabel({ execution_status: 'RUNNING' }))
            .toEqual({ label: 'RUNNING', attention: false });
    });

    it('falls back to status, then "?", when execution_status is missing', () => {
        expect(summaryStatusLabel({ status: 'pending' })).toEqual({ label: 'pending', attention: false });
        expect(summaryStatusLabel({})).toEqual({ label: '?', attention: false });
    });
});

describe('detailedOutcomeTag', () => {
    it('tags a recovered run [RECOVERED]', () => {
        expect(detailedOutcomeTag({ outcome: 'recovered' })).toBe(' [RECOVERED]');
    });

    it('tags a degraded run [DEGRADED]', () => {
        expect(detailedOutcomeTag({ outcome: 'degraded' })).toBe(' [DEGRADED]');
    });

    it('returns no tag for a clean success or a hard failure', () => {
        expect(detailedOutcomeTag({ outcome: 'success', execution_status: 'SUCCESS' })).toBe('');
        expect(detailedOutcomeTag({ outcome: 'failed', execution_status: 'ERROR' })).toBe('');
    });

    it('falls back to the local heuristic ([DEGRADED]) for older servers: a success with step errors', () => {
        const run = {
            execution_status: 'SUCCESS',
            steps: [{ name: 'a', error: '{"message":"boom"}' }],
        };
        expect(detailedOutcomeTag(run)).toBe(' [DEGRADED]');
    });

    it('returns no tag for an older-server clean success with no error evidence', () => {
        expect(detailedOutcomeTag({ execution_status: 'SUCCESS', steps: [{ name: 'a', error: null }] })).toBe('');
    });
});

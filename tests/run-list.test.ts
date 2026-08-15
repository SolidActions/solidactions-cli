import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    detailedOutcomeTag,
    displayDetailedList,
    displaySummaryTable,
    formatDetailedRevision,
    formatRevisionCell,
    summaryStatusLabel,
} from '../src/commands/run-list';

afterEach(() => vi.restoreAllMocks());

const revision = {
    commit_sha: 'abcdef1234567890abcdef1234567890abcdef12',
    short_sha: 'abcdef123456',
    dirty: false,
    default_branch: 'main',
    default_branch_sha: '1234567890abcdef1234567890abcdef12345678',
    commits_behind: 0,
};

describe('run revision formatting', () => {
    it('formats clean, dirty, unknown-dirty, behind, and unknown summary cells', () => {
        expect(formatRevisionCell(revision)).toBe('abcdef123456');
        expect(formatRevisionCell({ ...revision, dirty: true })).toBe('abcdef123456*');
        expect(formatRevisionCell({ ...revision, dirty: null })).toBe('abcdef123456?');
        expect(formatRevisionCell({ ...revision, commits_behind: 12 })).toBe('abcdef123456 ↓12');
        expect(formatRevisionCell(null)).toBe('-');
    });

    it('formats a human-readable detailed revision', () => {
        expect(formatDetailedRevision({ ...revision, dirty: true, commits_behind: 2 }))
            .toBe('abcdef123456 (DIRTY, 2 behind origin/main at deploy)');
        expect(formatDetailedRevision({ ...revision, dirty: null, commits_behind: null }))
            .toBe('abcdef123456 (dirty state unknown)');
        expect(formatDetailedRevision(null)).toBe('unknown');
    });

    it('adds a sanitized, dynamically sized REVISION column', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        displaySummaryTable([{ id: 1, workflow_name: 'safe', execution_status: 'SUCCESS', deployed_revision: {
            ...revision,
            short_sha: 'abc\nINJECTED\u202e',
        } }]);
        const output = log.mock.calls.map((call) => String(call[0])).join('\n');
        expect(output).toContain('REVISION');
        expect(output).toContain('abcINJECTED');
        expect(output).not.toContain('\u202e');
    });

    it('renders old-server summary as unknown and omits its detailed line', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const oldRun = { id: 1, workflow_name: 'legacy', execution_status: 'SUCCESS' };
        displaySummaryTable([oldRun]);
        expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(/legacy.*-/s);
        log.mockClear();
        displayDetailedList([oldRun]);
        expect(log.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('Revision (latest session):');
    });

    it('shows the exact detailed label when a new server returns present null', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        displayDetailedList([{ id: 1, workflow_name: 'new', execution_status: 'SUCCESS', deployed_revision: null }]);
        expect(log.mock.calls.map((call) => String(call[0])).join('\n'))
            .toContain('Revision (latest session): unknown');
    });
});

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

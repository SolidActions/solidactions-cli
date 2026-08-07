import { describe, expect, it } from 'vitest';
import { buildSchedulePayload, EXISTING_SCHEDULE_CHOICES, timezoneMismatch, timezoneMismatchRemedy } from '../src/commands/schedule-set';

describe('buildSchedulePayload', () => {
    it('includes timezone only when passed', () => {
        expect(buildSchedulePayload('0 7 * * 1', { timezone: 'America/Chicago' }))
            .toEqual({ cron: '0 7 * * 1', timezone: 'America/Chicago' });
        expect(buildSchedulePayload('0 7 * * 1', {})).toEqual({ cron: '0 7 * * 1' });
    });

    it('sends an explicit disabled target only for --paused', () => {
        expect(buildSchedulePayload('0 7 * * 1', { paused: true })).toEqual({ cron: '0 7 * * 1', enabled: false });
        expect(buildSchedulePayload('0 7 * * 1', { paused: false })).toEqual({ cron: '0 7 * * 1' });
        expect(buildSchedulePayload('0 7 * * 1', {})).toEqual({ cron: '0 7 * * 1' });
    });

    it('keeps workflow and input alongside timezone', () => {
        expect(buildSchedulePayload('0 7 * * 1', { workflow: 'report', timezone: 'UTC' }, { mode: 'weekly' }))
            .toEqual({ cron: '0 7 * * 1', workflow: 'report', input: { mode: 'weekly' }, timezone: 'UTC' });
    });
});

describe('timezoneMismatch (post-POST backstop for pre-timezone servers)', () => {
    it('no flag → never a mismatch, whatever the server returns', () => {
        expect(timezoneMismatch(undefined, 'UTC')).toBe(false);
        expect(timezoneMismatch(undefined, undefined)).toBe(false);
    });

    it('flag echoed back → no mismatch', () => {
        expect(timezoneMismatch('America/Chicago', 'America/Chicago')).toBe(false);
    });

    it('flag dropped by an old server (UTC or missing) → mismatch', () => {
        expect(timezoneMismatch('America/Chicago', 'UTC')).toBe(true);
        expect(timezoneMismatch('America/Chicago', undefined)).toBe(true);
    });
});

describe('timezoneMismatchRemedy — schedule delete takes a numeric ID, not a workflow name', () => {
    it('points at `schedule list` to find the ID, then `schedule delete <project> <schedule-id>`', () => {
        const remedy = timezoneMismatchRemedy('my-project');
        expect(remedy).toContain('solidactions schedule list my-project');
        expect(remedy).toContain('solidactions schedule delete my-project <schedule-id>');
    });
});

describe('one schedule per workflow', () => {
    it('offers replacement or cancellation, never an unsupported second schedule', () => {
        expect(EXISTING_SCHEDULE_CHOICES).toEqual([
            { title: 'Replace existing schedule', value: 'replace' },
            { title: 'Cancel', value: 'cancel' },
        ]);
    });
});

import { describe, expect, it } from 'vitest';
import { buildSchedulePayload, timezoneMismatch } from '../src/commands/schedule-set';

describe('buildSchedulePayload', () => {
    it('includes timezone only when passed', () => {
        expect(buildSchedulePayload('0 7 * * 1', { timezone: 'America/Chicago' }))
            .toEqual({ cron: '0 7 * * 1', timezone: 'America/Chicago' });
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

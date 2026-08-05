import { describe, expect, it } from 'vitest';
import { formatScheduleState } from '../src/commands/schedule-list';

describe('schedule list enabled-state detail', () => {
    it('marks an operator override and shows effective/YAML values when they disagree', () => {
        expect(formatScheduleState({ enabled: false, enabled_override: true, yaml_enabled: true }))
            .toBe('no (override; last declared YAML: yes)');
        expect(formatScheduleState({ enabled: true, enabled_override: true, yaml_enabled: false }))
            .toBe('yes (override; last declared YAML: no)');
    });

    it('marks a matching override without redundant YAML state', () => {
        expect(formatScheduleState({ enabled: false, enabled_override: true, yaml_enabled: false }))
            .toBe('no (override)');
    });

    it('keeps declarative and ad-hoc state compact', () => {
        expect(formatScheduleState({ enabled: true, enabled_override: false, yaml_enabled: true })).toBe('yes');
        expect(formatScheduleState({ enabled: false, enabled_override: false, yaml_enabled: null })).toBe('no');
    });
});

/**
 * F-C5 — client-side validation and readable error surfaces:
 *  - env var names must match [A-Za-z_][A-Za-z0-9_]* (no leading digit,
 *    no spaces/dashes/empty).
 *  - the reserved SOLIDACTIONS_ prefix check is now case-insensitive.
 *  - 422 validation responses render as plain readable text, never a raw
 *    JSON dump.
 *
 * Pure-function unit tests — no I/O, no mock/spy/stub libraries.
 */
import { describe, expect, it } from 'vitest';
import { isValidEnvName, isReservedEnvName, envNameError } from '../src/utils/env';
import { formatValidationError } from '../src/utils/api';

describe('isValidEnvName', () => {
    it('accepts a normal upper-snake-case name', () => {
        expect(isValidEnvName('GOOD_NAME')).toBe(true);
    });

    it('rejects a name starting with a digit', () => {
        expect(isValidEnvName('1LEADING')).toBe(false);
    });

    it('rejects a name containing a space', () => {
        expect(isValidEnvName('HAS SPACE')).toBe(false);
    });

    it('rejects a name containing a dash', () => {
        expect(isValidEnvName('HAS-DASH')).toBe(false);
    });

    it('rejects an empty name', () => {
        expect(isValidEnvName('')).toBe(false);
    });
});

describe('isReservedEnvName (case-insensitive)', () => {
    it('rejects a lowercase solidactions_ prefix, not just the uppercase form', () => {
        expect(isReservedEnvName('solidactions_lower')).toBe(true);
    });

    it('rejects a mixed-case SoLiDaCtIoNs_ prefix', () => {
        expect(isReservedEnvName('SoLiDaCtIoNs_mixed')).toBe(true);
    });

    it('still accepts an ordinary name', () => {
        expect(isReservedEnvName('MY_API_KEY')).toBe(false);
    });
});

describe('envNameError', () => {
    it('explains the required pattern for an invalid name', () => {
        const msg = envNameError('HAS-DASH');
        expect(msg).toContain('HAS-DASH');
        expect(msg).toContain('[A-Za-z_][A-Za-z0-9_]*');
    });

    it('has a distinct message for an empty name', () => {
        expect(envNameError('')).toBe('Variable key is required.');
    });
});

describe('formatValidationError', () => {
    it('flattens a Laravel-style errors object into readable text, stripping the variables.N. index prefix', () => {
        const result = formatValidationError({
            message: 'The variables.0.key field is required.',
            errors: { 'variables.0.key': ['The variables.0.key field is required.'] },
        });
        expect(result).toBe('The variable key is required.');
    });

    it('falls back to data.message when there is no errors object', () => {
        const result = formatValidationError({ message: 'Something went wrong.' });
        expect(result).toBe('Something went wrong.');
    });

    it('never returns a raw JSON dump', () => {
        const result = formatValidationError({
            message: 'Bad input.',
            errors: { 'variables.0.value': ['The variables.0.value field is required.'] },
        });
        expect(result).not.toMatch(/^\{/);
        expect(result).not.toContain('"errors"');
    });
});

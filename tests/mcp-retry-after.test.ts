import { describe, it, expect } from 'vitest';
import { retryAfterSeconds } from '../src/utils/mcp';

describe('retryAfterSeconds', () => {
    it('uses an integer as seconds', () => {
        expect(retryAfterSeconds('7')).toBe(7);
        expect(retryAfterSeconds(' 12 ')).toBe(12);
        expect(retryAfterSeconds(['3'])).toBe(3);
    });

    it('keeps a literal 0 at 0', () => {
        expect(retryAfterSeconds('0')).toBe(0);
    });

    it('caps at 60 seconds', () => {
        expect(retryAfterSeconds('3600')).toBe(60);
        expect(retryAfterSeconds(new Date(Date.now() + 10 * 60_000).toUTCString())).toBe(60);
    });

    it('waits about the remaining time for a future HTTP-date', () => {
        const sec = retryAfterSeconds(new Date(Date.now() + 20_000).toUTCString());
        expect(sec).toBeGreaterThanOrEqual(18);
        expect(sec).toBeLessThanOrEqual(21);
    });

    it('waits at least 1s for a past HTTP-date', () => {
        expect(retryAfterSeconds(new Date(Date.now() - 60_000).toUTCString())).toBe(1);
    });

    it('waits at least 1s for signed or fractional numbers', () => {
        expect(retryAfterSeconds('-5')).toBe(1);
        expect(retryAfterSeconds('+5')).toBeGreaterThanOrEqual(1);
        expect(retryAfterSeconds('5.5')).toBeGreaterThanOrEqual(1);
        expect(retryAfterSeconds('0.2')).toBe(1);
    });

    it('falls back to 5s for missing or garbage values', () => {
        expect(retryAfterSeconds(undefined)).toBe(5);
        expect(retryAfterSeconds('')).toBe(5);
        expect(retryAfterSeconds('soon')).toBe(5);
    });
});

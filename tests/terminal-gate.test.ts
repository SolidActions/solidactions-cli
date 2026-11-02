import { describe, expect, it } from 'vitest';
import { createTerminalGate } from '../src/utils/terminal-gate';

describe('terminal gate', () => {
    it('allows exactly one claim', () => {
        const gate = createTerminalGate();

        expect(gate.claim()).toBe(true);
        expect(gate.claim()).toBe(false);
        expect(gate.claim()).toBe(false);
    });

    it('allows only one interleaved async caller to claim', async () => {
        const gate = createTerminalGate();
        let release!: () => void;
        const ready = new Promise<void>((resolve) => { release = resolve; });
        const caller = async () => {
            await ready;
            return gate.claim();
        };
        const claims = [caller(), caller(), caller()];

        release();

        expect(await Promise.all(claims)).toEqual([true, false, false]);
    });
});

import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';

interface ReplicaCacheProbeModule {
    runReplicaCacheProbe: unknown;
    assertWarmCheaper: (coldBytes: number, warmBytes: number) => void;
    describeCompanions: (names: string[]) => string[];
    digestRows: (rows: Array<[number | string, string]>) => string;
    classifyOutcome: (error: unknown, matched: boolean) => string;
}

async function loadProbe(): Promise<ReplicaCacheProbeModule> {
    const moduleUrl = pathToFileURL(path.resolve(__dirname, '../scripts/probe-database-replica-cache.mjs')).href;
    const module = await import(moduleUrl) as unknown as ReplicaCacheProbeModule;

    expect(module.runReplicaCacheProbe).toBeTypeOf('function');
    return module;
}

describe('database replica cache probe', () => {
    it('accepts a warm sync under a quarter of the cold sync bytes', async () => {
        const { assertWarmCheaper } = await loadProbe();

        expect(() => assertWarmCheaper(1_000_000, 200_000)).not.toThrow();
    });

    it('rejects a warm sync at or over a quarter of the cold sync bytes and names the warm sync', async () => {
        const { assertWarmCheaper } = await loadProbe();

        expect(() => assertWarmCheaper(1_000_000, 300_000)).toThrow(/warm sync/);
        expect(() => assertWarmCheaper(1_000_000, 250_000)).toThrow(/warm sync/);
    });

    it('rejects a probe that measured no bytes at all', async () => {
        const { assertWarmCheaper } = await loadProbe();

        expect(() => assertWarmCheaper(0, 0)).toThrow(/warm sync/);
    });

    it('lists the sorted replica companion names and leaves out the database file and unrelated files', async () => {
        const { describeCompanions } = await loadProbe();

        expect(describeCompanions(['replica.db', 'replica.db-wal', 'replica.db-info', 'other']))
            .toEqual(['replica.db-info', 'replica.db-wal']);
    });

    it('digests row pairs to a 64-character hex string that is stable for equal input', async () => {
        const { digestRows } = await loadProbe();

        const first = digestRows([[1, 'a'], [2, 'b']]);
        const again = digestRows([[1, 'a'], [2, 'b']]);

        expect(first).toMatch(/^[0-9a-f]{64}$/);
        expect(again).toBe(first);
    });

    it('digests differently when a value changes or the order changes', async () => {
        const { digestRows } = await loadProbe();

        const base = digestRows([[1, 'a'], [2, 'b']]);

        expect(digestRows([[1, 'a'], [2, 'c']])).not.toBe(base);
        expect(digestRows([[2, 'b'], [1, 'a']])).not.toBe(base);
    });

    it('classifies a long error message as throws with at most 80 message characters', async () => {
        const { classifyOutcome } = await loadProbe();

        const outcome = classifyOutcome(new Error('x'.repeat(200)), false);

        expect(outcome.startsWith('throws: ')).toBe(true);
        expect(outcome.length).toBeLessThanOrEqual(88);
    });

    it('classifies a sync that did not throw by whether the content matched the server', async () => {
        const { classifyOutcome } = await loadProbe();

        expect(classifyOutcome(undefined, true)).toBe('succeeds-correct');
        expect(classifyOutcome(undefined, false)).toBe('succeeds-WRONG');
    });
});

/**
 * Fixture workflow for T6.1 tests.
 *
 * Doubles the numeric `n` field in the input. The test invokes with { n: 2 }
 * and expects output === 4.
 */
import { defineWorkflow } from '@solidactions/sdk';

export default defineWorkflow({
    name: 'echo',
    run: async (ctx) => {
        const input = ctx.input as { n?: number };
        return (input.n ?? 0) * 2;
    },
});

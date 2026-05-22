/**
 * Fixture workflow for the no-`--env` (bare local) dev test.
 *
 * Returns the SORTED list of keys present on `ctx.vars` so the test can assert
 * exactly which vars the workflow can read. In the bare path `ctx.vars` must be
 * empty `{}` — NO host `process.env` keys (HOME, PATH, …) may leak in.
 */
import { defineWorkflow } from '@solidactions/sdk';

export default defineWorkflow({
    name: 'echo-vars',
    run: async (ctx) => {
        return Object.keys(ctx.vars).sort();
    },
});

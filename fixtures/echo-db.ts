/**
 * Fixture workflow for the mapped-workspace-database dev test (#140).
 *
 * Parses the `APP_DB` var exactly the way a real Drizzle workflow does — the
 * value is a JSON envelope, identical in shape whether the platform's
 * RuntimeEnvBuilder injected it into a deployed sandbox or `dev --env` resolved
 * it locally — and returns it so the test can assert on the parsed shape rather
 * than on a raw string.
 */
import { defineWorkflow } from '@solidactions/sdk';

export default defineWorkflow({
    name: 'echo-db',
    run: async (ctx) => {
        const raw = ctx.vars.APP_DB;
        if (typeof raw !== 'string') return { present: false };
        return { present: true, ...JSON.parse(raw) };
    },
});

/**
 * Fixture workflow for the mapped-workspace-database dev test (#140).
 *
 * Reads `ctx.vars.APP_DB` exactly the way the SDK reference tells a workflow
 * author to — as a `DatabaseVar` object with a camelCased `readOnly` — so the
 * test proves local dev hands the workflow the SAME shape a deployed sandbox
 * does, rather than a raw JSON string it would have to parse itself.
 */
import { defineWorkflow } from '@solidactions/sdk';

export default defineWorkflow({
    name: 'echo-db',
    run: async (ctx) => {
        const db = ctx.vars.APP_DB as { name: string; url: string; token: string; readOnly: boolean } | undefined;
        if (!db || typeof db !== 'object') return { present: false, type: typeof db };
        return { present: true, name: db.name, url: db.url, token: db.token, readOnly: db.readOnly };
    },
});

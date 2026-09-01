/**
 * Fixture for the dev-path disk-safety test (#140 review R5).
 *
 * Deliberately returns NO credential bytes — only facts ABOUT the DatabaseVar.
 * The dev shim writes the workflow's return value to a temp result file, so a
 * fixture that echoed the token would put it on disk legitimately (an inherent,
 * disclosed property of returning a secret from your own workflow) and would
 * mask the thing the test is actually policing: that the CLI itself never
 * spills the credential to disk.
 */
import { defineWorkflow } from '@solidactions/sdk';

export default defineWorkflow({
    name: 'db-facts',
    run: async (ctx) => {
        const db = ctx.vars.APP_DB as { name: string; url: string; token: string; readOnly: boolean } | undefined;
        return {
            isObject: typeof db === 'object' && db !== null,
            name: db?.name ?? null,
            readOnly: db?.readOnly ?? null,
            tokenIsString: typeof db?.token === 'string',
            tokenLength: db?.token?.length ?? 0,
        };
    },
});

import { describe, expect, it } from 'vitest';
import path from 'path';
import { pathToFileURL } from 'url';

async function loadSupportModule(): Promise<Record<string, unknown>> {
    const moduleUrl = pathToFileURL(path.resolve(__dirname, '../src/utils/database-client-support.ts')).href;
    return import(moduleUrl);
}

describe('native database client support gate', () => {
    it('loads native support before requesting a short-lived credential', async () => {
        const support = await loadSupportModule();
        const loadDatabaseClientBeforeMint = support.loadDatabaseClientBeforeMint;

        expect(loadDatabaseClientBeforeMint).toBeTypeOf('function');
        if (typeof loadDatabaseClientBeforeMint !== 'function') return;

        const events: string[] = [];
        const createClient = () => ({ close: () => undefined });
        const result = await (loadDatabaseClientBeforeMint as Function)(
            async () => {
                events.push('mint');
                return { url: 'libsql://database.example', token: 'ephemeral-token' };
            },
            {
                loadClient: async () => {
                    events.push('load');
                    return { createClient };
                },
            },
        );

        expect(events).toEqual(['load', 'mint']);
        expect(result.createClient).toBe(createClient);
        expect(result.access).toEqual({ url: 'libsql://database.example', token: 'ephemeral-token' });
    });

    it('maps a native load failure to a stable product error without minting', async () => {
        const support = await loadSupportModule();
        const loadDatabaseClientBeforeMint = support.loadDatabaseClientBeforeMint;

        expect(loadDatabaseClientBeforeMint).toBeTypeOf('function');
        if (typeof loadDatabaseClientBeforeMint !== 'function') return;

        let mintCount = 0;
        let caught: any;
        try {
            await (loadDatabaseClientBeforeMint as Function)(
                async () => {
                    mintCount++;
                    return { token: 'must-not-be-minted' };
                },
                {
                    loadClient: async () => {
                        throw new Error('NATIVE_BINDING_SENTINEL libsql vendor detail');
                    },
                },
            );
        } catch (error) {
            caught = error;
        }

        expect(mintCount).toBe(0);
        expect(caught).toMatchObject({ code: 'database_client_unsupported' });
        expect(String(caught?.message).trim().length).toBeGreaterThan(0);
        expect(String(caught?.message)).not.toMatch(/NATIVE_BINDING_SENTINEL|libsql|turso/i);
    });
});

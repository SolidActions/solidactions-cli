import { describe, it, expect } from 'vitest';
import { liveConfig, LIVE } from './live-env';
import { callCrewsTool } from '../../src/utils/mcp';
import { createCleanup } from './cleanup';

describe.skipIf(!LIVE)('mcp transport (live)', () => {
    const config = liveConfig()!;

    it('surfaces a JSON-RPC error for an unknown tool instead of ok:{}', async () => {
        await expect(callCrewsTool(config, 'crews_no_such_tool', { action: 'list' }))
            .rejects.toThrow(/crews_no_such_tool|not found|unknown/i);
    });

    it('round-trips a ~200KB multibyte body byte-identical', async () => {
        const name = `cli-live-utf8-${Date.now()}`;
        const body = ('— ✓ 漢字 🚀 ').repeat(12000);
        const cleanup = createCleanup(config);
        cleanup.sharedSkill(name);
        try {
            const created = await callCrewsTool(config, 'skills', {
                action: 'create', name, description: 'utf8 live test', body,
            });
            expect(created.ok, JSON.stringify(created.data)).toBe(true);
            const read = await callCrewsTool(config, 'skills', { action: 'read', identifier: name });
            expect(read.ok, JSON.stringify(read.data)).toBe(true);
            expect(read.data.body).toBe(body);
        } finally {
            await cleanup.run();
        }
    });
});

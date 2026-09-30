import { describe, it, expect } from 'vitest';
import { liveConfig, LIVE } from './live-env';
import { callCrewsTool } from '../../src/utils/mcp';

// The dev server throttles /mcp to 60 calls/min per token and answers 429 + Retry-After
// beyond that. The transport must ride that out (wait, retry) instead of failing.
describe.skipIf(!LIVE)('mcp rate limit (live)', () => {
    const config = liveConfig()!;

    // 75 calls exceeds the 60/min budget; allow for up to ~2 Retry-After waits (<=60s each) plus call time.
    it('rides out the 60/min throttle: 75 rapid calls all resolve ok', async () => {
        const total = 75;
        let okCount = 0;
        for (let i = 0; i < total; i++) {
            const r = await callCrewsTool(config, 'roles', { action: 'list' });
            expect(r.ok, `call ${i + 1}: ${JSON.stringify(r.data)}`).toBe(true);
            okCount++;
        }
        expect(okCount).toBe(total);
    }, 240_000);
});

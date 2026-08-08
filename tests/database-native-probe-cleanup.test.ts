import { describe, expect, it, vi } from 'vitest';

import { removeNativeProbeDirectory } from '../scripts/remove-native-probe-directory.mjs';

describe('native database probe cleanup', () => {
    it('asks Node fs.rm for bounded retries of transient Windows cleanup errors', async () => {
        const remove = vi.fn().mockResolvedValue(undefined);

        await removeNativeProbeDirectory('C:\\Temp\\solidactions-database-probe', remove);

        expect(remove).toHaveBeenCalledOnce();
        expect(remove).toHaveBeenCalledWith('C:\\Temp\\solidactions-database-probe', {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
        });
    });

    it('surfaces the cleanup failure when Node exhausts its retries', async () => {
        const exhausted = Object.assign(new Error('resource busy'), { code: 'EBUSY' });
        const remove = vi.fn().mockRejectedValue(exhausted);

        await expect(removeNativeProbeDirectory('C:\\Temp\\probe.db', remove)).rejects.toBe(exhausted);
    });
});

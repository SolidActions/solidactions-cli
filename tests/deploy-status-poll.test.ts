import { describe, expect, it } from 'vitest';
import { startDeployStatusPoll } from '../src/utils/deploy-status-poll';

type Status = { status: string; build_log?: string };

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => { resolve = yes; });
    return { promise, resolve };
}

function setup(read: () => Promise<Status>, maxAttempts = 600) {
    let tick!: () => Promise<void>;
    let finalizations = 0;
    const finish = deferred<void>();
    const outcomes: string[] = [];
    startDeployStatusPoll({
        read,
        schedule: (callback) => { tick = callback; return () => {}; },
        maxAttempts,
        onLog: () => {},
        onWaiting: () => {},
        onDeployed: async () => { outcomes.push('deployed'); },
        onFailed: () => { outcomes.push('failed'); },
        onTimeout: () => { outcomes.push('timeout'); },
        finalize: async () => { finalizations++; await finish.promise; },
    });
    return { tick: () => tick(), finish, outcomes, count: () => finalizations };
}

describe('deploy status polling', () => {
    it('does not start another read while a slow read is pending', async () => {
        const response = deferred<Status>();
        let reads = 0;
        const poll = setup(() => { reads++; return response.promise; });
        const first = poll.tick();
        expect(reads).toBe(1);
        const second = poll.tick();
        expect(reads).toBe(1);
        response.resolve({ status: 'building' });
        await Promise.all([first, second]);
    });

    for (const status of ['deployed', 'error']) {
        it(`finalizes only once for overlapping ${status} observations`, async () => {
            const response = deferred<Status>();
            let reads = 0;
            const poll = setup(() => { reads++; return response.promise; });
            const marks = ['start'];
            const first = poll.tick().then(() => { marks.push('end'); });
            const second = poll.tick();
            response.resolve({ status });
            await Promise.resolve();
            await Promise.resolve();
            expect(poll.count()).toBe(1);
            expect(reads).toBe(1);
            marks.push('release');
            poll.finish.resolve();
            await Promise.all([first, second]);
            expect(marks).toEqual(['start', 'release', 'end']);
            expect(poll.count()).toBe(1);
            expect(poll.outcomes).toEqual([status === 'error' ? 'failed' : 'deployed']);
        });
    }

    it('does not finalize a late deployed reply after an inactivity timeout', async () => {
        const late = deferred<Status>();
        let reads = 0;
        const poll = setup(() => { reads++; return reads === 1 ? Promise.resolve({ status: 'building' }) : late.promise; }, 1);
        const marks = ['start'];
        const timeout = poll.tick().then(() => { marks.push('end'); });
        await Promise.resolve();
        expect(poll.outcomes).toEqual(['timeout']);
        const second = poll.tick();
        late.resolve({ status: 'deployed' });
        await Promise.resolve();
        expect(poll.count()).toBe(1);
        marks.push('release');
        poll.finish.resolve();
        await Promise.all([timeout, second]);
        expect(marks).toEqual(['start', 'release', 'end']);
        expect(poll.count()).toBe(1);
        expect(poll.outcomes).toEqual(['timeout']);
    });

    it('reopens admission after a transient read error', async () => {
        let reads = 0;
        const poll = setup(async () => {
            reads++;
            if (reads === 1) throw new Error('temporary');
            return { status: 'building' };
        });
        await poll.tick();
        expect(poll.count()).toBe(0);
        await poll.tick();
        expect(reads).toBe(2);
        expect(poll.count()).toBe(0);
    });
});

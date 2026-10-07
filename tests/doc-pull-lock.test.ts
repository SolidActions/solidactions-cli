/**
 * The destination lock and the stale snapshot (cli#168, PM ruling 12; spec §1.3 step 1, §1.4).
 *
 * A pull takes `<destination>/.solidactions-docs.json.lock` (one O_EXCL file holding its pid) before it reads the
 * destination's manifest, and removes it on every way out it can reach in-process. A pull whose destination does not
 * exist yet takes the lock after creating it and checks that no manifest appeared meanwhile. Every row runs the built
 * CLI against a real in-process HTTP server (shared harness), so real processes overlap; a gate on the server's `list`
 * answer holds a pull open while the next one starts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { CliResult } from './doc-pull-inv-harness';
import { LOCK_FILE, MANIFEST_FILE, doc, expectResult, failed, internalEntries, lockLine, manifestOf, pulledOk, read, relOf, singleDocWarning, snapshot, useDocPullHarness } from './doc-pull-inv-harness';

/** Wait until `condition` holds (a started pull has taken its lock, or reached the server). */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt++) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
}

const staleLine = (out: string): string => `error: another doc pull wrote to ${out} while this one was running — nothing was changed. Pull again.\n`;

describe('overlapping doc pulls', { timeout: 60_000 }, () => {
    const h = useDocPullHarness();

    it('a second pull that starts while the first is still fetching refuses naming the lock, and only the first writes', async () => {
        const a = doc('md', 1, 'a', 1);
        h.serve([a]);
        fs.mkdirSync(h.out);
        const gate = h.gateLists();

        const first = h.start('folder', 'docs');
        await waitFor(() => gate.waiting() === 1, 'the first pull to reach the server');
        const lockWhileHeld = read(h.out, LOCK_FILE);
        const second = await h.start('folder', 'docs').result;
        const afterSecond = fs.readdirSync(h.out);
        gate.release();
        const firstResult = await first.result;

        expect(lockWhileHeld).toBe(`${first.pid}\n`);
        expectResult(second, failed(lockLine(h.out)));
        expect(afterSecond).toEqual([LOCK_FILE]);
        expectResult(firstResult, pulledOk(h.out, [relOf(a)]));
        expect(read(h.out, 'a.md')).toBe(a.bytes);
        expect(manifestOf(h.out).docs).toHaveProperty('a.md');
        expect(internalEntries(h.out)).toEqual([]);
    });

    it('two pulls started together: exactly one takes the lock and writes, the other refuses with the lock line', async () => {
        const a = doc('md', 1, 'a', 1);
        h.serve([a]);
        fs.mkdirSync(h.out);
        const gate = h.gateLists();

        const runs = [h.start('folder', 'docs'), h.start('folder', 'docs')];
        const settled: CliResult[] = [];
        runs.forEach((run) => void run.result.then((result) => settled.push(result)));
        await waitFor(() => settled.length >= 1, 'one pull to refuse');
        gate.release();
        const results = await Promise.all(runs.map((run) => run.result));

        const refused = results.filter((result) => result.code !== 0);
        expect(refused).toHaveLength(1);
        expectResult(refused[0], failed(lockLine(h.out)));
        expectResult(results.find((result) => result.code === 0)!, pulledOk(h.out, [relOf(a)]));
        expect(read(h.out, 'a.md')).toBe(a.bytes);
        expect(internalEntries(h.out)).toEqual([]);
    });

    it('two disjoint single-doc pulls into one destination never lose a tracked doc: the overlapping one refuses, and its retry adds to the manifest', async () => {
        const a = doc('md', 1, 'a', 1);
        const b = doc('md', 2, 'b', 1);
        h.serve([a, b]);
        fs.mkdirSync(h.out);
        const gate = h.gateLists();

        const first = h.start('single', 'a');
        await waitFor(() => gate.waiting() === 1, 'the first pull to reach the server');
        const second = await h.start('single', 'b').result;
        gate.release();
        const firstResult = await first.result;

        expectResult(second, failed(lockLine(h.out)));
        expectResult(firstResult, pulledOk(h.out, ['a.md']));
        expect(fs.existsSync(path.join(h.out, 'b.md'))).toBe(false);
        await h.pull('single', 'b', pulledOk(h.out, ['b.md'], singleDocWarning));
        expect(Object.keys(manifestOf(h.out).docs).sort()).toEqual(['a.md', 'b.md']);
        expect(internalEntries(h.out)).toEqual([]);
    });
});

describe('a stale snapshot is refused, never written over (R-C2)', { timeout: 60_000 }, () => {
    const h = useDocPullHarness();

    it('a pull that planned a destination as new, while another pull created it and wrote its manifest, refuses and changes nothing', async () => {
        const a = doc('md', 1, 'a', 1);
        h.serve([a]);
        const gate = h.gateLists(1);

        const first = h.start('folder', 'docs');
        await waitFor(() => gate.waiting() === 1, 'the first pull to reach the server');
        expect(fs.existsSync(h.out)).toBe(false);
        await h.pull('folder', 'docs', pulledOk(h.out, [relOf(a)]));
        const afterSecond = snapshot(h.out);
        gate.release();
        const firstResult = await first.result;

        expectResult(firstResult, failed(staleLine(h.out)));
        expect(snapshot(h.out)).toEqual(afterSecond);
        expect(internalEntries(h.out)).toEqual([]);
    });

    it('a pull that planned a destination as new while another pull holds its lock refuses with the lock line, and leaves the lock', async () => {
        h.serve([doc('md', 1, 'a', 1)]);
        const gate = h.gateLists(1);

        const first = h.start('folder', 'docs');
        await waitFor(() => gate.waiting() === 1, 'the first pull to reach the server');
        fs.mkdirSync(h.out);
        fs.writeFileSync(path.join(h.out, LOCK_FILE), '4194303\n');
        gate.release();
        const firstResult = await first.result;

        expectResult(firstResult, failed(lockLine(h.out)));
        expect(fs.readdirSync(h.out)).toEqual([LOCK_FILE]);
        expect(read(h.out, LOCK_FILE)).toBe('4194303\n');
    });
});

describe('the lock is removed on every way out the pull can reach', { timeout: 60_000 }, () => {
    const h = useDocPullHarness();

    it('a refusal for another reason (a non-empty destination, no terminal) leaves no lock behind', async () => {
        fs.mkdirSync(h.out);
        fs.writeFileSync(path.join(h.out, 'x.txt'), 'local file');
        h.serve([doc('md', 1, 'a', 1)]);

        await h.pull('folder', 'docs', failed(/^error: .* is not empty and there is no terminal to confirm the pull; pass -y to pull into it\.\n$/), []);

        expect(fs.readdirSync(h.out)).toEqual(['x.txt']);
    });

    it('a write error leaves no lock behind', async () => {
        h.serve([doc('md', 1, 'a', 1)]);

        await h.pull('folder', 'docs', failed(/^error: cannot write a\.md: EIO: i\/o error, rename \(test hook\) — 0 of 1 files were updated and are tracked; pull again\.\n$/), ['-y'], 'fail-rename:1');

        expect(internalEntries(h.out)).toEqual([]);
    });

    it.each([
        ['SIGINT', 130],
        ['SIGTERM', 143],
    ] as const)('%s while the pull is fetching ends it with status %i and removes the lock', async (signal, code) => {
        h.serve([doc('md', 1, 'a', 1)]);
        fs.mkdirSync(h.out);
        const gate = h.gateLists();

        const run = h.start('folder', 'docs');
        await waitFor(() => gate.waiting() === 1, 'the pull to reach the server');
        expect(internalEntries(h.out)).toEqual([LOCK_FILE]);
        process.kill(run.pid, signal);
        const result = await run.result;
        gate.release();

        expectResult(result, { code, stdout: '', stderr: '' });
        expect(fs.readdirSync(h.out)).toEqual([]);
    });
});

describe('the lock file itself', { timeout: 60_000 }, () => {
    const h = useDocPullHarness();

    it('a lock left by a killed pull is never removed by a later pull, whatever pid it names', async () => {
        h.serve([doc('md', 1, 'a', 1)]);
        fs.mkdirSync(h.out);
        fs.writeFileSync(path.join(h.out, LOCK_FILE), '4194303\n');
        const before = snapshot(h.out);

        await h.pull('folder', 'docs', failed(lockLine(h.out)));

        expect(snapshot(h.out)).toEqual(before);
    });

    it('a symbolic link at the lock name is refused and never followed', async () => {
        h.serve([doc('md', 1, 'a', 1)]);
        fs.mkdirSync(h.out);
        fs.symlinkSync(h.outside, path.join(h.out, LOCK_FILE));
        const before = snapshot(h.out);

        await h.pull('folder', 'docs', failed(lockLine(h.out)));

        expect(snapshot(h.out)).toEqual(before);
        expect(fs.readdirSync(h.outside)).toEqual([]);
    });

    it('a doc titled like the lock or the manifest is written under another name, and the lock line never names a doc', async () => {
        const served = { ...doc('media', 5, `${MANIFEST_FILE}.lock`, 1) };
        h.serve([served]);

        await h.pull('folder', 'docs', pulledOk(h.out, [`_${MANIFEST_FILE}.lock`]));

        expect(read(h.out, `_${MANIFEST_FILE}.lock`)).toBe(served.bytes);
        expect(internalEntries(h.out)).toEqual([]);
    });
});

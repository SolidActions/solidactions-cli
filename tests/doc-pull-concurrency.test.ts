/**
 * Overlapping `doc pull`s and leftover staging folders (cli#168, final review 1 finding C3; spec §1.3 step 1, §1.4).
 *
 * A pull claims its staging folder `<destination>/.solidactions-pull-<pid>/` before it looks at anything else, then
 * classifies every other `.solidactions-pull-*` entry before changing any of them. Every row runs the built CLI
 * against a real in-process HTTP server (shared harness), so two real processes overlap; a gate on the server's
 * `list` answer holds the first pull open while the second one starts.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { CliResult } from './doc-pull-inv-harness';
import { MANIFEST_FILE, deadPid, doc, expectResult, failed, manifestOf, pulledOk, read, relOf, singleDocWarning, snapshot, stagingEntries, useDocPullHarness } from './doc-pull-inv-harness';

const OVERLAP_LINE = (pid: number, out: string, name: string): RegExp =>
    new RegExp(`^error: another doc pull \\(pid ${pid}\\) may be writing to ${out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(folder ${name}\\); wait for it to finish, or delete that folder if no doc pull is running\\.\n$`);

/** Wait until `condition` holds (a started pull has claimed its folder, or reached the server). */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt++) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
}

describe('overlapping doc pulls', { timeout: 60_000 }, () => {
    const h = useDocPullHarness();

    it('a second pull that starts while the first is still fetching refuses, and only the first publishes', async () => {
        const a = doc('md', 1, 'a', 1);
        h.serve([a]);
        fs.mkdirSync(h.out);
        const gate = h.gateLists();

        const first = h.start('folder', 'docs');
        await waitFor(() => gate.waiting() === 1, 'the first pull to reach the server');
        const second = await h.start('folder', 'docs').result;
        const afterSecond = stagingEntries(h.out);
        gate.release();
        const firstResult = await first.result;

        expectResult(second, failed(OVERLAP_LINE(first.pid, h.out, `\\.solidactions-pull-${first.pid}`)));
        expect(afterSecond).toEqual([`.solidactions-pull-${first.pid}`]);
        expectResult(firstResult, pulledOk(h.out, [relOf(a)]));
        expect(read(h.out, 'a.md')).toBe(a.bytes);
        expect(manifestOf(h.out).docs).toHaveProperty('a.md');
        expect(stagingEntries(h.out)).toEqual([]);
    });

    it('two pulls started together never both publish: at least one sees the other\'s claim and refuses', async () => {
        const a = doc('md', 1, 'a', 1);
        h.serve([a]);
        fs.mkdirSync(h.out);
        const gate = h.gateLists();

        const runs = [h.start('folder', 'docs'), h.start('folder', 'docs')];
        const settled: CliResult[] = [];
        runs.forEach((run) => void run.result.then((result) => settled.push(result)));
        await waitFor(() => settled.length >= 1 || gate.waiting() === 2, 'one pull to refuse, or both to reach the server');
        const refusedEarly = settled.length;
        gate.release();
        const results = await Promise.all(runs.map((run) => run.result));

        expect(refusedEarly).toBeGreaterThanOrEqual(1);
        expect(results.filter((result) => result.code === 0).length).toBeLessThanOrEqual(1);
        for (const result of results.filter((candidate) => candidate.code !== 0)) {
            expect(result.stdout).toBe('');
            expect(result.stderr).toMatch(/^error: another doc pull \(pid \d+\) may be writing to .* \(folder \.solidactions-pull-\d+\); wait for it to finish, or delete that folder if no doc pull is running\.\n$/);
        }
        expect(stagingEntries(h.out)).toEqual([]);
        const published = results.filter((result) => result.code === 0).length;
        expect(fs.existsSync(path.join(h.out, MANIFEST_FILE))).toBe(published === 1);
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

        expectResult(second, failed(OVERLAP_LINE(first.pid, h.out, `\\.solidactions-pull-${first.pid}`)));
        expectResult(firstResult, pulledOk(h.out, ['a.md']));
        expect(fs.existsSync(path.join(h.out, 'b.md'))).toBe(false);
        await h.pull('single', 'b', pulledOk(h.out, ['b.md'], singleDocWarning));
        expect(Object.keys(manifestOf(h.out).docs).sort()).toEqual(['a.md', 'b.md']);
        expect(stagingEntries(h.out)).toEqual([]);
    });

    it('the claim is removed on every way out: a refusal for another reason leaves no staging folder behind', async () => {
        fs.mkdirSync(h.out);
        fs.writeFileSync(path.join(h.out, 'x.txt'), 'local file');
        h.serve([doc('md', 1, 'a', 1)]);

        const result = await h.pull('folder', 'docs', failed(/^error: .* is not empty and there is no terminal to confirm the pull; pass -y to pull into it\.\n$/), []);

        expect(result.code).toBe(1);
        expect(fs.readdirSync(h.out)).toEqual(['x.txt']);
    });
});

describe('leftovers are classified before any is changed', { timeout: 60_000 }, () => {
    const h = useDocPullHarness();

    /** A killed pull's folder at a dead pid holding a saved copy of `rel`, whose target is absent (so a cleanup would restore it). */
    function plantDeadLeftover(rel: string, bytes: string): string {
        const name = `.solidactions-pull-${deadPid()}`;
        fs.mkdirSync(path.join(h.out, name, 'backup'), { recursive: true });
        fs.writeFileSync(path.join(h.out, name, 'backup', rel), bytes);
        return name;
    }

    it('refuses for a live pull found after several dead leftovers, and restores and removes none of them', async () => {
        h.serve([doc('md', 1, 'a', 1)]);
        fs.mkdirSync(h.out);
        const dead: string[] = [];
        for (let i = 0; i < 6; i++) {
            const name = `.solidactions-pull-${900000 + i * 7}`;
            fs.mkdirSync(path.join(h.out, name, 'backup'), { recursive: true });
            fs.writeFileSync(path.join(h.out, name, 'backup', `saved${i}.md`), `SAVED${i}`);
            dead.push(name);
        }
        const live = childProcess.spawn('sleep', ['20'], { stdio: 'ignore' });
        try {
            const liveName = `.solidactions-pull-${live.pid}`;
            fs.mkdirSync(path.join(h.out, liveName));
            const before = snapshot(h.out);

            await h.pull('folder', 'docs', failed(OVERLAP_LINE(live.pid!, h.out, liveName.replace(/\./g, '\\.'))));

            expect(snapshot(h.out)).toEqual(before);
            for (const name of dead) expect(fs.existsSync(path.join(h.out, name))).toBe(true);
            expect(fs.readdirSync(h.out).filter((name) => name.startsWith('saved'))).toEqual([]);
        } finally {
            live.kill('SIGKILL');
        }
    });

    it('refuses for a folder doc pull did not create found after dead leftovers, and restores and removes none of them', async () => {
        h.serve([doc('md', 1, 'a', 1)]);
        fs.mkdirSync(h.out);
        const dead = plantDeadLeftover('saved.md', 'SAVED');
        const foreignName = '.solidactions-pull-5';
        fs.mkdirSync(path.join(h.out, foreignName));
        fs.writeFileSync(path.join(h.out, foreignName, 'notes.txt'), 'USER NOTES');
        const before = snapshot(h.out);

        await h.pull('folder', 'docs', failed(new RegExp(`^error: ${h.out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.solidactions-pull-5 is not a folder doc pull created; remove it and pull again\\.\n$`)));

        expect(snapshot(h.out)).toEqual(before);
        expect(fs.existsSync(path.join(h.out, dead, 'backup', 'saved.md'))).toBe(true);
        expect(fs.existsSync(path.join(h.out, 'saved.md'))).toBe(false);
        expect(fs.readFileSync(path.join(h.out, foreignName, 'notes.txt'), 'utf8')).toBe('USER NOTES');
    });

    it('a pid that is not a process (0) is never a running pull: its leftover is cleaned up and the pull goes on', async () => {
        const a = doc('md', 1, 'a', 1);
        h.serve([a]);
        fs.mkdirSync(path.join(h.out, '.solidactions-pull-0', 'backup'), { recursive: true });
        fs.writeFileSync(path.join(h.out, '.solidactions-pull-0', 'backup', 'saved.md'), 'SAVED');

        await h.pull('folder', 'docs', pulledOk(h.out, ['a.md'], `! cleaned up after an interrupted doc pull in ${h.out} (restored 1 file(s))\n`));

        expect(read(h.out, 'saved.md')).toBe('SAVED');
        expect(read(h.out, 'a.md')).toBe(a.bytes);
        expect(stagingEntries(h.out)).toEqual([]);
        expect(fs.existsSync(path.join(h.out, MANIFEST_FILE))).toBe(true);
    });
});

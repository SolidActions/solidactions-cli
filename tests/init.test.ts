/**
 * F-C6 — `solidactions init --claude --agents` used to only fail deep inside
 * aiInit(), AFTER init() had already fetched and written every scaffold
 * template file over the network. The mutually-exclusive-flag check now runs
 * first, before any fetch or write.
 *
 * Test-double policy: real tmp dir, real process.exit-throw pattern. No
 * mock/spy/stub libraries — if the guard regressed, this test would instead
 * observe real template files landing on disk (or a real network attempt).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { init } from '../src/commands/init';

class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

describe('init — flag validation before writes (F-C6)', () => {
    it('rejects --claude + --agents together before fetching/writing any template file', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-init-test-'));
        const origExit = process.exit;
        const origCwd = process.cwd();
        const errorLines: string[] = [];
        const origError = console.error;
        console.error = (...args: unknown[]) => { errorLines.push(args.map(String).join(' ')); };
        (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };
        process.chdir(tmpDir);

        let caught: ProcessExitError | null = null;
        try {
            await init(undefined, { claude: true, agents: true });
        } catch (e) {
            if (e instanceof ProcessExitError) caught = e;
            else throw e;
        } finally {
            process.chdir(origCwd);
            process.exit = origExit;
            console.error = origError;
        }

        expect(caught?.code).toBe(1);
        expect(fs.readdirSync(tmpDir)).toEqual([]);
        expect(errorLines.join(' ')).toContain('--claude or --agents');

        fs.rmSync(tmpDir, { recursive: true, force: true });
    }, 10_000);
});

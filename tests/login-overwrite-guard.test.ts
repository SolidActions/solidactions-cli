/**
 * Cleanroom-gate Sev-4: `solidactions login <key> --host <url> --global` used
 * to silently overwrite an existing ~/.solidactions/config.json with only a
 * post-hoc "will be overwritten" notice — no prompt, no backup, no --force.
 * During a cleanroom smoke this destroyed a real config.
 *
 * Fix: before overwriting an existing config whose contents would change,
 * write a timestamped backup (config.json.bak-<ISO timestamp>) and print its
 * path. Non-interactive mode (agents, CI) proceeds automatically WITH the
 * backup so it never wedges; an interactive TTY additionally asks a y/N
 * confirm (default N).
 *
 * Test-double policy: real fs in tmp dirs (makeTmpEnv/writeGlobal), no
 * mock/spy/stub libraries. `--host` points at an unreachable local port so
 * the post-login workspace-selection network call fails fast and is
 * swallowed by login()'s own try/catch — it is not what these tests exercise.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { login } from '../src/commands/login';
import { makeTmpEnv, writeGlobal } from './helpers';

const UNREACHABLE_HOST = 'http://127.0.0.1:1';

class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

describe('login — overwrite guard (cleanroom Sev-4)', () => {
    let originalIsTTY: boolean | undefined;
    let originalExit: typeof process.exit;
    let originalLog: typeof console.log;
    let originalError: typeof console.error;
    let logLines: string[];
    let errorLines: string[];
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();

        originalIsTTY = process.stdin.isTTY;
        Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });

        originalExit = process.exit;
        (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };

        logLines = [];
        originalLog = console.log;
        console.log = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };

        errorLines = [];
        originalError = console.error;
        console.error = (...args: unknown[]) => { errorLines.push(args.map(String).join(' ')); };
    });

    afterEach(() => {
        Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
        (process as any).exit = originalExit;
        console.log = originalLog;
        console.error = originalError;
        env.cleanup();
    });

    it('existing config + non-interactive --global: backs up the OLD contents before overwriting, then writes the new config', async () => {
        const globalPath = writeGlobal(env.home, { host: 'http://old-host.example', apiKey: 'old-api-key' });
        const oldRaw = fs.readFileSync(globalPath, 'utf-8');

        await login('new-api-key', { global: true, host: UNREACHABLE_HOST });

        const dir = path.dirname(globalPath);
        const entries = fs.readdirSync(dir);
        const backups = entries.filter((f) => f.startsWith('config.json.bak-'));

        expect(backups).toHaveLength(1);
        const backupPath = path.join(dir, backups[0]);
        expect(fs.readFileSync(backupPath, 'utf-8')).toBe(oldRaw);

        // New config was written to the original path.
        const newConfig = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
        expect(newConfig.apiKey).toBe('new-api-key');
        expect(newConfig.host).toBe(UNREACHABLE_HOST);

        // Backup path was printed plainly (no prompt in non-interactive mode).
        expect(logLines.some((l) => l.includes('Backup saved to') && l.includes(backupPath))).toBe(true);
    });

    it('no existing config: no backup is written, no prompt is needed', async () => {
        // makeTmpEnv() gives a fresh $HOME with no .solidactions/ dir yet.
        const dir = path.join(env.home, '.solidactions');
        const globalPath = path.join(dir, 'config.json');
        expect(fs.existsSync(globalPath)).toBe(false);

        await login('brand-new-key', { global: true, host: UNREACHABLE_HOST });

        expect(fs.existsSync(dir)).toBe(true);
        const entries = fs.readdirSync(dir);
        const backups = entries.filter((f) => f.startsWith('config.json.bak-'));
        expect(backups).toHaveLength(0);
        expect(logLines.some((l) => l.includes('Backup saved to'))).toBe(false);

        const newConfig = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
        expect(newConfig.apiKey).toBe('brand-new-key');
    });

    it('non-interactive refusal (neither --local nor --global) explains both options, including the backup guarantee', async () => {
        let caught: ProcessExitError | null = null;
        try {
            await login('some-key', { host: UNREACHABLE_HOST });
        } catch (e) {
            if (e instanceof ProcessExitError) caught = e;
            else throw e;
        }

        expect(caught?.code).toBe(1);
        const out = errorLines.join(' ');
        expect(out).toContain('--global');
        expect(out).toContain('machine-wide');
        expect(out).toContain('backup');
        expect(out).toContain('--local');
        expect(out).toContain('./.solidactions/config.json');
    });
});

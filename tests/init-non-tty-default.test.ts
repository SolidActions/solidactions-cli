/**
 * Cleanroom-agent finding: `solidactions init foo </dev/null` (non-TTY, no
 * --claude/--agents) used to write package.json/tsconfig/solidactions.yaml/
 * .env.example/src/ and THEN hit an interactive "Which AI helper file?"
 * prompt. In a non-TTY shell (e.g. an AI agent's Bash tool) that prompt can
 * never be answered, so the process exited leaving a half-scaffolded
 * project: no CLAUDE.md/AGENTS.md, no .claude/skills/.
 *
 * Fix: the AI-helper target is now resolved UP FRONT (before any template
 * file is written) via `resolveAiHelperTarget()`. In a non-TTY shell with no
 * flag it defaults to CLAUDE.md and prints a one-line notice instead of
 * prompting.
 *
 * Test-double policy: real tmp dir, real stdin.isTTY toggling. No mock/spy/
 * stub libraries. `resolveAiHelperTarget()` is unit-tested directly (no
 * network involved on any of its return paths) rather than driving the full
 * `init()` command, which would need real network access to fetch template
 * files from GitHub — see CLAUDE.md test conventions ("don't make tests
 * depend on network").
 */
import { describe, expect, it, afterEach } from 'vitest';
import { resolveAiHelperTarget, NON_TTY_DEFAULT_NOTICE } from '../src/commands/ai-init';

class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

function withNonTty<T>(fn: () => T): T {
    const original = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    try {
        return fn();
    } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
    }
}

function captureLog(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    return { lines, restore: () => { console.log = orig; } };
}

describe('resolveAiHelperTarget — non-TTY default (cleanroom finding)', () => {
    afterEach(() => {
        Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    });

    it('non-TTY + no flags: resolves to CLAUDE.md and prints the default notice, without prompting', async () => {
        const log = captureLog();
        let target: string;
        try {
            target = await withNonTty(() => resolveAiHelperTarget({}));
        } finally {
            log.restore();
        }

        expect(target).toBe('CLAUDE.md');
        expect(log.lines.join('\n')).toContain(NON_TTY_DEFAULT_NOTICE);
    });

    it('non-TTY + --claude: resolves to CLAUDE.md with no notice', async () => {
        const log = captureLog();
        let target: string;
        try {
            target = await withNonTty(() => resolveAiHelperTarget({ claude: true }));
        } finally {
            log.restore();
        }

        expect(target).toBe('CLAUDE.md');
        expect(log.lines.join('\n')).not.toContain(NON_TTY_DEFAULT_NOTICE);
    });

    it('non-TTY + --agents: resolves to AGENTS.md with no notice', async () => {
        const log = captureLog();
        let target: string;
        try {
            target = await withNonTty(() => resolveAiHelperTarget({ agents: true }));
        } finally {
            log.restore();
        }

        expect(target).toBe('AGENTS.md');
        expect(log.lines.join('\n')).not.toContain(NON_TTY_DEFAULT_NOTICE);
    });

    it('--claude + --agents together still errors (exit 1) before resolving anything', async () => {
        const origExit = process.exit;
        (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };

        let caught: ProcessExitError | null = null;
        try {
            await withNonTty(() => resolveAiHelperTarget({ claude: true, agents: true }));
        } catch (e) {
            if (e instanceof ProcessExitError) caught = e;
            else throw e;
        } finally {
            process.exit = origExit;
        }

        expect(caught?.code).toBe(1);
    });
});

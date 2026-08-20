/**
 * Tests for `applyWorkspaceGuard` — the shared tail `requireConfigWithWorkspace()` runs after
 * resolving a workspace, wiring the workspace-guard primitives (src/utils/workspace-guard.ts)
 * into the actual resolution choke point.
 *
 * No mocks/spies/stubs/fakes — every `io` hook is a real closure recording into an array, and
 * last-used state is read/written through the real filesystem via a real temp home dir
 * (makeTmpEnv()).
 */

import { describe, expect, it } from 'vitest';
import {
    applyWorkspaceGuard,
    buildWorkspaceConfirmPrompt,
    WorkspaceGuardAbort,
    type WorkspaceGuardIo,
} from '../src/utils/api';
import { getGlobalConfigPath, type Config, type ResolvedConfig } from '../src/utils/config';
import { readLastUsedWorkspace, writeLastUsedWorkspace } from '../src/utils/workspace-guard';
import { makeTmpEnv } from './helpers';

const LOCAL_PATH = '/work/project/.solidactions/config.json';

function sources(workspaceIdSource: ResolvedConfig['sources']['workspaceId']): ResolvedConfig['sources'] {
    return {
        host: null,
        apiKey: null,
        workspace: workspaceIdSource,
        workspaceId: workspaceIdSource,
    };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
    return {
        host: 'https://host',
        apiKey: 'key',
        workspace: 'new-ws',
        workspaceId: 'ws-new',
        ...overrides,
    };
}

interface RecordingIo {
    io: WorkspaceGuardIo;
    warns: string[];
    announces: string[];
    confirmCalls: string[];
}

function makeIo(home: string, opts: { isTty?: boolean; confirmResult?: boolean } = {}): RecordingIo {
    const warns: string[] = [];
    const announces: string[] = [];
    const confirmCalls: string[] = [];
    const io: WorkspaceGuardIo = {
        isTty: () => opts.isTty ?? true,
        warn: (message) => warns.push(message),
        announce: (message) => announces.push(message),
        confirm: async (message) => {
            confirmCalls.push(message);
            return opts.confirmResult ?? true;
        },
        homeDir: home,
        now: () => new Date('2026-08-19T00:00:00.000Z'),
    };
    return { io, warns, announces, confirmCalls };
}

describe('applyWorkspaceGuard', () => {
    it('read command + changed CWD-inferred workspace: exactly one stderr warn line, proceeds, does not record last-used', async () => {
        const env = makeTmpEnv();
        try {
            writeLastUsedWorkspace({ workspaceId: 'ws-old', label: 'old-ws' }, env.home);
            const { io, warns, announces, confirmCalls } = makeIo(env.home);

            const config = makeConfig();
            const result = await applyWorkspaceGuard(
                config,
                sources(LOCAL_PATH),
                { mutating: false, explicitOverride: false },
                io,
            );

            expect(result).toBe(config);
            expect(warns).toHaveLength(1);
            expect(warns[0]).toContain('workspace changed to');
            expect(warns[0]).toContain('inferred from');
            expect(warns[0]).toContain(LOCAL_PATH);
            expect(warns[0]).toContain('last used was');
            expect(warns[0]).toContain('Pin it with -w ws-new');
            expect(confirmCalls).toHaveLength(0);
            expect(announces).toHaveLength(0); // non-mutating: no banner
            // A read must never consume the change that gates a write: state.json still
            // holds what it held before this read, unchanged.
            expect(readLastUsedWorkspace(env.home)).toEqual({ workspaceId: 'ws-old', label: 'old-ws' });
        } finally {
            env.cleanup();
        }
    });

    it('read-then-write regression: a read into a changed CWD-inferred workspace does not disarm the following write\'s confirmation', async () => {
        const env = makeTmpEnv();
        try {
            writeLastUsedWorkspace({ workspaceId: 'ws-old', label: 'old-ws' }, env.home);

            // Step 1: a read-only command resolves the changed, CWD-inferred workspace.
            const read = makeIo(env.home, { isTty: false });
            await applyWorkspaceGuard(
                makeConfig(),
                sources(LOCAL_PATH),
                { mutating: false, explicitOverride: false },
                read.io,
            );

            // Step 2: a mutating command in the same directory, non-interactive, no --yes.
            // If step 1 had recorded itself as last-used, decideWorkspaceGuard would now see
            // resolved === lastUsed and let the write through silently — that's the bug.
            const write = makeIo(env.home, { isTty: false });
            await expect(
                applyWorkspaceGuard(
                    makeConfig(),
                    sources(LOCAL_PATH),
                    { mutating: true, explicitOverride: false },
                    write.io,
                ),
            ).rejects.toMatchObject({ exitCode: 1 });

            expect(write.confirmCalls).toHaveLength(0);
        } finally {
            env.cleanup();
        }
    });

    it('write command + changed CWD-inferred workspace + TTY + confirm accepted: proceeds, last-used updated', async () => {
        const env = makeTmpEnv();
        try {
            writeLastUsedWorkspace({ workspaceId: 'ws-old', label: 'old-ws' }, env.home);
            const { io, warns, announces, confirmCalls } = makeIo(env.home, { isTty: true, confirmResult: true });

            const config = makeConfig({ workspaceOrg: 'Acme' });
            await applyWorkspaceGuard(
                config,
                sources(LOCAL_PATH),
                { mutating: true, explicitOverride: false },
                io,
            );

            expect(warns).toHaveLength(1);
            expect(confirmCalls).toHaveLength(1);
            expect(confirmCalls[0]).toContain('WRITE');
            expect(announces.some((line) => line.includes('Workspace:') && line.includes('new-ws') && line.includes('Acme') && line.includes('ws-new'))).toBe(true);
            expect(readLastUsedWorkspace(env.home)?.workspaceId).toBe('ws-new');
        } finally {
            env.cleanup();
        }
    });

    it('write command + declined: does not record last-used', async () => {
        const env = makeTmpEnv();
        try {
            writeLastUsedWorkspace({ workspaceId: 'ws-old', label: 'old-ws' }, env.home);
            const { io, announces } = makeIo(env.home, { isTty: true, confirmResult: false });

            const config = makeConfig();
            await expect(
                applyWorkspaceGuard(
                    config,
                    sources(LOCAL_PATH),
                    { mutating: true, explicitOverride: false },
                    io,
                ),
            ).rejects.toMatchObject({ exitCode: 0 });

            expect(announces.some((line) => line.includes('Cancelled.'))).toBe(true);
            expect(readLastUsedWorkspace(env.home)?.workspaceId).toBe('ws-old');
        } finally {
            env.cleanup();
        }
    });

    it('write command + non-TTY: refuses, hint names -w only (never --yes), does not record last-used', async () => {
        const env = makeTmpEnv();
        try {
            writeLastUsedWorkspace({ workspaceId: 'ws-old', label: 'old-ws' }, env.home);
            const { io, warns, confirmCalls } = makeIo(env.home, { isTty: false });

            const config = makeConfig();
            await expect(
                applyWorkspaceGuard(
                    config,
                    sources(LOCAL_PATH),
                    { mutating: true, explicitOverride: false },
                    io,
                ),
            ).rejects.toMatchObject({ exitCode: 1 });

            expect(confirmCalls).toHaveLength(0);
            expect(warns.some((line) => line === 're-run with -w ws-new to confirm the target workspace')).toBe(true);
            expect(warns.some((line) => line.includes('--yes'))).toBe(false);
            expect(readLastUsedWorkspace(env.home)?.workspaceId).toBe('ws-old');
        } finally {
            env.cleanup();
        }
    });

    it("a command's own --yes does not grant workspace consent: TTY still prompts", async () => {
        const env = makeTmpEnv();
        try {
            writeLastUsedWorkspace({ workspaceId: 'ws-old', label: 'old-ws' }, env.home);
            const { io, confirmCalls } = makeIo(env.home, { isTty: true, confirmResult: true });

            const config = makeConfig();
            await applyWorkspaceGuard(
                config,
                sources(LOCAL_PATH),
                { mutating: true, explicitOverride: false },
                io,
            );

            expect(confirmCalls).toHaveLength(1);
            expect(readLastUsedWorkspace(env.home)?.workspaceId).toBe('ws-new');
        } finally {
            env.cleanup();
        }
    });

    it('workspace from the GLOBAL config (not CWD-inferred): no warn, no confirm, even when it differs', async () => {
        const env = makeTmpEnv();
        try {
            writeLastUsedWorkspace({ workspaceId: 'ws-old', label: 'old-ws' }, env.home);
            const { io, warns, confirmCalls } = makeIo(env.home);

            const config = makeConfig();
            await applyWorkspaceGuard(
                config,
                sources(getGlobalConfigPath()),
                { mutating: true, explicitOverride: false },
                io,
            );

            expect(warns).toHaveLength(0);
            expect(confirmCalls).toHaveLength(0);
            expect(readLastUsedWorkspace(env.home)?.workspaceId).toBe('ws-new');
        } finally {
            env.cleanup();
        }
    });

    it('-w override: no warn, no confirm, even when the resolved workspace differs from last-used', async () => {
        const env = makeTmpEnv();
        try {
            writeLastUsedWorkspace({ workspaceId: 'ws-old', label: 'old-ws' }, env.home);
            const { io, warns, confirmCalls } = makeIo(env.home);

            const config = makeConfig();
            await applyWorkspaceGuard(
                config,
                sources('cli'),
                { mutating: true, explicitOverride: true },
                io,
            );

            expect(warns).toHaveLength(0);
            expect(confirmCalls).toHaveLength(0);
            expect(readLastUsedWorkspace(env.home)?.workspaceId).toBe('ws-new');
        } finally {
            env.cleanup();
        }
    });

    it('same workspace as last-used: silent', async () => {
        const env = makeTmpEnv();
        try {
            writeLastUsedWorkspace({ workspaceId: 'ws-new', label: 'new-ws' }, env.home);
            const { io, warns, confirmCalls } = makeIo(env.home);

            const config = makeConfig();
            await applyWorkspaceGuard(
                config,
                sources(LOCAL_PATH),
                { mutating: true, explicitOverride: false },
                io,
            );

            expect(warns).toHaveLength(0);
            expect(confirmCalls).toHaveLength(0);
        } finally {
            env.cleanup();
        }
    });

    describe('banner', () => {
        it('mutating command prints the Workspace: line with org when workspaceOrg is set', async () => {
            const env = makeTmpEnv();
            try {
                const { io, announces } = makeIo(env.home);
                const config = makeConfig({ workspaceOrg: 'Acme' });
                await applyWorkspaceGuard(
                    config,
                    sources(getGlobalConfigPath()),
                    { mutating: true, explicitOverride: false },
                    io,
                );
                expect(announces).toHaveLength(1);
                expect(announces[0]).toContain('Workspace:');
                expect(announces[0]).toContain('new-ws — organization Acme');
                expect(announces[0]).toContain('ws-new');
            } finally {
                env.cleanup();
            }
        });

        it('mutating command prints the Workspace: line without org when workspaceOrg is unset', async () => {
            const env = makeTmpEnv();
            try {
                const { io, announces } = makeIo(env.home);
                const config = makeConfig();
                await applyWorkspaceGuard(
                    config,
                    sources(getGlobalConfigPath()),
                    { mutating: true, explicitOverride: false },
                    io,
                );
                expect(announces).toHaveLength(1);
                expect(announces[0]).toContain('Workspace: new-ws (ws-new)');
                expect(announces[0]).not.toContain('organization');
            } finally {
                env.cleanup();
            }
        });

        it('shows the id alone when workspaceId came from the environment and the name did not: no stale slug', async () => {
            const env = makeTmpEnv();
            try {
                const { io, announces } = makeIo(env.home);

                // SOLIDACTIONS_WORKSPACE_ID alone: the id is env-sourced, the leftover name and
                // org describe whatever workspace the config file happens to name (#1437 R4).
                await applyWorkspaceGuard(
                    makeConfig({ workspace: 'stale-slug', workspaceOrg: 'Stale Org' }),
                    { host: null, apiKey: null, workspace: LOCAL_PATH, workspaceId: 'env' },
                    { mutating: true, explicitOverride: false },
                    io,
                );

                expect(announces).toHaveLength(1);
                expect(announces[0]).toContain('ws-new');
                expect(announces[0]).not.toContain('stale-slug');
                expect(announces[0]).not.toContain('Stale Org');
            } finally {
                env.cleanup();
            }
        });

        it('non-mutating command prints no banner', async () => {
            const env = makeTmpEnv();
            try {
                const { io, announces } = makeIo(env.home);
                const config = makeConfig();
                await applyWorkspaceGuard(
                    config,
                    sources(getGlobalConfigPath()),
                    { mutating: false, explicitOverride: false },
                    io,
                );
                expect(announces).toHaveLength(0);
            } finally {
                env.cleanup();
            }
        });
    });

    it('WorkspaceGuardAbort exposes exitCode', () => {
        const abort = new WorkspaceGuardAbort(1, 'refused');
        expect(abort.exitCode).toBe(1);
        expect(abort).toBeInstanceOf(Error);
    });
});

// The default confirmFn used by applyWorkspaceGuard when no io.confirm is injected renders
// its prompt via this question object. stdout is reserved for a command's own
// machine-parseable output (see the `announce` comment above applyWorkspaceGuard), so this
// prompt must render to stderr — otherwise its interactive ANSI UI corrupts a captured
// `--json` stdout stream while stdin is still a TTY (#1437).
describe('buildWorkspaceConfirmPrompt', () => {
    it('renders to stderr, not stdout', () => {
        const question = buildWorkspaceConfirmPrompt('This command WRITES to acme (ws-1). Proceed?');
        expect(question).toEqual({
            type: 'confirm',
            name: 'confirm',
            message: 'This command WRITES to acme (ws-1). Proceed?',
            initial: false,
            stdout: process.stderr,
        });
    });
});

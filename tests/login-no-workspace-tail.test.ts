/**
 * app#1197 — `completeLogin` printed "Logged in successfully!" plus the full
 * Next step / Quick start block even when no workspace ended up selected
 * (interactive picker cancelled, non-TTY with multiple workspaces, or zero
 * workspaces on the account). Every suggested next command needs a
 * workspace, so a first-time user was walked straight into a broken command.
 *
 * Fix: the success banner + next-steps block is now conditional on
 * `config.workspaceId` actually being set. The no-workspace tail instead
 * prints `Authentication saved to <path>.` plus a `workspace list` / `set`
 * pointer — but only when the account actually has workspaces to list.
 *
 * Test-double policy: real fs in a tmp $HOME (makeTmpEnv from ./helpers); no
 * mock/spy/stub/fake libraries. The interactive-picker-cancelled case is
 * driven through `completeLogin`'s optional `selectWorkspace` dependency
 * seam (see below) rather than fighting real stdin EOF.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeLogin, Config } from '../src/commands/login';
import { WorkspaceLookupRecord } from '../src/utils/workspace-lookup';
import { makeTmpEnv } from './helpers';

describe('completeLogin — no-workspace tail (app#1197)', () => {
    let originalIsTTY: boolean | undefined;
    let originalLog: typeof console.log;
    let logLines: string[];
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();

        originalIsTTY = process.stdin.isTTY;

        logLines = [];
        originalLog = console.log;
        console.log = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };
    });

    afterEach(() => {
        Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
        console.log = originalLog;
        env.cleanup();
    });

    const baseConfig = (): Config => ({
        host: 'https://app.solidactions.com',
        apiKey: 'test-api-key',
    });

    const twoWorkspaces: WorkspaceLookupRecord[] = [
        { id: 'ws-1', name: 'First Workspace', slug: 'first-workspace' },
        { id: 'ws-2', name: 'Second Workspace', slug: 'second-workspace' },
    ];

    const globalConfigPath = () => path.join(env.home, '.solidactions', 'config.json');

    it('cancelled interactive picker: suppresses success/next-steps, saves the credential, points at workspace list/set', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

        const config = baseConfig();
        await completeLogin(
            config,
            twoWorkspaces,
            { global: true },
            null,
            null,
            { selectWorkspace: async () => undefined },
        );

        const out = logLines.join('\n');
        expect(out).not.toContain('Logged in successfully!');
        expect(out).not.toContain('Next step');
        expect(out).not.toContain('Quick start');
        expect(out).not.toContain('solidactions project deploy');
        expect(out).toContain(`Authentication saved to ${globalConfigPath()}`);
        expect(out).toContain('solidactions workspace set');

        const saved = JSON.parse(fs.readFileSync(globalConfigPath(), 'utf-8'));
        expect(saved.apiKey).toBe('test-api-key');
        expect(saved.workspaceId).toBeUndefined();
    });

    it('non-TTY with multiple workspaces: suppresses success/next-steps, saves the credential, points at workspace list/set', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });

        const config = baseConfig();
        await completeLogin(config, twoWorkspaces, { global: true });

        const out = logLines.join('\n');
        expect(out).not.toContain('Logged in successfully!');
        expect(out).not.toContain('Next step');
        expect(out).not.toContain('Quick start');
        expect(out).not.toContain('solidactions project deploy');
        expect(out).toContain(`Authentication saved to ${globalConfigPath()}`);
        expect(out).toContain('solidactions workspace set');

        const saved = JSON.parse(fs.readFileSync(globalConfigPath(), 'utf-8'));
        expect(saved.apiKey).toBe('test-api-key');
        expect(saved.workspaceId).toBeUndefined();
    });

    it('zero workspaces: no success banner, no next-steps, no workspace-list instruction (the "create one" guidance already stands)', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });

        const config = baseConfig();
        await completeLogin(config, [], { global: true });

        const out = logLines.join('\n');
        expect(out).not.toContain('Logged in successfully!');
        expect(out).not.toContain('Next step');
        expect(out).not.toContain('Quick start');
        expect(out).toContain(`Authentication saved to ${globalConfigPath()}`);
        expect(out).not.toContain('solidactions workspace list');

        const saved = JSON.parse(fs.readFileSync(globalConfigPath(), 'utf-8'));
        expect(saved.apiKey).toBe('test-api-key');
        expect(saved.workspaceId).toBeUndefined();
    });

    it('happy path regression: a single auto-selected workspace still prints the full success banner and next-steps block', async () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });

        const config = baseConfig();
        const singleWorkspace: WorkspaceLookupRecord[] = [
            { id: 'ws-1', name: 'Only Workspace', slug: 'only-workspace' },
        ];
        await completeLogin(config, singleWorkspace, { global: true });

        const out = logLines.join('\n');
        expect(out).toContain('Logged in successfully!');
        expect(out).toContain(`Configuration saved to ${globalConfigPath()}`);
        expect(out).toContain('Next step — scaffold a new project (includes AI tooling):');
        expect(out).toContain('solidactions init <project-name>      Creates ./<project-name>/ with scaffold + AI skills');
        expect(out).toContain('solidactions init                     Scaffolds in the current (empty) directory');
        expect(out).toContain('Quick start:');
        expect(out).toContain('solidactions project deploy <name>    Deploy current directory');
        expect(out).toContain('solidactions run start <proj> <wf>    Run a workflow');
        expect(out).toContain('solidactions run list                 List recent runs');

        const saved = JSON.parse(fs.readFileSync(globalConfigPath(), 'utf-8'));
        expect(saved.workspaceId).toBe('ws-1');
    });
});

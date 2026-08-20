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
 * Test-double policy: real fs in tmp dirs (makeTmpEnv/writeGlobal); a real
 * in-process HTTP server (Node's http.createServer) stubs GET
 * /api/v1/workspaces so login()'s F-C2 pre-write validation succeeds — no
 * mock/spy/stub libraries.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { completeLogin, Config, login } from '../src/commands/login';
import { WorkspaceLookupRecord } from '../src/utils/workspace-lookup';
import { makeTmpEnv, writeGlobal } from './helpers';

class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

let stubServer: http.Server;
let stubPort: number;

beforeAll(async () => {
    stubServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
    });
    await new Promise<void>((resolve) => {
        stubServer.listen(0, '127.0.0.1', () => {
            stubPort = (stubServer.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => {
    return new Promise<void>((resolve, reject) => {
        stubServer.close((err) => (err ? reject(err) : resolve()));
    });
});

describe('login — overwrite guard (cleanroom Sev-4)', () => {
    let originalIsTTY: boolean | undefined;
    let originalExit: typeof process.exit;
    let originalLog: typeof console.log;
    let originalError: typeof console.error;
    let logLines: string[];
    let errorLines: string[];
    let env: ReturnType<typeof makeTmpEnv>;

    const HOST = () => `http://127.0.0.1:${stubPort}`;

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

        await login('new-api-key', { global: true, host: HOST() });

        const dir = path.dirname(globalPath);
        const entries = fs.readdirSync(dir);
        const backups = entries.filter((f) => f.startsWith('config.json.bak-'));

        expect(backups).toHaveLength(1);
        const backupPath = path.join(dir, backups[0]);
        expect(fs.readFileSync(backupPath, 'utf-8')).toBe(oldRaw);

        // New config was written to the original path.
        const newConfig = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
        expect(newConfig.apiKey).toBe('new-api-key');
        expect(newConfig.host).toBe(HOST());

        // Backup path was printed plainly (no prompt in non-interactive mode).
        expect(logLines.some((l) => l.includes('Backup saved to') && l.includes(backupPath))).toBe(true);
    });

    it('no existing config: no backup is written, no prompt is needed', async () => {
        // makeTmpEnv() gives a fresh $HOME with no .solidactions/ dir yet.
        const dir = path.join(env.home, '.solidactions');
        const globalPath = path.join(dir, 'config.json');
        expect(fs.existsSync(globalPath)).toBe(false);

        await login('brand-new-key', { global: true, host: HOST() });

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
            await login('some-key', { host: HOST() });
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

    // app#1197 (second item): the overwrite confirm/backup must run BEFORE
    // workspace resolution (including the interactive picker), not after —
    // otherwise the user does the picker work and only then finds out the
    // config would have been clobbered.
    it('ordering (app#1197): with a DIFFERENT-credential existing config and multiple workspaces, confirm/backup runs before the workspace picker is reached', async () => {
        const globalPath = writeGlobal(env.home, { host: 'http://old-host.example', apiKey: 'old-api-key' });
        const oldRaw = fs.readFileSync(globalPath, 'utf-8');

        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

        const config: Config = { host: HOST(), apiKey: 'new-api-key' };
        const multipleWorkspaces: WorkspaceLookupRecord[] = [
            { id: 'ws-1', name: 'First Workspace', slug: 'first-workspace' },
            { id: 'ws-2', name: 'Second Workspace', slug: 'second-workspace' },
        ];

        await completeLogin(
            config,
            multipleWorkspaces,
            { global: true },
            null,
            null,
            {
                // Auto-answer "yes" to the overwrite confirm so the test never
                // waits on real stdin, then record that the (real) interactive
                // workspace-picker branch was reached — a genuine observation
                // of completeLogin's own control flow, not a spy on it.
                overwriteQuestion: async () => 'y',
                selectWorkspace: async (ws) => {
                    console.log('picker reached');
                    return ws[0];
                },
            },
        );

        const backupIndex = logLines.findIndex((l) => l.includes('Backup saved to'));
        const pickerIndex = logLines.findIndex((l) => l.includes('picker reached'));

        expect(backupIndex).toBeGreaterThanOrEqual(0);
        expect(pickerIndex).toBeGreaterThanOrEqual(0);
        expect(backupIndex).toBeLessThan(pickerIndex);

        const dir = path.dirname(globalPath);
        const backups = fs.readdirSync(dir).filter((f) => f.startsWith('config.json.bak-'));
        expect(backups).toHaveLength(1);
        expect(fs.readFileSync(path.join(dir, backups[0]), 'utf-8')).toBe(oldRaw);
    });

    // app#1197 finding 1: a mismatched --workspace on an API-key login exits
    // before writeConfigFile is ever reached, so the destination/confirm/
    // backup block must not run — otherwise it falsely claims the (untouched)
    // config "will be overwritten" and leaves a stray backup file behind.
    it('mismatched --workspace with a DIFFERENT-credential existing config: exits 1 without backing up, overwriting, or claiming either', async () => {
        const globalPath = writeGlobal(env.home, { host: 'http://old-host.example', apiKey: 'old-api-key' });
        const oldRaw = fs.readFileSync(globalPath, 'utf-8');

        let caught: ProcessExitError | null = null;
        try {
            await login('new-api-key', { global: true, host: HOST(), workspace: 'Nonexistent Team' });
        } catch (e) {
            if (e instanceof ProcessExitError) caught = e;
            else throw e;
        }

        expect(caught?.code).toBe(1);
        expect(fs.readFileSync(globalPath, 'utf-8')).toBe(oldRaw);

        const dir = path.dirname(globalPath);
        const backups = fs.readdirSync(dir).filter((f) => f.startsWith('config.json.bak-'));
        expect(backups).toHaveLength(0);

        const allOutput = [...logLines, ...errorLines].join('\n');
        expect(allOutput).not.toContain('will be overwritten');
        expect(allOutput).not.toContain('Backup saved to');
    });

    // app#1197 + app#1196: the pre-write guard refuses whatever
    // `classifyWorkspaceInput` refuses, not just an outright miss. An input
    // that is BOTH an org name and a workspace name is ambiguous, and must
    // bail with the collision copy before the destination/confirm/backup
    // block runs — a first-match resolver would instead pick a workspace the
    // user never named and go on to back up and overwrite the config.
    it('ambiguous --workspace (org name that is also a workspace name): exits 1 with the collision message, without backing up or overwriting', async () => {
        const globalPath = writeGlobal(env.home, { host: 'http://old-host.example', apiKey: 'old-api-key' });
        const oldRaw = fs.readFileSync(globalPath, 'utf-8');

        const config: Config = { host: HOST(), apiKey: 'new-api-key' };
        const collidingWorkspaces: WorkspaceLookupRecord[] = [
            { id: 'ws-1', name: '10TC', slug: 'tentc', org_name: '10TC' },
            { id: 'ws-2', name: '10TC Sales', slug: 'tentc-sales', org_name: '10TC' },
        ];

        let caught: ProcessExitError | null = null;
        try {
            await completeLogin(config, collidingWorkspaces, { global: true, workspace: '10TC' });
        } catch (e) {
            if (e instanceof ProcessExitError) caught = e;
            else throw e;
        }

        expect(caught?.code).toBe(1);
        expect(fs.readFileSync(globalPath, 'utf-8')).toBe(oldRaw);

        const dir = path.dirname(globalPath);
        const backups = fs.readdirSync(dir).filter((f) => f.startsWith('config.json.bak-'));
        expect(backups).toHaveLength(0);

        const allOutput = [...logLines, ...errorLines].join('\n');
        expect(allOutput).toContain('is both an organization name and a workspace name');
        expect(allOutput).not.toContain('will be overwritten');
        expect(allOutput).not.toContain('Backup saved to');
    });

    // R3 (review pair): `org-only` is the third refusal kind and rode in on
    // `kind !== 'match'` with no integration coverage of its own — an input
    // naming an org that owns no workspace of that name must refuse with the
    // org listing, and must refuse at the same pre-write point as the others.
    it('org-only --workspace (an organization that owns no workspace of that name): exits 1 with the org listing, without backing up or overwriting', async () => {
        const globalPath = writeGlobal(env.home, { host: 'http://old-host.example', apiKey: 'old-api-key' });
        const oldRaw = fs.readFileSync(globalPath, 'utf-8');

        const config: Config = { host: HOST(), apiKey: 'new-api-key' };
        const orgOwnedWorkspaces: WorkspaceLookupRecord[] = [
            { id: 'ws-1', name: 'Engineering', slug: 'engineering', org_name: 'Acme' },
            { id: 'ws-2', name: 'Marketing', slug: 'marketing', org_name: 'Acme' },
        ];

        let caught: ProcessExitError | null = null;
        try {
            await completeLogin(config, orgOwnedWorkspaces, { global: true, workspace: 'Acme' });
        } catch (e) {
            if (e instanceof ProcessExitError) caught = e;
            else throw e;
        }

        expect(caught?.code).toBe(1);
        expect(fs.readFileSync(globalPath, 'utf-8')).toBe(oldRaw);

        const dir = path.dirname(globalPath);
        expect(fs.readdirSync(dir).filter((f) => f.startsWith('config.json.bak-'))).toHaveLength(0);

        const allOutput = [...logLines, ...errorLines].join('\n');
        expect(allOutput).toContain('"Acme" is an organization, not a workspace.');
        expect(allOutput).toContain('Engineering');
        expect(allOutput).toContain('Marketing');
        expect(allOutput).not.toContain('will be overwritten');
        expect(allOutput).not.toContain('Backup saved to');
    });

    // R1 (review pair, P1): the credentials-only isDestructive compare cannot
    // see a workspace pin being lost, and writeConfigFile writes wholesale. A
    // same-credential re-login on a multi-workspace account where NO workspace
    // resolves (picker cancelled here; the non-interactive branch is the same
    // shape) therefore used to silently delete the existing workspace pin —
    // with no prompt and no .bak, because same credentials are not
    // "destructive". The pin must survive instead.
    it('same-credential re-login, multiple workspaces, cancelled picker: preserves the existing workspace pin instead of deleting it', async () => {
        const globalPath = writeGlobal(env.home, {
            host: HOST(),
            apiKey: 'same-api-key',
            workspace: 'pinned-workspace',
            workspaceId: 'ws-pinned',
            workspaceOrg: 'Pinned Org',
        });

        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

        const config: Config = { host: HOST(), apiKey: 'same-api-key' };
        const multipleWorkspaces: WorkspaceLookupRecord[] = [
            { id: 'ws-1', name: 'First Workspace', slug: 'first-workspace' },
            { id: 'ws-2', name: 'Second Workspace', slug: 'second-workspace' },
        ];

        await completeLogin(config, multipleWorkspaces, { global: true }, null, null, {
            // Cancelling the picker (EOF) resolves to undefined — the app#1197
            // path this whole branch exists for.
            selectWorkspace: async () => undefined,
        });

        const written = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
        expect(written.workspace).toBe('pinned-workspace');
        expect(written.workspaceId).toBe('ws-pinned');
        expect(written.workspaceOrg).toBe('Pinned Org');
        expect(written.apiKey).toBe('same-api-key');

        // The user cancelled the picker, so they must be told the old pin is
        // what they are left on — otherwise the retained pin is as silent as
        // the deletion it replaced.
        expect(logLines.join('\n')).toContain('Keeping the workspace already pinned in this config: pinned-workspace');
    });

    // Same shape as above on the non-interactive branch, which reaches the
    // wholesale write by a different route (no picker at all).
    it('same-credential re-login, multiple workspaces, non-interactive: preserves the existing workspace pin', async () => {
        const globalPath = writeGlobal(env.home, {
            host: HOST(),
            apiKey: 'same-api-key',
            workspace: 'pinned-workspace',
            workspaceId: 'ws-pinned',
            workspaceOrg: 'Pinned Org',
        });

        // beforeEach already sets isTTY undefined; be explicit about the branch.
        Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });

        const config: Config = { host: HOST(), apiKey: 'same-api-key' };
        const multipleWorkspaces: WorkspaceLookupRecord[] = [
            { id: 'ws-1', name: 'First Workspace', slug: 'first-workspace' },
            { id: 'ws-2', name: 'Second Workspace', slug: 'second-workspace' },
        ];

        await completeLogin(config, multipleWorkspaces, { global: true }, null, null, {});

        const written = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
        expect(written.workspace).toBe('pinned-workspace');
        expect(written.workspaceId).toBe('ws-pinned');
        expect(written.workspaceOrg).toBe('Pinned Org');
    });

    // The carry-forward must NOT cross accounts: when the credentials change,
    // the existing pin belongs to a different account and re-pinning it would
    // point the new session at a workspace it may not even be able to see.
    // That path is already prompted + backed up, so losing the pin is
    // consented-to; carrying it forward would be the bug.
    it('different-credential re-login with no workspace resolved: does NOT carry the previous account\'s workspace pin forward', async () => {
        const globalPath = writeGlobal(env.home, {
            host: 'http://old-host.example',
            apiKey: 'old-api-key',
            workspace: 'pinned-workspace',
            workspaceId: 'ws-pinned',
            workspaceOrg: 'Pinned Org',
        });

        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

        const config: Config = { host: HOST(), apiKey: 'new-api-key' };
        const multipleWorkspaces: WorkspaceLookupRecord[] = [
            { id: 'ws-1', name: 'First Workspace', slug: 'first-workspace' },
            { id: 'ws-2', name: 'Second Workspace', slug: 'second-workspace' },
        ];

        await completeLogin(config, multipleWorkspaces, { global: true }, null, null, {
            overwriteQuestion: async () => 'y',
            selectWorkspace: async () => undefined,
        });

        const written = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
        expect(written.workspace).toBeUndefined();
        expect(written.workspaceId).toBeUndefined();
        expect(written.workspaceOrg).toBeUndefined();
        expect(written.apiKey).toBe('new-api-key');
    });

    // app#1197 finding 3: the decline path through the hoisted confirm/backup
    // block must abort BEFORE the workspace picker is ever reached, not just
    // before the answer 'y' is exercised.
    it('declining the overwrite confirm ("n"): aborts before the workspace picker is reached, leaves the config and disk untouched', async () => {
        const globalPath = writeGlobal(env.home, { host: 'http://old-host.example', apiKey: 'old-api-key' });
        const oldRaw = fs.readFileSync(globalPath, 'utf-8');

        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

        const config: Config = { host: HOST(), apiKey: 'new-api-key' };
        const multipleWorkspaces: WorkspaceLookupRecord[] = [
            { id: 'ws-1', name: 'First Workspace', slug: 'first-workspace' },
            { id: 'ws-2', name: 'Second Workspace', slug: 'second-workspace' },
        ];
        const pickerCalls: WorkspaceLookupRecord[][] = [];

        let caught: ProcessExitError | null = null;
        try {
            await completeLogin(
                config,
                multipleWorkspaces,
                { global: true },
                null,
                null,
                {
                    overwriteQuestion: async () => 'n',
                    // Records its own invocation in a plain array — a real
                    // observation of whether completeLogin reached the
                    // interactive-picker branch, not a mock/spy library.
                    selectWorkspace: async (ws) => {
                        pickerCalls.push(ws);
                        return ws[0];
                    },
                },
            );
        } catch (e) {
            if (e instanceof ProcessExitError) caught = e;
            else throw e;
        }

        expect(caught?.code).toBe(0);
        expect(logLines.some((l) => l.includes('Aborted. No changes were made.'))).toBe(true);
        expect(pickerCalls).toHaveLength(0);

        expect(fs.readFileSync(globalPath, 'utf-8')).toBe(oldRaw);
        const dir = path.dirname(globalPath);
        const backups = fs.readdirSync(dir).filter((f) => f.startsWith('config.json.bak-'));
        expect(backups).toHaveLength(0);
    });

    // app#1197: the byte-level "would the serialized config change" compare
    // used to trigger a backup here too, because the FINAL config gains a
    // workspaceId only after workspace resolution runs. Comparing credentials
    // (host + apiKey) instead means a same-account re-login backs up nothing.
    it('same-credential re-login: no backup file is created and no prompt is shown, even though the final config gains a workspaceId', async () => {
        const globalPath = writeGlobal(env.home, { host: HOST(), apiKey: 'same-key' });

        const config: Config = { host: HOST(), apiKey: 'same-key' };
        const oneWorkspace: WorkspaceLookupRecord[] = [
            { id: 'ws-1', name: 'Only Workspace', slug: 'only-workspace' },
        ];

        await completeLogin(config, oneWorkspace, { global: true });

        const dir = path.dirname(globalPath);
        const backups = fs.readdirSync(dir).filter((f) => f.startsWith('config.json.bak-'));
        expect(backups).toHaveLength(0);
        expect(logLines.some((l) => l.includes('Backup saved to'))).toBe(false);

        const newConfig = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
        expect(newConfig.apiKey).toBe('same-key');
        expect(newConfig.workspaceId).toBe('ws-1');
    });
});

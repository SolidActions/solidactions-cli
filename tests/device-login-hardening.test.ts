import fs from 'fs';
import http from 'http';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deviceLogin } from '../src/commands/device-login';
import { preflightDeviceLoginWrite } from '../src/commands/login';
import { makeTmpEnv, writeGlobal } from './helpers';

class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

describe('device login destination and credential hardening', () => {
    let server: http.Server;
    let port: number;
    let deviceCodeRequests: number;
    let workspaceStatus: number;
    let workspaceBody: unknown;
    let onTokenRequest: (() => void) | undefined;
    let onWorkspaceRequest: (() => void) | undefined;
    let env: ReturnType<typeof makeTmpEnv>;
    let originalExit: typeof process.exit;
    let originalIsTTY: boolean | undefined;
    let originalLog: typeof console.log;
    let originalError: typeof console.error;
    let logLines: string[];
    let errorLines: string[];

    const host = () => `http://127.0.0.1:${port}`;
    const globalPath = () => path.join(env.home, '.solidactions', 'config.json');

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            if (req.method === 'POST' && req.url === '/oauth/device/code') {
                deviceCodeRequests++;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    device_code: 'device-code',
                    user_code: 'ABCD-EFGH',
                    verification_uri: `${host()}/device`,
                    expires_in: 60,
                    interval: 0.001,
                }));
                return;
            }
            if (req.method === 'POST' && req.url === '/oauth/token') {
                onTokenRequest?.();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ access_token: 'approved-token', expires_in: 3600 }));
                return;
            }
            if (req.method === 'GET' && req.url === '/api/v1/workspaces') {
                onWorkspaceRequest?.();
                res.writeHead(workspaceStatus, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(workspaceBody));
                return;
            }
            res.writeHead(404).end();
        });
        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', () => {
                port = (server.address() as { port: number }).port;
                resolve();
            });
        });
    });

    afterAll(() => new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    }));

    beforeEach(() => {
        env = makeTmpEnv();
        deviceCodeRequests = 0;
        workspaceStatus = 200;
        workspaceBody = { data: [] };
        onTokenRequest = undefined;
        onWorkspaceRequest = undefined;

        originalExit = process.exit;
        (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };
        originalIsTTY = process.stdin.isTTY;
        Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
        logLines = [];
        errorLines = [];
        originalLog = console.log;
        originalError = console.error;
        console.log = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };
        console.error = (...args: unknown[]) => { errorLines.push(args.map(String).join(' ')); };
    });

    afterEach(() => {
        (process as any).exit = originalExit;
        Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
        console.log = originalLog;
        console.error = originalError;
        env.cleanup();
    });

    async function expectExit(action: () => Promise<void>, code = 1): Promise<void> {
        let caught: ProcessExitError | undefined;
        try {
            await action();
        } catch (error) {
            if (error instanceof ProcessExitError) caught = error;
            else throw error;
        }
        expect(caught?.code).toBe(code);
    }

    it('requires an explicit destination without a TTY before issuing a device code', async () => {
        await expectExit(() => deviceLogin({ host: host() }));

        expect(deviceCodeRequests).toBe(0);
        expect(errorLines.join('\n')).toContain(
            'No TTY detected. Re-run with the config destination made explicit: '
            + 'solidactions login --device --global --workspace <name>',
        );
    });

    it('aborts on destination-prompt EOF before a device code can be requested', async () => {
        let wouldRequestDeviceCode = 0;

        await expectExit(async () => {
            await preflightDeviceLoginWrite({}, {
                isTTY: true,
                destinationQuestion: async () => undefined,
            });
            wouldRequestDeviceCode++;
        });

        expect(wouldRequestDeviceCode).toBe(0);
        expect(errorLines.join('\n')).toContain('Input closed before a config destination was selected');
    });

    it('treats overwrite-confirmation EOF as decline before a device code can be requested', async () => {
        writeGlobal(env.home, { host: 'https://old.example', apiKey: 'old-token' });
        let wouldRequestDeviceCode = 0;

        await expectExit(async () => {
            await preflightDeviceLoginWrite({ global: true }, {
                isTTY: true,
                overwriteQuestion: async () => undefined,
            });
            wouldRequestDeviceCode++;
        }, 0);

        expect(wouldRequestDeviceCode).toBe(0);
        expect(deviceCodeRequests).toBe(0);
        expect(logLines.join('\n')).toContain('no device code was requested');
    });

    it('preserves normal destination and affirmative overwrite prompt answers', async () => {
        const localPreflight = await preflightDeviceLoginWrite({}, {
            isTTY: true,
            destinationQuestion: async () => 'local',
        });
        expect(localPreflight.target).toBe('local');

        writeGlobal(env.home, { host: 'https://old.example', apiKey: 'old-token' });
        const globalPreflight = await preflightDeviceLoginWrite({ global: true }, {
            isTTY: true,
            overwriteQuestion: async () => 'yes',
        });
        expect(globalPreflight.target).toBe('global');
        expect(globalPreflight.backupPath).toContain('config.json.bak-');
        expect(deviceCodeRequests).toBe(0);
    });

    it('rejects mutually exclusive destinations before issuing a device code', async () => {
        await expectExit(() => deviceLogin({ host: host(), local: true, global: true }));
        expect(deviceCodeRequests).toBe(0);
    });

    it('rejects a .solidactions file before issuing a device code', async () => {
        fs.writeFileSync(path.join(env.home, '.solidactions'), 'not a directory');

        await expectExit(() => deviceLogin({ host: host(), global: true }));

        expect(deviceCodeRequests).toBe(0);
        expect(errorLines.join('\n')).toContain(path.join(env.home, '.solidactions'));
    });

    it('rejects a read-only destination before issuing a device code', async () => {
        const configDir = path.dirname(globalPath());
        fs.mkdirSync(configDir);
        fs.chmodSync(configDir, 0o500);

        await expectExit(() => deviceLogin({ host: host(), global: true }));

        expect(deviceCodeRequests).toBe(0);
        expect(errorLines.join('\n')).toContain('not writable');
        fs.chmodSync(configDir, 0o700);
    });

    it('reuses the preflighted target and persists the token before workspace discovery', async () => {
        const originalPath = globalPath();
        const otherHome = path.join(path.dirname(env.home), 'other-home');
        fs.mkdirSync(otherHome);
        let baseConfigAtDiscovery: unknown;
        onTokenRequest = () => {
            process.env.HOME = otherHome;
        };
        onWorkspaceRequest = () => {
            baseConfigAtDiscovery = JSON.parse(fs.readFileSync(originalPath, 'utf-8'));
        };
        workspaceBody = {
            data: [{ id: 'ws-1', name: 'Only Workspace', slug: 'only-workspace' }],
            scope: { mode: 'single', workspace_ids: ['ws-1'] },
        };

        await deviceLogin({ host: host(), global: true });

        expect(baseConfigAtDiscovery).toEqual({ host: host(), apiKey: 'approved-token' });
        expect(fs.existsSync(path.join(otherHome, '.solidactions', 'config.json'))).toBe(false);
        expect(JSON.parse(fs.readFileSync(originalPath, 'utf-8'))).toMatchObject({
            host: host(),
            apiKey: 'approved-token',
            workspace: 'only-workspace',
            workspaceId: 'ws-1',
            scopeMode: 'single',
            scopedWorkspaceIds: ['ws-1'],
        });
        // "Auto-selected workspace:" is status text on stderr, not the command's own output.
        expect(errorLines.join('\n')).toContain('Auto-selected workspace: Only Workspace');
    });

    it('keeps a backup and the approved credential when workspace discovery fails', async () => {
        const existingPath = writeGlobal(env.home, { host: 'https://old.example', apiKey: 'old-token' });
        const oldRaw = fs.readFileSync(existingPath, 'utf-8');
        workspaceStatus = 503;
        workspaceBody = { message: 'temporarily unavailable' };

        await expectExit(() => deviceLogin({ host: host(), global: true }));

        expect(JSON.parse(fs.readFileSync(existingPath, 'utf-8'))).toEqual({
            host: host(),
            apiKey: 'approved-token',
        });
        const backup = fs.readdirSync(path.dirname(existingPath))
            .find((entry) => entry.startsWith('config.json.bak-'));
        expect(backup).toBeDefined();
        expect(fs.readFileSync(path.join(path.dirname(existingPath), backup!), 'utf-8')).toBe(oldRaw);
        const output = [...logLines, ...errorLines].join('\n');
        expect(output).toContain('Authentication was saved');
        expect(output).toContain('solidactions workspace set <name>');
        expect(logLines.findIndex((line) => line.includes('will be overwritten'))).toBeLessThan(
            logLines.findIndex((line) => line.includes('Requesting device authorization')),
        );
    });

    it('does not claim success when a device login ends with no workspace selected (multiple workspaces, non-interactive)', async () => {
        workspaceBody = {
            data: [
                { id: 'ws-1', name: 'First Workspace', slug: 'first-workspace' },
                { id: 'ws-2', name: 'Second Workspace', slug: 'second-workspace' },
            ],
            scope: { mode: 'all', workspace_ids: [] },
        };

        await deviceLogin({ host: host(), global: true });

        const output = [...logLines, ...errorLines].join('\n');
        expect(output).not.toContain('Logged in successfully!');
        expect(output).not.toContain('Next step');
        expect(output).not.toContain('Quick start');
        expect(output).toContain(`Authentication saved to ${globalPath()}`);

        expect(JSON.parse(fs.readFileSync(globalPath(), 'utf-8')).workspaceId).toBeUndefined();
    });

    it('keeps the approved credential when an explicit workspace does not match', async () => {
        workspaceBody = {
            data: [{ id: 'ws-1', name: 'Only Workspace', slug: 'only-workspace' }],
            scope: { mode: 'all', workspace_ids: [] },
        };

        await expectExit(() => deviceLogin({
            host: host(),
            global: true,
            workspace: 'Missing Workspace',
        }));

        expect(JSON.parse(fs.readFileSync(globalPath(), 'utf-8'))).toMatchObject({
            host: host(),
            apiKey: 'approved-token',
            scopeMode: 'all',
        });
        const output = [...logLines, ...errorLines].join('\n');
        expect(output).toContain('Authentication was saved');
        expect(output).toContain('solidactions workspace list');
        expect(output).toContain('solidactions workspace set <name>');
    });

    it('review fix #2: keeps the approved credential and describes the real ambiguity when an explicit workspace name is also its org\'s name', async () => {
        workspaceBody = {
            data: [
                { id: 'ws-1', name: '10TC', slug: '10tc', org_name: '10TC', role: 'admin' },
                { id: 'ws-2', name: '10TC Sales', slug: '10tc-sales', org_name: '10TC', role: 'member' },
            ],
            scope: { mode: 'all', workspace_ids: [] },
        };

        await expectExit(() => deviceLogin({
            host: host(),
            global: true,
            workspace: '10TC',
        }));

        expect(JSON.parse(fs.readFileSync(globalPath(), 'utf-8'))).toMatchObject({
            host: host(),
            apiKey: 'approved-token',
            scopeMode: 'all',
        });
        const output = [...logLines, ...errorLines].join('\n');
        // The credentialPersisted branch must describe the REAL failure
        // (ambiguous), not the old blanket "was not found" copy.
        expect(output).toContain('is both an organization name and a workspace name');
        expect(output).toContain('10TC Sales');
        expect(output).toContain('Authentication was saved');
        expect(output).toContain('solidactions workspace list');
        expect(output).toContain('solidactions workspace set <name>');
    });

    it('review fix #2: keeps the approved credential and describes the real org-only failure when an explicit workspace name is actually an organization', async () => {
        workspaceBody = {
            data: [
                { id: 'ws-1', name: 'Operations', slug: 'ops', org_name: 'Test Org', role: 'admin' },
                { id: 'ws-2', name: 'Engineering', slug: 'eng', org_name: 'Test Org', role: 'member' },
            ],
            scope: { mode: 'all', workspace_ids: [] },
        };

        await expectExit(() => deviceLogin({
            host: host(),
            global: true,
            workspace: 'Test Org',
        }));

        expect(JSON.parse(fs.readFileSync(globalPath(), 'utf-8'))).toMatchObject({
            host: host(),
            apiKey: 'approved-token',
            scopeMode: 'all',
        });
        const output = [...logLines, ...errorLines].join('\n');
        expect(output).toContain('is an organization, not a workspace.');
        expect(output).toContain('Operations');
        expect(output).toContain('Engineering');
        expect(output).toContain('Authentication was saved');
        expect(output).toContain('solidactions workspace list');
        expect(output).toContain('solidactions workspace set <name>');
    });
});

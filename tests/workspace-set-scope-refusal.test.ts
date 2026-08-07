import http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceSet } from '../src/commands/workspaces';
import { ensureWorkspaceSelected } from '../src/utils/api';
import { readConfigFile } from '../src/utils/config';
import { makeTmpEnv, writeGlobal } from './helpers';

describe('workspace set — scoped token refusal', () => {
    let env: ReturnType<typeof makeTmpEnv>;
    let exitSpy: any;
    let errorSpy: any;
    let logSpy: any;

    beforeEach(() => {
        env = makeTmpEnv();
        exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        env?.cleanup();
    });

    const WS_A = '11111111-1111-1111-1111-111111111111';
    const WS_B = '22222222-2222-2222-2222-222222222222';

    it('refuses to switch to a workspace outside a subset-scoped token without a network call', async () => {
        writeGlobal(env.home, {
            host: 'http://127.0.0.1:1', // unroutable; a network call here would hang/fail the test
            apiKey: 'sk_test',
            workspaceId: WS_A,
            scopeMode: 'subset',
            scopedWorkspaceIds: [WS_A],
        });

        await expect(workspaceSet(WS_B, { global: true })).rejects.toThrow('exit');

        expect(errorSpy.mock.calls.join(' ')).toContain('scoped to workspace');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('allows switching to a workspace within scope (falls through to network resolution)', async () => {
        const server = http.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ workspaces: { Org: [{ id: WS_A, slug: 'ws-a', name: 'Workspace A' }] } }));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as { port: number }).port;

        try {
            writeGlobal(env.home, {
                host: `http://127.0.0.1:${port}`,
                apiKey: 'sk_test',
                workspaceId: WS_A,
                scopeMode: 'subset',
                scopedWorkspaceIds: [WS_A],
            });

            await workspaceSet(WS_A, { global: true });

            expect(exitSpy).not.toHaveBeenCalled();
            expect(logSpy.mock.calls.join(' ')).toContain('Workspace set to');
        } finally {
            await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
        }
    });

    it('persists scope from a scoped /v1/workspaces response inside ensureWorkspaceSelected', async () => {
        const server = http.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                workspaces: { Org: [{ id: 'ws-a', name: 'Workspace A', role: 'member' }] },
                scope: { mode: 'single', workspace_ids: ['ws-a'] },
            }));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as { port: number }).port;

        try {
            const globalPath = writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'sk_test' });

            const config = { host: `http://127.0.0.1:${port}`, apiKey: 'sk_test' };
            await ensureWorkspaceSelected(config);

            const written = readConfigFile(globalPath);
            expect(written?.scopeMode).toBe('single');
            expect(written?.scopedWorkspaceIds).toEqual(['ws-a']);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
        }
    });

    it('leaves scope fields absent for a sanctum (scope: null) response', async () => {
        const server = http.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                workspaces: { Org: [{ id: 'ws-a', name: 'Workspace A', role: 'member' }] },
                scope: null,
            }));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as { port: number }).port;

        try {
            const globalPath = writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'sk_test' });

            const config = { host: `http://127.0.0.1:${port}`, apiKey: 'sk_test' };
            await ensureWorkspaceSelected(config);

            const written = readConfigFile(globalPath);
            expect(written?.scopeMode).toBeUndefined();
            expect(written?.scopedWorkspaceIds).toBeUndefined();
        } finally {
            await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
        }
    });
});

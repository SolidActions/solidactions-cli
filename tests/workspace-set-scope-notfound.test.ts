/**
 * Issue #73: `workspace set <name-or-id>` couldn't distinguish "workspace
 * doesn't exist" from "exists but outside this session's OAuth grant". A
 * scoped (single/subset) session only lists the workspaces its grant covers,
 * so a slug/name miss must surface a distinct, re-auth-suggesting message
 * instead of the generic not-found.
 *
 * Test-double policy: no mocks — drives workspaceSet() against a real local
 * HTTP server returning a real scoped /v1/workspaces payload, matching the
 * pattern in tests/workspace-set-scope-refusal.test.ts.
 */
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceSet } from '../src/commands/workspaces';
import { makeTmpEnv, writeGlobal } from './helpers';

describe('workspace set — scoped not-found disambiguation (#73)', () => {
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

    async function withServer(payload: unknown, run: (port: number) => Promise<void>) {
        const server = http.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as { port: number }).port;
        try {
            await run(port);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
        }
    }

    it('a slug miss under a subset scope suggests re-auth with broader scope', async () => {
        await withServer(
            {
                workspaces: { Org: [{ id: WS_A, slug: 'ws-a', name: 'Workspace A' }] },
                scope: { mode: 'subset', workspace_ids: [WS_A] },
            },
            async (port) => {
                writeGlobal(env.home, {
                    host: `http://127.0.0.1:${port}`,
                    apiKey: 'sk_test',
                    workspaceId: WS_A,
                    scopeMode: 'subset',
                    scopedWorkspaceIds: [WS_A],
                });

                // 'other-team' is a valid-looking slug (not a UUID) so it passes
                // the local pre-check and reaches the server-authoritative miss.
                await expect(workspaceSet('other-team', { global: true })).rejects.toThrow('exit');

                const errText = errorSpy.mock.calls.join(' ');
                expect(errText).toContain("not found in this session's authorized workspaces");
                expect(errText).toContain('login --device');
                expect(exitSpy).toHaveBeenCalledWith(1);
            },
        );
    });

    it('a slug miss under an all-scope session keeps the plain not-found message', async () => {
        await withServer(
            {
                workspaces: { Org: [{ id: WS_A, slug: 'ws-a', name: 'Workspace A' }] },
                scope: { mode: 'all', workspace_ids: [] },
            },
            async (port) => {
                writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'sk_test' });

                await expect(workspaceSet('other-team', { global: true })).rejects.toThrow('exit');

                const errText = errorSpy.mock.calls.join(' ');
                expect(errText).toContain('not found');
                expect(errText).not.toContain('authorized workspaces');
                expect(exitSpy).toHaveBeenCalledWith(1);
            },
        );
    });
});

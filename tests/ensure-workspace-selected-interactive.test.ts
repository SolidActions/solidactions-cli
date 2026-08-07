import fs from 'fs';
import http from 'http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureWorkspaceSelected } from '../src/utils/api';
import { makeTmpEnv, writeGlobal } from './helpers';

class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

describe('ensureWorkspaceSelected interactive multi-workspace selection', () => {
    let server: http.Server;
    let port: number;
    let workspaceBody: unknown;
    let env: ReturnType<typeof makeTmpEnv>;
    let originalExit: typeof process.exit;
    let originalIsTTY: boolean | undefined;
    let originalLog: typeof console.log;
    let logLines: string[];

    beforeAll(async () => {
        server = http.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(workspaceBody));
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
        originalExit = process.exit;
        (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };
        originalIsTTY = process.stdin.isTTY;
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        originalLog = console.log;
        logLines = [];
        console.log = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };
        workspaceBody = {
            workspaces: {
                'Acme Org': [
                    { id: 'ws-1', name: 'First Workspace', slug: 'first-workspace', tenant_name: 'Acme Org', role: 'admin' },
                    { id: 'ws-2', name: 'Second Workspace', slug: 'second-workspace', tenant_name: 'Acme Org', role: 'member' },
                ],
            },
        };
    });

    afterEach(() => {
        (process as any).exit = originalExit;
        Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
        console.log = originalLog;
        env.cleanup();
    });

    it('treats EOF as cancellation, exits 1, and persists no workspace', async () => {
        const configPath = writeGlobal(env.home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'existing-token',
        });

        await expect(
            ensureWorkspaceSelected(
                { host: `http://127.0.0.1:${port}`, apiKey: 'existing-token' },
                { question: async () => undefined },
            ),
        ).rejects.toMatchObject({ code: 1 });

        expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).workspaceId).toBeUndefined();
    });

    it('re-prompts on invalid input and persists the later valid selection', async () => {
        const configPath = writeGlobal(env.home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'existing-token',
        });
        const answers = ['banana', '9', '2'];

        const config = await ensureWorkspaceSelected(
            { host: `http://127.0.0.1:${port}`, apiKey: 'existing-token' },
            { question: async () => answers.shift() },
        );

        expect(config.workspaceId).toBe('ws-2');
        expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).workspaceId).toBe('ws-2');
    });

    it('prints the (org_name, role) annotation for each workspace in the numbered list', async () => {
        writeGlobal(env.home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'existing-token',
        });

        await ensureWorkspaceSelected(
            { host: `http://127.0.0.1:${port}`, apiKey: 'existing-token' },
            { question: async () => '1' },
        );

        expect(logLines.some((line) => line.includes('First Workspace') && line.includes('(Acme Org, admin)'))).toBe(true);
    });
});

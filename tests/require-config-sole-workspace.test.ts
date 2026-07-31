import fs from 'fs';
import http from 'http';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { requireConfigWithWorkspace } from '../src/utils/api';
import { makeTmpEnv, writeGlobal } from './helpers';

class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

describe('requireConfigWithWorkspace for existing unpinned configs', () => {
    let server: http.Server;
    let port: number;
    let workspaceBody: unknown;
    let env: ReturnType<typeof makeTmpEnv>;
    let originalExit: typeof process.exit;
    let originalIsTTY: boolean | undefined;
    let originalError: typeof console.error;
    let errorLines: string[];

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
        Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
        originalError = console.error;
        errorLines = [];
        console.error = (...args: unknown[]) => { errorLines.push(args.map(String).join(' ')); };
    });

    afterEach(() => {
        (process as any).exit = originalExit;
        Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
        console.error = originalError;
        env.cleanup();
    });

    it('discovers and persists the sole workspace without a TTY', async () => {
        const configPath = writeGlobal(env.home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'existing-token',
        });
        workspaceBody = {
            data: [{ id: 'ws-1', name: 'Only Workspace', slug: 'only-workspace' }],
        };

        const config = await requireConfigWithWorkspace();

        expect(config.workspaceId).toBe('ws-1');
        expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).workspaceId).toBe('ws-1');
    });

    it('refuses ambiguous multiple workspaces without a TTY and gives an explicit set command', async () => {
        writeGlobal(env.home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'existing-token',
        });
        workspaceBody = {
            data: [
                { id: 'ws-1', name: 'First Workspace' },
                { id: 'ws-2', name: 'Second Workspace' },
            ],
        };

        await expect(requireConfigWithWorkspace()).rejects.toMatchObject({ code: 1 });
        expect(errorLines.join('\n')).toContain('solidactions workspace set <name-or-id>');
    });
});

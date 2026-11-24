/**
 * A browser sign-in is marked in the config file (`signIn: 'browser'`, written by
 * `deviceLogin` next to `apiKey`), so a 401 can say the sign-in has ended instead
 * of the generic "Authentication failed" text (#2911 part 4, cli#275).
 *
 * Real in-process HTTP server and real files under a temporary HOME; no mocks.
 * Console output is captured only to keep the test output pristine.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deviceLogin } from '../src/commands/device-login';
import { login } from '../src/commands/login';
import { authFailedLine } from '../src/utils/api';
import { makeTmpEnv, writeGlobal, writeLocal } from './helpers';

const GENERIC_LINE = 'Authentication failed against https://host.example. '
    + 'Run "solidactions login --global" to re-configure.';
const ENDED_LINE = 'Your browser sign-in to https://host.example has ended. '
    + 'Run "solidactions login --global" to sign in again.';

describe('a browser sign-in that ended says so', () => {
    let server: http.Server;
    let port: number;
    let env: ReturnType<typeof makeTmpEnv>;
    let originalCwd: string;
    let originalLog: typeof console.log;
    let originalError: typeof console.error;

    const host = () => `http://127.0.0.1:${port}`;
    const globalPath = () => path.join(env.home, '.solidactions', 'config.json');
    const readGlobal = () => JSON.parse(fs.readFileSync(globalPath(), 'utf-8'));

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            const json = (body: unknown) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(body));
            };
            if (req.method === 'POST' && req.url === '/oauth/device/code') {
                json({
                    device_code: 'device-code',
                    user_code: 'ABCD-EFGH',
                    verification_uri: `${host()}/device`,
                    expires_in: 60,
                    interval: 0.001,
                });
                return;
            }
            if (req.method === 'POST' && req.url === '/oauth/token') {
                json({ access_token: 'approved-token', expires_in: 3600 });
                return;
            }
            if (req.method === 'GET' && req.url === '/api/v1/workspaces') {
                json({
                    data: [{ id: 'ws-1', name: 'Only Workspace', slug: 'only-workspace' }],
                    scope: { mode: 'all', workspace_ids: [] },
                });
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
        server.close((error) => (error ? reject(error) : resolve()));
    }));

    beforeEach(() => {
        env = makeTmpEnv();
        originalCwd = process.cwd();
        process.chdir(env.cwd);
        originalLog = console.log;
        originalError = console.error;
        console.log = () => {};
        console.error = () => {};
    });

    afterEach(() => {
        console.log = originalLog;
        console.error = originalError;
        process.chdir(originalCwd);
        env.cleanup();
    });

    it('deviceLogin writes signIn: browser into the config file next to apiKey, and keeps it after the workspace is chosen', async () => {
        await deviceLogin({ host: host(), global: true });

        expect(readGlobal()).toMatchObject({
            host: host(),
            apiKey: 'approved-token',
            signIn: 'browser',
            workspace: 'only-workspace',
            workspaceId: 'ws-1',
            scopeMode: 'all',
        });
    });

    it('a key sign-in over an old browser sign-in with the same credentials writes no signIn', async () => {
        writeGlobal(env.home, { host: host(), apiKey: 'typed-key', signIn: 'browser' });
        expect(readGlobal().signIn).toBe('browser');

        await login('typed-key', { host: host(), global: true });

        const written = readGlobal();
        expect(written.apiKey).toBe('typed-key');
        expect(written.workspaceId).toBe('ws-1');
        expect('signIn' in written).toBe(false);
        expect(authFailedLine('https://host.example')).toBe(GENERIC_LINE);
    });

    it('authFailedLine names the ended browser sign-in for a config with the marker', () => {
        writeGlobal(env.home, { host: 'https://host.example', apiKey: 'approved-token', signIn: 'browser' });

        expect(authFailedLine('https://host.example')).toBe(ENDED_LINE);
    });

    it('authFailedLine keeps the generic text for a key config without the marker', () => {
        writeGlobal(env.home, { host: 'https://host.example', apiKey: 'sk_typed_key' });

        expect(authFailedLine('https://host.example')).toBe(GENERIC_LINE);
    });

    it('authFailedLine keeps the generic text when SOLIDACTIONS_API_KEY is set: the environment wins over a browser config', () => {
        writeGlobal(env.home, { host: 'https://host.example', apiKey: 'approved-token', signIn: 'browser' });
        process.env.SOLIDACTIONS_API_KEY = 'sk_from_environment';

        expect(authFailedLine('https://host.example')).toBe(GENERIC_LINE);
    });

    it('authFailedLine keeps the generic text when a folder config brings its own key over a global browser config', () => {
        writeGlobal(env.home, { host: 'https://host.example', apiKey: 'approved-token', signIn: 'browser' });
        writeLocal(env.cwd, { host: 'https://host.example', apiKey: 'sk_folder_key' });

        expect(authFailedLine('https://host.example')).toBe(GENERIC_LINE);
    });

    it('authFailedLine names the ended browser sign-in when a folder config only pins a workspace over a global browser config', () => {
        writeGlobal(env.home, { host: 'https://host.example', apiKey: 'approved-token', signIn: 'browser' });
        writeLocal(env.cwd, { workspace: 'pinned', workspaceId: 'ws-9' });

        expect(authFailedLine('https://host.example')).toBe(ENDED_LINE);
    });

    it('authFailedLine keeps the generic text when no config exists', () => {
        expect(fs.existsSync(globalPath())).toBe(false);

        expect(authFailedLine('https://host.example')).toBe(GENERIC_LINE);
    });

    it('authFailedLine keeps the generic text when the config file cannot be read', () => {
        fs.mkdirSync(path.dirname(globalPath()), { recursive: true });
        fs.writeFileSync(globalPath(), '{ not json');

        expect(authFailedLine('https://host.example')).toBe(GENERIC_LINE);
    });
});

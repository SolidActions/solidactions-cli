/**
 * `solidactions env pull` against a token that lacks the `env:reveal` ability.
 *
 * Uses a real in-process HTTP server (no mocks/stubs) that 403s the
 * `reveal=true` fetch with the app's `token_missing_ability` shape. Asserts
 * the printed stderr carries actionable guidance instead of a raw
 * `Failed: 403 <object>` dump.
 */

import * as http from 'http';
import * as path from 'path';
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { envPull } from '../src/commands/env-pull';
import { makeTmpEnv, writeGlobal } from './helpers';

const FIXTURE_VARS = [
    { env_name: 'SECRET_VAR', is_secret: true, source_type: 'plain', resolved_value: null },
];

let stubServer: http.Server;
let stubPort: number;

beforeAll(async () => {
    stubServer = http.createServer((req, res) => {
        if (req.url?.includes('reveal=true')) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                code: 'token_missing_ability',
                message: "This API key does not have the 'env:reveal' ability.",
                required_ability: 'env:reveal',
            }));
            return;
        }
        // Unrevealed check-for-secrets fetch succeeds normally.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(FIXTURE_VARS));
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

describe('envPull — reveal ability denied', () => {
    let env: ReturnType<typeof makeTmpEnv>;
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${stubPort}`, apiKey: 'test-key', workspaceId: 'ws-1' });
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        env.cleanup();
    });

    it('prints actionable env:reveal guidance instead of a raw Failed: 403 dump', async () => {
        const outputPath = path.join(env.cwd, '.env.dev');

        await envPull('my-project', { env: 'dev', output: outputPath, yes: true });

        const printed = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');

        // States which step needed the ability.
        expect(printed).toContain("Reading variable values requires the 'env:reveal' ability.");

        // Carries the interceptor-augmented actionable guidance, not a raw dump.
        expect(printed).toContain('API key');
        expect(printed).toContain('Settings');
        expect(printed).not.toMatch(/Failed: 403/);
        expect(printed).not.toContain('[object Object]');

        expect(exitSpy).toHaveBeenCalledWith(1);
    });
});

/**
 * A 403 on this path is not always about reveal — it can equally be a
 * workspace-scope or project-policy denial. Blaming `env:reveal` for those
 * sends the user off to mint an API key that would not have helped, so the
 * ability is only named when the server actually asked for it.
 */
describe('envPull — a non-reveal 403 is not blamed on env:reveal', () => {
    let denyServer: http.Server;
    let denyPort: number;
    let env: ReturnType<typeof makeTmpEnv>;
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeAll(async () => {
        denyServer = http.createServer((req, res) => {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                code: 'workspace_forbidden',
                message: 'This session is scoped to a limited set of workspaces.',
            }));
        });

        await new Promise<void>((resolve) => {
            denyServer.listen(0, '127.0.0.1', () => {
                denyPort = (denyServer.address() as { port: number }).port;
                resolve();
            });
        });
    });

    afterAll(() => {
        return new Promise<void>((resolve, reject) => {
            denyServer.close((err) => (err ? reject(err) : resolve()));
        });
    });

    beforeEach(() => {
        env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${denyPort}`, apiKey: 'test-key', workspaceId: 'ws-1' });
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        env.cleanup();
    });

    it('reports the denial without naming env:reveal when the server did not ask for it', async () => {
        const outputPath = path.join(env.cwd, '.env.dev');

        await envPull('my-project', { env: 'dev', output: outputPath, yes: true });

        const printed = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');

        expect(printed).not.toContain('env:reveal');
        expect(printed).toContain('Permission denied.');
        expect(printed).toContain('limited set of workspaces');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
});

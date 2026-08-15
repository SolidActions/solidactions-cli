/**
 * A failure writing the .env must name the file, not blame the connection —
 * and a genuine connection failure must still say so.
 *
 * process.exit / console.error are intercepted because envPull's error path
 * ends in process.exit(1); same pattern as env-pull-reveal-denied.test.ts.
 */

import fs from 'fs';
import http from 'http';
import path from 'path';
import { describe, expect, it, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { envPull } from '../src/commands/env-pull';
import { makeTmpEnv, writeGlobal } from './helpers';

const FIXTURE_VARS = [
    { env_name: 'API_TOKEN', resolved_value: 'super-secret', source_type: 'plain', is_secret: true },
];

let stubServer: http.Server;
let stubPort: number;

beforeAll(async () => {
    stubServer = http.createServer((_req, res) => {
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

afterAll(() => new Promise<void>((resolve, reject) => {
    stubServer.close((err) => (err ? reject(err) : resolve()));
}));

describe('envPull error reporting', () => {
    let env: ReturnType<typeof makeTmpEnv>;
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        env = makeTmpEnv();
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        env.cleanup();
    });

    function printed(): string {
        return errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    }

    it('names the file when the write fails', async () => {
        writeGlobal(env.home, { host: `http://127.0.0.1:${stubPort}`, apiKey: 'test-key', workspaceId: 'ws-1' });
        const dest = path.join(env.cwd, '.env.dev');
        fs.mkdirSync(dest); // a directory where the .env should go

        await envPull('my-project', { env: 'dev', output: dest, yes: true });

        expect(printed()).toContain('Failed to write');
        expect(printed()).not.toContain('Connection failed');
    });

    it('still reports a genuine connection failure as such', async () => {
        // Port 1 is reserved and closed — axios fails ECONNREFUSED, which also
        // carries an error.code, so the new branch must not swallow it.
        writeGlobal(env.home, { host: 'http://127.0.0.1:1', apiKey: 'test-key', workspaceId: 'ws-1' });

        await envPull('my-project', { env: 'dev', output: path.join(env.cwd, '.env.dev'), yes: true });

        expect(printed()).toContain('Connection failed');
        expect(printed()).not.toContain('Failed to write');
    });
});

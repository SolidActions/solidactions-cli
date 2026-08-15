/**
 * `solidactions env pull` must leave every file it writes owner-only, on the
 * create path AND the overwrite path (writeFileSync's mode applies only on
 * creation, so a pre-existing 0644 .env is the case that matters).
 *
 * Real in-process HTTP stub, real temp dirs. umask is pinned to 022 — under a
 * 077 umask these assertions would pass against unfixed code.
 */

import fs from 'fs';
import http from 'http';
import path from 'path';
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { envPull } from '../src/commands/env-pull';
import { makeTmpEnv, writeGlobal } from './helpers';

const posixOnly = process.platform === 'win32' ? it.skip : it;

const FIXTURE_VARS = [
    { env_name: 'PLAIN', resolved_value: 'plain-value', source_type: 'plain', is_secret: false },
    { env_name: 'API_TOKEN', resolved_value: 'super-secret', source_type: 'plain', is_secret: true },
    {
        env_name: 'OAUTH_TOKEN',
        resolved_value: 'oauth-secret',
        source_type: 'oauth_connection',
        oauth_connection_name: 'Gmail',
        is_secret: true,
    },
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

describe('envPull file permissions', () => {
    let env: ReturnType<typeof makeTmpEnv>;
    let previousUmask: number;

    beforeEach(() => {
        previousUmask = process.umask(0o022);
        env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${stubPort}`, apiKey: 'test-key', workspaceId: 'ws-1' });
    });

    afterEach(() => {
        env.cleanup();
        process.umask(previousUmask);
    });

    function mode(p: string): number {
        return fs.statSync(p).mode & 0o777;
    }

    posixOnly('writes a new .env owner-only', async () => {
        const dest = path.join(env.cwd, '.env.dev');

        await envPull('my-project', { env: 'dev', output: dest, yes: true });

        expect(fs.readFileSync(dest, 'utf8')).toContain('API_TOKEN=super-secret');
        expect(mode(dest)).toBe(0o600);
        expect(fs.statSync(dest).mode & 0o077).toBe(0);
    });

    posixOnly('tightens an existing group-readable .env on overwrite', async () => {
        const dest = path.join(env.cwd, '.env.dev');
        fs.writeFileSync(dest, 'OLD=0\n');
        fs.chmodSync(dest, 0o644);
        expect(mode(dest)).toBe(0o644); // precondition

        await envPull('my-project', { env: 'dev', output: dest, yes: true });

        expect(fs.readFileSync(dest, 'utf8')).toContain('API_TOKEN=super-secret');
        expect(mode(dest)).toBe(0o600);
        expect(fs.statSync(dest).mode & 0o077).toBe(0);
    });

    posixOnly('leaves no temp file beside the written .env', async () => {
        const dest = path.join(env.cwd, '.env.dev');

        await envPull('my-project', { env: 'dev', output: dest, yes: true });

        expect(fs.readdirSync(env.cwd)).toEqual(['.env.dev']);
    });

    posixOnly('writes through a symlinked .env and keeps the link', async () => {
        const target = path.join(env.home, 'real.env');
        const link = path.join(env.cwd, '.env.dev');
        fs.writeFileSync(target, 'OLD=0\n');
        fs.chmodSync(target, 0o644);
        fs.symlinkSync(target, link);

        await envPull('my-project', { env: 'dev', output: link, yes: true });

        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(target, 'utf8')).toContain('API_TOKEN=super-secret');
        expect(mode(target)).toBe(0o600);
        expect(fs.statSync(target).mode & 0o077).toBe(0);
    });

    posixOnly('creates an OAuth-only .env owner-only (--update-oauth, no existing file)', async () => {
        const dest = path.join(env.cwd, '.env.dev');

        await envPull('my-project', { env: 'dev', output: dest, updateOauth: true });

        expect(fs.readFileSync(dest, 'utf8')).toContain('OAUTH_TOKEN=oauth-secret');
        expect(mode(dest)).toBe(0o600);
        expect(fs.statSync(dest).mode & 0o077).toBe(0);
    });

    posixOnly('tightens an existing .env when merging OAuth tokens (--update-oauth)', async () => {
        const dest = path.join(env.cwd, '.env.dev');
        fs.writeFileSync(dest, 'KEEP_ME=yes\n');
        fs.chmodSync(dest, 0o644);
        expect(mode(dest)).toBe(0o644); // precondition

        await envPull('my-project', { env: 'dev', output: dest, updateOauth: true });

        const written = fs.readFileSync(dest, 'utf8');
        expect(written).toContain('KEEP_ME=yes');
        expect(written).toContain('OAUTH_TOKEN=oauth-secret');
        expect(mode(dest)).toBe(0o600);
        expect(fs.statSync(dest).mode & 0o077).toBe(0);
    });
});

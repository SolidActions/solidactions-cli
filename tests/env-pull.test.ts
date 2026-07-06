/**
 * Tests for `solidactions env pull`
 *
 * Uses a real in-process HTTP server to stub the variable-mappings endpoint.
 * No mocks/stubs/spies — follows the pattern from project-create.test.ts.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { envPull } from '../src/commands/env-pull';
import { makeTmpEnv, writeGlobal } from './helpers';

// ---------------------------------------------------------------------------
// Stub API server — any request returns the same fixture mappings (no secrets,
// so envPull never prompts for confirmation).
// ---------------------------------------------------------------------------

const FIXTURE_VARS = [
    { env_name: 'X', resolved_value: 'plain-x', source_type: 'plain', is_secret: false },
    { env_name: 'Y', resolved_value: 'plain-y', source_type: 'plain', is_secret: false },
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

afterAll(() => {
    return new Promise<void>((resolve, reject) => {
        stubServer.close((err) => (err ? reject(err) : resolve()));
    });
});

describe('envPull', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${stubPort}`, apiKey: 'test-key', workspaceId: 'ws-1' });
    });

    afterEach(() => {
        env.cleanup();
    });

    it('prepends a header noting this .env is not read by `solidactions dev`', async () => {
        const outputPath = path.join(env.cwd, '.env.dev');

        await envPull('my-project', { env: 'dev', output: outputPath, yes: true });

        const content = fs.readFileSync(outputPath, 'utf8');
        const lines = content.split('\n');

        // Header block appears at the very top of the file.
        expect(lines[0]).toBe('# Variables pulled from SolidActions for my-project / dev.');
        expect(content).toContain('NOT read by `solidactions dev`');
        expect(content).toContain('-e <env>');
        expect(content).toContain('-i');

        // The actual variables still get written after the header.
        expect(content).toContain('X=plain-x');
        expect(content).toContain('Y=plain-y');
    });
});

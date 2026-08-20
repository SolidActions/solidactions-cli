/**
 * Regression contract for #1437 R1: a command's OWN --yes is never consent to the
 * CWD-inferred workspace.
 *
 * `database push` is the worst case and the one reproduced live: it declares -y as a
 * REQUIRED option (acknowledging the destructive replacement), so `assumeYes` was always
 * true there and the workspace confirmation was structurally unreachable on the
 * highest-blast-radius command in the CLI.
 *
 * Test-double policy: the real compiled CLI, a real temporary HOME and CWD, and a real
 * in-process HTTP server that records every request it receives. No mocks/spies/stubs.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpEnv, writeGlobal, writeLocal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

let server: http.Server;
let port: number;
let requests: string[] = [];

beforeAll(async () => {
    server = http.createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ message: 'the guard should have refused before any request' }));
    });
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    requests = [];
});

let env: ReturnType<typeof makeTmpEnv>;

afterEach(() => {
    env?.cleanup();
});

function writeLastUsed(home: string, workspaceId: string): void {
    const dir = path.join(home, '.solidactions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'state.json'),
        JSON.stringify({ workspaceId, label: 'old-ws', at: '2026-08-19T00:00:00.000Z' }, null, 2),
    );
}

function readLastUsed(home: string): string | undefined {
    const file = path.join(home, '.solidactions', 'state.json');
    return JSON.parse(fs.readFileSync(file, 'utf-8')).workspaceId;
}

describe("a command's own --yes is not workspace consent (#1437)", () => {
    it('database push -y into a changed CWD-inferred workspace refuses in a non-interactive shell and reaches no server', () => {
        env = makeTmpEnv();
        writeGlobal(env.home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            workspace: 'old-ws',
            workspaceId: 'ws-old-1111',
        });
        writeLocal(env.cwd, { workspace: 'new-ws', workspaceId: 'ws-new-2222' });
        writeLastUsed(env.home, 'ws-old-1111');

        const result = childProcess.spawnSync(
            process.execPath,
            [CLI_BINARY, 'database', 'push', 'mydb', 'snapshot.db', '-y'],
            {
                cwd: env.cwd,
                encoding: 'utf-8',
                env: { ...process.env, HOME: env.home, SOLIDACTIONS_WORKSPACE_ID: undefined },
            },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('re-run with -w ws-new-2222 to confirm the target workspace');
        expect(result.stderr).not.toContain('--yes to accept');
        expect(result.stdout).toBe('');
        expect(requests).toEqual([]);
        expect(readLastUsed(env.home)).toBe('ws-old-1111');
    });
});

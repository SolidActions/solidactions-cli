/**
 * Tests for `solidactions skill run <dir> -- <command...>`.
 *
 * Test-double policy: no mock/spy/stub libraries. Unit tests exercise the
 * exported pure helpers directly. The integration case spawns the real built
 * CLI binary (dist/index.js) as a subprocess against a real in-process HTTP
 * server (Node's http.createServer) standing in for the SolidActions API —
 * matching the pattern in tests/flag-consistency.test.ts.
 *
 * Two adaptations from a naive "call skillRunWithConfig in-process" test:
 *
 * 1. Spawn the built binary, don't call the function in-process. Production
 *    code runs the user's command with `stdio: 'inherit'` (real-time
 *    streaming + interactive stdin, matching the MCP sandbox_exec UX).
 *    `inherit` hands the grandchild the parent's raw file descriptor,
 *    bypassing `process.stdout.write` entirely — an in-process call can't
 *    capture it via a JS-level monkeypatch. Spawning the CLI as a subprocess
 *    of the *test* makes the fd chain capturable: the grandchild inherits
 *    the CLI process's fds, which are the test's own pipes.
 * 2. Use async `spawn`, not `spawnSync`, to launch the CLI. `spawnSync`
 *    blocks the calling process's event loop until the child exits — but
 *    the stub HTTP server lives in this same test process, so the CLI
 *    child's request back to it would never be accepted while the test is
 *    blocked inside `spawnSync`. Confirmed by direct repro: nesting
 *    spawnSync(CLI) -> [CLI does an async HTTP GET to the test's own
 *    in-process server] -> spawnSync(grandchild) deadlocks every time.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as childProcess from 'child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseEnvFile, assembleEnv } from '../src/commands/skill-run';
import { Config } from '../src/utils/config';

const config = { host: 'https://sa.test', apiKey: 'test-api-key', workspaceId: 'ws-123' } as Config;

describe('parseEnvFile', () => {
    it('parses KEY=VALUE lines, ignores comments/blanks, strips simple quotes', () => {
        const parsed = parseEnvFile('# comment\n\nFOO=bar\nQUOTED="a b"\nEQ=a=b\n');
        expect(parsed).toEqual({ FOO: 'bar', QUOTED: 'a b', EQ: 'a=b' });
    });
});

describe('assembleEnv', () => {
    it('layers resolved < fileVars < framework vars and warns on shadows', () => {
        const { env, warnings } = assembleEnv({
            resolved: { REGION: 'us-east-1', SHARED: 'from-platform' },
            fileVars: { SHARED: 'from-file', LOCAL_ONLY: 'x' },
            storageScope: null,
            dir: '/tmp/skill',
            config,
        });
        expect(env.SHARED).toBe('from-file');
        expect(warnings.join('\n')).toContain('SHARED');
        expect(env.SOLIDACTIONS_API_URL).toBe('https://sa.test/api/v1');
        expect(env.SOLIDACTIONS_API_TOKEN).toBe('test-api-key');
        expect(env.SOLIDACTIONS_WORKSPACE_ID).toBe('ws-123');
    });

    it('rejects reserved names from the env file with a warning', () => {
        const { env, warnings } = assembleEnv({
            resolved: {},
            fileVars: { SOLIDACTIONS_API_TOKEN: 'evil', PATH: '/evil', OK_VAR: 'fine' },
            storageScope: null,
            dir: '/tmp/skill',
            config,
        });
        expect(env.SOLIDACTIONS_API_TOKEN).toBe('test-api-key'); // framework wins
        expect(env.PATH).toBeUndefined(); // not injected by assembleEnv (process.env merge happens at spawn)
        expect(env.OK_VAR).toBe('fine');
        expect(warnings.join('\n')).toContain('SOLIDACTIONS_API_TOKEN');
        expect(warnings.join('\n')).toContain('PATH');
    });

    it('rejects reserved names from resolved crew vars with a warning, same as env-file vars', () => {
        const { env, warnings } = assembleEnv({
            resolved: { SOLIDACTIONS_API_TOKEN: 'evil-from-crew', PATH: '/evil-from-crew', OK_VAR: 'fine' },
            fileVars: {},
            storageScope: null,
            dir: '/tmp/skill',
            config,
        });
        expect(env.SOLIDACTIONS_API_TOKEN).toBe('test-api-key'); // framework wins, not the crew-resolved value
        expect(env.PATH).toBeUndefined(); // not injected by assembleEnv (process.env merge happens at spawn)
        expect(env.OK_VAR).toBe('fine');
        expect(warnings.join('\n')).toContain('SOLIDACTIONS_API_TOKEN');
        expect(warnings.join('\n')).toContain('PATH');
    });

    it('injects STATE_DIR only for storage.scope=crew and SHARED_DIR only for workspace', () => {
        const crew = assembleEnv({ resolved: {}, fileVars: {}, storageScope: 'crew', dir: '/tmp/skill', config });
        expect(crew.env.SOLIDACTIONS_STATE_DIR).toBe(path.join('/tmp/skill', '.sa-state'));
        expect(crew.env.SOLIDACTIONS_SHARED_DIR).toBeUndefined();

        const ws = assembleEnv({ resolved: {}, fileVars: {}, storageScope: 'workspace', dir: '/tmp/skill', config });
        expect(ws.env.SOLIDACTIONS_SHARED_DIR).toContain(path.join('.solidactions', 'shared', 'ws-123'));
        expect(ws.env.SOLIDACTIONS_STATE_DIR).toBeUndefined();

        const none = assembleEnv({ resolved: {}, fileVars: {}, storageScope: null, dir: '/tmp/skill', config });
        expect(none.env.SOLIDACTIONS_STATE_DIR).toBeUndefined();
        expect(none.env.SOLIDACTIONS_SHARED_DIR).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Integration: real HTTP server + real built CLI subprocess
// ---------------------------------------------------------------------------

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

describe('solidactions skill run — integration', () => {
    let stubServer: http.Server;
    let stubPort: number;

    beforeAll(async () => {
        if (!fs.existsSync(CLI_BINARY)) {
            throw new Error(`CLI not built — run \`npm run build\` first (expected: ${CLI_BINARY})`);
        }

        stubServer = http.createServer((req, res) => {
            if (req.url === '/api/v1/crews') {
                // fetchCrews() in src/utils/crew.ts reads response.data?.data.
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ data: [{ id: 7, name: 'my-crew' }] }));
                return;
            }
            if (req.url?.startsWith('/api/v1/crews/7/variables/resolve')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ variables: { PROBE: 'resolved' }, skipped_secrets: ['HIDDEN'] }));
                return;
            }
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'not found' }));
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

    it('resolves crew variables by name via GET /api/v1/crews, fetches env for the given environment, and injects them into the child process env, warning about skipped secrets', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-skill-run-test-'));
        fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: probe\ndescription: test skill\n---\n\nbody\n');

        try {
            const result = await new Promise<{ stdout: string; stderr: string; status: number | null }>((resolve, reject) => {
                const child = childProcess.spawn(
                    process.execPath,
                    [
                        CLI_BINARY, 'skill', 'run', dir,
                        '--crew', 'my-crew',
                        '--environment', 'dev',
                        '--',
                        'node', '-e', 'console.log("PROBE="+process.env.PROBE)',
                    ],
                    {
                        env: {
                            ...process.env,
                            SOLIDACTIONS_HOST: `http://127.0.0.1:${stubPort}`,
                            SOLIDACTIONS_API_KEY: 'test-api-key',
                            SOLIDACTIONS_WORKSPACE_ID: 'ws-123',
                        },
                    },
                );
                let stdout = '';
                let stderr = '';
                child.stdout.on('data', (chunk) => { stdout += chunk; });
                child.stderr.on('data', (chunk) => { stderr += chunk; });
                const timer = setTimeout(() => {
                    child.kill();
                    reject(new Error(`CLI timed out. stdout so far: ${stdout} stderr so far: ${stderr}`));
                }, 15_000);
                child.on('close', (status) => {
                    clearTimeout(timer);
                    resolve({ stdout, stderr, status });
                });
                child.on('error', (err) => {
                    clearTimeout(timer);
                    reject(err);
                });
            });

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('PROBE=resolved');
            expect(result.stderr).toContain('HIDDEN');
            expect(result.stderr).toContain('env:reveal');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);
});

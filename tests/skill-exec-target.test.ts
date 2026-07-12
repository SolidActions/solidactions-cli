/**
 * Tests for `solidactions skill exec <name> --target sandbox|host [...] -- <command...>`
 * (Task 4: required --target, option matrix, host orchestration).
 *
 * Test-double policy: no mock/spy/stub libraries. Follows the exact pattern of
 * tests/skill-run.test.ts: async `spawn` of the BUILT CLI (dist/index.js)
 * against a real in-process http.createServer stub. `--target host` writes
 * real cache files to disk and shells out via `stdio: 'inherit'`, both of
 * which are unobservable/unexercisable via an in-process function call — see
 * tests/skill-run.test.ts's header comment for the full rationale (stdio
 * inherit + spawnSync deadlock).
 *
 * HOME is redirected per test (group) to a temp dir so `~/.solidactions/cache`
 * lands in a sandboxed location. Config comes entirely from SOLIDACTIONS_*
 * env vars, so redirecting HOME does not affect CLI auth/config resolution —
 * only where the host cache is materialized.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as childProcess from 'child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { validateExecInvocation } from '../src/commands/skill-exec';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

// ---------------------------------------------------------------------------
// Pure unit tests: validateExecInvocation covers the option matrix directly
// (fast, no server/process needed) — including branches the integration
// suite below doesn't happen to exercise.
// ---------------------------------------------------------------------------

describe('validateExecInvocation', () => {
    it('requires --target sandbox|host', () => {
        expect(validateExecInvocation('q-tool', {})).toMatch(/--target is required/);
        expect(validateExecInvocation('q-tool', { target: 'bogus' })).toMatch(/'sandbox'.*'host'|sandbox.*host/s);
    });

    it('rejects directory-looking names regardless of target', () => {
        expect(validateExecInvocation('./local', { target: 'host' })).toMatch(/skill dev \.\/local/);
        expect(validateExecInvocation('../local', { target: 'host' })).toMatch(/skill dev/);
        expect(validateExecInvocation('/abs/local', { target: 'host' })).toMatch(/skill dev/);
    });

    it('rejects --crew with --target sandbox', () => {
        expect(validateExecInvocation('q-tool', { target: 'sandbox', crew: 'acme' })).toMatch(/--crew/);
    });

    it('rejects --env-file with --target sandbox', () => {
        expect(validateExecInvocation('q-tool', { target: 'sandbox', envFile: '.env' })).toMatch(/--env-file/);
    });

    it('rejects --crew combined with --role', () => {
        expect(validateExecInvocation('q-tool', { target: 'host', role: 'writer', crew: 'acme' })).toMatch(/--crew/);
    });

    it('rejects --in-crew without --role', () => {
        expect(validateExecInvocation('q-tool', { target: 'host', inCrew: 'acme' })).toMatch(/--in-crew/);
    });

    it('allows valid host and sandbox invocations', () => {
        expect(validateExecInvocation('q-tool', { target: 'sandbox' })).toBeNull();
        expect(validateExecInvocation('q-tool', { target: 'host' })).toBeNull();
        expect(validateExecInvocation('q-tool', { target: 'host', crew: 'acme' })).toBeNull();
        expect(validateExecInvocation('q-tool', { target: 'host', role: 'writer', inCrew: 'acme' })).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Integration: real HTTP server + real built CLI subprocess
// ---------------------------------------------------------------------------

interface CliResult {
    stdout: string;
    stderr: string;
    status: number | null;
}

/**
 * Spawn the built CLI as a real subprocess. Uses async `spawn` (not
 * `spawnSync`) — spawnSync blocks this process's event loop until the child
 * exits, which would prevent the in-process stub HTTP server (running on
 * this same event loop) from ever accepting the child's connection.
 */
function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
    return new Promise((resolve, reject) => {
        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], {
            env: { ...process.env, ...env },
        });
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
}

describe('solidactions skill exec — integration (--target sandbox|host)', () => {
    let stubServer: http.Server;
    let stubPort: number;
    let homeRoot: string;
    let home: string;

    // Mutable bundle served by crews_skills/read and crews_roles/read_skill.
    let BUNDLE: any;
    let execSkillCalls: Array<Record<string, unknown>> = [];

    beforeAll(async () => {
        if (!fs.existsSync(CLI_BINARY)) {
            throw new Error(`CLI not built — run \`npm run build\` first (expected: ${CLI_BINARY})`);
        }

        BUNDLE = {
            identifier: 'q-tool',
            doc_id: 42,
            published: true,
            head_revision_id: 7,
            active_snapshot_revision_id: 7,
            properties: { name: 'q-tool', description: 'd' },
            body: 'B',
            reference: {
                'scripts/q.js': 'console.log("VAR="+(process.env.PROBE||"none"))',
                'assets/blob.bin': { binary: true, mime: 'application/octet-stream', size: 4, blob_sha: 'blob1' },
            },
        };

        stubServer = http.createServer((req, res) => {
            if (req.method === 'GET' && req.url === '/signed/blob.bin') {
                res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
                res.end(Buffer.from('BIN!'));
                return;
            }
            if (req.method === 'GET' && req.url === '/api/v1/crews') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ data: [{ id: 7, name: 'acme', path: 'acme' }] }));
                return;
            }
            if (req.method === 'GET' && req.url?.startsWith('/api/v1/crews/7/variables/resolve')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ variables: { PROBE: 'resolved' }, skipped_secrets: [] }));
                return;
            }
            if (req.method === 'POST' && req.url === '/mcp') {
                let raw = '';
                req.on('data', (chunk) => { raw += chunk; });
                req.on('end', () => {
                    const parsed = JSON.parse(raw);
                    const toolName: string = parsed.params.name;
                    const args: Record<string, unknown> = parsed.params.arguments;
                    const action = args.action;

                    const respondText = (toolData: object) => {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            jsonrpc: '2.0', id: 1,
                            result: { isError: false, content: [{ type: 'text', text: JSON.stringify(toolData) }] },
                        }));
                    };

                    if (toolName === 'crews_skills' && action === 'read') {
                        respondText(BUNDLE);
                        return;
                    }
                    if (toolName === 'crews_skills' && action === 'read_reference_file') {
                        respondText({
                            path: 'assets/blob.bin',
                            mime: 'application/octet-stream',
                            size: 4,
                            signed_url: `http://127.0.0.1:${stubPort}/signed/blob.bin`,
                        });
                        return;
                    }
                    if (toolName === 'crews_skills' && action === 'exec_skill') {
                        execSkillCalls.push(args);
                        respondText({ stdout: 'sandbox ran', exit_code: 0, status: 'ok' });
                        return;
                    }
                    if (toolName === 'crews_roles' && action === 'list') {
                        respondText({
                            roles: [
                                { identifier: 'writer', in_crew: 'acme' },
                                { identifier: 'dupe', in_crew: 'acme' },
                                { identifier: 'dupe', in_crew: 'beta' },
                            ],
                        });
                        return;
                    }
                    if (toolName === 'crews_roles' && action === 'read_skill') {
                        const roleReference = { ...BUNDLE.reference };
                        delete roleReference['assets/blob.bin'];
                        respondText({ ...BUNDLE, identifier: 'q-tool', reference: roleReference });
                        return;
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        jsonrpc: '2.0', id: 1,
                        result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'unhandled', message: `no stub for ${toolName}/${action}` }) }] },
                    }));
                });
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

    beforeAll(() => {
        homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-skill-exec-target-test-'));
        home = path.join(homeRoot, 'home');
        fs.mkdirSync(home, { recursive: true });
    });

    afterAll(() => {
        fs.rmSync(homeRoot, { recursive: true, force: true });
    });

    function baseEnv(homeDir: string): Record<string, string> {
        return {
            HOME: homeDir,
            SOLIDACTIONS_HOST: `http://127.0.0.1:${stubPort}`,
            SOLIDACTIONS_API_KEY: 'test-api-key',
            SOLIDACTIONS_WORKSPACE_ID: 'ws-123',
        };
    }

    /** Locate the single cache dir for q-tool under a shared or role scope. */
    function findCacheDir(homeDir: string, ...scopeSegs: string[]): string {
        const base = path.join(homeDir, '.solidactions', 'cache', 'skills');
        const origins = fs.readdirSync(base);
        expect(origins.length).toBe(1);
        return path.join(base, origins[0], ...scopeSegs, 'q-tool');
    }

    it('1. exec without --target exits 1 (commander requiredOption error)', async () => {
        const result = await runCli(['skill', 'exec', 'q-tool', '--', 'node', '-e', 'x'], baseEnv(home));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('--target');
    });

    it('2. exec with --target bogus exits 1 mentioning both valid targets', async () => {
        const result = await runCli(['skill', 'exec', 'q-tool', '--target', 'bogus', '--', 'node', '-e', 'x'], baseEnv(home));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('sandbox');
        expect(result.stderr).toContain('host');
    });

    it('3. exec ./somedir --target host exits 1 pointing at `skill dev`', async () => {
        const result = await runCli(['skill', 'exec', './somedir', '--target', 'host', '--', 'node', '-e', 'x'], baseEnv(home));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('skill dev');
    });

    it('4. exec q-tool --target sandbox runs remotely (v1.30 behavior + banner)', async () => {
        execSkillCalls = [];
        const result = await runCli(
            ['skill', 'exec', 'q-tool', '--target', 'sandbox', '--', 'node', '-e', 'x'],
            baseEnv(home),
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('sandbox ran');
        expect(result.stderr).toContain('▶ stored skill q-tool → sandbox (production)');
        expect(execSkillCalls[0].environment).toBeUndefined();
    });

    it('5. exec q-tool --target sandbox --crew acme is rejected', async () => {
        const result = await runCli(
            ['skill', 'exec', 'q-tool', '--target', 'sandbox', '--crew', 'acme', '--', 'node', '-e', 'x'],
            baseEnv(home),
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('--crew');
    });

    it('6. exec q-tool --target host --crew acme materializes the cache and runs locally', async () => {
        const result = await runCli(
            ['skill', 'exec', 'q-tool', '--target', 'host', '--crew', 'acme', '--', 'node', 'scripts/q.js'],
            baseEnv(home),
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('VAR=resolved');
        expect(result.stderr).toContain('@ rev 7');
        expect(result.stderr).toContain('local cache (production)');

        const cacheDir = findCacheDir(home, 'shared');
        expect(fs.readFileSync(path.join(cacheDir, 'SKILL.md'), 'utf8')).toContain('name: q-tool');
        expect(fs.existsSync(path.join(cacheDir, 'scripts/q.js'))).toBe(true);
        expect(fs.readFileSync(path.join(cacheDir, 'assets/blob.bin'), 'utf8')).toBe('BIN!');
        expect(fs.existsSync(path.join(cacheDir, '.sa-cache-manifest.json'))).toBe(true);
    });

    it('7. second identical run against a read-only cache dir is a no-op (proves no writes)', async () => {
        const cacheDir = findCacheDir(home, 'shared');

        function chmodTree(dir: string, fileMode: number, dirMode: number) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    chmodTree(full, fileMode, dirMode);
                    fs.chmodSync(full, dirMode);
                } else {
                    fs.chmodSync(full, fileMode);
                }
            }
        }

        chmodTree(cacheDir, 0o444, 0o555);
        fs.chmodSync(cacheDir, 0o555);

        try {
            const result = await runCli(
                ['skill', 'exec', 'q-tool', '--target', 'host', '--crew', 'acme', '--', 'node', 'scripts/q.js'],
                baseEnv(home),
            );
            expect(result.status).toBe(0);
            expect(result.stdout).toContain('VAR=resolved');
        } finally {
            fs.chmodSync(cacheDir, 0o755);
            chmodTree(cacheDir, 0o644, 0o755);
        }
    });

    it('8. upstream change refreshes tracked files, deletes dropped ones, and preserves untracked scratch files', async () => {
        const cacheDir = findCacheDir(home, 'shared');
        fs.mkdirSync(path.join(cacheDir, 'node_modules'), { recursive: true });
        fs.writeFileSync(path.join(cacheDir, 'node_modules', 'keep.txt'), 'keep');
        fs.mkdirSync(path.join(cacheDir, '.sa-state'), { recursive: true });
        fs.writeFileSync(path.join(cacheDir, '.sa-state', 'state.json'), '{}');

        BUNDLE = {
            ...BUNDLE,
            body: 'B2',
            active_snapshot_revision_id: 8,
            reference: {
                'scripts/q.js': 'console.log("VAR="+(process.env.PROBE||"none"));\n// v2',
            },
        };

        const result = await runCli(
            ['skill', 'exec', 'q-tool', '--target', 'host', '--crew', 'acme', '--', 'node', 'scripts/q.js'],
            baseEnv(home),
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('VAR=resolved');

        expect(fs.existsSync(path.join(cacheDir, 'assets/blob.bin'))).toBe(false);
        expect(fs.readFileSync(path.join(cacheDir, 'node_modules', 'keep.txt'), 'utf8')).toBe('keep');
        expect(fs.readFileSync(path.join(cacheDir, '.sa-state', 'state.json'), 'utf8')).toBe('{}');

        const manifest = JSON.parse(fs.readFileSync(path.join(cacheDir, '.sa-cache-manifest.json'), 'utf8'));
        expect(manifest.execution_revision_id).toBe(8);
    });

    it('9. local tampering (drift) is self-healed on the next run', async () => {
        const cacheDir = findCacheDir(home, 'shared');
        fs.writeFileSync(path.join(cacheDir, 'scripts/q.js'), 'GARBAGE, not valid js');

        const result = await runCli(
            ['skill', 'exec', 'q-tool', '--target', 'host', '--crew', 'acme', '--', 'node', 'scripts/q.js'],
            baseEnv(home),
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('VAR=resolved');
    });

    it('10. role path: crew resolved via roles.list; ambiguous role rejected asking for --in-crew', async () => {
        const writerResult = await runCli(
            ['skill', 'exec', 'q-tool', '--target', 'host', '--role', 'writer', '--', 'node', 'scripts/q.js'],
            baseEnv(home),
        );
        expect(writerResult.status).toBe(0);
        expect(writerResult.stdout).toContain('VAR=resolved');

        const dupeResult = await runCli(
            ['skill', 'exec', 'q-tool', '--target', 'host', '--role', 'dupe', '--', 'node', 'scripts/q.js'],
            baseEnv(home),
        );
        expect(dupeResult.status).toBe(1);
        expect(dupeResult.stderr).toContain('--in-crew');
    });

    it('11. two simultaneous cold-cache runs both succeed (lock serializes materialization)', async () => {
        const coldRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-skill-exec-target-cold-'));
        const coldHome = path.join(coldRoot, 'home');
        fs.mkdirSync(coldHome, { recursive: true });

        try {
            const args = ['skill', 'exec', 'q-tool', '--target', 'host', '--crew', 'acme', '--', 'node', 'scripts/q.js'];
            const [a, b] = await Promise.all([
                runCli(args, baseEnv(coldHome)),
                runCli(args, baseEnv(coldHome)),
            ]);
            expect(a.status).toBe(0);
            expect(b.status).toBe(0);
            expect(a.stdout).toContain('VAR=resolved');
            expect(b.stdout).toContain('VAR=resolved');
        } finally {
            fs.rmSync(coldRoot, { recursive: true, force: true });
        }
    }, 20_000);
});

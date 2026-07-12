/**
 * Tests for `solidactions skill dev <dir> -- <command...>` (Task 5: rename of
 * `skill run` to `skill dev`, with `skill run` kept as a hidden deprecated
 * alias until v2.0.0).
 *
 * Test-double policy: no mock/spy/stub libraries. Follows the exact pattern
 * of tests/skill-run.test.ts / tests/skill-exec-target.test.ts: spawn the
 * BUILT CLI (dist/index.js) as a real subprocess against a real in-process
 * http.createServer stub (crews list + variables/resolve only).
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as childProcess from 'child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

interface CliResult {
    stdout: string;
    stderr: string;
    status: number | null;
}

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

describe('solidactions skill dev — integration (rename from skill run)', () => {
    let stubServer: http.Server;
    let stubPort: number;
    let homeRoot: string;
    let home: string;
    let dir: string;

    beforeAll(async () => {
        if (!fs.existsSync(CLI_BINARY)) {
            throw new Error(`CLI not built — run \`npm run build\` first (expected: ${CLI_BINARY})`);
        }

        stubServer = http.createServer((req, res) => {
            if (req.url === '/api/v1/crews') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ data: [{ id: 7, name: 'my-crew' }] }));
                return;
            }
            if (req.url?.startsWith('/api/v1/crews/7/variables/resolve')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ variables: { PROBE: 'resolved' }, skipped_secrets: [] }));
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
        homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-skill-dev-test-'));
        home = path.join(homeRoot, 'home');
        fs.mkdirSync(home, { recursive: true });

        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-skill-dev-workdir-'));
        fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: probe\ndescription: test skill\n---\n\nbody\n');
    });

    afterAll(() => {
        fs.rmSync(homeRoot, { recursive: true, force: true });
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function baseEnv(): Record<string, string> {
        return {
            HOME: home,
            SOLIDACTIONS_HOST: `http://127.0.0.1:${stubPort}`,
            SOLIDACTIONS_API_KEY: 'test-api-key',
            SOLIDACTIONS_WORKSPACE_ID: 'ws-123',
        };
    }

    it('1. skill dev <dir with SKILL.md> --crew --environment runs locally with resolved crew vars', async () => {
        const result = await runCli(
            [
                'skill', 'dev', dir,
                '--crew', 'my-crew',
                '--environment', 'dev',
                '--',
                'node', '-e', 'console.log("PROBE="+process.env.PROBE)',
            ],
            baseEnv(),
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('PROBE=resolved');
        expect(result.stderr).toContain('▶ working copy');
        expect(result.stderr).toContain('(dev)');
    });

    it('2. skill dev q-tool (name, not a directory) is rejected pointing at `skill exec ... --target host`', async () => {
        const result = await runCli(['skill', 'dev', 'q-tool', '--', 'node', '-e', '1'], baseEnv());
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('skill exec q-tool --target host');
    });

    it('3. skill run <same dir> is a deprecated alias — identical stdout to skill dev, plus a deprecation warning on stderr', async () => {
        const devResult = await runCli(
            [
                'skill', 'dev', dir,
                '--crew', 'my-crew',
                '--',
                'node', '-e', 'console.log("PROBE="+process.env.PROBE)',
            ],
            baseEnv(),
        );
        const runResult = await runCli(
            [
                'skill', 'run', dir,
                '--crew', 'my-crew',
                '--',
                'node', '-e', 'console.log("PROBE="+process.env.PROBE)',
            ],
            baseEnv(),
        );
        expect(runResult.status).toBe(0);
        expect(runResult.stdout).toBe(devResult.stdout);
        expect(runResult.stderr).toContain('deprecated');
        expect(runResult.stderr).toContain('skill dev');
    });

    it("4. skill --help hides `run` but lists `dev` and `exec`", async () => {
        const result = await runCli(['skill', '--help'], baseEnv());
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('dev');
        expect(result.stdout).toContain('exec');
        expect(result.stdout).not.toMatch(/^\s*run\s/m);
    });
});

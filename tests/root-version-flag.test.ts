import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { makeTmpEnv, writeGlobal } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json');
const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');
const REFUSAL = '--version must be a whole number of 1 or more.';

/** Spawns the built CLI with an isolated HOME, the way a user's shell does. */
function runCli(args: string[], home: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1' };
        for (const key of ['SOLIDACTIONS_HOST', 'SOLIDACTIONS_API_KEY', 'SOLIDACTIONS_WORKSPACE_ID', 'DEBUG', 'NODE_DEBUG']) delete env[key];
        execFile(process.execPath, [CLI_BINARY, ...args], { cwd, env, timeout: 30_000 }, (error, stdout, stderr) => {
            resolve({ stdout, stderr, code: error ? Number((error as { code?: number }).code ?? 1) : 0 });
        });
    });
}

async function inTmpEnv(body: (env: { home: string; cwd: string }) => Promise<void>): Promise<void> {
    expect(fs.existsSync(CLI_BINARY)).toBe(true); // CLI not built — run `npm run build` first
    const env = makeTmpEnv();
    try {
        // A host nothing listens on: a row that reaches a command which would call the server fails loudly instead of hanging.
        writeGlobal(env.home, { host: 'http://127.0.0.1:1', apiKey: 'pat', workspaceId: 'ws-1', workspace: 'ws-1' });
        await body({ home: env.home, cwd: fs.realpathSync(env.cwd) });
    } finally {
        env.cleanup();
    }
}

describe('the root --version flag in the built binary', () => {
    it('plain --version prints the CLI version and exits 0', async () => {
        await inTmpEnv(async ({ home, cwd }) => {
            const result = await runCli(['--version'], home, cwd);

            expect(result.code).toBe(0);
            expect(result.stdout).toBe(`${pkg.version}\n`);
        });
    });

    it('-V still prints the CLI version and exits 0', async () => {
        await inTmpEnv(async ({ home, cwd }) => {
            const result = await runCli(['-V'], home, cwd);

            expect(result.code).toBe(0);
            expect(result.stdout).toBe(`${pkg.version}\n`);
        });
    });

    it.each([
        ['-w <ws> --version', ['-w', 'ws-1', '--version']],
        ['--workspace-override <ws> --version', ['--workspace-override', 'ws-1', '--version']],
        ['--workspace-override=<ws> --version', ['--workspace-override=ws-1', '--version']],
        ['-w<ws> --version', ['-wws-1', '--version']],
        ['-w <ws> -V', ['-w', 'ws-1', '-V']],
    ])('%s prints the CLI version exactly like plain --version', async (_label, args) => {
        await inTmpEnv(async ({ home, cwd }) => {
            const plain = await runCli(['--version'], home, cwd);
            const result = await runCli(args, home, cwd);

            expect(plain.code).toBe(0); // setup: the plain form works, so the comparison below is meaningful
            expect(result.code).toBe(0);
            expect(result.stdout).toBe(plain.stdout);
            expect(result.stderr).not.toContain('unknown option');
        });
    });

    // The root keeps a --version that comes BEFORE the subcommand path; only a --version after `database pull` belongs to pull.
    it.each([
        ['--version database pull sales', ['--version', 'database', 'pull', 'sales']],
        ['-w <ws> --version database pull sales', ['-w', 'ws-1', '--version', 'database', 'pull', 'sales']],
    ])('%s prints the CLI version exactly like plain --version', async (_label, args) => {
        await inTmpEnv(async ({ home, cwd }) => {
            const plain = await runCli(['--version'], home, cwd);
            const result = await runCli(args, home, cwd);

            expect(plain.code).toBe(0); // setup: the plain form works, so the comparison below is meaningful
            expect(result.code).toBe(0);
            expect(result.stdout).toBe(plain.stdout);
            expect(result.stderr).not.toContain('unknown option');
        });
    });

    it('--version after another subcommand still prints the CLI version, as before this wave', async () => {
        await inTmpEnv(async ({ home, cwd }) => {
            const result = await runCli(['database', 'list', '--version'], home, cwd);

            expect(result.code).toBe(0);
            expect(result.stdout).toBe(`${pkg.version}\n`);
        });
    });

    it('database pull <name> --version 0 reaches the pull command (control for the global-option rows below)', async () => {
        await inTmpEnv(async ({ home, cwd }) => {
            const result = await runCli(['database', 'pull', 'sales', 'out.duckdb', '--version', '0'], home, cwd);

            expect(result.code).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toContain(REFUSAL);
            expect(result.stderr).not.toContain(pkg.version);
        });
    });

    // A global workspace option makes the CLI resolve the workspace over the network first, so these rows
    // cannot reach the --version refusal: they prove the flag was handed to the pull command by its outcome
    // (the connection failure) rather than the CLI version or an unknown-option error.
    it.each([
        ['-w <ws>', ['-w', 'ws-1']],
        ['--workspace-override <ws>', ['--workspace-override', 'ws-1']],
        ['--workspace-override=<ws>', ['--workspace-override=ws-1']],
    ])('%s before the subcommand: database pull <name> out.duckdb --version 2 reaches the pull command instead of printing the CLI version', async (_label, globalArgs) => {
        await inTmpEnv(async ({ home, cwd }) => {
            const result = await runCli([...globalArgs, 'database', 'pull', 'sales', 'out.duckdb', '--version', '2'], home, cwd);

            expect(result.stdout).not.toContain(pkg.version);
            expect(result.stderr).not.toContain('unknown option');
            expect(result.stderr).toContain('Connection failed'); // no server behind the host: the pull itself fails
            expect(result.code).toBe(1);
        });
    });
});

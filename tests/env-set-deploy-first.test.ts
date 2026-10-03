import * as childProcess from 'child_process';
import * as http from 'http';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { envSet } from '../src/commands/env-set';
import { makeTmpEnv, writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

interface CliResult {
    stdout: string;
    stderr: string;
    status: number | null;
}

/**
 * Run the real built binary against this file's in-process stub server:
 * real stdout, stderr and exit status with a temp HOME. Async spawn (never
 * spawnSync): the stub server lives in this process.
 */
function runCli(args: string[], home: string, cwd: string): Promise<CliResult> {
    return new Promise((resolve, reject) => {
        const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home };
        delete childEnv.SOLIDACTIONS_HOST;
        delete childEnv.SOLIDACTIONS_API_KEY;
        delete childEnv.SOLIDACTIONS_WORKSPACE_ID;

        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], { cwd, env: childEnv });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });

        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`CLI timed out. stdout: ${stdout} stderr: ${stderr}`));
        }, 15_000);

        child.on('close', (status) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, status });
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

let server: http.Server;
let port: number;
let projectRows: Array<{ name: string; slug: string; environments: string[] }> = [];

beforeAll(async () => {
    server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url?.match(/\/api\/v1\/projects\/.+\/variable-mappings\/bulk/)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'Project not found.' }));
            return;
        }
        if (req.method === 'GET' && req.url === '/api/v1/projects') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: projectRows }));
            return;
        }
        // cli#161: the slug-resolution lookup misses the absent environment,
        // so the command falls back to its first candidate.
        if (req.method === 'GET' && req.url?.match(/\/api\/v1\/projects\/[^/]+$/)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'Not found.' }));
            return;
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: `Unexpected ${req.method} ${req.url}` }));
    });
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
}));

beforeEach(() => {
    projectRows = [];
});

async function failedEnvSet(
    project: string,
    options: { yes: true; env?: string },
): Promise<string> {
    const env = makeTmpEnv();
    writeGlobal(env.home, {
        host: `http://127.0.0.1:${port}`,
        apiKey: 'test-key',
        workspaceId: 'ws-1',
    });
    const originalExit = process.exit.bind(process);
    const originalError = console.error;
    const lines: string[] = [];
    (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };

    try {
        await expect(envSet(project, 'API_KEY', 'secret', options))
            .rejects.toMatchObject({ code: 1 });
        return lines.join('\n');
    } finally {
        (process as any).exit = originalExit;
        console.error = originalError;
        env.cleanup();
    }
}

describe('env set missing environment deploy-first hint', () => {
    it('prints the exact production creation command with the actual project', async () => {
        projectRows = [{ name: 'X', slug: 'X', environments: ['dev'] }];

        const output = await failedEnvSet('X', { yes: true, env: 'production' });

        expect(output).toContain('Project "X" has no production environment (exists in: dev).');
        expect(output).toContain(
            "Run 'solidactions project deploy X -e production --create' first.",
        );
    });

    it('uses the default dev environment in the creation command', async () => {
        projectRows = [{ name: 'my-project', slug: 'my-project', environments: ['production'] }];

        const output = await failedEnvSet('my-project', { yes: true });

        expect(output).toContain('Project "my-project" has no dev environment (exists in: production).');
        expect(output).toContain(
            "Run 'solidactions project deploy my-project -e dev --create' first.",
        );
    });

    // FR2-I1: this case changed in this wave, so it spawns the built binary
    // (real stdout/stderr/exit status) instead of replacing process.exit and
    // console.error. The two older cases above are unchanged since the merge
    // base and keep the in-process harness under the recorded exception.
    it('prints the server message (never a missing-environment hint) when discovery returns null', async () => {
        const env = makeTmpEnv();
        try {
            writeGlobal(env.home, {
                host: `http://127.0.0.1:${port}`,
                apiKey: 'test-key',
                workspaceId: 'ws-1',
            });

            const result = await runCli(['env', 'set', 'missing-project', 'API_KEY', 'secret', '-e', 'production', '--yes'], env.home, env.cwd);

            expect(result.status).toBe(1);
            expect(result.stderr).toContain('Failed: 404 Project not found.');
            expect(result.stderr).not.toMatch(/has no .* environment/);
        } finally {
            env.cleanup();
        }
    });
});

/**
 * cli#194: DEBUG / NODE_DEBUG output never prints the API key or URL userinfo.
 *
 * Spawned-binary tests: a real in-process HTTP server, real temp HOME configs
 * carrying a fake key, and the real built CLI. This file imports nothing from
 * `src/`, so it still collects and runs on the unfixed build (RED).
 *
 * No mocks/spies/stubs — follows the pattern from one-line-401-sites.test.ts.
 */
import * as childProcess from 'child_process';
import * as http from 'http';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpEnv, writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

const API_KEY = 'sk-test-9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c';
const USERINFO_PASSWORD = 'pw-DEBUGLEAK';
const BASIC_AUTH = Buffer.from(`user:${USERINFO_PASSWORD}`).toString('base64');
// Every secret that must never appear in stdout or stderr.
const SECRETS = [API_KEY, 'DEBUGLEAK', USERINFO_PASSWORD, BASIC_AUTH];

interface CapturedRequest {
    method: string | undefined;
    url: string | undefined;
}

let server: http.Server;
let port: number;
let requests: CapturedRequest[];

beforeAll(async () => {
    requests = [];
    server = http.createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
            // Record every request before answering.
            requests.push({ method: request.method, url: request.url });
            const json = (status: number, payload: unknown) => {
                response.writeHead(status, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(payload));
            };
            if (request.method === 'POST' && request.url === '/mcp') {
                json(200, {
                    jsonrpc: '2.0',
                    id: 1,
                    result: { isError: false, content: [{ type: 'text', text: '{"skills":[]}' }] },
                });
                return;
            }
            // GET /api/v1/projects and any other GET.
            json(200, { data: [] });
        });
    });
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
}));

interface CliResult {
    stdout: string;
    stderr: string;
    status: number | null;
}

function runCli(args: string[], home: string, cwd: string, extraEnv: Record<string, string>): Promise<CliResult> {
    return new Promise((resolve, reject) => {
        const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1', ...extraEnv };
        delete childEnv.SOLIDACTIONS_HOST;
        delete childEnv.SOLIDACTIONS_API_KEY;
        delete childEnv.SOLIDACTIONS_WORKSPACE_ID;
        delete childEnv.DEBUG;
        delete childEnv.NODE_DEBUG;
        delete childEnv.FORCE_COLOR;
        for (const [key, value] of Object.entries(extraEnv)) {
            childEnv[key] = value;
        }

        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], { cwd, env: childEnv });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });

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

function splitEnv(assignment: string): Record<string, string> {
    const index = assignment.indexOf('=');
    return { [assignment.slice(0, index)]: assignment.slice(index + 1) };
}

describe('debug output never prints the API key', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();
        requests = [];
    });
    afterEach(() => env.cleanup());

    const writeConfig = (variant: 'plain' | 'userinfo') => {
        const host = variant === 'plain'
            ? `http://127.0.0.1:${port}`
            : `http://user:${USERINFO_PASSWORD}@127.0.0.1:${port}`;
        writeGlobal(env.home, { host, apiKey: API_KEY, workspaceId: 'ws-1', workspace: 'ws-1' });
    };

    const debugEnvs = ['DEBUG=*', 'DEBUG=axios,follow-redirects', 'DEBUG=follow-redirects'];
    const nodeDebugEnvs = ['NODE_DEBUG=http,https,net,tls', 'NODE_DEBUG=*'];
    const commands: { name: string; args: string[]; request: CapturedRequest }[] = [
        { name: 'project list', args: ['project', 'list'], request: { method: 'GET', url: '/api/v1/projects' } },
        { name: 'skill list', args: ['skill', 'list'], request: { method: 'POST', url: '/mcp' } },
    ];

    for (const envAssignment of [...debugEnvs, ...nodeDebugEnvs]) {
        const isNodeDebug = envAssignment.startsWith('NODE_DEBUG=');
        const envValue = envAssignment.slice(envAssignment.indexOf('=') + 1);
        for (const command of commands) {
            for (const variant of ['plain', 'userinfo'] as const) {
                it(`${envAssignment} + ${command.name} + ${variant} config prints no secret`, async () => {
                    writeConfig(variant);
                    const result = await runCli(command.args, env.home, env.cwd, splitEnv(envAssignment));
                    const combined = result.stdout + result.stderr;
                    for (const secret of SECRETS) {
                        expect(combined).not.toContain(secret);
                    }
                    if (variant === 'plain' && !isNodeDebug) {
                        expect(result.status).toBe(0);
                        expect(requests).toContainEqual(command.request);
                    }
                    if (variant === 'plain' && isNodeDebug) {
                        expect(result.status).toBe(1);
                        expect(result.stderr).toContain(
                            `error: NODE_DEBUG="${envValue}" turns on Node's "http" debug output, ` +
                            'which prints request headers including your API key.',
                        );
                        expect(requests).toHaveLength(0);
                    }
                    // userinfo config: no exit-code or server assertions; Task 2
                    // makes this host refuse before any request.
                });
            }
        }
    }

    it('control: NODE_DEBUG=module runs normally with no refusal line', async () => {
        writeConfig('plain');
        const result = await runCli(['project', 'list'], env.home, env.cwd, { NODE_DEBUG: 'module' });
        expect(result.status).toBe(0);
        expect(requests).toContainEqual({ method: 'GET', url: '/api/v1/projects' });
        expect(result.stderr).not.toContain('turns on Node');
        const combined = result.stdout + result.stderr;
        for (const secret of SECRETS) {
            expect(combined).not.toContain(secret);
        }
    });

    it('control: --version with NODE_DEBUG=net refuses naming "net"', async () => {
        writeConfig('plain');
        const result = await runCli(['--version'], env.home, env.cwd, { NODE_DEBUG: 'net' });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('turns on Node\'s "net" debug output');
    });
});

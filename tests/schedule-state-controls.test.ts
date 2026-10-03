import * as childProcess from 'child_process';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpEnv, writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

type RequestRecord = {
    method: string;
    url: string;
    body: string;
    authorization?: string;
    accept?: string;
    contentType?: string;
    workspace?: string;
};

let server: http.Server;
let port: number;
let requests: RequestRecord[] = [];
let responseStatus = 200;
let responseBody: Record<string, unknown> = {};

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            requests.push({
                method: req.method ?? '',
                url: req.url ?? '',
                body: Buffer.concat(chunks).toString('utf8'),
                authorization: req.headers.authorization,
                accept: req.headers.accept,
                contentType: req.headers['content-type'],
                workspace: req.headers['x-workspace-id'] as string | undefined,
            });
            // Slug resolution (cli#161): the bare project lookup succeeds so
            // each command reaches its mutation; the mutation itself answers
            // with the per-test status/body.
            if (req.method === 'GET' && url.pathname.startsWith('/api/v1/projects/') && !url.pathname.includes('/schedules')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ slug: url.pathname.split('/').pop() }));
                return;
            }
            res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responseBody));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
}));

interface CliResult {
    stdout: string;
    stderr: string;
    status: number | null;
}

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

describe('schedule target-state commands', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'test-key', workspaceId: 'workspace-1' });
        requests = [];
        responseStatus = 200;
        responseBody = { schedule: { id: 42, enabled: true } };
    });
    afterEach(() => env.cleanup());

    it('enables idempotently with the exact API path, JSON body, and auth/workspace headers', async () => {
        const first = await runCli(['schedule', 'enable', 'billing', '42'], env.home, env.cwd);
        const second = await runCli(['schedule', 'enable', 'billing', '42'], env.home, env.cwd);

        expect(first.status).toBe(0);
        expect(second.status).toBe(0);

        // Each call resolves the slug first (cli#161), then PATCHes.
        expect(requests).toHaveLength(4);
        for (const request of [requests[0], requests[2]]) {
            expect(request).toMatchObject({
                method: 'GET',
                url: '/api/v1/projects/billing',
            });
        }
        for (const request of [requests[1], requests[3]]) {
            expect(request).toMatchObject({
                method: 'PATCH',
                url: '/api/v1/projects/billing/schedules/42',
                body: JSON.stringify({ enabled: true }),
                accept: 'application/json',
                contentType: 'application/json',
                workspace: 'workspace-1',
            });
            expect(request.authorization).toMatch(/^Bearer \S+$/);
        }
        expect(first.stdout).toContain('sticky override');
        expect(first.stdout).toContain('survives redeploy');
    });

    it('disables with an explicit false target and resolves an explicit environment slug', async () => {
        responseBody = { schedule: { id: 42, enabled: false } };

        const result = await runCli(['schedule', 'disable', 'billing', '42', '--env', 'dev'], env.home, env.cwd);

        expect(result.status).toBe(0);
        expect(requests).toHaveLength(2);
        expect(requests[0]).toMatchObject({
            method: 'GET',
            url: '/api/v1/projects/billing-dev',
        });
        expect(requests[1]).toMatchObject({
            method: 'PATCH',
            url: '/api/v1/projects/billing-dev/schedules/42',
            body: JSON.stringify({ enabled: false }),
        });
        expect(result.stdout).toContain('disabled');
    });

    it('resets through the exact POST endpoint and explains that YAML controls the schedule again', async () => {
        responseBody = { schedule: { id: 42, enabled: true, enabled_override: false, yaml_enabled: true } };

        const result = await runCli(['schedule', 'reset', 'billing', '42', '--env', 'production'], env.home, env.cwd);

        expect(result.status).toBe(0);
        expect(requests).toHaveLength(2);
        expect(requests[0]).toMatchObject({
            method: 'GET',
            url: '/api/v1/projects/billing',
        });
        expect(requests[1]).toMatchObject({
            method: 'POST',
            url: '/api/v1/projects/billing/schedules/42/reset',
            body: JSON.stringify({}),
            accept: 'application/json',
            contentType: 'application/json',
            workspace: 'workspace-1',
        });
        expect(requests[1].authorization).toMatch(/^Bearer \S+$/);
        expect(result.stdout).toContain('YAML controls this schedule again');
    });

    it('exits nonzero and renders the API message on a rejected reset', async () => {
        responseStatus = 422;
        responseBody = { message: 'This schedule has no YAML declaration to reset to.' };

        const result = await runCli(['schedule', 'reset', 'billing', '42', '--env', 'production'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('This schedule has no YAML declaration to reset to.');
    });
});

describe('schedule set paused wire contract', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'test-key', workspaceId: 'workspace-1' });
        requests = [];
        responseStatus = 200;
    });
    afterEach(() => env.cleanup());

    it('sends enabled=false only when --paused is present', async () => {
        responseBody = { schedule: { id: 42, enabled: false } };

        const paused = await runCli(['schedule', 'set', 'billing', '* * * * *', '--yes', '--paused', '--env', 'dev'], env.home, env.cwd);

        expect(paused.status).toBe(0);
        expect(requests).toHaveLength(2);
        expect(requests[0]).toMatchObject({
            method: 'GET',
            url: '/api/v1/projects/billing-dev',
        });
        expect(requests[1]).toMatchObject({
            method: 'POST',
            url: '/api/v1/projects/billing-dev/schedules',
            body: JSON.stringify({ cron: '* * * * *', enabled: false }),
            accept: 'application/json',
            contentType: 'application/json',
            workspace: 'workspace-1',
        });
        expect(requests[1].authorization).toMatch(/^Bearer \S+$/);
        expect(paused.stdout).toContain('survives redeploy');

        requests = [];
        responseBody = { schedule: { id: 42, enabled: false } };
        const unpaused = await runCli(['schedule', 'set', 'billing', '* * * * *', '--yes'], env.home, env.cwd);

        expect(unpaused.status).toBe(0);
        expect(requests).toHaveLength(2);
        expect(requests[0]).toMatchObject({
            method: 'GET',
            url: '/api/v1/projects/billing',
        });
        expect(JSON.parse(requests[1].body)).toEqual({ cron: '* * * * *' });
        expect(JSON.parse(requests[1].body)).not.toHaveProperty('enabled');
    });
});

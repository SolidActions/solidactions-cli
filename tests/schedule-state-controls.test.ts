import * as http from 'http';
import { AddressInfo } from 'net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleDisable, scheduleEnable, scheduleReset } from '../src/commands/schedule-state';
import { scheduleSet } from '../src/commands/schedule-set';

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
            requests.push({
                method: req.method ?? '',
                url: req.url ?? '',
                body: Buffer.concat(chunks).toString('utf8'),
                authorization: req.headers.authorization,
                accept: req.headers.accept,
                contentType: req.headers['content-type'],
                workspace: req.headers['x-workspace-id'] as string | undefined,
            });
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

beforeEach(() => {
    requests = [];
    responseStatus = 200;
    responseBody = { schedule: { id: 42, enabled: true } };
    process.env.SOLIDACTIONS_HOST = `http://127.0.0.1:${port}`;
    process.env.SOLIDACTIONS_API_KEY = 'test-key';
    process.env.SOLIDACTIONS_WORKSPACE_ID = 'workspace-1';
});

afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SOLIDACTIONS_HOST;
    delete process.env.SOLIDACTIONS_API_KEY;
    delete process.env.SOLIDACTIONS_WORKSPACE_ID;
});

describe('schedule target-state commands', () => {
    it('enables idempotently with the exact API path, JSON body, and auth/workspace headers', async () => {
        const logs: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.map(String).join(' ')); });

        await scheduleEnable('billing', '42');
        await scheduleEnable('billing', '42');

        expect(requests).toHaveLength(2);
        for (const request of requests) {
            expect(request).toMatchObject({
                method: 'PATCH',
                url: '/api/v1/projects/billing/schedules/42',
                body: JSON.stringify({ enabled: true }),
                authorization: 'Bearer test-key',
                accept: 'application/json',
                contentType: 'application/json',
                workspace: 'workspace-1',
            });
        }
        expect(logs.join('\n')).toContain('sticky override');
        expect(logs.join('\n')).toContain('survives redeploy');
    });

    it('disables with an explicit false target and resolves an explicit environment slug', async () => {
        responseBody = { schedule: { id: 42, enabled: false } };

        await scheduleDisable('billing', '42', { env: 'dev' });

        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
            method: 'PATCH',
            url: '/api/v1/projects/billing-dev/schedules/42',
            body: JSON.stringify({ enabled: false }),
        });
    });

    it('resets through the exact POST endpoint and explains that YAML controls the schedule again', async () => {
        const logs: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.map(String).join(' ')); });
        responseBody = { schedule: { id: 42, enabled: true, enabled_override: false, yaml_enabled: true } };

        await scheduleReset('billing', '42', { env: 'production' });

        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
            method: 'POST',
            url: '/api/v1/projects/billing/schedules/42/reset',
            body: JSON.stringify({}),
            authorization: 'Bearer test-key',
            accept: 'application/json',
            contentType: 'application/json',
            workspace: 'workspace-1',
        });
        expect(logs.join('\n')).toContain('YAML controls this schedule again');
    });

    it('exits nonzero and renders the API message on a rejected reset', async () => {
        responseStatus = 422;
        responseBody = { message: 'This schedule has no YAML declaration to reset to.' };
        const errors: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.map(String).join(' ')); });
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code}`);
        }) as never);

        await expect(scheduleReset('billing', '42')).rejects.toThrow('exit:1');

        expect(exit).toHaveBeenCalledWith(1);
        expect(errors.join('\n')).toContain('This schedule has no YAML declaration to reset to.');
    });
});

describe('schedule set paused wire contract', () => {
    it('sends enabled=false only when --paused is present', async () => {
        responseBody = { schedule: { id: 42, enabled: false } };

        await scheduleSet('billing', '* * * * *', { yes: true, paused: true, env: 'dev' });

        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
            method: 'POST',
            url: '/api/v1/projects/billing-dev/schedules',
            body: JSON.stringify({ cron: '* * * * *', enabled: false }),
            authorization: 'Bearer test-key',
            accept: 'application/json',
            contentType: 'application/json',
            workspace: 'workspace-1',
        });

        requests = [];
        responseBody = { schedule: { id: 42, enabled: false } };
        await scheduleSet('billing', '* * * * *', { yes: true });

        expect(requests).toHaveLength(1);
        expect(JSON.parse(requests[0].body)).toEqual({ cron: '* * * * *' });
        expect(JSON.parse(requests[0].body)).not.toHaveProperty('enabled');
    });
});

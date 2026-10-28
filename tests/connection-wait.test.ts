/**
 * Contract tests for `solidactions connection wait`.
 *
 * Test-double policy: the command talks to a real in-process HTTP server and
 * reads a real temporary CLI config. No mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeGlobal } from './helpers';
import { parseWaitTimeout } from '../src/commands/connection-wait';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

interface CapturedRequest {
    method: string | undefined;
    url: string | undefined;
    headers: http.IncomingHttpHeaders;
    body: unknown;
}

interface QueuedResponse {
    status: number;
    payload: unknown;
}

let server: http.Server;
let port: number;
let requests: CapturedRequest[] = [];
let arrivals: number[] = [];
let queue: QueuedResponse[] = [];

beforeAll(async () => {
    server = http.createServer((request, response) => {
        let raw = '';
        request.on('data', (chunk) => {
            raw += chunk;
        });
        request.on('end', () => {
            let body: unknown;
            try {
                body = raw === '' ? undefined : JSON.parse(raw);
            } catch {
                body = raw;
            }
            requests.push({
                method: request.method,
                url: request.url,
                headers: request.headers,
                body,
            });
            arrivals.push(Date.now());
            const answer = queue[Math.min(requests.length - 1, queue.length - 1)] ?? { status: 200, payload: {} };
            response.writeHead(answer.status, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(answer.payload));
        });
    });

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => {
    return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
});

function requestedLink(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: '01JBTEST',
        status: 'requested',
        mode: 'connect',
        platform: 'gmail',
        platform_name: 'Gmail',
        name: 'gmail-main',
        bindings: [],
        expires_at: '2026-10-29T19:00:00Z',
        requested_by: null,
        connection: null,
        connected_by: null,
        connected_at: null,
        ...overrides,
    };
}

function connectedLink(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return requestedLink({
        status: 'connected',
        connection: { id: 7, name: 'gmail-main', status: 'active' },
        connected_by: { name: 'Pat Doe' },
        connected_at: '2026-10-28T19:05:00Z',
        bindings: [{ project: 'newsletter', var: 'GMAIL_KEY' }],
        ...overrides,
    });
}

describe('parseWaitTimeout', () => {
    it.each([
        ['30s', 30_000],
        ['15m', 900_000],
        ['1h', 3_600_000],
        ['90', 90_000],
        ['24h', 86_400_000],
    ])('parses %s as %d ms', (value, ms) => {
        expect(parseWaitTimeout(value)).toBe(ms);
    });

    it.each(['0s', '25h', 'abc', '15 m', '-5', ''])('refuses %j with a --timeout message', (value) => {
        expect(() => parseWaitTimeout(value)).toThrow(/--timeout/);
    });
});

describe('connectionWait', () => {
    let root: string;
    let home: string;
    let cwd: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-connection-wait-'));
        home = path.join(root, 'home');
        cwd = path.join(root, 'work');
        fs.mkdirSync(home, { recursive: true });
        fs.mkdirSync(cwd, { recursive: true });
        writeGlobal(home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            workspaceId: 'workspace-1',
        });
        requests = [];
        arrivals = [];
        queue = [];
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('polls requested, opened, then connected and prints the bindings made', async () => {
        queue = [
            { status: 200, payload: requestedLink() },
            { status: 200, payload: requestedLink({ status: 'opened' }) },
            { status: 200, payload: connectedLink() },
        ];
        const result = await runCli(['connection', 'wait', '01JBTEST'], home, cwd, fastPollEnv());

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(requests).toHaveLength(3);
        for (const request of requests) {
            expect(request).toMatchObject({ method: 'GET', url: '/api/v1/connections/requests/01JBTEST' });
            expect(request.headers.authorization).toBe(('Bear' + 'er test-key'));
            expect(request.headers['x-workspace-id']).toBe('workspace-1');
        }
        expect(result.stdout).toContain('Connected: gmail-main (Gmail), by Pat Doe.');
        expect(result.stdout).toContain('  project newsletter uses it as GMAIL_KEY');
    });

    it('prints Bindings: none when the link connected with no bindings', async () => {
        queue = [{ status: 200, payload: connectedLink({ bindings: [] }) }];
        const result = await runCli(['connection', 'wait', '01JBTEST'], home, cwd, fastPollEnv());

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('Connected: gmail-main (Gmail), by Pat Doe.');
        expect(result.stdout).toContain('Bindings: none.');
    });

    it('exits 1 on expired with a connect retry command', async () => {
        queue = [{ status: 200, payload: requestedLink({ status: 'expired' }) }];
        const result = await runCli(['connection', 'wait', '01JBTEST'], home, cwd, fastPollEnv());

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        expect(result.stderr.trim().split('\n')).toHaveLength(1);
        expect(result.stderr).toContain('expired');
        expect(result.stderr).toContain('solidactions connection connect gmail --name gmail-main');
        expect(result.stdout).toBe('');
    });

    it('exits 1 on expired with a reconnect retry command', async () => {
        queue = [{ status: 200, payload: requestedLink({ status: 'expired', mode: 'reconnect' }) }];
        const result = await runCli(['connection', 'wait', '01JBTEST'], home, cwd, fastPollEnv());

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('solidactions connection connect gmail --reconnect gmail-main');
        expect(result.stdout).toBe('');
    });

    it('quotes a name with spaces in the expired connect retry so it pastes as one argument', async () => {
        queue = [{ status: 200, payload: requestedLink({ status: 'expired', name: 'Team Gmail' }) }];
        const result = await runCli(['connection', 'wait', '01JBTEST'], home, cwd, fastPollEnv());

        expect(result.status).toBe(1);
        expect(result.stderr.trim().split('\n')).toHaveLength(1);
        expect(result.stderr).toContain(`solidactions connection connect gmail --name 'Team Gmail'`);
        expect(result.stdout).toBe('');
    });

    it('quotes a name with a quote in the expired reconnect retry so it pastes as one argument', async () => {
        queue = [{ status: 200, payload: requestedLink({ status: 'expired', mode: 'reconnect', name: `it's` }) }];
        const result = await runCli(['connection', 'wait', '01JBTEST'], home, cwd, fastPollEnv());

        expect(result.status).toBe(1);
        expect(result.stderr.trim().split('\n')).toHaveLength(1);
        expect(result.stderr).toContain(`solidactions connection connect gmail --reconnect 'it'\\''s'`);
        expect(result.stdout).toBe('');
    });

    it('exits 1 on cancelled with one line', async () => {
        queue = [{ status: 200, payload: requestedLink({ status: 'cancelled' }) }];
        const result = await runCli(['connection', 'wait', '01JBTEST'], home, cwd, fastPollEnv());

        expect(result.status).toBe(1);
        expect(result.stderr.trim().split('\n')).toHaveLength(1);
        expect(result.stderr).toContain('was cancelled');
        expect(result.stdout).toBe('');
    });

    it('exits 2 when the timeout passes while the link is still open', async () => {
        queue = [{ status: 200, payload: requestedLink() }];
        const result = await runCli(['connection', 'wait', '01JBTEST', '--timeout', '1s'], home, cwd, fastPollEnv());

        expect(result.status).toBe(2);
        expect(requests.length).toBeGreaterThanOrEqual(2);
        expect(result.stderr.trim().split('\n')).toHaveLength(1);
        expect(result.stderr).toContain('Still waiting after 1s');
        expect(result.stderr).toContain('is requested');
        expect(result.stderr).toContain('link expires 2026-10-29 19:00 UTC');
        expect(result.stderr).toContain('solidactions connection wait 01JBTEST');
        expect(result.stdout).toContain('2026-10-29 19:00 UTC');
    });

    it.skipIf(process.platform === 'win32')('sends no request after the deadline: a SIGSTOP-held wait resumes past it and admits nothing (SIGSTOP/SIGCONT are not deliverable on Windows; CI unit tests run on Linux)', { timeout: 30_000 }, async () => {
        queue = [{ status: 200, payload: requestedLink() }];
        const { child, done } = spawnCli(['connection', 'wait', '01JBTEST', '--timeout', '1s'], home, cwd, pollEnv(400));
        let announced = '';
        child.stdout?.on('data', (chunk) => {
            announced += chunk;
        });

        try {
            // Wait for the first arrival: the child computed its deadline
            // just before sending it, so everything after is relative to the
            // child — child boot time (spawn → first GET) cannot flake this
            // row the way a spawn-relative bound does.
            const deadline = Date.now() + 5_000;
            while (arrivals.length < 1 && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            expect(arrivals.length).toBeGreaterThanOrEqual(1);

            // Readiness: the announce line on the child's stdout proves GET#1
            // was answered AND processed (the child is in its 400 ms sleep),
            // so SIGSTOP cannot land between the arrival and the reply being
            // read — on resume the abort timer would otherwise win over the
            // buffered reply and the fixed code would print `status unknown`.
            const announcedBy = Date.now() + 5_000;
            while (!announced.includes('Waiting for someone to connect') && Date.now() < announcedBy) {
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            expect(announced).toContain('Waiting for someone to connect');

            // Hold the child past its 1s budget, then let it run again. On
            // resume the poll timer is late, Date.now() >= deadline, so the
            // admission branch exits 2 without sending another GET.
            child.kill('SIGSTOP');
            await new Promise((resolve) => setTimeout(resolve, 1300));
            child.kill('SIGCONT');
            const result = await done;

            expect(result.status).toBe(2);
            expect(result.stderr).toContain('Still waiting after 1s');
            expect(result.stderr).toContain('is requested');
            expect(result.stdout).toContain('Waiting for someone to connect Gmail as gmail-main');
            expect(arrivals.length).toBe(1);
        } finally {
            // The test may fail between STOP and CONT: continue first so a
            // SIGTERM can land, then make sure the child is gone.
            child.kill('SIGCONT');
            child.kill();
        }
    });

    it('recovers from transient 503s and prints Connected', async () => {
        queue = [
            { status: 503, payload: { message: 'Service Unavailable' } },
            { status: 503, payload: { message: 'Service Unavailable' } },
            { status: 200, payload: connectedLink() },
        ];
        const result = await runCli(['connection', 'wait', '01JBTEST'], home, cwd, fastPollEnv());

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('Connected: gmail-main (Gmail), by Pat Doe.');
    });

    it('exits 1 with the unusable-status line when a connected payload has no platform_name', async () => {
        // `undefined` values are dropped by JSON, so the server answers a
        // connected payload with no `platform_name` key at all.
        queue = [{ status: 200, payload: connectedLink({ platform_name: undefined }) }];
        const result = await runCli(['connection', 'wait', '01JBTEST'], home, cwd, fastPollEnv());

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        expect(result.stderr.trim().split('\n')).toHaveLength(1);
        expect(result.stderr).toContain('no usable status');
        expect(result.stdout).toBe('');
        expect(result.stdout).not.toContain('Connected:');
    });

    it('gives up after exactly 5 failed checks in a row', async () => {
        queue = [{ status: 503, payload: { message: 'Service Unavailable' } }];
        const result = await runCli(['connection', 'wait', '01JBTEST'], home, cwd, fastPollEnv());

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(5);
        expect(result.stderr.trim().startsWith('Failed: 503')).toBe(true);
        expect(result.stderr).toContain('5 failed checks in a row');
        expect(result.stdout).toBe('');
    });

    it('fails at once on a 404 request_not_found', async () => {
        queue = [{ status: 404, payload: { code: 'request_not_found', message: 'Connect link not found.' } }];
        const result = await runCli(['connection', 'wait', '01JBTEST'], home, cwd, fastPollEnv());

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        expect(result.stderr.trim()).toBe('Failed: 404 Connect link not found.');
        expect(result.stdout).toBe('');
    });

    it('names the host on a 401', async () => {
        queue = [{ status: 401, payload: { message: 'Unauthenticated.' } }];
        const result = await runCli(['connection', 'wait', '01JBTEST'], home, cwd, fastPollEnv());

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        expect(result.stderr).toContain('Authentication failed against');
        expect(result.stderr).toContain(`127.0.0.1:${port}`);
        expect(result.stdout).toBe('');
    });

    it('fails on an unknown status without ever exiting 0', async () => {
        queue = [{ status: 200, payload: requestedLink({ status: 'weird' }) }];
        const result = await runCli(['connection', 'wait', '01JBTEST'], home, cwd, fastPollEnv());

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('unknown status');
        expect(result.stdout).toBe('');
    });

    it('exits 1 at once with one line when repeated 200s carry no usable status', async () => {
        queue = [{ status: 200, payload: null }];
        const result = await runCli(['connection', 'wait', '01JBTEST', '--timeout', '1s'], home, cwd, fastPollEnv());

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        expect(result.stderr.trim()).toBe(`Failed: connect link 01JBTEST: the server's answer has no usable status.`);
        expect(result.stdout).toBe('');
    });

    it('exits 1 at once with one line when a 200 carries a non-string status', async () => {
        queue = [{ status: 200, payload: requestedLink({ status: 7 }) }];
        const result = await runCli(['connection', 'wait', '01JBTEST', '--timeout', '1s'], home, cwd, fastPollEnv());

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        expect(result.stderr.trim()).toBe(`Failed: connect link 01JBTEST: the server's answer has no usable status.`);
        expect(result.stderr).not.toContain('    at ');
        expect(result.stdout).toBe('');
    });

    it('exits 1 after exactly 1 request when a requested payload has no usable fields', async () => {
        queue = [{ status: 200, payload: { status: 'requested' } }];
        const result = await runCli(['connection', 'wait', '01JBTEST', '--timeout', '1s'], home, cwd, fastPollEnv());

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        expect(result.stderr.trim().split('\n')).toHaveLength(1);
        expect(result.stderr.trim()).toBe(`Failed: connect link 01JBTEST: the server's answer has no usable status.`);
        expect(result.stderr).not.toContain('    at ');
        expect(result.stdout).toBe('');
    });

    it('exits 1 with one line when an expired payload has no name', async () => {
        queue = [{ status: 200, payload: requestedLink({ status: 'expired', name: undefined }) }];
        const result = await runCli(['connection', 'wait', '01JBTEST', '--timeout', '1s'], home, cwd, fastPollEnv());

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        expect(result.stderr.trim().split('\n')).toHaveLength(1);
        expect(result.stderr.trim()).toBe(`Failed: connect link 01JBTEST: the server's answer has no usable status.`);
        expect(result.stderr).not.toContain('    at ');
        expect(result.stdout).toBe('');
    });

    it('exits 1 without printing Connected when a connected payload has unusable bindings', async () => {
        queue = [{ status: 200, payload: connectedLink({ bindings: [{ project: 'newsletter' }] }) }];
        const result = await runCli(['connection', 'wait', '01JBTEST'], home, cwd, fastPollEnv());

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        expect(result.stderr.trim().split('\n')).toHaveLength(1);
        expect(result.stderr).toContain('unusable bindings');
        expect(result.stderr).not.toContain('    at ');
        expect(result.stdout).not.toContain('Connected:');
        expect(result.stdout).toBe('');
    });

    it('exits 1 without printing Connected when a connected payload has a non-object connection', async () => {
        queue = [{ status: 200, payload: connectedLink({ connection: 'weird' }) }];
        const result = await runCli(['connection', 'wait', '01JBTEST'], home, cwd, fastPollEnv());

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        expect(result.stderr.trim().split('\n')).toHaveLength(1);
        expect(result.stderr).toContain('unusable connection');
        expect(result.stderr).not.toContain('    at ');
        expect(result.stdout).not.toContain('Connected:');
        expect(result.stdout).toBe('');
    });

    it('treats a missing bindings array on a connected payload as none', async () => {
        const link = connectedLink();
        delete (link as Record<string, unknown>).bindings;
        queue = [{ status: 200, payload: link }];
        const result = await runCli(['connection', 'wait', '01JBTEST'], home, cwd, fastPollEnv());

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('Connected: gmail-main (Gmail), by Pat Doe.');
        expect(result.stdout).toContain('Bindings: none.');
    });

    it('refuses an invalid --timeout locally with zero requests', async () => {
        const result = await runCli(['connection', 'wait', '01JBTEST', '--timeout', '15 m'], home, cwd, fastPollEnv());

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(0);
        expect(result.stderr).toContain('--timeout');
        expect(result.stdout).toBe('');
    });

    it('strips terminal control sequences from the connected name', async () => {
        queue = [{ status: 200, payload: connectedLink({ connection: { id: 7, name: 'gmail-\u001b[2Jmain', status: 'active' } }) }];
        const result = await runCli(['connection', 'wait', '01JBTEST'], home, cwd, fastPollEnv());

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).not.toContain('\u001b');
        expect(result.stdout).toContain('Connected: gmail-[2Jmain (Gmail), by Pat Doe.');
    });

    it.skipIf(process.platform === 'win32')('exits 130 on Ctrl-C with a resume line and keeps the link open (SIGINT to a child is not deliverable on Windows; CI unit tests run on Linux)', { timeout: 30_000 }, async () => {
        queue = [{ status: 200, payload: requestedLink() }];
        const { child, done } = spawnCli(['connection', 'wait', '01JBTEST', '--timeout', '1h'], home, cwd, fastPollEnv());

        const deadline = Date.now() + 5_000;
        while (requests.length < 1 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(requests.length).toBeGreaterThanOrEqual(1);

        child.kill('SIGINT');
        const result = await done;

        expect(result.status).toBe(130);
        expect(result.signal).toBe(null);
        expect(result.stderr).toContain('Still waiting: resume with solidactions connection wait 01JBTEST');
        expect(result.stderr).not.toContain('Failed');
        expect(result.stderr).not.toContain('    at ');

        const countAfterClose = requests.length;
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(requests.length).toBe(countAfterClose);
    });

    it('never prints unknown as if it were a status: requested then failing checks', async () => {
        queue = [
            { status: 200, payload: requestedLink() },
            { status: 503, payload: { message: 'Service Unavailable' } },
        ];
        const result = await runCli(['connection', 'wait', '01JBTEST', '--timeout', '1s'], home, cwd, pollEnv(400));

        expect(result.status).toBe(2);
        expect(result.stderr).toContain('is requested');
    });

    it('never prints unknown as if it were a status: every check failing', async () => {
        queue = [{ status: 503, payload: { message: 'Service Unavailable' } }];
        const result = await runCli(['connection', 'wait', '01JBTEST', '--timeout', '1s'], home, cwd, pollEnv(400));

        expect(result.status).toBe(2);
        expect(result.stderr).toContain('status unknown (last check failed)');
        expect(result.stderr).not.toContain('is unknown');
    });

    it('exits 2 within the tolerance when the first status GET never answers', async () => {
        const held = await startHoldServer(() => {
            // Hold the response: never call response.end().
        });
        try {
            writeGlobal(home, {
                host: held.host,
                apiKey: 'test-key',
                workspaceId: 'workspace-1',
            });
            const startedAt = Date.now();
            const result = await runCli(['connection', 'wait', '01JBTEST', '--timeout', '1s'], home, cwd, fastPollEnv());

            expect(result.status).toBe(2);
            expect(Date.now() - startedAt).toBeLessThan(4000);
            expect(held.arrivals).toHaveLength(1);
            expect(result.stderr.trim().split('\n')).toHaveLength(1);
            expect(result.stderr).toContain('Still waiting after 1s');
            expect(result.stderr).toContain('status unknown (last check failed)');
            expect(result.stderr).toContain('solidactions connection wait 01JBTEST');
            expect(result.stderr).not.toContain('Connection failed');
            expect(result.stdout).toBe('');
            await waitForSocketsDestroyed(held.seen);
            expect(held.seen.every((socket) => socket.destroyed)).toBe(true);
        } finally {
            await held.close();
        }
    });

    it('exits 2 with the last known status when a later GET hangs after a requested reply', async () => {
        const held = await startHoldServer((index, response) => {
            if (index === 0) {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(requestedLink()));
            }
            // Later GETs hang: never call response.end().
        });
        try {
            writeGlobal(home, {
                host: held.host,
                apiKey: 'test-key',
                workspaceId: 'workspace-1',
            });
            const startedAt = Date.now();
            const result = await runCli(['connection', 'wait', '01JBTEST', '--timeout', '1s'], home, cwd, fastPollEnv());

            expect(result.status).toBe(2);
            expect(Date.now() - startedAt).toBeLessThan(4000);
            expect(held.arrivals).toHaveLength(2);
            expect(result.stderr).toContain('Still waiting after 1s');
            expect(result.stderr).toContain('is requested');
            expect(result.stderr).toContain('link expires 2026-10-29 19:00 UTC');
            expect(result.stdout).toContain('Waiting for someone to connect Gmail as gmail-main');
        } finally {
            await held.close();
        }
    });

    it('admits no request after the deadline: a connected reply past it is never processed', async () => {
        const held = await startHoldServer((index, response) => {
            if (index === 0) {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(requestedLink()));
                return;
            }
            // Answer connected long after the 1s deadline; the fixed CLI must
            // have exited by then and never see it.
            const timer = setTimeout(() => {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(connectedLink()));
            }, 3000);
            response.on('close', () => clearTimeout(timer));
        });
        try {
            writeGlobal(home, {
                host: held.host,
                apiKey: 'test-key',
                workspaceId: 'workspace-1',
            });
            const startedAt = Date.now();
            const result = await runCli(['connection', 'wait', '01JBTEST', '--timeout', '1s'], home, cwd, fastPollEnv());

            expect(result.status).toBe(2);
            expect(Date.now() - startedAt).toBeLessThan(4000);
            expect(held.arrivals).toHaveLength(2);
            expect(result.stdout).not.toContain('Connected:');
            expect(result.stderr).toContain('Still waiting after 1s');
            expect(result.stderr).toContain('is requested');
        } finally {
            await held.close();
        }
    });

    it.skipIf(process.platform === 'win32')('exits 130 with a resume line when SIGINT arrives during a held GET', { timeout: 30_000 }, async () => {
        const held = await startHoldServer(() => {
            // Hold the response: never call response.end().
        });
        try {
            writeGlobal(home, {
                host: held.host,
                apiKey: 'test-key',
                workspaceId: 'workspace-1',
            });
            const { child, done } = spawnCli(['connection', 'wait', '01JBTEST', '--timeout', '1h'], home, cwd, fastPollEnv());

            const deadline = Date.now() + 5_000;
            while (held.arrivals.length < 1 && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            expect(held.arrivals.length).toBeGreaterThanOrEqual(1);

            child.kill('SIGINT');
            const result = await done;

            expect(result.status).toBe(130);
            expect(result.signal).toBe(null);
            expect(result.stderr).toContain('Still waiting: resume with solidactions connection wait 01JBTEST');
            expect(result.stderr).not.toContain('    at ');

            const countAfterClose = held.arrivals.length;
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(held.arrivals.length).toBe(countAfterClose);
        } finally {
            await held.close();
        }
    });
});

interface HoldServer {
    server: http.Server;
    host: string;
    arrivals: number[];
    seen: net.Socket[];
    close: () => Promise<void>;
}

/**
 * A loopback server whose handler decides per request whether to answer or
 * hold the response open (never calling `response.end()`). Held sockets are
 * tracked so the test can close them after the child exits.
 */
function startHoldServer(onRequest: (index: number, response: http.ServerResponse) => void): Promise<HoldServer> {
    const arrivals: number[] = [];
    const seen: net.Socket[] = [];
    const live = new Set<net.Socket>();
    const server = http.createServer((request, response) => {
        arrivals.push(Date.now());
        request.resume();
        request.on('end', () => {
            onRequest(arrivals.length - 1, response);
        });
    });
    server.on('connection', (socket) => {
        seen.push(socket);
        live.add(socket);
        socket.on('close', () => {
            live.delete(socket);
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as { port: number }).port;
            resolve({
                server,
                host: `http://127.0.0.1:${port}`,
                arrivals,
                seen,
                close: async () => {
                    for (const socket of live) {
                        socket.destroy();
                    }
                    await new Promise<void>((resolveClose, rejectClose) => {
                        server.close((error) => (error ? rejectClose(error) : resolveClose()));
                    });
                },
            });
        });
    });
}

async function waitForSocketsDestroyed(sockets: net.Socket[]): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
        if (sockets.length > 0 && sockets.every((socket) => socket.destroyed)) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

function fastPollEnv(): Record<string, string> {
    return pollEnv(50);
}

function pollEnv(intervalMs: number): Record<string, string> {
    return {
        SOLIDACTIONS_TEST_HOOKS: '1',
        SOLIDACTIONS_CONNECTION_WAIT_INTERVAL_MS: String(intervalMs),
    };
}

interface CliResult {
    stdout: string;
    stderr: string;
    status: number | null;
    signal: NodeJS.Signals | null;
}

function childEnv(home: string, extra: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...extra };
    delete env.SOLIDACTIONS_HOST;
    delete env.SOLIDACTIONS_API_KEY;
    delete env.SOLIDACTIONS_WORKSPACE_ID;
    delete env.DEBUG;
    delete env.NODE_DEBUG;
    delete env.FORCE_COLOR;
    if (extra.SOLIDACTIONS_TEST_HOOKS === undefined) {
        delete env.SOLIDACTIONS_TEST_HOOKS;
    }
    return env;
}

function runCli(args: string[], home: string, cwd: string, extraEnv: Record<string, string> = {}): Promise<CliResult> {
    return new Promise((resolve, reject) => {
        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], {
            cwd,
            env: childEnv(home, extraEnv),
        });
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

        child.on('close', (status, signal) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, status, signal });
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

function spawnCli(args: string[], home: string, cwd: string, extraEnv: Record<string, string> = {}): {
    child: childProcess.ChildProcess;
    done: Promise<CliResult>;
} {
    const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], {
        cwd,
        env: childEnv(home, extraEnv),
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
        stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
        stderr += chunk;
    });

    const done = new Promise<CliResult>((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`CLI timed out. stdout: ${stdout} stderr: ${stderr}`));
        }, 15_000);

        child.on('close', (status, signal) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, status, signal });
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });

    return { child, done };
}

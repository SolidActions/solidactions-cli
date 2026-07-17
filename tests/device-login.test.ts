/**
 * pollForToken drives the RFC 8628 §3.5 device-flow polling loop. Test-double
 * policy (matching tests/login-validation.test.ts): a real in-process HTTP
 * server stubs POST /oauth/token, no mock/spy/stub libraries. Interval
 * arguments are kept sub-second (fractional seconds) so the suite stays fast
 * without needing fake timers.
 */
import http from 'http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pollForToken } from '../src/commands/device-login';

describe('pollForToken', () => {
    let server: http.Server;
    let port: number;
    let responses: Array<{ status: number; body: unknown }>;
    let requestCount: number;

    const HOST = () => `http://127.0.0.1:${port}`;

    beforeAll(async () => {
        server = http.createServer((_req, res) => {
            requestCount++;
            const next = responses.shift() ?? { status: 500, body: {} };
            res.writeHead(next.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(next.body));
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
            server.close((err) => (err ? reject(err) : resolve()));
        });
    });

    beforeEach(() => {
        requestCount = 0;
    });

    it('honors authorization_pending and returns the token once approved', async () => {
        responses = [
            { status: 400, body: { error: 'authorization_pending' } },
            { status: 200, body: { access_token: 'tok-123', expires_in: 3600 } },
        ];

        const result = await pollForToken(HOST(), 'client-id', 'devcode', 0.02, 0.02);

        expect(result.access_token).toBe('tok-123');
        expect(requestCount).toBe(2);
    });

    it('backs off on slow_down by increasing the interval before the next poll', async () => {
        responses = [
            { status: 400, body: { error: 'slow_down' } },
            { status: 200, body: { access_token: 'tok-456', expires_in: 3600 } },
        ];

        const start = Date.now();
        const result = await pollForToken(HOST(), 'client-id', 'devcode', 0.02, 0.1);
        const elapsed = Date.now() - start;

        expect(result.access_token).toBe('tok-456');
        expect(requestCount).toBe(2);
        // First poll after ~0.02s, second only after the bumped ~0.12s interval.
        expect(elapsed).toBeGreaterThanOrEqual(110);
    });

    it('throws on access_denied', async () => {
        responses = [{ status: 400, body: { error: 'access_denied' } }];

        await expect(pollForToken(HOST(), 'client-id', 'devcode', 0.02, 0.02)).rejects.toThrow('access_denied');
        expect(requestCount).toBe(1);
    });
});

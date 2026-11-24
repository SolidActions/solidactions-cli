/**
 * requestDeviceCode requests the fine per-area scope list first (#2911 part 3),
 * then degrades through the older lists: with connect links, with `env:reveal`,
 * and the legacy coarse list. Servers that haven't registered one of the
 * requested scopes reject the ENTIRE device-code request with 400
 * `invalid_scope` — this must degrade gracefully (at most 4 requests), rather
 * than hard-breaking `solidactions login` for every user of that server. Real
 * in-process HTTP server, no mocks.
 */
import http from 'http';
import { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { requestDeviceCode } from '../src/commands/device-login';

function startServer(
    handler: (body: Record<string, unknown>, requestIndex: number) => { status: number; body: unknown },
): Promise<{ server: http.Server; host: string; requests: Record<string, unknown>[] }> {
    const requests: Record<string, unknown>[] = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            const body = JSON.parse(raw || '{}');
            requests.push(body);
            const { status, body: responseBody } = handler(body, requests.length - 1);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responseBody));
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as AddressInfo).port;
            resolve({ server, host: `http://127.0.0.1:${port}`, requests });
        });
    });
}

describe('requestDeviceCode — scope fallback', () => {
    let server: http.Server | undefined;

    afterEach(() => {
        return new Promise<void>((resolve, reject) => {
            if (!server) return resolve();
            server.close((err) => (err ? reject(err) : resolve()));
        });
    });

    function acceptedCode() {
        return {
            status: 200,
            body: {
                device_code: 'device-code',
                user_code: 'USER-CODE',
                verification_uri: 'https://example.test/device',
                expires_in: 600,
                interval: 5,
            },
        };
    }

    function invalidScope() {
        return {
            status: 400,
            body: {
                error: 'invalid_scope',
                error_description: 'The requested scope is invalid, unknown, or malformed',
            },
        };
    }

    const FINE = 'deploy:read deploy:edit runs:read runs:edit env:read env:edit crews:read crews:edit '
        + 'docs:read docs:edit databases:read databases:edit connections:request env:reveal workspace:read';
    const WITH_CONNECT_LINKS = 'env env:reveal deploy runs docs databases connections:request';
    const WITH_REVEAL = 'env env:reveal deploy runs docs databases';
    const LEGACY = 'env deploy runs docs databases';

    it('makes one request with the fine scope list when the server accepts it', async () => {
        const started = await startServer(() => acceptedCode());
        server = started.server;

        const result = await requestDeviceCode(started.host);

        expect(result.device_code).toBe('device-code');
        expect(started.requests).toHaveLength(1);
        expect(started.requests[0].scope).toBe(FINE);
    });

    it('makes 2 requests, fine then the connect-links list, when the server rejects only the fine scopes', async () => {
        const started = await startServer((body) => {
            return String(body.scope).includes('deploy:read') ? invalidScope() : acceptedCode();
        });
        server = started.server;

        const result = await requestDeviceCode(started.host);

        expect(result.device_code).toBe('device-code');
        expect(started.requests.map((request) => request.scope)).toEqual([FINE, WITH_CONNECT_LINKS]);
    });

    it('makes 3 requests, ending on the env:reveal list, when the server rejects connections:request', async () => {
        const started = await startServer((body) => {
            return String(body.scope).includes('connections:request') ? invalidScope() : acceptedCode();
        });
        server = started.server;

        const result = await requestDeviceCode(started.host);

        expect(result.device_code).toBe('device-code');
        expect(started.requests.map((request) => request.scope)).toEqual([FINE, WITH_CONNECT_LINKS, WITH_REVEAL]);
    });

    it('makes 4 requests, ending on the legacy list, when the server rejects env:reveal', async () => {
        const started = await startServer((body) => {
            return String(body.scope).includes('env:reveal') ? invalidScope() : acceptedCode();
        });
        server = started.server;

        const result = await requestDeviceCode(started.host);

        expect(result.device_code).toBe('device-code');
        expect(started.requests.map((request) => request.scope)).toEqual([
            FINE,
            WITH_CONNECT_LINKS,
            WITH_REVEAL,
            LEGACY,
        ]);
    });

    it('stops after 4 requests and rejects when even the legacy list is refused with invalid_scope', async () => {
        const started = await startServer(() => invalidScope());
        server = started.server;

        await expect(requestDeviceCode(started.host)).rejects.toBeTruthy();
        expect(started.requests).toHaveLength(4);
    });

    it('does not retry and rejects on a 400 for an unrelated reason (e.g. invalid_client)', async () => {
        const started = await startServer(() => ({
            status: 400,
            body: {
                error: 'invalid_client',
                error_description: 'Client authentication failed',
            },
        }));
        server = started.server;

        await expect(requestDeviceCode(started.host)).rejects.toBeTruthy();
        expect(started.requests).toHaveLength(1);
    });
});

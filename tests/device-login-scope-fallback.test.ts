/**
 * requestDeviceCode requests the full `env:reveal`-including scope list
 * first. Servers that haven't registered `env:reveal` (#1252 not yet
 * deployed there) reject the ENTIRE device-code request with 400
 * `invalid_scope` — this must degrade gracefully by retrying once with the
 * legacy scope list, rather than hard-breaking `solidactions login --device`
 * for every user of that server. Real in-process HTTP server, no mocks.
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

describe('requestDeviceCode — env:reveal scope fallback', () => {
    let server: http.Server | undefined;

    afterEach(() => {
        return new Promise<void>((resolve, reject) => {
            if (!server) return resolve();
            server.close((err) => (err ? reject(err) : resolve()));
        });
    });

    it('retries once with the legacy scope list when the server rejects env:reveal with invalid_scope', async () => {
        const started = await startServer((body) => {
            const scope = String(body.scope);
            if (scope.includes('env:reveal')) {
                return {
                    status: 400,
                    body: {
                        error: 'invalid_scope',
                        error_description: 'The requested scope is invalid, unknown, or malformed',
                        hint: 'Check the `env:reveal` scope',
                    },
                };
            }
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
        });
        server = started.server;

        const result = await requestDeviceCode(started.host);

        expect(result.device_code).toBe('device-code');
        expect(started.requests).toHaveLength(2);
        expect(String(started.requests[0].scope)).toContain('env:reveal');
        expect(String(started.requests[1].scope)).not.toContain('env:reveal');
    });

    it('makes only one request, including env:reveal, when the server accepts the full scope list', async () => {
        const started = await startServer(() => ({
            status: 200,
            body: {
                device_code: 'device-code',
                user_code: 'USER-CODE',
                verification_uri: 'https://example.test/device',
                expires_in: 600,
                interval: 5,
            },
        }));
        server = started.server;

        const result = await requestDeviceCode(started.host);

        expect(result.device_code).toBe('device-code');
        expect(started.requests).toHaveLength(1);
        expect(String(started.requests[0].scope)).toContain('env:reveal');
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

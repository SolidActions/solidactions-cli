import http from 'http';
import { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { requestDeviceCode } from '../src/commands/device-login';

describe('database device-token compatibility', () => {
    let server: http.Server | undefined;

    afterEach(() => {
        const closing = server;
        server = undefined;
        return new Promise<void>((resolve, reject) => {
            if (!closing) return resolve();
            closing.close((err) => (err ? reject(err) : resolve()));
        });
    });

    it('requests the coarse databases scope during device authorization', async () => {
        const requests: Record<string, unknown>[] = [];
        server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (chunk) => {
                raw += chunk;
            });
            req.on('end', () => {
                requests.push(JSON.parse(raw || '{}'));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    device_code: 'device-code',
                    user_code: 'USER-CODE',
                    verification_uri: 'https://example.test/device',
                    expires_in: 600,
                    interval: 5,
                }));
            });
        });
        await new Promise<void>((resolve) => {
            server!.listen(0, '127.0.0.1', () => resolve());
        });
        const host = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

        const result = await requestDeviceCode(host);

        expect(result.device_code).toBe('device-code');
        expect(requests).toHaveLength(1);
        // `env:reveal` joined this list in #1252. It is requested, not assumed
        // granted — the consent screen shows it as a default-off checkbox and
        // the server strips it from the token unless the user opts in. It has
        // to be requested here regardless, because a device code's scope set is
        // frozen at creation and consent can never add to it.
        // `connections:request` joined in cli#219 (connect links).
        expect(String(requests[0]?.scope).split(/\s+/).sort()).toEqual(
            ['connections:request', 'databases', 'deploy', 'docs', 'env', 'env:reveal', 'runs'],
        );
    });

    it('exports a reusable stale-token hint for database ability failures', async () => {
        const api = await import('../src/utils/api') as Record<string, unknown>;
        const augment = api.augmentTokenMissingAbilityMessage;

        expect(augment).toBeTypeOf('function');
        if (typeof augment !== 'function') return;

        const error: any = {
            response: {
                status: 403,
                data: {
                    code: 'token_missing_ability',
                    message: "This API key does not have the 'databases' ability.",
                    required_ability: 'databases',
                },
            },
        };
        const result = (augment as (error: any) => any)(error);

        expect(result.response.data.message).toContain("does not have the 'databases' ability");
        expect(result.response.data.message).toContain('solidactions login --device');

        const unrelated: any = {
            response: { status: 403, data: { code: 'forbidden', message: 'Access denied.' } },
        };
        expect((augment as (error: any) => any)(unrelated)).toBe(unrelated);
        expect(unrelated.response.data.message).toBe('Access denied.');

        const otherAbility: any = {
            response: {
                status: 403,
                data: {
                    code: 'token_missing_ability',
                    message: "This API key does not have the 'env' ability.",
                    required_ability: 'env',
                },
            },
        };
        expect((augment as (error: any) => any)(otherAbility)).toBe(otherAbility);
        expect(otherAbility.response.data.message).not.toContain('solidactions login --device');
    });
});

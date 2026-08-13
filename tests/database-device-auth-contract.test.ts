import axios, { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it } from 'vitest';
import { requestDeviceCode } from '../src/commands/device-login';

describe('database device-token compatibility', () => {
    it('requests the coarse databases scope during device authorization', async () => {
        const originalAdapter = axios.defaults.adapter;
        let requestBody: Record<string, unknown> | undefined;
        axios.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
            requestBody = JSON.parse(String(config.data));
            return {
                status: 200,
                statusText: 'OK',
                headers: {},
                config,
                data: {
                    device_code: 'device-code',
                    user_code: 'USER-CODE',
                    verification_uri: 'https://example.test/device',
                    expires_in: 600,
                    interval: 5,
                },
            };
        };

        try {
            await requestDeviceCode('https://app.solidactions.com');
        } finally {
            axios.defaults.adapter = originalAdapter;
        }

        // `env:reveal` joined this list in #1252. It is requested, not assumed
        // granted — the consent screen shows it as a default-off checkbox and
        // the server strips it from the token unless the user opts in. It has
        // to be requested here regardless, because a device code's scope set is
        // frozen at creation and consent can never add to it.
        expect(String(requestBody?.scope).split(/\s+/).sort()).toEqual(
            ['databases', 'deploy', 'docs', 'env', 'env:reveal', 'runs'],
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

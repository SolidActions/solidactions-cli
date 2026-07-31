import { AxiosHeaders } from 'axios';
import { describe, expect, it } from 'vitest';
import {
    augmentSandboxEgressMessage,
    augmentWorkspaceForbiddenMessage,
    SANDBOX_EGRESS_MESSAGE,
} from '../src/utils/api';

function proxyError(overrides: {
    status?: number;
    url?: string;
    headers?: unknown;
    data?: unknown;
} = {}): any {
    const error: any = new Error('Request failed with status code 403');
    error.isAxiosError = true;
    error.config = {
        url: overrides.url ?? 'https://app.solidactions.com/oauth/device/code',
    };
    error.response = {
        status: overrides.status ?? 403,
        headers: overrides.headers ?? {},
        data: overrides.data ?? 'host not permitted by sandbox network policy',
    };
    return error;
}

describe('augmentSandboxEgressMessage', () => {
    it.each([
        'host not permitted',
        'HOST IS NOT PERMITTED by policy',
        { error: 'network access denied' },
        { message: 'Network egress to this host is blocked' },
        { message: 'network egress has been disabled' },
        { error: 'destination app.solidactions.com is not allowed' },
    ])('diagnoses the narrow Cloud proxy phrase fixture %#', (data) => {
        const originalText = typeof data === 'string'
            ? data
            : String((data as { error?: string; message?: string }).error
                ?? (data as { message?: string }).message);
        const result = augmentSandboxEgressMessage(proxyError({ data }));

        expect(result.message).toBe(SANDBOX_EGRESS_MESSAGE);
        expect(result.message).toContain('Allow-list app.solidactions.com');
        expect(result.message).toContain(
            'https://www.solidactions.com/docs/troubleshooting/#sandbox-egress',
        );
        expect(result.response.data.message).toContain(SANDBOX_EGRESS_MESSAGE);
        expect(result.response.data.message).toContain(originalText);
    });

    it.each([
        ['wrong status', { status: 429 }],
        ['plain Server header', { headers: { server: 'cloudflare' } }],
        ['mixed-case Server header', { headers: { SeRvEr: 'nginx' } }],
        ['AxiosHeaders Server header', { headers: new AxiosHeaders({ Server: 'envoy' }) }],
        ['SolidActions code', { data: { code: 'workspace_forbidden', message: 'host not permitted' } }],
        ['unrelated body', { data: { message: 'Forbidden.' } }],
        ['self-hosted URL', { url: 'https://solidactions.internal/oauth/device/code' }],
        ['local development URL', { url: 'http://localhost:8000/oauth/device/code' }],
    ])('does not classify %s', (_name, overrides) => {
        const error = proxyError(overrides);
        const originalMessage = error.message;
        const originalData = error.response.data;

        const result = augmentSandboxEgressMessage(error);

        expect(result.message).toBe(originalMessage);
        expect(result.response.data).toBe(originalData);
    });

    it.each(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'])(
        'does not classify connection-level %s failures',
        (code) => {
            const error: any = new Error('Could not reach host');
            error.code = code;
            error.config = { url: 'https://app.solidactions.com/oauth/device/code' };

            expect(augmentSandboxEgressMessage(error).message).toBe('Could not reach host');
        },
    );

    it('keeps workspace_forbidden augmentation intact', () => {
        const error = proxyError({
            data: { code: 'workspace_forbidden', message: 'host not permitted' },
        });

        const result = augmentWorkspaceForbiddenMessage(augmentSandboxEgressMessage(error));

        expect(result.message).toBe('Request failed with status code 403');
        expect(result.response.data.message).toContain('limited set of workspaces');
        expect(result.response.data.message).toContain('login --device');
    });
});

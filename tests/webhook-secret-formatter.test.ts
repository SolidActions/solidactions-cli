import { describe, expect, it } from 'vitest';
import { formatSecretOutput } from '../src/commands/webhook-secret';

describe('formatSecretOutput', () => {
    it('returns the raw secret when there is exactly one webhook', () => {
        const result = formatSecretOutput([{ workflow_name: 'hello', webhook_secret: 'abc123' }]);
        expect(result).toBe('abc123');
    });

    it('returns a table when there are multiple webhooks', () => {
        const result = formatSecretOutput([
            { workflow_name: 'alpha', webhook_secret: 'secret-a' },
            { workflow_name: 'beta', webhook_secret: 'secret-b' },
        ]);
        expect(result).toContain('WORKFLOW');
        expect(result).toContain('alpha');
        expect(result).toContain('secret-a');
        expect(result).toContain('beta');
        expect(result).toContain('secret-b');
    });

    it('filters to a single workflow by name when --workflow is given', () => {
        const result = formatSecretOutput(
            [
                { workflow_name: 'alpha', webhook_secret: 'secret-a' },
                { workflow_name: 'beta', webhook_secret: 'secret-b' },
            ],
            'beta'
        );
        expect(result).toBe('secret-b');
    });

    it('returns a not-found message when --workflow filter matches nothing', () => {
        const result = formatSecretOutput(
            [{ workflow_name: 'alpha', webhook_secret: 'secret-a' }],
            'nope'
        );
        expect(result).toContain('No webhook named "nope" found.');
    });

    it('returns a placeholder when secret is absent (access denied)', () => {
        const result = formatSecretOutput([{ workflow_name: 'hello', webhook_secret: undefined }]);
        expect(result).toContain('secret not returned');
    });
});

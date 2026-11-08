import { describe, expect, it } from 'vitest';
import { formatSecretJson, formatSecretOutput } from '../src/commands/webhook-secret';

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

    it('S1: returns the workflow raw secret when a function row is mixed in', () => {
        const result = formatSecretOutput([
            { workflow_name: 'hello', webhook_secret: 'abc123' },
            { kind: 'function', workflow_name: undefined, webhook_secret: 'fn-secret' },
        ]);
        expect(result).toBe('abc123');
    });

    it('S2: matches --workflow against workflow rows only, ignoring a same-named function', () => {
        const result = formatSecretOutput(
            [
                { kind: 'function', workflow_name: 'alpha', webhook_secret: 'function-alpha-secret' },
                { workflow_name: 'alpha', webhook_secret: 'workflow-alpha-secret' },
            ],
            'alpha'
        );
        expect(result).toBe('workflow-alpha-secret');
    });

    it('S3: outputs only workflow rows as {workflow, secret} in JSON', () => {
        const output = JSON.parse(
            formatSecretJson([
                { workflow_name: 'alpha', webhook_secret: 'secret-a' },
                { kind: 'function', workflow_name: 'my-fn', webhook_secret: 'fn-secret' },
            ])
        );
        expect(output).toEqual([{ workflow: 'alpha', secret: 'secret-a' }]);
    });
});

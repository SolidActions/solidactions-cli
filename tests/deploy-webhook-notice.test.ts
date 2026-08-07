import { describe, expect, it } from 'vitest';
import { shouldPrintWebhookSecretNotice } from '../src/commands/deploy';

describe('shouldPrintWebhookSecretNotice', () => {
    it('returns true for a webhook workflow with hmac auth (default)', () => {
        expect(shouldPrintWebhookSecretNotice([{ name: 'hello', trigger: 'webhook' }])).toBe(true);
    });

    it('returns true for explicit hmac', () => {
        expect(shouldPrintWebhookSecretNotice([
            { name: 'hello', trigger: 'webhook', webhook: { auth: 'hmac' } },
        ])).toBe(true);
    });

    it('returns true for header auth', () => {
        expect(shouldPrintWebhookSecretNotice([
            { name: 'hello', trigger: 'webhook', webhook: { auth: 'header' } },
        ])).toBe(true);
    });

    it('returns false for auth: none', () => {
        expect(shouldPrintWebhookSecretNotice([
            { name: 'hello', trigger: 'webhook', webhook: { auth: 'none' } },
        ])).toBe(false);
    });

    it('returns false when there are no webhook workflows', () => {
        expect(shouldPrintWebhookSecretNotice([{ name: 'scheduled' }])).toBe(false);
    });

    it('returns true when any workflow in a multi-workflow project uses a secret', () => {
        expect(shouldPrintWebhookSecretNotice([
            { name: 'public', trigger: 'webhook', webhook: { auth: 'none' } },
            { name: 'private', trigger: 'webhook', webhook: { auth: 'hmac' } },
        ])).toBe(true);
    });
});

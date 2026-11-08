import { describe, expect, it } from 'vitest';
import { formatJson, formatTable, webhookState } from '../src/utils/webhook-formatters';
import { webhookListParams } from '../src/commands/webhook-list';

const workflowRow = {
    kind: 'workflow',
    name: 'my-flow',
    slug: 'my-flow',
    workflow_name: 'my-flow',
    workflow_slug: 'my-flow',
    webhook_url: 'https://example.test/hooks/my-flow',
    webhook_secret: 'wf-secret',
    enabled: true,
    project_enabled: true,
    retired: false,
    effective_enabled: true,
} as any;

const functionRow = {
    kind: 'function',
    name: 'my-fn',
    slug: 'my-fn',
    status: 'live',
    enabled: true,
    project_enabled: true,
    retired: false,
    effective_enabled: true,
    webhook_token: '0123456789abcdef0123456789abcdef',
    webhook_url: 'https://example.test/api/webhook/0123456789abcdef0123456789abcdef',
    webhook_auth_type: 'hmac',
    webhook_secret: 'fn-secret',
} as any;

function plain(value: string): string {
    return value.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('webhook KIND column', () => {
    it('K1: renders the NAME KIND STATE URL header with workflow and function rows', () => {
        const lines = formatTable([workflowRow, functionRow], { showSecrets: false }).map(plain);

        expect(lines[0]).toMatch(/^NAME\s+KIND\s+STATE\s+URL$/);
        expect(lines.find((line) => line.includes('my-flow'))).toContain('workflow');
        const fnLine = lines.find((line) => line.includes('my-fn'));
        expect(fnLine).toContain('function');
        expect(fnLine).toContain('https://example.test/api/webhook/0123456789abcdef0123456789abcdef');
    });

    it('K2: renders a row without kind as a workflow (legacy server)', () => {
        const legacy = {
            workflow_name: 'legacy-flow',
            webhook_url: 'https://example.test/hooks/legacy-flow',
            enabled: true,
            project_enabled: true,
            retired: false,
            effective_enabled: true,
        } as any;
        const lines = formatTable([legacy], { showSecrets: false }).map(plain);

        expect(lines.find((line) => line.includes('legacy-flow'))).toContain('workflow');
        expect(JSON.parse(formatJson([legacy], { showSecrets: false }))[0]).toMatchObject({ kind: 'workflow' });
    });

    it('K3: derives the function state matrix on, off, blocked (project off), not live, retired', () => {
        const base = { ...functionRow };
        expect(webhookState({ ...base, status: 'live', enabled: true, project_enabled: true, retired: false, effective_enabled: true })).toBe('on');
        expect(webhookState({ ...base, status: 'live', enabled: false, effective_enabled: false })).toBe('off');
        expect(webhookState({ ...base, status: 'live', enabled: true, project_enabled: false, effective_enabled: false })).toBe('blocked (project off)');
        expect(webhookState({ ...base, status: 'live', enabled: true, project_enabled: true, retired: false, effective_enabled: false })).toBe('not live');
        expect(webhookState({ ...base, status: 'retired', retired: true, effective_enabled: false })).toBe('retired');

        const lines = formatTable(
            [{ ...base, name: 'fn-not-live', slug: 'fn-not-live', effective_enabled: false }],
            { showSecrets: false }
        ).map(plain);
        expect(lines.find((line) => line.includes('fn-not-live'))).toContain('not live');
    });

    it('K4: shows the function secret under SECRET with --show-secrets', () => {
        const lines = formatTable([workflowRow, functionRow], { showSecrets: true }).map(plain);

        expect(lines[0]).toContain('SECRET');
        expect(lines.find((line) => line.includes('my-fn'))).toContain('fn-secret');
        expect(lines.find((line) => line.includes('my-flow'))).toContain('wf-secret');
    });

    it('K5: formats JSON with kind, name, slug and function status', () => {
        const output = JSON.parse(formatJson([workflowRow, functionRow], { showSecrets: false }));

        expect(output[0]).toMatchObject({ kind: 'workflow', name: 'my-flow', slug: 'my-flow', workflow: 'my-flow' });
        expect(output[0]).not.toHaveProperty('status');
        expect(output[1]).toMatchObject({
            kind: 'function',
            name: 'my-fn',
            slug: 'my-fn',
            workflow: null,
            url: 'https://example.test/api/webhook/0123456789abcdef0123456789abcdef',
            state: 'on',
            status: 'live',
        });
    });

    it('K6: builds list params with include=functions', () => {
        expect(webhookListParams({ showSecrets: true })).toEqual({ include: 'functions', show_secrets: 'true' });
        expect(webhookListParams({})).toEqual({ include: 'functions' });
    });
});

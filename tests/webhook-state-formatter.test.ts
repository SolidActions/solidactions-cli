import { describe, expect, it } from 'vitest';
import { formatJson, formatTable } from '../src/utils/webhook-formatters';
import { workflowEffectiveState } from '../src/utils/workflow-state';

const rows = [
    {
        workflow_name: 'retired-flow',
        webhook_url: 'https://example.test/retired',
        webhook_secret: 'retired-secret',
        enabled: false,
        project_enabled: false,
        retired: true,
        effective_enabled: false,
    },
    {
        workflow_name: 'off-flow',
        webhook_url: 'https://example.test/off',
        webhook_secret: 'off-secret',
        enabled: false,
        project_enabled: false,
        retired: false,
        effective_enabled: false,
    },
    {
        workflow_name: 'blocked-flow',
        webhook_url: 'https://example.test/blocked',
        webhook_secret: 'blocked-secret',
        enabled: true,
        project_enabled: false,
        retired: false,
        effective_enabled: false,
    },
    {
        workflow_name: 'on-flow',
        webhook_url: 'https://example.test/on',
        webhook_secret: 'on-secret',
        enabled: true,
        project_enabled: true,
        retired: false,
        effective_enabled: true,
    },
] as any[];

function plain(value: string): string {
    return value.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('webhook enabled-state formatting', () => {
    it('adds a STATE table column with retired > off > blocked > on precedence', () => {
        const lines = formatTable(rows, { showSecrets: false }).map(plain);

        expect(lines[0]).toMatch(/^WORKFLOW\s+STATE\s+URL$/);
        expect(lines.find((line) => line.includes('retired-flow'))).toContain('retired');
        expect(lines.find((line) => line.includes('off-flow'))).toMatch(/off-flow\s+off\s+/);
        expect(lines.find((line) => line.includes('blocked-flow'))).toContain('blocked (project off)');
        expect(lines.find((line) => line.includes('on-flow'))).toMatch(/on-flow\s+on\s+/);
    });

    it('uses the neutral shared workflow-state helper for the same dataset', () => {
        expect(rows.map(workflowEffectiveState)).toEqual([
            'retired',
            'off',
            'blocked (project off)',
            'on',
        ]);
    });

    it('includes derived and raw state in JSON while redacting secrets by default', () => {
        const output = JSON.parse(formatJson(rows, { showSecrets: false }));

        expect(output.map((row: any) => row.state)).toEqual([
            'retired',
            'off',
            'blocked (project off)',
            'on',
        ]);
        expect(output[2]).toMatchObject({
            enabled: true,
            project_enabled: false,
            retired: false,
            effective_enabled: false,
        });
        expect(output[0]).not.toHaveProperty('secret');
        expect(JSON.stringify(output)).not.toContain('retired-secret');
    });

    it('preserves opt-in secret output alongside state', () => {
        const output = JSON.parse(formatJson([rows[3]], { showSecrets: true }));

        expect(output[0]).toMatchObject({ state: 'on', secret: 'on-secret' });
    });
});

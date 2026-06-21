import { describe, it, expect } from 'vitest';
import { buildRunListParams } from '../src/commands/run-list';

describe('buildRunListParams', () => {
    it('includes environment when -e is passed', () => {
        const params = buildRunListParams('my-flow', { environment: 'dev', limit: 20 });
        expect(params.project).toBe('my-flow');
        expect(params.environment).toBe('dev');
    });

    it('omits environment when not passed', () => {
        const params = buildRunListParams('my-flow', { limit: 20 });
        expect(params).not.toHaveProperty('environment');
    });

    it('omits project when projectName is undefined', () => {
        const params = buildRunListParams(undefined, { limit: 20 });
        expect(params).not.toHaveProperty('project');
    });

    it('uses provided limit', () => {
        const params = buildRunListParams('my-flow', { limit: 50 });
        expect(params.limit).toBe(50);
    });

    it('defaults limit to 20 when not detailed', () => {
        const params = buildRunListParams('my-flow', {});
        expect(params.limit).toBe(20);
    });

    it('defaults limit to 5 when detailed is set', () => {
        const params = buildRunListParams('my-flow', { detailed: true });
        expect(params.limit).toBe(5);
    });

    it('includes status when set', () => {
        const params = buildRunListParams('my-flow', { status: 'failed' });
        expect(params.status).toBe('failed');
    });

    it('includes has_errors when hasErrors is set', () => {
        const params = buildRunListParams('my-flow', { hasErrors: true });
        expect(params.has_errors).toBe('1');
    });

    it('includes workflow when set', () => {
        const params = buildRunListParams('my-flow', { workflow: 'my-workflow' });
        expect(params.workflow).toBe('my-workflow');
    });
});

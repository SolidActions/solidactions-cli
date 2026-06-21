import { describe, it, expect } from 'vitest';
import { buildBuildLogUrl, buildBuildLogRequest } from '../src/commands/project-logs';

describe('buildBuildLogUrl', () => {
    it('uses resolve route when environment is provided', () => {
        const url = buildBuildLogUrl('http://localhost:8001', 'my-flow', 'dev');
        expect(url).toBe('http://localhost:8001/api/v1/projects/resolve/build-log');
    });
    it('uses slug route when environment is omitted', () => {
        const url = buildBuildLogUrl('http://localhost:8001', 'my-flow-dev', undefined);
        expect(url).toBe('http://localhost:8001/api/v1/projects/my-flow-dev/build-log');
    });
});

describe('buildBuildLogParams', () => {
    it('returns name+environment params when environment provided', () => {
        const { url, params } = buildBuildLogRequest('http://localhost:8001', 'my-flow', 'dev');
        expect(params).toEqual({ name: 'my-flow', environment: 'dev' });
    });
    it('returns no params when slug route is used', () => {
        const { url, params } = buildBuildLogRequest('http://localhost:8001', 'my-flow-dev', undefined);
        expect(params).toBeUndefined();
    });
});

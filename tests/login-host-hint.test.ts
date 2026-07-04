import { describe, expect, it } from 'vitest';
import { loginHostLines, resolveLoginHost } from '../src/commands/login';

describe('resolveLoginHost', () => {
    it('defaults to SolidActions Cloud and marks it as a default', () => {
        expect(resolveLoginHost({})).toEqual({ host: 'https://app.solidactions.com', isDefault: true });
    });

    it('--host wins and is not a default', () => {
        expect(resolveLoginHost({ host: 'http://localhost:8002' }))
            .toEqual({ host: 'http://localhost:8002', isDefault: false });
    });

    it('--dev resolves localhost:8000 and is not a default', () => {
        expect(resolveLoginHost({ dev: true })).toEqual({ host: 'http://localhost:8000', isDefault: false });
    });

    it('--host beats --dev', () => {
        expect(resolveLoginHost({ dev: true, host: 'https://self.hosted' }).host).toBe('https://self.hosted');
    });
});

describe('loginHostLines', () => {
    it('default host prints the cloud callout and the --host/--dev hint', () => {
        const lines = loginHostLines(resolveLoginHost({}));
        expect(lines[0]).toBe('Logging into https://app.solidactions.com (SolidActions Cloud)');
        expect(lines[1]).toContain('--host <url>');
        expect(lines[1]).toContain('--dev');
    });

    it('explicit host prints the plain Host line with no hint', () => {
        const lines = loginHostLines(resolveLoginHost({ host: 'http://localhost:8002' }));
        expect(lines).toEqual(['Host: http://localhost:8002']);
    });
});

import { describe, expect, it } from 'vitest';
import {
    LoginHostConflictError,
    LoginHostInvalidError,
    loginHostLines,
    resolveLoginHost,
} from '../src/commands/login';

describe('resolveLoginHost', () => {
    it('defaults to SolidActions Cloud and marks it as a default', () => {
        expect(resolveLoginHost({}, {})).toEqual({ host: 'https://app.solidactions.com', isDefault: true });
    });

    it('--host wins and is not a default', () => {
        expect(resolveLoginHost({ host: 'http://localhost:8002' }, {}))
            .toEqual({ host: 'http://localhost:8002', isDefault: false });
    });

    it('--dev resolves localhost:8000 and is not a default', () => {
        expect(resolveLoginHost({ dev: true }, {})).toEqual({ host: 'http://localhost:8000', isDefault: false });
    });

    it('--host beats --dev', () => {
        expect(resolveLoginHost({ dev: true, host: 'https://self.hosted' }, {}).host).toBe('https://self.hosted');
    });

    it('uses SOLIDACTIONS_HOST with the trailing slash stripped', () => {
        expect(resolveLoginHost({}, { SOLIDACTIONS_HOST: 'http://h:1/' }))
            .toEqual({ host: 'http://h:1', isDefault: false });
    });

    it('treats a trailing-slash difference between --host and env as the same host', () => {
        expect(resolveLoginHost({ host: 'http://H:1/' }, { SOLIDACTIONS_HOST: 'http://h:1' }))
            .toEqual({ host: 'http://H:1', isDefault: false });
    });

    it('throws LoginHostConflictError when --host disagrees with the env', () => {
        expect(() => resolveLoginHost({ host: 'https://x' }, { SOLIDACTIONS_HOST: 'http://h:1' }))
            .toThrow(LoginHostConflictError);
    });

    it('compares ports literally (cli#124)', () => {
        expect(() => resolveLoginHost(
            { host: 'https://example.com:443' },
            { SOLIDACTIONS_HOST: 'https://example.com' },
        )).toThrow(LoginHostConflictError);
    });

    it('treats a SOLIDACTIONS_HOST of "/" or "///" as invalid, never absent (ruling 9)', () => {
        expect(() => resolveLoginHost({}, { SOLIDACTIONS_HOST: '/' })).toThrow(LoginHostInvalidError);
        expect(() => resolveLoginHost({}, { SOLIDACTIONS_HOST: '///' })).toThrow(LoginHostInvalidError);
    });

    it('treats --host / as invalid (ruling 9)', () => {
        expect(() => resolveLoginHost({ host: '/' }, {})).toThrow(LoginHostInvalidError);
    });

    it('treats a whitespace-only --host as invalid, unlike a whitespace-only SOLIDACTIONS_HOST (refusing is the safe direction)', () => {
        expect(() => resolveLoginHost({ host: '  ' }, {})).toThrow(LoginHostInvalidError);
    });

    it('treats whitespace-only SOLIDACTIONS_HOST as absent (cloud default)', () => {
        expect(resolveLoginHost({}, { SOLIDACTIONS_HOST: '  ' }))
            .toEqual({ host: 'https://app.solidactions.com', isDefault: true });
    });
});

describe('loginHostLines', () => {
    it('default host prints only the cloud callout, with no --host/--dev mention (they are internal-only, #994)', () => {
        const lines = loginHostLines(resolveLoginHost({}, {}));
        expect(lines).toEqual(['Logging into https://app.solidactions.com (SolidActions Cloud)']);
        expect(lines.join('\n')).not.toContain('--host');
        expect(lines.join('\n')).not.toContain('--dev');
    });

    it('explicit host prints the plain Host line with no hint', () => {
        const lines = loginHostLines(resolveLoginHost({ host: 'http://localhost:8002' }, {}));
        expect(lines).toEqual(['Host: http://localhost:8002']);
    });
});

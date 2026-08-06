/**
 * Issue #1127 — `parseYamlEnvVars` parses the `database:` YAML form the same
 * way it already parses `oauth:` (spec §4B item 2). Mirrors the SDK's
 * declarations.ts database-form tests (solidactions-ts-sdk
 * tests/invoke/database-declarations.test.ts) so both sides of the wire
 * agree on the YAML convention:
 *
 *   - VAR_NAME:
 *       database: "Name"
 */
import { describe, expect, it } from 'vitest';
import { parseYamlEnvVars, SolidActionsConfig } from '../src/utils/env';

function configWithEnv(env: SolidActionsConfig['env']): SolidActionsConfig {
    return { workflows: [], env };
}

describe('parseYamlEnvVars: database form', () => {
    it('parses `- VAR_NAME:\\n    database: "Name"` into a database declaration', () => {
        const config = configWithEnv([{ MYDB: { database: 'analytics' } }]);
        const parsed = parseYamlEnvVars(config);
        expect(parsed).toEqual([
            { key: 'MYDB', mappedTo: null, oauthName: null, databaseName: 'analytics' },
        ]);
    });

    it('mixed plain / mapped / oauth / database declarations classify independently', () => {
        const config = configWithEnv([
            'PLAIN_VAR',
            { MAPPED: 'GLOBAL_KEY' },
            { GCAL: { oauth: 'Google Calendar' } },
            { MYDB: { database: 'analytics' } },
        ]);
        const parsed = parseYamlEnvVars(config);
        expect(parsed).toEqual([
            { key: 'PLAIN_VAR', mappedTo: null, oauthName: null, databaseName: null },
            { key: 'MAPPED', mappedTo: 'GLOBAL_KEY', oauthName: null, databaseName: null },
            { key: 'GCAL', mappedTo: null, oauthName: 'Google Calendar', databaseName: null },
            { key: 'MYDB', mappedTo: null, oauthName: null, databaseName: 'analytics' },
        ]);
    });

    it('throws when `database` is not a non-empty string', () => {
        const config = configWithEnv([{ MYDB: { database: '' } }]);
        expect(() => parseYamlEnvVars(config)).toThrow(/database.*non-empty string/);
    });

    it('yaml with no database declarations returns none', () => {
        const config = configWithEnv(['PLAIN_VAR']);
        const parsed = parseYamlEnvVars(config);
        expect(parsed.every(v => v.databaseName === null)).toBe(true);
    });
});

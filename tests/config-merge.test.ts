import { describe, expect, it } from 'vitest';
import { mergeConfigs } from '../src/utils/config';

const LOCAL_PATH = '/tmp/local/.solidactions/config.json';
const GLOBAL_PATH = '/home/u/.solidactions/config.json';

describe('mergeConfigs', () => {
    it('returns null when no source contributes host or apiKey', () => {
        const result = mergeConfigs({}, null, null, null, GLOBAL_PATH);
        expect(result).toBeNull();
    });

    it('env wins per-key over local and global', () => {
        const env = { host: 'https://env-host', apiKey: 'env-key' };
        const local = { host: 'https://local-host', apiKey: 'local-key', workspace: 'local-ws', workspaceId: 'local-uuid' };
        const global = { host: 'https://global-host', apiKey: 'global-key', workspace: 'global-ws', workspaceId: 'global-uuid' };
        const result = mergeConfigs(env, local, LOCAL_PATH, global, GLOBAL_PATH);
        expect(result).not.toBeNull();
        expect(result!.config.host).toBe('https://env-host');
        expect(result!.config.apiKey).toBe('env-key');
        expect(result!.sources.host).toBe('env');
        expect(result!.sources.apiKey).toBe('env');
    });

    it('local wins over global per-key when env is silent', () => {
        const local = { workspace: 'mercer', workspaceId: 'local-uuid' };
        const global = { host: 'https://h', apiKey: 'k', workspace: 'global-ws', workspaceId: 'global-uuid' };
        const result = mergeConfigs({}, local, LOCAL_PATH, global, GLOBAL_PATH);
        expect(result).not.toBeNull();
        expect(result!.config.workspace).toBe('mercer');
        expect(result!.config.workspaceId).toBe('local-uuid');
        expect(result!.sources.workspace).toBe(LOCAL_PATH);
        expect(result!.sources.workspaceId).toBe(LOCAL_PATH);
        expect(result!.config.host).toBe('https://h');
        expect(result!.sources.host).toBe(GLOBAL_PATH);
    });

    it('falls through missing keys to the next layer', () => {
        const local = { workspace: 'mercer' };
        const global = { host: 'https://h', apiKey: 'k', workspaceId: 'global-uuid' };
        const result = mergeConfigs({}, local, LOCAL_PATH, global, GLOBAL_PATH);
        expect(result).not.toBeNull();
        expect(result!.config.workspace).toBe('mercer');
        expect(result!.sources.workspace).toBe(LOCAL_PATH);
        expect(result!.config.workspaceId).toBe('global-uuid');
        expect(result!.sources.workspaceId).toBe(GLOBAL_PATH);
    });

    it('reports null source for keys absent from every layer', () => {
        const result = mergeConfigs({}, null, null, { host: 'https://h', apiKey: 'k' }, GLOBAL_PATH);
        expect(result).not.toBeNull();
        expect(result!.config.workspace).toBeUndefined();
        expect(result!.sources.workspace).toBeNull();
        expect(result!.config.workspaceId).toBeUndefined();
        expect(result!.sources.workspaceId).toBeNull();
    });

    it('local config with its own apiKey does NOT inherit workspace from global (F-C3)', () => {
        const local = { host: 'https://other.example', apiKey: 'local-key' };
        const global = { host: 'https://h', apiKey: 'k', workspace: 'global-ws', workspaceId: 'global-uuid' };
        const result = mergeConfigs({}, local, LOCAL_PATH, global, GLOBAL_PATH);
        expect(result).not.toBeNull();
        expect(result!.config.workspaceId).toBeUndefined();
        expect(result!.sources.workspaceId).toBeNull();
        expect(result!.config.workspace).toBeUndefined();
        expect(result!.sources.workspace).toBeNull();
    });

    it('pure workspace-pin local (no host/apiKey) still inherits global creds (existing behavior)', () => {
        const local = { workspace: 'mercer', workspaceId: 'local-uuid' };
        const global = { host: 'https://h', apiKey: 'k' };
        const result = mergeConfigs({}, local, LOCAL_PATH, global, GLOBAL_PATH);
        expect(result).not.toBeNull();
        expect(result!.config.host).toBe('https://h');
        expect(result!.config.workspaceId).toBe('local-uuid');
    });
});

import { describe, expect, it } from 'vitest';
import { credentialConflictMessage, DEFAULT_HOST, mergeConfigs } from '../src/utils/config';

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

    // #1194 / #1437: workspaceOrg is cosmetic-only, but it must travel with the SAME
    // layer that supplied workspaceId, never be picked independently — otherwise a
    // local file pinning workspace A (with no org recorded) could silently inherit the
    // global file's org name for a totally different workspace B, and the CLI would
    // confidently print the wrong organization.
    describe('workspaceOrg travels with the layer that supplied workspaceId', () => {
        it('local pin WITH its own org uses the local org, not the global one', () => {
            const local = { workspace: 'mercer', workspaceId: 'local-uuid', workspaceOrg: 'Local Org' };
            const global = { host: 'https://h', apiKey: 'k', workspace: 'global-ws', workspaceId: 'global-uuid', workspaceOrg: 'Global Org' };
            const result = mergeConfigs({}, local, LOCAL_PATH, global, GLOBAL_PATH);
            expect(result).not.toBeNull();
            expect(result!.config.workspaceId).toBe('local-uuid');
            expect(result!.config.workspaceOrg).toBe('Local Org');
        });

        it('local pin WITHOUT a recorded org does NOT inherit the global file\'s org for a different workspace', () => {
            const local = { workspace: 'mercer', workspaceId: 'local-uuid' }; // no workspaceOrg
            const global = { host: 'https://h', apiKey: 'k', workspace: 'global-ws', workspaceId: 'global-uuid', workspaceOrg: 'Global Org' };
            const result = mergeConfigs({}, local, LOCAL_PATH, global, GLOBAL_PATH);
            expect(result).not.toBeNull();
            expect(result!.config.workspaceId).toBe('local-uuid');
            expect(result!.config.workspaceOrg).toBeUndefined();
        });

        it('falls through to the global org only when workspaceId itself also falls through to global', () => {
            const local = { workspace: 'mercer' }; // no workspaceId at all -> workspaceId falls through to global
            const global = { host: 'https://h', apiKey: 'k', workspaceId: 'global-uuid', workspaceOrg: 'Global Org' };
            const result = mergeConfigs({}, local, LOCAL_PATH, global, GLOBAL_PATH);
            expect(result).not.toBeNull();
            expect(result!.config.workspaceId).toBe('global-uuid');
            expect(result!.config.workspaceOrg).toBe('Global Org');
        });

        it('env-sourced workspaceId (SOLIDACTIONS_WORKSPACE_ID) never carries an org from any file layer', () => {
            const env = { workspaceId: 'env-uuid' };
            const local = { workspace: 'mercer', workspaceId: 'local-uuid', workspaceOrg: 'Local Org' };
            const global = { host: 'https://h', apiKey: 'k', workspaceOrg: 'Global Org' };
            const result = mergeConfigs(env, local, LOCAL_PATH, global, GLOBAL_PATH);
            expect(result).not.toBeNull();
            expect(result!.config.workspaceId).toBe('env-uuid');
            expect(result!.config.workspaceOrg).toBeUndefined();
        });
    });
});

describe('credential pair: a key is only sent to its own host (cli#124)', () => {
    const G = { host: 'https://app.solidactions.com', apiKey: 'global-key' };

    it('local host-only with a DIFFERENT host than global refuses and withholds the key', () => {
        const r = mergeConfigs({}, { host: 'https://dev.example' }, LOCAL_PATH, G, GLOBAL_PATH)!;
        expect(r.config.apiKey).toBe('');
        expect(r.credentialConflict).toEqual({
            host: 'https://dev.example', hostSource: LOCAL_PATH,
            keyHost: 'https://app.solidactions.com', keySource: GLOBAL_PATH,
        });
    });

    it('env SOLIDACTIONS_HOST alone with a different host than the file refuses', () => {
        const r = mergeConfigs({ host: 'https://dev.example' }, null, null, G, GLOBAL_PATH)!;
        expect(r.config.apiKey).toBe('');
        expect(r.credentialConflict?.hostSource).toBe('env');
        expect(r.credentialConflict?.keySource).toBe(GLOBAL_PATH);
    });

    it('a host above a key layer that has no host of its own refuses (keyHost undefined)', () => {
        const r = mergeConfigs({ host: 'https://dev.example' }, null, null, { apiKey: 'k' }, GLOBAL_PATH)!;
        expect(r.config.apiKey).toBe('');
        expect(r.credentialConflict?.keyHost).toBeUndefined();
    });

    it('local host-only EQUAL to the global host (case and trailing slash ignored) keeps working', () => {
        const r = mergeConfigs({}, { host: 'HTTPS://app.solidactions.com/' }, LOCAL_PATH, G, GLOBAL_PATH)!;
        expect(r.credentialConflict).toBeUndefined();
        expect(r.config.apiKey).toBe('global-key');
    });

    it('a workspace-pin-only local file keeps the global credentials', () => {
        const r = mergeConfigs({}, { workspace: 'w', workspaceId: 'w-id' }, LOCAL_PATH, G, GLOBAL_PATH)!;
        expect(r.credentialConflict).toBeUndefined();
        expect(r.config.host).toBe(G.host);
        expect(r.config.apiKey).toBe('global-key');
    });

    it('env SOLIDACTIONS_API_KEY alone uses the host configured below it', () => {
        const r = mergeConfigs({ apiKey: 'env-key' }, null, null, G, GLOBAL_PATH)!;
        expect(r.credentialConflict).toBeUndefined();
        expect(r.config.apiKey).toBe('env-key');
        expect(r.config.host).toBe(G.host);
    });

    it('env host + env key is one layer', () => {
        const r = mergeConfigs({ host: 'https://dev.example', apiKey: 'env-key' }, null, null, G, GLOBAL_PATH)!;
        expect(r.credentialConflict).toBeUndefined();
        expect(r.config.apiKey).toBe('env-key');
    });

    it('a local file with its own host and key is one layer', () => {
        const r = mergeConfigs({}, { host: 'https://dev.example', apiKey: 'local-key' }, LOCAL_PATH, G, GLOBAL_PATH)!;
        expect(r.credentialConflict).toBeUndefined();
        expect(r.config.apiKey).toBe('local-key');
    });

    it('env host over a local file with its own different host+key refuses', () => {
        const r = mergeConfigs({ host: 'https://other.example' }, { host: 'https://dev.example', apiKey: 'local-key' }, LOCAL_PATH, G, GLOBAL_PATH)!;
        expect(r.config.apiKey).toBe('');
        expect(r.credentialConflict?.keySource).toBe(LOCAL_PATH);
        expect(r.credentialConflict?.keyHost).toBe('https://dev.example');
    });

    it('env key alone + a local host that DIFFERS from the global host refuses (PM ruling 1)', () => {
        const r = mergeConfigs({ apiKey: 'env-key' }, { host: 'https://dev.example' }, LOCAL_PATH, G, GLOBAL_PATH)!;
        expect(r.config.apiKey).toBe('');
        expect(r.credentialConflict).toEqual({
            host: 'https://dev.example', hostSource: LOCAL_PATH,
            keyHost: undefined, keySource: 'env',
            otherHost: 'https://app.solidactions.com', otherHostSource: GLOBAL_PATH,
        });
    });

    it('env key alone + a local host+key that differs from the global host refuses (PM ruling 1)', () => {
        const r = mergeConfigs({ apiKey: 'env-key' }, { host: 'https://dev.example', apiKey: 'local-key' }, LOCAL_PATH, G, GLOBAL_PATH)!;
        expect(r.config.apiKey).toBe('');
        expect(r.credentialConflict?.keySource).toBe('env');
    });

    it('env key alone + a local host EQUAL to the global host keeps working', () => {
        const same = mergeConfigs({ apiKey: 'env-key' }, { host: 'https://app.solidactions.com/' }, LOCAL_PATH, G, GLOBAL_PATH)!;
        expect(same.credentialConflict).toBeUndefined();
        expect(same.config.apiKey).toBe('env-key');
    });

    it('env key alone + a LOCAL-ONLY host (no global host) refuses (PM ruling 10)', () => {
        const r = mergeConfigs({ apiKey: 'env-key' }, { host: 'https://dev.example' }, LOCAL_PATH, null, GLOBAL_PATH)!;
        expect(r.config.apiKey).toBe('');
        expect(r.credentialConflict).toEqual({
            host: 'https://dev.example', hostSource: LOCAL_PATH,
            keyHost: undefined, keySource: 'env',
        });
        const noGlobalHost = mergeConfigs({ apiKey: 'env-key' }, { host: 'https://dev.example' }, LOCAL_PATH, { workspaceId: 'w' }, GLOBAL_PATH)!;
        expect(noGlobalHost.config.apiKey).toBe('');
    });

    it('env key alone + only a global host keeps working (PM ruling 10)', () => {
        const r = mergeConfigs({ apiKey: 'env-key' }, { workspaceId: 'w' }, LOCAL_PATH, G, GLOBAL_PATH)!;
        expect(r.credentialConflict).toBeUndefined();
        expect(r.config.host).toBe('https://app.solidactions.com');
        expect(r.config.apiKey).toBe('env-key');
    });

    it('env key alone with no host anywhere goes to the default host (PM ruling 10)', () => {
        const r = mergeConfigs({ apiKey: 'env-key' }, null, null, null, GLOBAL_PATH)!;
        expect(r.credentialConflict).toBeUndefined();
        expect(r.config.host).toBe(DEFAULT_HOST);
        expect(r.sources.host).toBe('default');
        expect(r.config.apiKey).toBe('env-key');
    });

    it('the env-key refusal tells the user to set SOLIDACTIONS_HOST and names both file hosts', () => {
        const r = mergeConfigs({ apiKey: 'env-key' }, { host: 'https://dev.example' }, LOCAL_PATH, G, GLOBAL_PATH)!;
        const msg = credentialConflictMessage(r.credentialConflict!);
        expect(msg).toContain('$SOLIDACTIONS_API_KEY');
        expect(msg).toContain('SOLIDACTIONS_HOST');
        expect(msg).toContain('https://dev.example');
        expect(msg).toContain('https://app.solidactions.com');
        expect(msg).not.toContain('env-key');
    });

    it('credentialConflictMessage names both sides and a fix, and never the key', () => {
        const r = mergeConfigs({}, { host: 'https://dev.example' }, LOCAL_PATH, G, GLOBAL_PATH)!;
        const msg = credentialConflictMessage(r.credentialConflict!);
        expect(msg).toContain('https://dev.example');
        expect(msg).toContain(LOCAL_PATH);
        expect(msg).toContain('https://app.solidactions.com');
        expect(msg).toContain(GLOBAL_PATH);
        expect(msg).toContain('solidactions login --local --host https://dev.example');
        expect(msg).not.toContain('global-key');
    });
});

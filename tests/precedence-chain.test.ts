import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    resolveConfig,
    setCliWorkspaceOverride,
} from '../src/utils/config';
import { makeTmpEnv, writeGlobal, writeLocal } from './helpers';

describe('resolveConfig precedence chain', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();
    });
    afterEach(() => {
        setCliWorkspaceOverride(undefined);
        env?.cleanup();
    });

    it('returns null when no layer is set', () => {
        const result = resolveConfig(env.cwd);
        expect(result).toBeNull();
    });

    it('global only — global workspace wins', () => {
        writeGlobal(env.home, {
            host: 'https://app.solidactions.com',
            apiKey: 'sk_g',
            workspace: 'global-ws',
            workspaceId: 'global-uuid',
        });
        const result = resolveConfig(env.cwd);
        expect(result?.config.workspaceId).toBe('global-uuid');
        expect(result?.config.workspace).toBe('global-ws');
        expect(result?.sources.workspaceId).toMatch(/\.solidactions\/config\.json$/);
    });

    it('local overrides global per key', () => {
        writeGlobal(env.home, { host: 'https://h', apiKey: 'k', workspace: 'g', workspaceId: 'g-uuid' });
        writeLocal(env.cwd, { workspace: 'mercer', workspaceId: 'local-uuid' });
        const result = resolveConfig(env.cwd);
        expect(result?.config.workspaceId).toBe('local-uuid');
        expect(result?.config.workspace).toBe('mercer');
        expect(result?.config.host).toBe('https://h');
        expect(result?.config.apiKey).toBe('k');
    });

    it('SOLIDACTIONS_WORKSPACE_ID env var beats local + global', () => {
        writeGlobal(env.home, { host: 'https://h', apiKey: 'k', workspaceId: 'g-uuid' });
        writeLocal(env.cwd, { workspaceId: 'local-uuid' });
        process.env.SOLIDACTIONS_WORKSPACE_ID = 'env-uuid';
        const result = resolveConfig(env.cwd);
        expect(result?.config.workspaceId).toBe('env-uuid');
        expect(result?.sources.workspaceId).toBe('env');
    });

    it('-w (CLI override) beats env, local, and global', () => {
        writeGlobal(env.home, { host: 'https://h', apiKey: 'k', workspaceId: 'g-uuid' });
        writeLocal(env.cwd, { workspaceId: 'local-uuid' });
        process.env.SOLIDACTIONS_WORKSPACE_ID = 'env-uuid';
        setCliWorkspaceOverride('cli-input');
        const result = resolveConfig(env.cwd);
        expect(result?.config.workspace).toBe('cli-input');
        expect(result?.config.workspaceId).toBeUndefined();
        expect(result?.sources.workspace).toBe('cli');
        expect(result?.sources.workspaceId).toBe('cli');
    });

    it('clearing the override returns to the underlying chain', () => {
        writeGlobal(env.home, { host: 'https://h', apiKey: 'k', workspaceId: 'g-uuid' });
        setCliWorkspaceOverride('cli-input');
        setCliWorkspaceOverride(undefined);
        const result = resolveConfig(env.cwd);
        expect(result?.config.workspaceId).toBe('g-uuid');
        expect(result?.config.workspace).toBeUndefined();
    });
});

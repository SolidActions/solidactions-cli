import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeWorkspaceToFile, getGlobalConfigPath, getLocalConfigPath, readConfigFile } from '../src/utils/config';
import { makeTmpEnv, writeGlobal } from './helpers';

describe('writeWorkspaceToFile', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => { env = makeTmpEnv(); });
    afterEach(() => env?.cleanup());

    it('local: creates .solidactions/config.json with only workspace + workspaceId', () => {
        writeGlobal(env.home, { host: 'https://h', apiKey: 'sk_g', workspaceId: 'old' });

        const localPath = getLocalConfigPath(env.cwd);
        writeWorkspaceToFile(localPath, 'mercer', 'new-uuid');

        expect(fs.existsSync(localPath)).toBe(true);
        const local = readConfigFile(localPath);
        expect(local).toEqual({ workspace: 'mercer', workspaceId: 'new-uuid' });
        expect(local).not.toHaveProperty('host');
        expect(local).not.toHaveProperty('apiKey');

        // Global is untouched.
        const globalPath = getGlobalConfigPath();
        const global = readConfigFile(globalPath);
        expect(global).toEqual({ host: 'https://h', apiKey: 'sk_g', workspaceId: 'old' });
    });

    it('local: shallow-merges over an existing local file (preserves prior keys)', () => {
        const localPath = getLocalConfigPath(env.cwd);
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        fs.writeFileSync(localPath, JSON.stringify({ host: 'https://manual', apiKey: 'sk_l', workspace: 'old', workspaceId: 'old-uuid' }));

        writeWorkspaceToFile(localPath, 'mercer', 'new-uuid');

        const local = readConfigFile(localPath);
        expect(local).toEqual({ host: 'https://manual', apiKey: 'sk_l', workspace: 'mercer', workspaceId: 'new-uuid' });
    });

    it('global: shallow-merges into an existing global file (preserves host/apiKey)', () => {
        writeGlobal(env.home, { host: 'https://h', apiKey: 'sk_g', workspaceId: 'old' });
        const globalPath = getGlobalConfigPath();

        writeWorkspaceToFile(globalPath, 'mercer', 'new-uuid');

        const global = readConfigFile(globalPath);
        expect(global).toEqual({ host: 'https://h', apiKey: 'sk_g', workspace: 'mercer', workspaceId: 'new-uuid' });
    });

    it('writes the file with mode 0o600', () => {
        const localPath = getLocalConfigPath(env.cwd);
        writeWorkspaceToFile(localPath, 'mercer', 'uuid');
        const stat = fs.statSync(localPath);
        // file mode is the last 9 bits
        expect(stat.mode & 0o777).toBe(0o600);
    });
});

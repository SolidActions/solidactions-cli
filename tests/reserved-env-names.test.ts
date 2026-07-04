import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import {
    RESERVED_ENV_PREFIX,
    isReservedEnvName,
    reservedEnvNameError,
} from '../src/utils/env';
import { envSet } from '../src/commands/env-set';
import { envMap } from '../src/commands/env-map';
import { envPush } from '../src/commands/env-push';
import { makeTmpEnv, writeGlobal } from './helpers';

describe('reserved env-name guard (unit)', () => {
    it('accepts ordinary names', () => {
        expect(isReservedEnvName('MY_API_KEY')).toBe(false);
    });

    it('rejects SOLIDACTIONS_-prefixed names', () => {
        expect(isReservedEnvName('SOLIDACTIONS_API_KEY')).toBe(true);
        expect(isReservedEnvName('SOLIDACTIONS_ANYTHING')).toBe(true);
    });

    it('message names the key, explains the clobber, and suggests a rename', () => {
        const msg = reservedEnvNameError('SOLIDACTIONS_API_KEY');
        expect(msg).toContain('SOLIDACTIONS_API_KEY');
        expect(msg).toContain(`reserved ${RESERVED_ENV_PREFIX} prefix`);
        expect(msg).toContain('authentication failures');
        expect(msg).toContain('MY_API_KEY');
    });
});

describe('commands hard-reject reserved names before any HTTP request', () => {
    let exitCode: number | undefined;
    let originalExit: typeof process.exit;
    let originalGet: typeof axios.get;
    let originalPost: typeof axios.post;
    let httpCalls: string[];
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();
        writeGlobal(process.env.HOME!, { host: 'http://localhost', apiKey: 'k', workspaceId: 'ws-1' });

        exitCode = undefined;
        originalExit = process.exit;
        (process as any).exit = (code?: number) => {
            exitCode = code ?? 0;
            throw new Error(`process.exit(${code})`);
        };

        httpCalls = [];
        originalGet = axios.get;
        originalPost = axios.post;
        axios.get = (async (url: string) => { httpCalls.push(`GET ${url}`); throw new Error('unexpected HTTP'); }) as any;
        axios.post = (async (url: string) => { httpCalls.push(`POST ${url}`); throw new Error('unexpected HTTP'); }) as any;
    });

    afterEach(() => {
        (process as any).exit = originalExit;
        axios.get = originalGet;
        axios.post = originalPost;
        env.cleanup();
    });

    it('env set (global mode) exits 1 with no HTTP', async () => {
        try { await envSet('SOLIDACTIONS_API_KEY', 'foo', undefined, {}); } catch { /* exit throws */ }
        expect(exitCode).toBe(1);
        expect(httpCalls).toEqual([]);
    });

    it('env set (project mode) exits 1 with no HTTP', async () => {
        try { await envSet('my-project', 'SOLIDACTIONS_API_KEY', 'foo', { yes: true }); } catch { /* exit throws */ }
        expect(exitCode).toBe(1);
        expect(httpCalls).toEqual([]);
    });

    it('env map exits 1 with no HTTP when the project_key target is reserved', async () => {
        try { await envMap('my-project', 'SOLIDACTIONS_API_KEY', 'GLOBAL_KEY', { yes: true }); } catch { /* exit throws */ }
        expect(exitCode).toBe(1);
        expect(httpCalls).toEqual([]);
    });

    it('env push lists offending keys, pushes nothing, exits 1', async () => {
        const dir = path.join(env.cwd, 'proj');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'solidactions.yaml'), [
            'project: demo',
            'workflows: []',
            'env:',
            '  - SOLIDACTIONS_API_KEY',
            '  - MY_OK_VAR',
        ].join('\n'));
        fs.writeFileSync(path.join(dir, '.env.dev'), 'SOLIDACTIONS_API_KEY=evil\nMY_OK_VAR=fine\n');

        try { await envPush('demo', dir, { yes: true }); } catch { /* exit throws */ }
        expect(exitCode).toBe(1);
        expect(httpCalls).toEqual([]);
    });
});

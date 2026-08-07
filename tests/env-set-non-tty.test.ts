import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { envSet, isNonTty } from '../src/commands/env-set';
import { makeTmpEnv, writeGlobal } from './helpers';

describe('envSet non-TTY fast-fail', () => {
    let originalIsTTY: boolean | undefined;
    let exitCode: number | undefined;
    let originalExit: typeof process.exit;
    let originalAxiosGet: typeof axios.get;

    beforeEach(() => {
        originalIsTTY = process.stdin.isTTY;
        // Simulate non-TTY (CI / pipe) — isTTY is undefined in a pipe
        Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });

        exitCode = undefined;
        originalExit = process.exit;
        (process as any).exit = (code?: number) => {
            exitCode = code ?? 0;
            throw new Error(`process.exit(${code})`);
        };

        originalAxiosGet = axios.get;
    });

    afterEach(() => {
        Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
        (process as any).exit = originalExit;
        axios.get = originalAxiosGet;
    });

    it('isNonTty() returns true when stdin.isTTY is undefined', () => {
        // process.stdin.isTTY is set to undefined in beforeEach
        expect(isNonTty()).toBe(true);
    });

    it('isNonTty() returns false when stdin.isTTY is true', () => {
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        expect(isNonTty()).toBe(false);
    });

    it('project-mode: exits with code 1 (no hang) when non-TTY and variable already has a value', async () => {
        const { cleanup } = makeTmpEnv();
        try {
            // Write a real config file so requireConfigWithWorkspace resolves without a server call
            const tmpHome = process.env.HOME!;
            writeGlobal(tmpHome, {
                host: 'http://localhost',
                apiKey: 'test-key',
                workspaceId: 'ws-1',
            });

            // Stub axios.get to return an existing variable mapping
            axios.get = async (url: string) => {
                if (url.includes('variable-mappings')) {
                    return { data: [{ env_name: 'MY_KEY', has_value: true }] };
                }
                throw new Error('unexpected GET: ' + url);
            };

            try {
                await envSet('my-project', 'MY_KEY', 'new-value', { yes: false, env: 'dev' });
            } catch {
                // process.exit mock throws; any path that sets exitCode to 1 is correct.
            }

            expect(exitCode).toBe(1);
        } finally {
            cleanup();
        }
    });

    it('global-mode: exits with code 1 (no hang) when non-TTY and global variable already exists', async () => {
        const { cleanup } = makeTmpEnv();
        try {
            const tmpHome = process.env.HOME!;
            writeGlobal(tmpHome, {
                host: 'http://localhost',
                apiKey: 'test-key',
                workspaceId: 'ws-1',
            });

            // Stub axios.get to return an existing global variable
            axios.get = async (url: string) => {
                if (url.includes('/api/v1/variables')) {
                    return { data: { data: [{ id: 42, key: 'GLOBAL_KEY' }] } };
                }
                throw new Error('unexpected GET: ' + url);
            };

            try {
                // Global mode: only two positional args (key, value), no third arg
                await envSet('GLOBAL_KEY', 'new-value', undefined, { yes: false, global: true });
            } catch (err: any) {
                // Expected: process.exit mock throws, then caught by envSet's outer catch, may throw again
            }

            expect(exitCode).toBe(1);
        } finally {
            cleanup();
        }
    });
});

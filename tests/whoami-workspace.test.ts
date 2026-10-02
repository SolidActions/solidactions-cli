/**
 * `solidactions whoami` names the organization next to the workspace (cli#162)
 * and no longer flags a workspace as "inherited from a different config file"
 * (cli#113).
 *
 * `whoami` is offline: a real temp HOME, the real built CLI, no server. No
 * mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpEnv, writeGlobal, writeLocal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');
const API_KEY = 'sk_test_whoami_secret';

interface CliResult {
    stdout: string;
    stderr: string;
    status: number | null;
}

function runCli(args: string[], home: string, cwd: string): Promise<CliResult> {
    return new Promise((resolve, reject) => {
        const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home };
        delete childEnv.SOLIDACTIONS_HOST;
        delete childEnv.SOLIDACTIONS_API_KEY;
        delete childEnv.SOLIDACTIONS_WORKSPACE_ID;

        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], { cwd, env: childEnv });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });

        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`CLI timed out. stdout: ${stdout} stderr: ${stderr}`));
        }, 15_000);

        child.on('close', (status) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, status });
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

function workspaceLine(stdout: string): string {
    const line = stdout.split('\n').find((l) => l.includes('Workspace:'));
    if (!line) throw new Error(`no Workspace line in: ${stdout}`);
    return line;
}

describe('solidactions whoami workspace line', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();
    });
    afterEach(() => env.cleanup());

    const globalConfig = {
        host: 'http://127.0.0.1:9',
        apiKey: API_KEY,
        workspace: 'acme-south-ws',
        workspaceId: 'ws-2',
        workspaceOrg: 'Acme',
    };

    it('shows the organization next to the workspace slug and id', async () => {
        writeGlobal(env.home, globalConfig);

        const result = await runCli(['whoami'], env.home, env.cwd);

        expect(result.status).toBe(0);
        expect(workspaceLine(result.stdout)).toContain('acme-south-ws — organization Acme (ws-2)');
    });

    it('shows the local pin organization and does not call it inherited when a local config overrides the workspace', async () => {
        writeGlobal(env.home, globalConfig);
        const localPath = writeLocal(env.cwd, { workspace: 'acme-north-ws', workspaceId: 'ws-1', workspaceOrg: 'Acme North' });

        const result = await runCli(['whoami'], env.home, env.cwd);

        expect(result.status).toBe(0);
        const line = workspaceLine(result.stdout);
        expect(line).toContain('acme-north-ws — organization Acme North (ws-1)');
        expect(line).toContain(localPath);
        expect(result.stdout).not.toContain('inherited from a different config file');
    });

    it('keeps the plain slug and id line when no organization is stored', async () => {
        const { workspaceOrg: _omitted, ...withoutOrg } = globalConfig;
        writeGlobal(env.home, withoutOrg);

        const result = await runCli(['whoami'], env.home, env.cwd);

        expect(result.status).toBe(0);
        const line = workspaceLine(result.stdout);
        expect(line).toContain('acme-south-ws (ws-2)');
        expect(line).not.toContain('organization');
    });

    it('never prints the full API key on either stream', async () => {
        writeGlobal(env.home, globalConfig);

        const result = await runCli(['whoami'], env.home, env.cwd);

        expect(result.stdout).not.toContain(API_KEY);
        expect(result.stderr).not.toContain(API_KEY);
    });
});

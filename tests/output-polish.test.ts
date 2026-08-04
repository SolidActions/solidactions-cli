/**
 * F-C8 — output polish batch:
 *  - `project list --json` / `env list --json` emit the raw API objects.
 *  - `project list` prints its "Projects:" header only after the fetch
 *    succeeds (an auth/network failure used to print the header first).
 *  - `logout` with nothing to remove is an explicit exit(0) decision.
 *  - `ensureGitignoreCovers` is a silent no-op outside a git repo.
 *  - `authFailureMessage` names the host and the key's config source.
 *
 * Test-double policy: real in-process HTTP server (Node's http.createServer),
 * real tmp dirs (makeTmpEnv/writeGlobal), ProcessExitError-throw pattern for
 * process.exit. No mock/spy/stub libraries.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { projectList } from '../src/commands/project-list';
import { envList } from '../src/commands/env-list';
import { logout } from '../src/commands/login';
import { ensureGitignoreCovers } from '../src/utils/config-write-target';
import { authFailureMessage } from '../src/utils/api';
import { makeTmpEnv, writeGlobal } from './helpers';

class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

let stubServer: http.Server;
let stubPort: number;
let nextStatus = 200;
let nextBody: unknown = { data: [] };

beforeAll(async () => {
    stubServer = http.createServer((_req, res) => {
        res.writeHead(nextStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(nextBody));
    });
    await new Promise<void>((resolve) => {
        stubServer.listen(0, '127.0.0.1', () => {
            stubPort = (stubServer.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => {
    return new Promise<void>((resolve, reject) => {
        stubServer.close((err) => (err ? reject(err) : resolve()));
    });
});

describe('project list / env list --json', () => {
    let env: ReturnType<typeof makeTmpEnv>;
    let originalExit: typeof process.exit;
    let logLines: string[];
    let originalLog: typeof console.log;

    beforeEach(() => {
        env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${stubPort}`, apiKey: 'k', workspaceId: 'ws-1' });
        nextStatus = 200;
        originalExit = process.exit;
        (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };
        logLines = [];
        originalLog = console.log;
        console.log = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };
    });

    afterEach(() => {
        process.exit = originalExit;
        console.log = originalLog;
        env.cleanup();
    });

    it('project list --json passes through compatibility environments and environment details', async () => {
        nextBody = {
            data: [{
                name: 'demo',
                status: 'ready',
                slug: 'demo',
                environments: ['production', 'dev'],
                environment_details: [
                    { environment: 'production', slug: 'demo', enabled: true },
                    { environment: 'dev', slug: 'demo-dev', enabled: false },
                ],
            }],
        };

        await projectList({ json: true });

        const parsed = JSON.parse(logLines.join('\n'));
        expect(parsed).toEqual((nextBody as any).data);
        expect(logLines.some((l) => l.includes('Projects:'))).toBe(false);
    });

    it('project list renders environment details as environment:on/off and preserves legacy fallback rows', async () => {
        nextBody = {
            data: [
                {
                    name: 'stateful',
                    status: 'ready',
                    environments: ['production', 'staging', 'dev'],
                    environment_details: [
                        { environment: 'production', slug: 'stateful', enabled: true },
                        { environment: 'staging', slug: 'stateful-staging', enabled: false },
                        { environment: 'dev', slug: 'stateful-dev', enabled: true },
                    ],
                },
                {
                    name: 'legacy',
                    status: 'ready',
                    environments: ['production', 'dev'],
                },
            ],
        };

        await projectList({});

        const output = logLines.join('\n');
        expect(output).toContain('production:on, staging:off, dev:on');
        expect(output).toMatch(/legacy.*production, dev/);
    });

    it('project list colors the exact sanitized and truncated environment cell', async () => {
        nextBody = {
            data: [{
                name: 'bounded-row',
                status: 'ready',
                environment_details: [{
                    environment: `${'x'.repeat(80)}\ninjected-tail`,
                    slug: 'bounded-row',
                    enabled: true,
                }],
            }],
        };

        await projectList({});

        const dataLine = logLines.find((line) => line.includes('bounded-row'));
        expect(dataLine).toBeDefined();
        expect(dataLine).not.toContain('\n');
        expect(dataLine).toContain('…');
        expect(dataLine).not.toContain('injected-tail');
    });

    it('project list prints "Projects:" only after a successful fetch, not before an auth failure', async () => {
        nextStatus = 401;
        nextBody = { message: 'Unauthenticated.' };

        let caught: ProcessExitError | null = null;
        try {
            await projectList({});
        } catch (e) {
            if (e instanceof ProcessExitError) caught = e;
            else throw e;
        }

        expect(caught?.code).toBe(1);
        expect(logLines.some((l) => l.includes('Projects:'))).toBe(false);
    });

    it('env list --json (project mode) prints the raw mappings array', async () => {
        nextBody = [{ env_name: 'X', resolved_value: 'x' }];

        await envList('demo', { json: true });

        const parsed = JSON.parse(logLines.join('\n'));
        expect(parsed).toEqual([{ env_name: 'X', resolved_value: 'x' }]);
    });
});

describe('logout — idempotent no-op', () => {
    let env: ReturnType<typeof makeTmpEnv>;
    let originalExit: typeof process.exit;
    let logLines: string[];
    let originalLog: typeof console.log;

    beforeEach(() => {
        env = makeTmpEnv();
        originalExit = process.exit;
        (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };
        logLines = [];
        originalLog = console.log;
        console.log = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };
    });

    afterEach(() => {
        process.exit = originalExit;
        console.log = originalLog;
        env.cleanup();
    });

    it('exits 0 explicitly and says there is nothing to remove when no config exists', () => {
        let caught: ProcessExitError | null = null;
        try {
            logout({ global: true });
        } catch (e) {
            if (e instanceof ProcessExitError) caught = e;
            else throw e;
        }

        expect(caught?.code).toBe(0);
        expect(logLines.join(' ')).toContain('nothing to remove');
    });
});

describe('ensureGitignoreCovers — skips outside a git repo', () => {
    it('does not create a .gitignore when no .git ancestor exists', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-no-git-'));
        try {
            await ensureGitignoreCovers(tmpDir, true);
            expect(fs.existsSync(path.join(tmpDir, '.gitignore'))).toBe(false);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('still writes .gitignore when a .git ancestor exists', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-with-git-'));
        try {
            fs.mkdirSync(path.join(tmpDir, '.git'));
            await ensureGitignoreCovers(tmpDir, true);
            expect(fs.existsSync(path.join(tmpDir, '.gitignore'))).toBe(true);
            expect(fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8')).toContain('.solidactions/');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('authFailureMessage', () => {
    it('names the host and the config file the key came from', () => {
        const msg = authFailureMessage(
            { host: 'https://app.example', apiKey: 'k' },
            { host: '/home/u/.solidactions/config.json', apiKey: '/home/u/.solidactions/config.json', workspace: null, workspaceId: null },
        );
        expect(msg).toContain('https://app.example');
        expect(msg).toContain('/home/u/.solidactions/config.json');
    });

    it('falls back to "config" when sources are unavailable', () => {
        const msg = authFailureMessage({ host: 'https://app.example', apiKey: 'k' }, null);
        expect(msg).toContain('key from config');
    });
});

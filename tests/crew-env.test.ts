/**
 * Tests for `solidactions crew env set|list|delete|push`.
 *
 * Uses a real in-process HTTP server (Node's http.createServer) to stub the
 * /api/v1/crews... REST endpoints — no mock/spy/stub libraries. Pattern
 * copied from tests/skill-push.test.ts (FIFO response queue + request
 * capture); config is written to a real temp config file (as in
 * tests/env-pull.test.ts / tests/env-set-non-tty.test.ts) since the crew-env
 * commands resolve config via requireConfigWithWorkspace(), not an injected
 * Config param.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import prompts from 'prompts';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { crewEnvSet, buildVariableBody } from '../src/commands/crew-env-set';
import { crewEnvList, formatValue } from '../src/commands/crew-env-list';
import { crewEnvDelete } from '../src/commands/crew-env-delete';
import { crewEnvPush, diffPushEntry } from '../src/commands/crew-env-push';
import { matchCrewByName } from '../src/utils/crew';
import { makeTmpEnv, writeGlobal } from './helpers';

// ---------------------------------------------------------------------------
// Stub REST server — FIFO queue of canned responses; records every request.
// ---------------------------------------------------------------------------

interface CapturedRequest {
    method: string | undefined;
    path: string | undefined;
    headers: http.IncomingHttpHeaders;
    body: any;
}

interface QueuedResponse {
    status: number;
    body: any;
}

let stubServer: http.Server;
let stubPort: number;
let allCaptures: CapturedRequest[] = [];
let responseQueue: QueuedResponse[] = [];

function queue(status: number, body: any): void {
    responseQueue.push({ status, body });
}

beforeAll(async () => {
    stubServer = http.createServer((req, res) => {
        let rawBody = '';
        req.on('data', (chunk) => { rawBody += chunk; });
        req.on('end', () => {
            let parsedBody: any = null;
            try { parsedBody = rawBody ? JSON.parse(rawBody) : null; } catch { /* ignore */ }

            allCaptures.push({ method: req.method, path: req.url, headers: req.headers, body: parsedBody });

            const next = responseQueue.shift();
            if (!next) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'no stub response queued for this request' }));
                return;
            }
            res.writeHead(next.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(next.body));
        });
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

beforeEach(() => {
    allCaptures = [];
    responseQueue = [];
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a real config file pointing at the stub server (crew-env commands resolve config via requireConfigWithWorkspace()). */
function setupConfig(): { cleanup: () => void } {
    const { cleanup } = makeTmpEnv();
    const tmpHome = process.env.HOME!;
    writeGlobal(tmpHome, {
        host: `http://127.0.0.1:${stubPort}`,
        apiKey: 'test-api-key',
        workspaceId: 'ws-test',
    });
    return { cleanup };
}

class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

function patchProcessExit(): () => void {
    const orig = process.exit.bind(process);
    (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };
    return () => { (process as any).exit = orig; };
}

function captureConsole(): { logs: string[]; errors: string[]; restore: () => void } {
    const logs: string[] = [];
    const errors: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args: any[]) => { logs.push(args.map(String).join(' ')); };
    console.error = (...args: any[]) => { errors.push(args.map(String).join(' ')); };
    return { logs, errors, restore: () => { console.log = origLog; console.error = origError; } };
}

async function runExpectingExit(fn: () => Promise<void>): Promise<number | undefined> {
    const restoreExit = patchProcessExit();
    try {
        await fn();
        return undefined;
    } catch (e) {
        if (e instanceof ProcessExitError) return e.code;
        throw e;
    } finally {
        restoreExit();
    }
}

function writeTmpEnvFile(content: string): { file: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-crew-env-push-'));
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, content, 'utf8');
    return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Pure unit tests: buildVariableBody (the --env → column mapping contract)
// ---------------------------------------------------------------------------

describe('buildVariableBody', () => {
    it('production: writes only production_value', () => {
        expect(buildVariableBody('production', 'v', true)).toEqual({ is_secret: true, production_value: 'v' });
    });

    it('staging: writes staging_value + staging_source:"value"', () => {
        expect(buildVariableBody('staging', 'v', false)).toEqual({
            is_secret: false,
            staging_value: 'v',
            staging_source: 'value',
        });
    });

    it('dev: writes dev_value + dev_source:"value"', () => {
        expect(buildVariableBody('dev', 'v', true)).toEqual({
            is_secret: true,
            dev_value: 'v',
            dev_source: 'value',
        });
    });

    it('all (default): writes all five columns with the same value', () => {
        expect(buildVariableBody('all', 'v', true)).toEqual({
            is_secret: true,
            production_value: 'v',
            staging_value: 'v',
            staging_source: 'value',
            dev_value: 'v',
            dev_source: 'value',
        });
    });
});

// ---------------------------------------------------------------------------
// Pure unit tests: matchCrewByName (name resolution semantics)
// ---------------------------------------------------------------------------

describe('matchCrewByName', () => {
    const crews = [
        { id: 1, name: 'Ops Crew' },
        { id: 2, name: 'Support' },
        { id: 3, name: 'support' },
    ];

    it('matches case-insensitively', () => {
        const result = matchCrewByName('ops crew', crews);
        expect(result).toEqual({ status: 'ok', crew: crews[0] });
    });

    it('returns not_found when no name matches', () => {
        expect(matchCrewByName('nope', crews)).toEqual({ status: 'not_found' });
    });

    it('returns ambiguous with all candidates when multiple crews share a case-insensitive name', () => {
        const result = matchCrewByName('Support', crews);
        expect(result.status).toBe('ambiguous');
        if (result.status === 'ambiguous') {
            expect(result.candidates).toEqual([crews[1], crews[2]]);
        }
    });
});

// ---------------------------------------------------------------------------
// Pure unit tests: diffPushEntry (create/update/skip decision)
// ---------------------------------------------------------------------------

describe('diffPushEntry', () => {
    it('creates when the key does not exist on the server', () => {
        const entry = diffPushEntry('KEY', 'v', 'all', true, undefined);
        expect(entry.action).toBe('create');
    });

    it('always updates (never skips) a secret push, even if the value looks unchanged', () => {
        const existing = {
            id: 1, env_name: 'KEY', is_secret: true,
            production_value: '********', staging_value: '********', staging_source: 'value',
            dev_value: '********', dev_source: 'value',
        };
        const entry = diffPushEntry('KEY', 'v', 'all', true, existing);
        expect(entry.action).toBe('update');
    });

    it('skips a plain (non-secret) push when the server value already matches for every targeted column', () => {
        const existing = {
            id: 1, env_name: 'KEY', is_secret: false,
            production_value: 'v', staging_value: 'v', staging_source: 'value',
            dev_value: 'v', dev_source: 'value',
        };
        const entry = diffPushEntry('KEY', 'v', 'all', false, existing);
        expect(entry.action).toBe('skip');
    });

    it('updates a plain push when the server value differs', () => {
        const existing = {
            id: 1, env_name: 'KEY', is_secret: false,
            production_value: 'old', staging_value: 'old', staging_source: 'value',
            dev_value: 'old', dev_source: 'value',
        };
        const entry = diffPushEntry('KEY', 'new', 'all', false, existing);
        expect(entry.action).toBe('update');
    });

    it('with --env production, only compares the production column (staging/dev drift is ignored)', () => {
        const existing = {
            id: 1, env_name: 'KEY', is_secret: false,
            production_value: 'v', staging_value: 'stale', staging_source: 'value',
            dev_value: 'stale', dev_source: 'value',
        };
        const entry = diffPushEntry('KEY', 'v', 'production', false, existing);
        expect(entry.action).toBe('skip');
        expect(entry.body).toEqual({ is_secret: false, production_value: 'v' });
    });

    it('forces update when the secret flag changes from the server-recorded state', () => {
        const existing = {
            id: 1, env_name: 'KEY', is_secret: true,
            production_value: '********', staging_value: '********', staging_source: 'value',
            dev_value: '********', dev_source: 'value',
        };
        const entry = diffPushEntry('KEY', 'v', 'all', false, existing);
        expect(entry.action).toBe('update');
    });
});

// ---------------------------------------------------------------------------
// Pure unit tests: formatValue (unset-vs-masked column rendering)
// ---------------------------------------------------------------------------

describe('formatValue', () => {
    it('null (unset env) renders "-" for a secret column, not the mask', () => {
        const result = formatValue(null, true);
        expect(result).toContain('-');
        expect(result).not.toContain('•');
    });

    it('null (unset env) renders "-" for a plain column', () => {
        const result = formatValue(null, false);
        expect(result).toContain('-');
        expect(result).not.toContain('•');
    });

    it('a set secret value is always masked, never printed raw', () => {
        const result = formatValue('dev-secret-value', true);
        expect(result).toContain('••••••');
        expect(result).not.toContain('dev-secret-value');
    });

    it('a set plain value is printed as-is', () => {
        expect(formatValue('us-east-1', false)).toContain('us-east-1');
    });
});

// ---------------------------------------------------------------------------
// Integration: crewEnvSet
// ---------------------------------------------------------------------------

describe('crewEnvSet', () => {
    it('resolves crew by case-insensitive name, defaults --env to all and secret to true, sends auth + workspace headers', async () => {
        const { cleanup } = setupConfig();
        const { logs, restore } = captureConsole();
        try {
            queue(200, { data: [{ id: 7, name: 'Foo Crew', path: '/crews/foo' }] });
            queue(201, { id: 1, env_name: 'API_KEY', is_secret: true, message: 'created' });

            const code = await runExpectingExit(() => crewEnvSet('foo crew', 'API_KEY', 'super-secret-value', {}));
            expect(code).toBeUndefined();

            expect(allCaptures).toHaveLength(2);
            expect(allCaptures[0].method).toBe('GET');
            expect(allCaptures[0].path).toBe('/api/v1/crews');

            const put = allCaptures[1];
            expect(put.method).toBe('PUT');
            expect(put.path).toBe('/api/v1/crews/7/variables/API_KEY');
            expect(put.headers['authorization']).toBe('Bearer test-api-key');
            expect(put.headers['x-workspace-id']).toBe('ws-test');
            expect(put.body).toEqual({
                is_secret: true,
                production_value: 'super-secret-value',
                staging_value: 'super-secret-value',
                staging_source: 'value',
                dev_value: 'super-secret-value',
                dev_source: 'value',
            });

            // The raw value must never be echoed to stdout.
            expect(logs.join('\n')).not.toContain('super-secret-value');
        } finally {
            restore();
            cleanup();
        }
    });

    it('--env production maps to only the production_value column', async () => {
        const { cleanup } = setupConfig();
        const { restore } = captureConsole();
        try {
            queue(200, { data: [{ id: 7, name: 'Foo Crew' }] });
            queue(200, { id: 1, env_name: 'K', is_secret: true, message: 'updated' });

            await runExpectingExit(() => crewEnvSet('Foo Crew', 'K', 'val', { env: 'production' }));

            expect(allCaptures[1].body).toEqual({ is_secret: true, production_value: 'val' });
        } finally {
            restore();
            cleanup();
        }
    });

    it('--no-secret (options.secret === false) sends is_secret:false', async () => {
        const { cleanup } = setupConfig();
        const { restore } = captureConsole();
        try {
            queue(200, { data: [{ id: 7, name: 'Foo Crew' }] });
            queue(200, { id: 1, env_name: 'K', is_secret: false, message: 'updated' });

            await runExpectingExit(() => crewEnvSet('Foo Crew', 'K', 'val', { env: 'production', secret: false }));

            expect(allCaptures[1].body).toEqual({ is_secret: false, production_value: 'val' });
        } finally {
            restore();
            cleanup();
        }
    });

    it('numeric crew argument is used directly as the id — no GET /api/v1/crews lookup', async () => {
        const { cleanup } = setupConfig();
        const { restore } = captureConsole();
        try {
            queue(200, { id: 1, env_name: 'K', is_secret: true, message: 'created' });

            await runExpectingExit(() => crewEnvSet('42', 'K', 'val', { env: 'production' }));

            expect(allCaptures).toHaveLength(1);
            expect(allCaptures[0].method).toBe('PUT');
            expect(allCaptures[0].path).toBe('/api/v1/crews/42/variables/K');
        } finally {
            restore();
            cleanup();
        }
    });

    it('ambiguous crew name: exits non-zero, lists candidate ids, and makes no PUT call', async () => {
        const { cleanup } = setupConfig();
        const { errors, restore } = captureConsole();
        try {
            queue(200, { data: [{ id: 1, name: 'Support', path: '/a' }, { id: 2, name: 'Support', path: '/b' }] });

            const code = await runExpectingExit(() => crewEnvSet('Support', 'K', 'val', {}));

            expect(code).toBe(1);
            expect(allCaptures).toHaveLength(1); // only the GET /api/v1/crews lookup
            const out = errors.join('\n');
            expect(out).toContain('Multiple crews named "Support"');
            expect(out).toContain('id=1');
            expect(out).toContain('id=2');
        } finally {
            restore();
            cleanup();
        }
    });

    it('crew name not found: exits non-zero and makes no PUT call', async () => {
        const { cleanup } = setupConfig();
        const { errors, restore } = captureConsole();
        try {
            queue(200, { data: [] });

            const code = await runExpectingExit(() => crewEnvSet('Ghost Crew', 'K', 'val', {}));

            expect(code).toBe(1);
            expect(allCaptures).toHaveLength(1);
            expect(errors.join('\n')).toContain('Ghost Crew');
        } finally {
            restore();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Integration: crewEnvList
// ---------------------------------------------------------------------------

describe('crewEnvList', () => {
    it('GETs the crew variables and masks secrets with •••••• — raw secret values never reach stdout', async () => {
        const { cleanup } = setupConfig();
        const { logs, restore } = captureConsole();
        try {
            queue(200, { data: [{ id: 3, name: 'Ops' }] });
            queue(200, {
                data: [
                    { id: 1, env_name: 'DB_PASS', is_secret: true, production_value: 'raw-secret-value', staging_value: 'raw-secret-value', dev_value: null },
                    { id: 2, env_name: 'REGION', is_secret: false, production_value: 'us-east-1', staging_value: null, dev_value: 'us-east-1' },
                ],
            });

            const code = await runExpectingExit(() => crewEnvList('Ops', {}));
            expect(code).toBeUndefined();

            expect(allCaptures[1].method).toBe('GET');
            expect(allCaptures[1].path).toBe('/api/v1/crews/3/variables');

            const out = logs.join('\n');
            expect(out).not.toContain('raw-secret-value');
            expect(out).toContain('••••••');
            expect(out).toContain('DB_PASS');
            expect(out).toContain('REGION');
            expect(out).toContain('us-east-1');
        } finally {
            restore();
            cleanup();
        }
    });

    it('--json passes the API payload straight through', async () => {
        const { cleanup } = setupConfig();
        const { logs, restore } = captureConsole();
        try {
            queue(200, { data: [{ id: 3, name: 'Ops' }] });
            queue(200, { data: [{ id: 1, env_name: 'K', is_secret: false, production_value: 'v' }] });

            await runExpectingExit(() => crewEnvList('Ops', { json: true }));

            const parsed = JSON.parse(logs.join(''));
            expect(parsed).toEqual([{ id: 1, env_name: 'K', is_secret: false, production_value: 'v' }]);
        } finally {
            restore();
            cleanup();
        }
    });

    it('numeric crew argument skips the GET /api/v1/crews lookup', async () => {
        const { cleanup } = setupConfig();
        const { restore } = captureConsole();
        try {
            queue(200, { data: [] });

            await runExpectingExit(() => crewEnvList('99', {}));

            expect(allCaptures).toHaveLength(1);
            expect(allCaptures[0].path).toBe('/api/v1/crews/99/variables');
        } finally {
            restore();
            cleanup();
        }
    });

    it('renders a workspace database mapping as database:name without any value or credential', async () => {
        const { cleanup } = setupConfig();
        const { logs, restore } = captureConsole();
        try {
            queue(200, { data: [{ id: 3, name: 'Ops' }] });
            queue(200, {
                data: [{
                    id: 4,
                    env_name: 'ANALYTICS_DB',
                    source_type: 'workspace_database',
                    workspace_database_id: 'database-id',
                    workspace_database_name: 'analytics',
                    is_secret: true,
                    production_value: 'credential-must-not-render',
                    staging_value: 'credential-must-not-render',
                    dev_value: 'credential-must-not-render',
                    token: 'token-must-not-render',
                }],
            });

            await runExpectingExit(() => crewEnvList('Ops', {}));

            const output = logs.join('\n');
            expect(output).toContain('database:analytics');
            expect(output).not.toContain('credential-must-not-render');
            expect(output).not.toContain('token-must-not-render');
            expect(output).not.toContain('••••••');
        } finally {
            restore();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Integration: crewEnvDelete
// ---------------------------------------------------------------------------

describe('crewEnvDelete', () => {
    it('--yes skips the confirm prompt and DELETEs with the correct path + headers', async () => {
        const { cleanup } = setupConfig();
        const { logs, restore } = captureConsole();
        try {
            queue(200, { data: [{ id: 5, name: 'Ops' }] });
            queue(200, { message: 'Variable deleted.' });

            const code = await runExpectingExit(() => crewEnvDelete('Ops', 'OLD_KEY', { yes: true }));
            expect(code).toBeUndefined();

            expect(allCaptures[1].method).toBe('DELETE');
            expect(allCaptures[1].path).toBe('/api/v1/crews/5/variables/OLD_KEY');
            expect(allCaptures[1].headers['authorization']).toBe('Bearer test-api-key');
            expect(allCaptures[1].headers['x-workspace-id']).toBe('ws-test');
            expect(logs.join('\n')).toContain('Variable deleted.');
        } finally {
            restore();
            cleanup();
        }
    });

    it('404 from the server (variable not found) exits non-zero and surfaces the server message', async () => {
        const { cleanup } = setupConfig();
        const { errors, restore } = captureConsole();
        try {
            queue(200, { data: [{ id: 5, name: 'Ops' }] });
            queue(404, { message: 'Variable "MISSING" not found.' });

            const code = await runExpectingExit(() => crewEnvDelete('Ops', 'MISSING', { yes: true }));

            expect(code).toBe(1);
            expect(errors.join('\n')).toContain('Variable "MISSING" not found.');
        } finally {
            restore();
            cleanup();
        }
    });

    it('numeric crew argument skips the GET /api/v1/crews lookup', async () => {
        const { cleanup } = setupConfig();
        const { restore } = captureConsole();
        try {
            queue(200, { message: 'deleted' });

            await runExpectingExit(() => crewEnvDelete('12', 'K', { yes: true }));

            expect(allCaptures).toHaveLength(1);
            expect(allCaptures[0].method).toBe('DELETE');
            expect(allCaptures[0].path).toBe('/api/v1/crews/12/variables/K');
        } finally {
            restore();
            cleanup();
        }
    });

    it('interactive decline (prompts.inject false): prints Cancelled and issues NO DELETE request', async () => {
        const { cleanup } = setupConfig();
        const { logs, restore } = captureConsole();
        try {
            queue(200, { data: [{ id: 5, name: 'Ops' }] });
            prompts.inject([false]);

            const code = await runExpectingExit(() => crewEnvDelete('Ops', 'OLD_KEY', {}));
            expect(code).toBeUndefined();

            // Only the crew name-lookup GET — the DELETE was never sent.
            expect(allCaptures).toHaveLength(1);
            expect(allCaptures[0].method).toBe('GET');
            expect(allCaptures[0].path).toBe('/api/v1/crews');
            expect(logs.join('\n')).toContain('Cancelled.');
        } finally {
            restore();
            cleanup();
        }
    });
});

// ---------------------------------------------------------------------------
// Integration: crewEnvPush
// ---------------------------------------------------------------------------

describe('crewEnvPush', () => {
    it('create case: new key is PUT with the mapped body; --yes skips the confirm prompt; diff table masks the value', async () => {
        const { cleanup } = setupConfig();
        const { file, cleanup: cleanupEnvFile } = writeTmpEnvFile('NEW_KEY=super-secret-value\n');
        const { logs, restore } = captureConsole();
        try {
            queue(200, { data: [{ id: 9, name: 'MyCrew' }] });
            queue(200, { data: [] }); // no existing variables
            queue(201, { id: 1, env_name: 'NEW_KEY', is_secret: true, message: 'created' });

            const code = await runExpectingExit(() => crewEnvPush('MyCrew', file, { yes: true }));
            expect(code).toBeUndefined();

            expect(allCaptures).toHaveLength(3);
            const put = allCaptures[2];
            expect(put.method).toBe('PUT');
            expect(put.path).toBe('/api/v1/crews/9/variables/NEW_KEY');
            expect(put.body).toEqual({
                is_secret: true,
                production_value: 'super-secret-value',
                staging_value: 'super-secret-value',
                staging_source: 'value',
                dev_value: 'super-secret-value',
                dev_source: 'value',
            });

            const out = logs.join('\n');
            expect(out).not.toContain('super-secret-value');
            expect(out).toContain('••••••');
            expect(out).toContain('NEW_KEY');
            expect(out).toContain('create');
        } finally {
            restore();
            cleanupEnvFile();
            cleanup();
        }
    });

    it('skip case: an unchanged plain variable is not PUT, and the run exits 0 with no confirm prompt needed', async () => {
        const { cleanup } = setupConfig();
        const { file, cleanup: cleanupEnvFile } = writeTmpEnvFile('REGION=us-east-1\n');
        const { logs, restore } = captureConsole();
        try {
            queue(200, { data: [{ id: 3, name: 'Ops' }] });
            queue(200, {
                data: [{
                    id: 2, env_name: 'REGION', is_secret: false,
                    production_value: 'us-east-1', staging_value: 'us-east-1', staging_source: 'value',
                    dev_value: 'us-east-1', dev_source: 'value',
                }],
            });

            const code = await runExpectingExit(() => crewEnvPush('Ops', file, { secret: false }));
            expect(code).toBe(0);

            // Only the two GETs — no PUT for the unchanged key, and no confirm prompt reached.
            expect(allCaptures).toHaveLength(2);
            expect(logs.join('\n')).toContain('skip');
        } finally {
            restore();
            cleanupEnvFile();
            cleanup();
        }
    });

    it('--no-secret (options.secret === false) sends is_secret:false for every pushed key', async () => {
        const { cleanup } = setupConfig();
        const { file, cleanup: cleanupEnvFile } = writeTmpEnvFile('PLAIN_KEY=plain-value\n');
        const { restore } = captureConsole();
        try {
            queue(200, { data: [{ id: 9, name: 'MyCrew' }] });
            queue(200, { data: [] });
            queue(201, { id: 1, env_name: 'PLAIN_KEY', is_secret: false, message: 'created' });

            await runExpectingExit(() => crewEnvPush('MyCrew', file, { yes: true, secret: false }));

            expect(allCaptures[2].body.is_secret).toBe(false);
        } finally {
            restore();
            cleanupEnvFile();
            cleanup();
        }
    });

    it('numeric crew argument skips the GET /api/v1/crews lookup', async () => {
        const { cleanup } = setupConfig();
        const { file, cleanup: cleanupEnvFile } = writeTmpEnvFile('K=v\n');
        const { restore } = captureConsole();
        try {
            queue(200, { data: [] });
            queue(201, { id: 1, env_name: 'K', is_secret: true, message: 'created' });

            await runExpectingExit(() => crewEnvPush('77', file, { yes: true }));

            expect(allCaptures).toHaveLength(2); // GET variables, then PUT — no crews list lookup
            expect(allCaptures[0].path).toBe('/api/v1/crews/77/variables');
            expect(allCaptures[1].path).toBe('/api/v1/crews/77/variables/K');
        } finally {
            restore();
            cleanupEnvFile();
            cleanup();
        }
    });

    it('interactive accept (prompts.inject true): summary counts line appears in stdout and the PUTs fire', async () => {
        const { cleanup } = setupConfig();
        const { file, cleanup: cleanupEnvFile } = writeTmpEnvFile('NEW_KEY=super-secret-value\nOLD_KEY=changed-value\n');
        const { logs, restore } = captureConsole();
        try {
            queue(200, { data: [{ id: 9, name: 'MyCrew' }] });
            queue(200, {
                data: [{
                    id: 2, env_name: 'OLD_KEY', is_secret: false,
                    production_value: 'stale', staging_value: 'stale', staging_source: 'value',
                    dev_value: 'stale', dev_source: 'value',
                }],
            });
            queue(201, { id: 1, env_name: 'NEW_KEY', is_secret: false, message: 'created' });
            queue(200, { id: 2, env_name: 'OLD_KEY', is_secret: false, message: 'updated' });
            prompts.inject([true]);

            const code = await runExpectingExit(() => crewEnvPush('MyCrew', file, { secret: false }));
            expect(code).toBeUndefined();

            // GET crews, GET variables, then one PUT per pushed key.
            expect(allCaptures).toHaveLength(4);
            expect(allCaptures[2].method).toBe('PUT');
            expect(allCaptures[2].path).toBe('/api/v1/crews/9/variables/NEW_KEY');
            expect(allCaptures[3].method).toBe('PUT');
            expect(allCaptures[3].path).toBe('/api/v1/crews/9/variables/OLD_KEY');

            // The create/update/skip summary counts are printed to stdout.
            expect(logs.join('\n')).toContain('1 create, 1 update');
        } finally {
            restore();
            cleanupEnvFile();
            cleanup();
        }
    });

    it('interactive decline (prompts.inject false): prints Cancelled and issues NO PUT requests', async () => {
        const { cleanup } = setupConfig();
        const { file, cleanup: cleanupEnvFile } = writeTmpEnvFile('NEW_KEY=super-secret-value\n');
        const { logs, restore } = captureConsole();
        try {
            queue(200, { data: [{ id: 9, name: 'MyCrew' }] });
            queue(200, { data: [] });
            prompts.inject([false]);

            const code = await runExpectingExit(() => crewEnvPush('MyCrew', file, {}));
            expect(code).toBeUndefined();

            // Only the two GETs — no PUT was ever sent.
            expect(allCaptures).toHaveLength(2);
            expect(allCaptures.every((c) => c.method === 'GET')).toBe(true);

            const out = logs.join('\n');
            expect(out).toContain('1 create');
            expect(out).toContain('Cancelled.');
            expect(out).not.toContain('super-secret-value');
        } finally {
            restore();
            cleanupEnvFile();
            cleanup();
        }
    });
});

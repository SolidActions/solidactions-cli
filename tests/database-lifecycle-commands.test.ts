import * as http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { AddressInfo } from 'net';
import { pathToFileURL } from 'url';
import { describe, expect, it, vi } from 'vitest';

interface DatabaseRecord {
    name: string;
    status: string;
    deleted_at: string | null;
    purge_at: string | null;
    size_bytes: number;
}

interface Config {
    host: string;
    apiKey: string;
    workspaceId: string;
}

interface PostCall {
    url: string;
    body: Record<string, unknown>;
    options: { headers: Record<string, string> };
}

interface CommandDependencies {
    post: (
        url: string,
        body: Record<string, unknown>,
        options: { headers: Record<string, string> },
    ) => Promise<{ data: unknown }>;
    stdout: (line: string) => void;
    stderr: (line: string) => void;
    confirm: (message: string) => Promise<boolean | undefined>;
    isTTY: boolean;
    importDatabase: (name: string, file: string) => Promise<void>;
}

const CONFIG: Config = {
    host: 'https://app.example.test',
    apiKey: 'control-plane-pat',
    workspaceId: 'workspace-1146',
};

const ACTIVE: DatabaseRecord = {
    id: 'database-active-id',
    name: 'Analytics',
    status: 'ready',
    deleted_at: null,
    purge_at: null,
    size_bytes: 1234,
};

const DELETED: DatabaseRecord = {
    id: 'database-deleted-id',
    name: 'Retired',
    status: 'ready',
    deleted_at: '2026-08-07T12:00:00.000000Z',
    purge_at: '2026-09-06T12:00:00.000000Z',
    size_bytes: 5678,
};

const LIST_RESPONSE = {
    databases: [ACTIVE, DELETED],
    quota: { used: 1, limit: 5 },
};

async function loadDatabaseCommands(): Promise<Record<string, unknown>> {
    const moduleUrl = pathToFileURL(path.resolve(__dirname, '../src/commands/database.ts')).href;

    try {
        return await import(moduleUrl) as Record<string, unknown>;
    } catch {
        return {};
    }
}

async function requireExport(name: string): Promise<Function> {
    const module = await loadDatabaseCommands();
    expect(module[name], `${name} export`).toBeTypeOf('function');
    return module[name] as Function;
}

function harness(responseData: unknown = { database: ACTIVE }) {
    const calls: PostCall[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const confirm = vi.fn(async () => true as boolean | undefined);
    const importDatabase = vi.fn(async () => undefined);
    const dependencies: CommandDependencies = {
        post: async (url, body, options) => {
            calls.push({ url, body, options });
            return { data: responseData };
        },
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        confirm,
        isTTY: true,
        importDatabase,
    };

    return { calls, stdout, stderr, confirm, importDatabase, dependencies };
}

function expectControlPost(call: PostCall, body: Record<string, unknown>): void {
    expect(call).toEqual({
        url: 'https://app.example.test/api/v1/databases',
        body,
        options: {
            headers: {
                Accept: 'application/json',
                Authorization: 'Bearer control-plane-pat',
                'Content-Type': 'application/json',
                'X-Workspace-Id': 'workspace-1146',
            },
            signal: expect.any(AbortSignal),
            timeout: 30_000,
        },
    });
}

describe('database lifecycle control-plane contract', () => {
    it('lists active and deleted rows with stable fields and quota in the shared table style', async () => {
        const databaseListWithConfig = await requireExport('databaseListWithConfig');
        const test = harness(LIST_RESPONSE);

        await databaseListWithConfig({}, CONFIG, test.dependencies);

        expect(test.calls).toHaveLength(1);
        expectControlPost(test.calls[0], { operation: 'list' });
        const output = test.stdout.join('\n');
        expect(output).toMatch(/NAME/i);
        expect(output).toMatch(/STATUS/i);
        expect(output).toMatch(/SIZE/i);
        expect(output).toMatch(/DELETED/i);
        expect(output).toMatch(/PURGE/i);
        expect(output).toContain('Analytics');
        expect(output).toContain('Retired');
        expect(output).toContain('1234');
        expect(output).toContain(ACTIVE.status);
        expect(output).toContain(DELETED.deleted_at);
        expect(output).toContain(DELETED.purge_at);
        expect(output).toMatch(/quota.*1.*5/i);
        expect(test.stderr).toEqual([]);
    });

    it('writes the complete list response as JSON with no decoration', async () => {
        const databaseListWithConfig = await requireExport('databaseListWithConfig');
        const test = harness(LIST_RESPONSE);

        await databaseListWithConfig({ json: true }, CONFIG, test.dependencies);

        expect(JSON.parse(test.stdout.join('\n'))).toEqual(LIST_RESPONSE);
        expect(test.stderr).toEqual([]);
        expect(test.stdout.join('\n')).not.toMatch(/Databases:|Quota:|\u001b\[/);
    });

    it('creates with the exact operation and renders the stable response payload as JSON', async () => {
        const databaseCreateWithConfig = await requireExport('databaseCreateWithConfig');
        const payload = { database: ACTIVE };
        const test = harness(payload);

        await databaseCreateWithConfig('Analytics', { json: true }, CONFIG, test.dependencies);

        expect(test.calls).toHaveLength(1);
        expectControlPost(test.calls[0], { operation: 'create', name: 'Analytics' });
        expect(JSON.parse(test.stdout.join('\n'))).toEqual(payload);
        expect(test.stderr).toEqual([]);
    });

    it('undeletes with the exact operation and renders the stable response payload as JSON', async () => {
        const databaseUndeleteWithConfig = await requireExport('databaseUndeleteWithConfig');
        const payload = { database: ACTIVE };
        const test = harness(payload);

        await databaseUndeleteWithConfig('Analytics', { json: true }, CONFIG, test.dependencies);

        expect(test.calls).toHaveLength(1);
        expectControlPost(test.calls[0], { operation: 'undelete', name: 'Analytics' });
        expect(JSON.parse(test.stdout.join('\n'))).toEqual(payload);
        expect(test.stderr).toEqual([]);
    });

    it('deletes with --yes without prompting and preserves the stable JSON payload', async () => {
        const databaseDeleteWithConfig = await requireExport('databaseDeleteWithConfig');
        const payload = { database: DELETED };
        const test = harness(payload);

        await databaseDeleteWithConfig('Retired', { yes: true, json: true }, CONFIG, test.dependencies);

        expect(test.confirm).not.toHaveBeenCalled();
        expect(test.calls).toHaveLength(1);
        expectControlPost(test.calls[0], { operation: 'delete', name: 'Retired' });
        expect(JSON.parse(test.stdout.join('\n'))).toEqual(payload);
        expect(test.stderr).toEqual([]);
    });

    it.each([
        {
            label: 'create',
            exportName: 'databaseCreateWithConfig',
            name: 'Analytics',
            options: {},
            response: { database: ACTIVE },
            operation: 'create',
            success: /creat/i,
            requiredValues: ['Analytics', 'ready'],
        },
        {
            label: 'delete',
            exportName: 'databaseDeleteWithConfig',
            name: 'Retired',
            options: { yes: true },
            response: { database: DELETED },
            operation: 'delete',
            success: /delet/i,
            requiredValues: ['Retired', 'ready', DELETED.deleted_at, DELETED.purge_at],
        },
        {
            label: 'undelete',
            exportName: 'databaseUndeleteWithConfig',
            name: 'Analytics',
            options: {},
            response: { database: ACTIVE },
            operation: 'undelete',
            success: /restor|undelet/i,
            requiredValues: ['Analytics', 'ready'],
        },
    ])('renders safe, operation-appropriate human output for $label', async (scenario) => {
        const handler = await requireExport(scenario.exportName);
        const response = {
            ...scenario.response,
            transport_debug: 'RAW_AXIOS_TRANSPORT_SENTINEL',
            token: 'SUCCESS_RESPONSE_CREDENTIAL_SENTINEL',
        };
        const test = harness(response);

        await handler(scenario.name, scenario.options, CONFIG, test.dependencies);

        expect(test.calls).toHaveLength(1);
        expectControlPost(test.calls[0], { operation: scenario.operation, name: scenario.name });
        const output = test.stdout.join('\n');
        expect(output).toMatch(scenario.success);
        for (const value of scenario.requiredValues) {
            expect(output).toContain(value);
        }
        expect(() => JSON.parse(output)).toThrow();
        expect(output).not.toMatch(/\u001b\[/);
        expect(output).not.toContain(CONFIG.apiKey);
        expect(output).not.toContain('RAW_AXIOS_TRANSPORT_SENTINEL');
        expect(output).not.toContain('SUCCESS_RESPONSE_CREDENTIAL_SENTINEL');
        expect(test.stderr).toEqual([]);
    });
});

describe('database delete confirmation safety', () => {
    it('prompts interactively before posting when --yes is absent', async () => {
        const databaseDeleteWithConfig = await requireExport('databaseDeleteWithConfig');
        const test = harness({ database: DELETED });

        await databaseDeleteWithConfig('Retired', {}, CONFIG, test.dependencies);

        expect(test.confirm).toHaveBeenCalledOnce();
        expect(test.confirm.mock.calls[0][0]).toContain('Retired');
        expect(test.calls).toHaveLength(1);
        expectControlPost(test.calls[0], { operation: 'delete', name: 'Retired' });
    });

    it.each([
        ['decline', false],
        ['EOF', undefined],
    ])('treats interactive %s as cancellation and performs no POST', async (_label, answer) => {
        const databaseDeleteWithConfig = await requireExport('databaseDeleteWithConfig');
        const test = harness({ database: DELETED });
        test.dependencies.confirm = vi.fn(async () => answer);

        await databaseDeleteWithConfig('Retired', {}, CONFIG, test.dependencies);

        expect(test.calls).toEqual([]);
        expect(test.stdout.join('\n')).toMatch(/cancelled/i);
        expect(test.stderr).toEqual([]);
    });

    it('refuses non-interactive deletion without --yes and performs no POST', async () => {
        const databaseDeleteWithConfig = await requireExport('databaseDeleteWithConfig');
        const test = harness({ database: DELETED });
        test.dependencies.isTTY = false;

        await expect(databaseDeleteWithConfig('Retired', {}, CONFIG, test.dependencies))
            .rejects.toThrow(/--yes/i);

        expect(test.confirm).not.toHaveBeenCalled();
        expect(test.calls).toEqual([]);
    });

    it('never prompts in JSON mode and requires --yes before deletion', async () => {
        const databaseDeleteWithConfig = await requireExport('databaseDeleteWithConfig');
        const test = harness({ database: DELETED });

        await expect(databaseDeleteWithConfig('Retired', { json: true }, CONFIG, test.dependencies))
            .rejects.toThrow(/--yes/i);

        expect(test.confirm).not.toHaveBeenCalled();
        expect(test.calls).toEqual([]);
        expect(test.stdout).toEqual([]);
    });
});

describe('database create --from importer handoff', () => {
    it('provisions first, then hands the created logical name and file to the future importer', async () => {
        const databaseCreateWithConfig = await requireExport('databaseCreateWithConfig');
        const events: string[] = [];
        const test = harness({ database: ACTIVE });
        test.dependencies.post = async (url, body, options) => {
            events.push('provision');
            test.calls.push({ url, body, options });
            return { data: { database: ACTIVE } };
        };
        test.dependencies.importDatabase = vi.fn(async (name, file) => {
            events.push(`import:${name}:${file}`);
        });

        await databaseCreateWithConfig(
            'requested-name',
            { from: 'fixtures/seed.sql' },
            CONFIG,
            test.dependencies,
        );

        expect(events).toEqual(['provision', 'import:Analytics:fixtures/seed.sql']);
        expectControlPost(test.calls[0], { operation: 'create', name: 'requested-name' });
    });

    it('reports that the created database remains in place when the later import fails', async () => {
        const databaseCreateWithConfig = await requireExport('databaseCreateWithConfig');
        const test = harness({ database: ACTIVE });
        const importHandoff = vi.fn(async () => {
            throw new Error('IMPORT_HANDOFF_FAILURE_SENTINEL');
        });
        test.dependencies.importDatabase = importHandoff;

        let caught: any;
        try {
            await databaseCreateWithConfig(
                'requested-name',
                { from: 'fixtures/seed.sql' },
                CONFIG,
                test.dependencies,
            );
        } catch (error) {
            caught = error;
        }

        expect(test.calls).toHaveLength(1);
        expect(importHandoff).toHaveBeenCalledOnce();
        expect(importHandoff).toHaveBeenCalledWith('Analytics', 'fixtures/seed.sql');
        const report = `${caught?.message ?? ''}\n${test.stderr.join('\n')}`;
        expect(report).toMatch(/Analytics/);
        expect(report).toMatch(/import.*fail/i);
        expect(report).toMatch(/remain|left.*place/i);
    });
});

describe('database lifecycle error boundary', () => {
    it('retains stable app product errors without exposing Axios transport objects', async () => {
        const databaseCreateWithConfig = await requireExport('databaseCreateWithConfig');
        const test = harness();
        const appError: any = new Error('Axios raw request dump');
        appError.config = { headers: { Authorization: `Bearer ${CONFIG.apiKey}` } };
        appError.request = { metadata: 'AXIOS_REQUEST_SENTINEL' };
        appError.response = {
            status: 409,
            data: {
                code: 'database_name_taken',
                message: 'A database with this name already exists in this workspace.',
            },
            config: appError.config,
            request: appError.request,
        };
        test.dependencies.post = async () => { throw appError; };

        let caught: any;
        try {
            await databaseCreateWithConfig('Analytics', {}, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({
            code: 'database_name_taken',
            message: 'A database with this name already exists in this workspace.',
            status: 409,
        });
        expect(caught).not.toHaveProperty('config');
        expect(caught).not.toHaveProperty('request');
        expect(caught).not.toHaveProperty('response');
        const rendered = `${String(caught)}\n${JSON.stringify(caught)}\n${test.stderr.join('\n')}`;
        expect(rendered).not.toContain(CONFIG.apiKey);
        expect(rendered).not.toContain('AXIOS_REQUEST_SENTINEL');
        expect(rendered).not.toContain('Axios raw request dump');
    });

    it('adds actionable device re-login guidance without dumping the raw Axios error', async () => {
        const databaseListWithConfig = await requireExport('databaseListWithConfig');
        const test = harness();
        const appError: any = new Error('RAW_AXIOS_TOKEN_ABILITY_SENTINEL');
        appError.config = { headers: { Authorization: `Bearer ${CONFIG.apiKey}` } };
        appError.response = {
            status: 403,
            data: {
                code: 'token_missing_ability',
                message: "This API key does not have the 'databases:read' ability.",
                required_ability: 'databases:read',
            },
        };
        test.dependencies.post = async () => { throw appError; };

        let caught: any;
        try {
            await databaseListWithConfig({}, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({ code: 'token_missing_ability', status: 403 });
        expect(caught?.message).toContain("does not have the 'databases:read' ability");
        expect(caught?.message).toContain('solidactions login --device');
        const rendered = `${String(caught)}\n${JSON.stringify(caught)}\n${test.stderr.join('\n')}`;
        expect(rendered).not.toContain(CONFIG.apiKey);
        expect(rendered).not.toContain('RAW_AXIOS_TOKEN_ABILITY_SENTINEL');
    });

    it('maps the stable unauthenticated code to actionable login guidance', async () => {
        const databaseListWithConfig = await requireExport('databaseListWithConfig');
        const test = harness();
        const appError: any = new Error(`RAW_UNAUTHENTICATED_SENTINEL ${CONFIG.apiKey}`);
        appError.response = {
            status: 401,
            data: {
                code: 'unauthenticated',
                message: 'Unauthenticated.',
            },
        };
        test.dependencies.post = async () => { throw appError; };

        let caught: any;
        try {
            await databaseListWithConfig({}, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({ code: 'unauthenticated', status: 401 });
        expect(caught?.message).toContain('solidactions login');
        expect(caught?.message).not.toContain('upstream_unavailable');
        const rendered = `${String(caught)}\n${JSON.stringify(caught)}\n${test.stderr.join('\n')}`;
        expect(rendered).not.toContain(CONFIG.apiKey);
        expect(rendered).not.toContain('RAW_UNAUTHENTICATED_SENTINEL');
    });
});

function runBuiltCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const cli = path.resolve(__dirname, '../dist/index.js');

    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli, ...args], {
            cwd: path.resolve(__dirname, '..'),
            env: { ...process.env, ...env, NO_COLOR: '1', SOLIDACTIONS_NO_AGENT_NUDGES: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.on('error', reject);
        child.on('close', (code) => resolve({
            code,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
        }));
    });
}

describe('database lifecycle real CLI registration', () => {
    it('dispatches database list through the built command action', async () => {
        const requests: Array<{ method: string; url: string; body: string; headers: http.IncomingHttpHeaders }> = [];
        const server = http.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', (chunk: Buffer) => chunks.push(chunk));
            request.on('end', () => {
                requests.push({
                    method: request.method ?? '',
                    url: request.url ?? '',
                    body: Buffer.concat(chunks).toString('utf8'),
                    headers: request.headers,
                });
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(LIST_RESPONSE));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as AddressInfo).port;

        let result: Awaited<ReturnType<typeof runBuiltCli>>;
        try {
            result = await runBuiltCli(['database', 'list', '--json'], {
                SOLIDACTIONS_HOST: `http://127.0.0.1:${port}`,
                SOLIDACTIONS_API_KEY: 'built-process-pat',
                SOLIDACTIONS_WORKSPACE_ID: 'built-workspace',
            });
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toEqual(LIST_RESPONSE);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
            method: 'POST',
            url: '/api/v1/databases',
            body: JSON.stringify({ operation: 'list' }),
        });
        expect(requests[0].headers.authorization).toBe('Bearer built-process-pat');
        expect(requests[0].headers['x-workspace-id']).toBe('built-workspace');
    });
});

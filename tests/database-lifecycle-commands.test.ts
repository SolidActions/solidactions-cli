import * as http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { AddressInfo } from 'net';
import { pathToFileURL } from 'url';
import { describe, expect, it, vi } from 'vitest';

interface DatabaseRecord {
    name: string;
    kind: string;
    status: string;
    activity?: string;
    deleted_at: string | null;
    purge_at: string | null;
    size_bytes: number;
    size_limit_bytes?: number;
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
    kind: 'libsql',
    status: 'ready',
    deleted_at: null,
    purge_at: null,
    size_bytes: 1234,
};

const DELETED: DatabaseRecord = {
    id: 'database-deleted-id',
    name: 'Retired',
    kind: 'libsql',
    status: 'ready',
    deleted_at: '2026-08-07T12:00:00.000000Z',
    purge_at: '2026-09-06T12:00:00.000000Z',
    size_bytes: 5678,
};

const ANALYTICAL: DatabaseRecord = {
    id: 'database-analytical-id',
    name: 'Warehouse',
    kind: 'duckdb',
    status: 'ready',
    activity: 'idle',
    deleted_at: null,
    purge_at: null,
    size_bytes: 1_288_490_188,
    size_limit_bytes: 2_147_483_648,
};

const LIST_RESPONSE = {
    databases: [ACTIVE, DELETED, ANALYTICAL],
    quota: {
        libsql: { used: 2, limit: 5, scope: 'workspace' },
        duckdb: { used: 1, limit: 3, scope: 'org' },
    },
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

/**
 * Locate the rendered table row (from a `renderDatabaseTable` line-per-record
 * table) that contains `match` and split it into its column cell values.
 * Columns are padded with at least two trailing spaces by `renderTable`, so
 * splitting on runs of 2+ spaces reliably isolates NAME/KIND/STATUS/ACTIVITY/etc.
 */
function tableRow(output: string, match: string): string[] {
    const line = output.split('\n').find((candidate) => candidate.trim().startsWith(match));
    if (line === undefined) {
        throw new Error(`no table row starting with "${match}" in:\n${output}`);
    }
    return line.trim().split(/ {2,}/);
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
        expect(test.stderr).toEqual([]);
    });

    it('lists KIND/ACTIVITY/SIZE columns for analytical rows and filters by --kind', async () => {
        const databaseListWithConfig = await requireExport('databaseListWithConfig');
        const test = harness(LIST_RESPONSE);

        await databaseListWithConfig({}, CONFIG, test.dependencies);

        const output = test.stdout.join('\n');
        expect(output).toMatch(/KIND/i);
        expect(output).toMatch(/ACTIVITY/i);
        expect(output).toContain('duckdb');
        expect(output).toContain('idle');
        expect(output).toContain('1.2 GiB / 2.0 GiB');
        // Pin used/limit to their scope on the SAME line, specifically enough
        // that swapping which scope string renders under which kind fails:
        // standard (libsql) databases are limited per workspace, analytical
        // (duckdb) per organisation.
        expect(output).toContain(
            `libsql ${LIST_RESPONSE.quota.libsql.used} / ${LIST_RESPONSE.quota.libsql.limit} (${LIST_RESPONSE.quota.libsql.scope})`,
        );
        expect(output).toContain(
            `duckdb ${LIST_RESPONSE.quota.duckdb.used} / ${LIST_RESPONSE.quota.duckdb.limit} (${LIST_RESPONSE.quota.duckdb.scope})`,
        );

        const stdoutBeforeFilteredCall = test.stdout.length;
        await databaseListWithConfig({ kind: 'duckdb' } as any, CONFIG, test.dependencies);
        expectControlPost(test.calls[1], { operation: 'list' });
        const filtered = test.stdout.slice(stdoutBeforeFilteredCall).join('\n');
        expect(filtered).toContain('Warehouse');
        expect(filtered).not.toContain('Analytics');
        expect(filtered).not.toContain('Retired');
    });

    it('rejects an unrecognized --kind before sending any request', async () => {
        const databaseListWithConfig = await requireExport('databaseListWithConfig');
        const test = harness(LIST_RESPONSE);

        let caught: any;
        try {
            await databaseListWithConfig({ kind: 'duckdbb' } as any, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({ code: 'invalid_kind' });
        expect(caught?.message).toMatch(/duckdbb/);
        expect(test.calls).toEqual([]);
    });

    it('writes the complete list response as JSON with no decoration', async () => {
        const databaseListWithConfig = await requireExport('databaseListWithConfig');
        const test = harness(LIST_RESPONSE);

        await databaseListWithConfig({ json: true }, CONFIG, test.dependencies);

        expect(JSON.parse(test.stdout.join('\n'))).toEqual(LIST_RESPONSE);
        expect(test.stderr).toEqual([]);
        expect(test.stdout.join('\n')).not.toMatch(/Databases:|Quota:|\u001b\[/);
    });

    it('filters JSON output to the matching kind while keeping the full quota', async () => {
        const databaseListWithConfig = await requireExport('databaseListWithConfig');
        const test = harness(LIST_RESPONSE);

        await databaseListWithConfig({ kind: 'duckdb', json: true } as any, CONFIG, test.dependencies);

        expect(JSON.parse(test.stdout.join('\n'))).toEqual({
            databases: [ANALYTICAL],
            quota: LIST_RESPONSE.quota,
        });
    });

    it('creates with the exact operation and renders the stable response payload as JSON', async () => {
        const databaseCreateWithConfig = await requireExport('databaseCreateWithConfig');
        const payload = { database: ACTIVE };
        const test = harness(payload);

        await databaseCreateWithConfig('Analytics', { json: true }, CONFIG, test.dependencies);

        expect(test.calls).toHaveLength(1);
        expectControlPost(test.calls[0], { operation: 'create', name: 'Analytics', kind: 'libsql' });
        expect(JSON.parse(test.stdout.join('\n'))).toEqual(payload);
        expect(test.stderr).toEqual([]);
    });

    it('creates a duckdb database with --kind and polls show until ready', async () => {
        const databaseCreateWithConfig = await requireExport('databaseCreateWithConfig');
        const provisioning = { ...ACTIVE, kind: 'duckdb', status: 'provisioning' };
        const ready = { ...ACTIVE, kind: 'duckdb', status: 'ready' };
        const calls: Array<Record<string, unknown>> = [];
        const test = harness({ database: provisioning });
        const sleeps: number[] = [];
        test.dependencies.post = async (url, body) => {
            calls.push(body);
            if (body.operation === 'create') return { data: { database: provisioning } };
            return { data: { database: ready } };
        };
        (test.dependencies as any).sleep = async (ms: number) => { sleeps.push(ms); };

        await databaseCreateWithConfig('Orders', { kind: 'duckdb', json: true }, CONFIG, test.dependencies);

        expect(calls[0]).toEqual({ operation: 'create', name: 'Orders', kind: 'duckdb' });
        expect(calls[1]).toEqual({ operation: 'show', name: 'Orders' });
        expect(sleeps.length).toBeGreaterThan(0);
        expect(JSON.parse(test.stdout.join('\n'))).toEqual({ database: ready });
    });

    it('does not poll when --no-wait is passed', async () => {
        const databaseCreateWithConfig = await requireExport('databaseCreateWithConfig');
        const provisioning = { ...ACTIVE, kind: 'duckdb', status: 'provisioning' };
        const test = harness({ database: provisioning });

        await databaseCreateWithConfig('Orders', { kind: 'duckdb', wait: false, json: true }, CONFIG, test.dependencies);

        expect(test.calls).toHaveLength(1);
        expect(JSON.parse(test.stdout.join('\n'))).toEqual({ database: provisioning });
    });

    it('defaults --kind to libsql and creates synchronously', async () => {
        const databaseCreateWithConfig = await requireExport('databaseCreateWithConfig');
        const test = harness({ database: ACTIVE });

        await databaseCreateWithConfig('Analytics', {}, CONFIG, test.dependencies);

        expectControlPost(test.calls[0], { operation: 'create', name: 'Analytics', kind: 'libsql' });
    });

    it('renders KIND and the ACTIVITY placeholder on a libsql mutation table', async () => {
        const databaseCreateWithConfig = await requireExport('databaseCreateWithConfig');
        const test = harness({ database: ACTIVE });

        await databaseCreateWithConfig('Analytics', {}, CONFIG, test.dependencies);

        const row = tableRow(test.stdout.join('\n'), ACTIVE.name);
        expect(row[1]).toBe('libsql');
        expect(row[3]).toBe('-');
    });

    it('renders KIND and the real ACTIVITY value on a duckdb mutation table', async () => {
        const databaseCreateWithConfig = await requireExport('databaseCreateWithConfig');
        const duckdbActive: DatabaseRecord = {
            ...ACTIVE,
            name: 'Warehouse',
            kind: 'duckdb',
            activity: 'active',
        };
        const test = harness({ database: duckdbActive });

        await databaseCreateWithConfig('Warehouse', { kind: 'duckdb' }, CONFIG, test.dependencies);

        const row = tableRow(test.stdout.join('\n'), duckdbActive.name);
        expect(row[1]).toBe('duckdb');
        expect(row[3]).toBe('active');
    });

    it('throws provisioning_timeout and stops polling once the deadline passes while still provisioning', async () => {
        const databaseCreateWithConfig = await requireExport('databaseCreateWithConfig');
        const provisioning = { ...ACTIVE, kind: 'duckdb', status: 'provisioning' };
        const calls: Array<Record<string, unknown>> = [];
        const test = harness({ database: provisioning });
        test.dependencies.post = async (url, body) => {
            calls.push(body);
            return { data: { database: provisioning } };
        };
        const sleeps: number[] = [];
        (test.dependencies as any).sleep = async (ms: number) => { sleeps.push(ms); };
        // deadline = call#1 (0) + 5min (300_000) = 300_000.
        // call#2 (loop check, 1_000) is under the deadline -> one poll happens.
        // call#3 (loop check after that poll, 400_000) is past the deadline -> loop stops.
        const timestamps = [0, 1_000, 400_000];
        let nowCalls = 0;
        (test.dependencies as any).now = () => timestamps[Math.min(nowCalls++, timestamps.length - 1)];

        let caught: any;
        try {
            await databaseCreateWithConfig('Orders', { kind: 'duckdb', json: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({ code: 'provisioning_timeout' });
        expect(caught?.message).toMatch(/Orders/);
        // Exactly one show poll happened (create + one show) — a broken loop
        // condition (e.g. an inverted comparison, or ignoring the deadline)
        // would poll unboundedly or zero times instead.
        expect(calls).toEqual([
            { operation: 'create', name: 'Orders', kind: 'duckdb' },
            { operation: 'show', name: 'Orders' },
        ]);
        expect(sleeps).toEqual([2_000]);
    });

    it('throws provisioning_failed when the database reaches a terminal non-ready status', async () => {
        const databaseCreateWithConfig = await requireExport('databaseCreateWithConfig');
        const provisioning = { ...ACTIVE, kind: 'duckdb', status: 'provisioning' };
        const failed = { ...ACTIVE, kind: 'duckdb', status: 'error' };
        const calls: Array<Record<string, unknown>> = [];
        const test = harness({ database: provisioning });
        test.dependencies.post = async (url, body) => {
            calls.push(body);
            if (body.operation === 'create') return { data: { database: provisioning } };
            return { data: { database: failed } };
        };
        (test.dependencies as any).sleep = async () => undefined;

        let caught: any;
        try {
            await databaseCreateWithConfig('Orders', { kind: 'duckdb', json: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({ code: 'provisioning_failed' });
        expect(caught?.message).toMatch(/Orders/);
        expect(caught?.message).toMatch(/error/);
        expect(calls).toEqual([
            { operation: 'create', name: 'Orders', kind: 'duckdb' },
            { operation: 'show', name: 'Orders' },
        ]);
    });

    it('rejects an unrecognized --kind before sending any request', async () => {
        const databaseCreateWithConfig = await requireExport('databaseCreateWithConfig');
        const test = harness({ database: ACTIVE });

        let caught: any;
        try {
            await databaseCreateWithConfig('Orders', { kind: 'duckdbb' as any, json: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({ code: 'invalid_kind' });
        expect(caught?.message).toMatch(/duckdbb/);
        expect(test.calls).toEqual([]);
    });

    it('rejects --kind duckdb combined with --from before sending any request (C-2)', async () => {
        // An analytical database is a billable, org-quota-scoped resource — if this
        // combination reached the server it would create and bill the database, wait
        // out provisioning, and only then fail the (inapplicable) SQL import, leaving
        // the database behind consuming quota. Must be rejected up front, with no POST.
        const databaseCreateWithConfig = await requireExport('databaseCreateWithConfig');
        const test = harness({ database: ACTIVE });

        let caught: any;
        try {
            await databaseCreateWithConfig('Orders', { kind: 'duckdb', from: 'schema.sql', json: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({ code: 'invalid_flag_combination' });
        expect(caught?.message).toMatch(/--from/);
        expect(caught?.message).toMatch(/--kind duckdb/);
        expect(test.calls).toEqual([]);
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

    it('undeletes an analytical database through the same generic operation, with no client-side kind gating (C-4)', async () => {
        // `undelete` applies no kind-based refusal on the CLI side (unlike `dump`/`pull`/
        // `push`/`import`/`exec`) — it dispatches straight to the shared operation, so an
        // analytical database undeletes exactly like a standard one and any server-side
        // refusal (or success) is surfaced verbatim through the generic error boundary.
        const databaseUndeleteWithConfig = await requireExport('databaseUndeleteWithConfig');
        const payload = { database: ANALYTICAL };
        const test = harness(payload);

        await databaseUndeleteWithConfig('Warehouse', { json: true }, CONFIG, test.dependencies);

        expect(test.calls).toHaveLength(1);
        expectControlPost(test.calls[0], { operation: 'undelete', name: 'Warehouse' });
        expect(JSON.parse(test.stdout.join('\n'))).toEqual(payload);
    });

    it('surfaces a server-side undelete refusal for an analytical database verbatim (C-4)', async () => {
        const databaseUndeleteWithConfig = await requireExport('databaseUndeleteWithConfig');
        const test = harness();
        test.dependencies.post = async () => {
            const error: any = new Error('Request failed with status code 422');
            error.response = {
                status: 422,
                data: { code: 'kind_mismatch', message: '"Warehouse" is an analytical database and cannot be undeleted yet.' },
            };
            throw error;
        };

        let caught: any;
        try {
            await databaseUndeleteWithConfig('Warehouse', { json: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({
            code: 'kind_mismatch',
            message: '"Warehouse" is an analytical database and cannot be undeleted yet.',
            status: 422,
        });
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
            extraBody: { kind: 'libsql' },
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
        expectControlPost(test.calls[0], { operation: scenario.operation, name: scenario.name, ...(scenario as any).extraBody });
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
        expectControlPost(test.calls[0], { operation: 'create', name: 'requested-name', kind: 'libsql' });
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
            env: { ...process.env, NO_COLOR: '1', SOLIDACTIONS_NO_AGENT_NUDGES: '1', ...env },
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
    it('keeps built JSON stdout byte-pure while an outdated-CLI nudge is active', async () => {
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
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-database-json-nudge-'));
        fs.mkdirSync(path.join(home, '.solidactions'));
        fs.writeFileSync(path.join(home, '.solidactions', 'agent-update-check.json'), JSON.stringify({
            checkedAt: new Date().toISOString(),
            latestVersion: '9.8.7',
        }));

        let result: Awaited<ReturnType<typeof runBuiltCli>>;
        try {
            result = await runBuiltCli(['database', 'list', '--json'], {
                SOLIDACTIONS_HOST: `http://127.0.0.1:${port}`,
                SOLIDACTIONS_API_KEY: 'built-process-pat',
                SOLIDACTIONS_WORKSPACE_ID: 'built-workspace',
                SOLIDACTIONS_NO_AGENT_NUDGES: '0',
                HOME: home,
            });
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }

        expect(result.code).toBe(0);
        expect(result.stderr).toContain('AGENT NOTE: CLI 1.33.0 outdated (9.8.7 available)');
        expect(result.stdout).toBe(`${JSON.stringify(LIST_RESPONSE, null, 2)}\n`);
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

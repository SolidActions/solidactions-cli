import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseOperationError } from '../src/utils/database-data-plane';

const CONFIG = {
    host: 'https://app.example.test',
    apiKey: 'control-plane-pat-sentinel',
    workspaceId: 'workspace-1146',
};

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        fs.chmodSync(root, 0o700);
        fs.rmSync(root, { recursive: true, force: true });
    }
});

async function commandModule(): Promise<Record<string, unknown>> {
    const url = pathToFileURL(path.resolve(__dirname, '../src/commands/database.ts')).href;
    return await import(url) as Record<string, unknown>;
}

async function requireImport(): Promise<Function> {
    const module = await commandModule();
    expect(module.databaseImportWithConfig, 'databaseImportWithConfig export').toBeTypeOf('function');
    return module.databaseImportWithConfig as Function;
}

async function requireCreate(): Promise<Function> {
    const module = await commandModule();
    expect(module.databaseCreateWithConfig, 'databaseCreateWithConfig export').toBeTypeOf('function');
    return module.databaseCreateWithConfig as Function;
}

function tempRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-database-import-'));
    roots.push(root);
    return root;
}

function sourceFile(root: string, sql: string | Buffer, name = 'seed.sql'): string {
    const file = path.join(root, name);
    fs.writeFileSync(file, sql, { mode: 0o600 });
    return file;
}

interface Execution {
    client: number;
    sql: string;
}

interface HarnessOptions {
    confirm?: boolean;
    isTTY?: boolean;
    now?: () => number;
    expiresAt?: string[];
    post?: (attempt: number, body: Record<string, unknown>) => Promise<unknown>;
    execute?: (execution: Execution) => Promise<void>;
    onLoad?: () => void;
    filesystem?: typeof fs.promises;
}

function importHarness(root: string, options: HarnessOptions = {}) {
    const events: string[] = [];
    const posts: Array<{ url: string; body: Record<string, unknown>; options: Record<string, unknown> }> = [];
    const clients: Record<string, unknown>[] = [];
    const executions: Execution[] = [];
    const closed: number[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const confirm = vi.fn(async () => {
        events.push('confirm');
        return options.confirm ?? true;
    });
    const expiresAt = options.expiresAt ?? ['2026-08-07T12:10:00.000Z'];
    let clientCount = 0;
    let accessAttempt = 0;

    const dependencies: Record<string, unknown> = {
        cwd: root,
        filesystem: options.filesystem,
        now: options.now ?? (() => Date.parse('2026-08-07T12:00:00.000Z')),
        isTTY: options.isTTY ?? true,
        confirm,
        stdout: (line: string) => stdout.push(line),
        stderr: (line: string) => stderr.push(line),
        loadClient: async () => {
            events.push('native:load');
            options.onLoad?.();
            return {
                createClient: (config: Record<string, unknown>) => {
                    const client = ++clientCount;
                    clients.push(config);
                    events.push(`client:${client}:create`);
                    return {
                        execute: async () => {
                            throw new Error('import must use executeMultiple');
                        },
                        executeMultiple: async (statement: unknown) => {
                            const execution = { client, sql: String(statement) };
                            executions.push(execution);
                            events.push(`client:${client}:execute:${executions.length}`);
                            await options.execute?.(execution);
                        },
                        close: async () => {
                            closed.push(client);
                            events.push(`client:${client}:close`);
                        },
                    };
                },
            };
        },
        post: async (url: string, body: Record<string, unknown>, requestOptions: Record<string, unknown>) => {
            posts.push({ url, body, options: requestOptions });
            events.push(`post:${String(body.operation)}`);
            if (body.operation === 'create') {
                if (options.post) return { data: await options.post(0, body) };
                return {
                    data: {
                        database: {
                            name: 'Analytics',
                            status: 'ready',
                            deleted_at: null,
                            purge_at: null,
                            size_bytes: 0,
                        },
                    },
                };
            }

            const attempt = ++accessAttempt;
            if (options.post) return { data: await options.post(attempt, body) };
            return {
                data: {
                    url: 'libsql://physical-hostname.sentinel.invalid',
                    token: `write-token-sentinel-${attempt}`,
                    mode: 'write',
                    expires_at: expiresAt[Math.min(attempt - 1, expiresAt.length - 1)],
                },
            };
        },
    };

    return { events, posts, clients, executions, closed, stdout, stderr, confirm, dependencies };
}

function managedEnvelope(statements: string[]): string {
    return [
        'PRAGMA foreign_keys=OFF;',
        'BEGIN IMMEDIATE;',
        ...statements,
        'COMMIT;',
        'PRAGMA foreign_keys=ON;',
    ].join('\n');
}

function accessPosts(test: ReturnType<typeof importHarness>) {
    return test.posts.filter((call) => call.body.operation === 'access');
}

function expectWriteAccess(test: ReturnType<typeof importHarness>): void {
    for (const call of accessPosts(test)) {
        expect(call).toEqual({
            url: 'https://app.example.test/api/v1/databases',
            body: { operation: 'access', name: 'Analytics', mode: 'write' },
            options: {
                headers: {
                    Accept: 'application/json',
                    Authorization: 'Bearer control-plane-pat-sentinel',
                    'Content-Type': 'application/json',
                    'X-Workspace-Id': 'workspace-1146',
                },
            },
        });
    }
}

function importFiles(root: string): string[] {
    const directory = path.join(root, '.solidactions', 'imports');
    return fs.existsSync(directory)
        ? fs.readdirSync(directory).map((name) => path.join(directory, name))
        : [];
}

function checkpointFiles(root: string): string[] {
    return importFiles(root).filter((file) => file.endsWith('.json'));
}

function checkpointFor(source: string, database: string, overrides: Record<string, unknown> = {}) {
    const content = fs.readFileSync(source);
    return {
        version: 1,
        database,
        source: {
            sha256: createHash('sha256').update(content).digest('hex'),
            sizeBytes: content.length,
        },
        lastCompletedBatch: 1,
        nextStatement: 1,
        completedSourceBytes: Buffer.byteLength(content.toString('utf8').split('\n')[0]),
        ...overrides,
    };
}

function writeCheckpoint(root: string, value: Record<string, unknown>, name = 'resume.json'): string {
    const directory = path.join(root, '.solidactions', 'imports');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, name);
    fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    return file;
}

function report(error: unknown, test: ReturnType<typeof importHarness>): string {
    const value = error as { code?: unknown; message?: unknown } | null;
    return [value?.code, value?.message, ...test.stdout, ...test.stderr].map(String).join('\n');
}

function resumeLine(database: string, source: string, checkpoint: string): string {
    return `Resume with: solidactions database import ${JSON.stringify(database)} ${JSON.stringify(source)} --resume ${JSON.stringify(checkpoint)} --yes`;
}

function expectNoSecrets(value: unknown): void {
    const rendered = typeof value === 'string' ? value : JSON.stringify(value);
    expect(rendered).not.toContain(CONFIG.apiKey);
    expect(rendered).not.toContain('write-token-sentinel');
    expect(rendered).not.toContain('physical-hostname.sentinel.invalid');
    expect(rendered).not.toContain('RAW_TRANSPORT_SECRET');
}

describe('database import command registration', () => {
    it('registers a real Commander action and required --resume checkpoint option', async () => {
        const { program } = await import('../src/index');
        const database = program.commands.find((command) => command.name() === 'database');
        const command = database?.commands.find((candidate) => candidate.name() === 'import') as any;

        expect(command).toBeDefined();
        expect(command._actionHandler, 'database import action').toBeTypeOf('function');
        expect(command.registeredArguments.map((argument: any) => [argument.name(), argument.required])).toEqual([
            ['name', true],
            ['file.sql', true],
        ]);
        expect(command.options.find((option: any) => option.long === '--yes')).toBeDefined();
        expect(command.options.find((option: any) => option.long === '--resume')).toMatchObject({ required: true });
    });
});

describe('database import preflight and execution', () => {
    it('closes a stalled atomic batch at the per-verb deadline and does not publish progress', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const source = sourceFile(root, 'CREATE TABLE stalled (id);');
        const test = importHarness(root, {
            execute: async () => new Promise(() => undefined),
        });
        test.dependencies.dataPlaneTimeoutMs = 10;

        await expect(databaseImportWithConfig('Analytics', source, { yes: true }, CONFIG, test.dependencies))
            .rejects.toMatchObject({ code: 'upstream_unavailable' });

        expect(test.closed).toEqual([1]);
        expect(checkpointFiles(root)).toEqual([]);
        expect(test.stdout).toEqual([]);
    }, 1_000);

    it.each([
        "CREATE TABLE t (id);\n-- DOWNLOAD INCOMPLETE: stream failed\n",
        "\ufeffCREATE TABLE t (id);\r\n-- DOWNLOAD INCOMPLETE: browser stream failed\r\n",
        "CREATE TABLE t (id)\n",
        `INSERT INTO t VALUES ('${'x'.repeat(8 * 1024 * 1024)}');`,
        '',
        ' \n-- comments only;\n/* still only a comment */\n',
        Buffer.from([0x43, 0x52, 0x45, 0x41, 0x54, 0x45, 0x20, 0xc3, 0x28, 0x3b]),
    ])('refuses an unsafe source before confirmation, native load, mint, or execution', async (sql) => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const source = sourceFile(root, sql);
        const test = importHarness(root);

        await expect(databaseImportWithConfig('Analytics', source, { yes: true }, CONFIG, test.dependencies))
            .rejects.toMatchObject({ code: 'import_failed' });

        expect(test.confirm).not.toHaveBeenCalled();
        expect(test.events).not.toContain('native:load');
        expect(test.posts).toEqual([]);
        expect(test.executions).toEqual([]);
    });

    it('requires confirmation, supports --yes, and always preflights before loading native code or minting', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const source = sourceFile(root, 'CREATE TABLE t (id);');
        const declined = importHarness(root, { confirm: false });

        await databaseImportWithConfig('Analytics', source, {}, CONFIG, declined.dependencies);

        expect(declined.confirm).toHaveBeenCalledOnce();
        expect(declined.events).toEqual(['confirm']);
        expect(declined.stdout).toEqual(['Cancelled.']);

        const accepted = importHarness(root);
        await databaseImportWithConfig('Analytics', source, { yes: true }, CONFIG, accepted.dependencies);
        expect(accepted.confirm).not.toHaveBeenCalled();
        expect(accepted.events.indexOf('native:load')).toBeLessThan(accepted.events.indexOf('post:access'));
        expect(accepted.events.indexOf('post:access')).toBeLessThan(accepted.events.indexOf('client:1:execute:1'));
    });

    it('fails non-interactively without --yes before native load or mint', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const source = sourceFile(root, 'CREATE TABLE t (id);');
        const test = importHarness(root, { isTTY: false });

        await expect(databaseImportWithConfig('Analytics', source, {}, CONFIG, test.dependencies))
            .rejects.toMatchObject({ code: 'confirmation_required' });
        expect(test.events).toEqual([]);
        expect(test.posts).toEqual([]);
    });

    it('refuses a matching deterministic checkpoint without --resume before minting or replaying work', async () => {
        const databaseImportWithConfig = await requireImport();
        const outer = tempRoot();
        const root = path.join(outer, 'project with spaces');
        fs.mkdirSync(root);
        const database = 'Finance North';
        const statements = Array.from({ length: 101 }, (_, index) => `INSERT INTO t VALUES (${index});`);
        const source = sourceFile(root, statements.join('\n'), 'seed file.sql');
        const interrupted = importHarness(root, {
            execute: async ({ sql }) => {
                if (sql.includes('VALUES (100)')) throw new Error('INITIAL_FAILURE');
            },
        });
        let initialFailure: unknown;
        try {
            await databaseImportWithConfig(database, source, { yes: true }, CONFIG, interrupted.dependencies);
        } catch (error) {
            initialFailure = error;
        }
        const [checkpoint] = checkpointFiles(root);
        expect(checkpoint).toBeDefined();
        expect(report(initialFailure, interrupted).split('\n')).toContain(resumeLine(database, source, checkpoint));
        const before = fs.readFileSync(checkpoint);
        const test = importHarness(root);

        let caught: unknown;
        try {
            await databaseImportWithConfig(database, source, { yes: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(test.events).not.toContain('native:load');
        expect(test.posts).toEqual([]);
        expect(test.executions).toEqual([]);
        expect(fs.readFileSync(checkpoint)).toEqual(before);
        const lines = report(caught, test).split('\n').filter((line) => line.startsWith('Resume with:'));
        expect(lines).toEqual([resumeLine(database, source, checkpoint)]);
    });

    it.each([
        {
            label: 'expires at the 30-second boundary',
            access: {
                url: 'libsql://physical-hostname.sentinel.invalid',
                token: 'write-token-sentinel-near-expiry',
                mode: 'write',
                expires_at: '2026-08-07T12:00:30.000Z',
                transport_debug: 'RAW_TRANSPORT_SECRET',
            },
        },
        {
            label: 'has the wrong mode',
            access: {
                url: 'libsql://physical-hostname.sentinel.invalid',
                token: 'write-token-sentinel-read',
                mode: 'read',
                expires_at: '2026-08-07T12:10:00.000Z',
                transport_debug: 'RAW_TRANSPORT_SECRET',
            },
        },
    ])('rejects access that $label without creating a client or leaking metadata', async ({ access }) => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const source = sourceFile(root, 'CREATE TABLE t (id);');
        const test = importHarness(root, { post: async () => access });

        let caught: unknown;
        try {
            await databaseImportWithConfig('Analytics', source, { yes: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(test.clients).toEqual([]);
        expect(test.executions).toEqual([]);
        expect(test.closed).toEqual([]);
        expect(importFiles(root)).toEqual([]);
        const rendered = report(caught, test);
        expectNoSecrets(rendered);
        expect(rendered).not.toContain('RAW_TRANSPORT_SECRET');
    });

    it('imports a command-owned preflight snapshot with write-only ephemeral access and an exact managed envelope', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const original = "INSERT INTO items VALUES ('original');";
        const source = sourceFile(root, original);
        const test = importHarness(root, {
            onLoad: () => fs.writeFileSync(source, "INSERT INTO items VALUES ('raced replacement');"),
        });

        await databaseImportWithConfig('Analytics', source, { yes: true }, CONFIG, test.dependencies);

        expectWriteAccess(test);
        expect(accessPosts(test)).toHaveLength(1);
        expect(test.clients).toEqual([{
            url: 'libsql://physical-hostname.sentinel.invalid',
            authToken: 'write-token-sentinel-1',
            intMode: 'string',
        }]);
        expect(test.executions).toEqual([{ client: 1, sql: managedEnvelope([original]) }]);
        expect(test.closed).toEqual([1]);
        expect(checkpointFiles(root)).toEqual([]);
        expect(importFiles(root).filter((file) => /\.tmp$/.test(file))).toEqual([]);
        expectNoSecrets(test.stdout);
        expectNoSecrets(test.stderr);
    });

    it('batches deterministically at 100 groups and reports committed statements and source bytes after each batch', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const statements = Array.from({ length: 101 }, (_, index) => `INSERT INTO t VALUES (${index});`);
        const source = sourceFile(root, statements.join('\n'));
        const test = importHarness(root);

        await databaseImportWithConfig('Analytics', source, { yes: true }, CONFIG, test.dependencies);

        expect(test.executions).toEqual([
            { client: 1, sql: managedEnvelope(statements.slice(0, 100)) },
            { client: 1, sql: managedEnvelope(statements.slice(100)) },
        ]);
        const output = test.stdout.join('\n');
        expect(output).toMatch(/100 statements.*source bytes/i);
        expect(output).toMatch(/101 statements.*source bytes/i);
        expect(output).toMatch(/Imported 101 statements/i);
        expect(output).toContain(String(fs.statSync(source).size));
    });

    it('distinguishes committed source progress from total source size', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const statement = 'INSERT INTO t VALUES (1);';
        const source = sourceFile(root, `${statement}\n`);
        const test = importHarness(root);

        await databaseImportWithConfig('Analytics', source, { yes: true }, CONFIG, test.dependencies);

        expect(test.stdout).toEqual([
            `Imported checkpoint: 1 statements, committed source progress: ${Buffer.byteLength(statement)} source bytes.`,
            `Imported 1 statements (${fs.statSync(source).size} total source bytes) into database "Analytics".`,
        ]);
    });

    it('batches at 512 KiB of UTF-8 SQL and runs one larger legal group alone', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const statement = (marker: string, bytes: number) => {
            const prefix = `INSERT INTO t VALUES ('${marker}`;
            const suffix = "');";
            return `${prefix}${'é'.repeat(Math.floor((bytes - Buffer.byteLength(prefix + suffix)) / 2))}${suffix}`;
        };
        const first = statement('a', 300 * 1024);
        const second = statement('b', 300 * 1024);
        const oversized = statement('c', 600 * 1024);
        const source = sourceFile(root, [first, second, oversized].join('\n'));
        const test = importHarness(root);

        await databaseImportWithConfig('Analytics', source, { yes: true }, CONFIG, test.dependencies);

        expect(test.executions.map((execution) => execution.sql)).toEqual([
            managedEnvelope([first]),
            managedEnvelope([second]),
            managedEnvelope([oversized]),
        ]);
    });

    it('renews proactively only between batches and closes the old client before a fresh write mint', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const statements = Array.from({ length: 101 }, (_, index) => `INSERT INTO t VALUES (${index});`);
        const source = sourceFile(root, statements.join('\n'));
        let clock = Date.parse('2026-08-07T12:00:00.000Z');
        const test = importHarness(root, {
            now: () => clock,
            expiresAt: ['2026-08-07T12:10:00.000Z', '2026-08-07T12:20:00.000Z'],
            execute: async () => {
                clock = Date.parse('2026-08-07T12:09:31.000Z');
            },
        });

        await databaseImportWithConfig('Analytics', source, { yes: true }, CONFIG, test.dependencies);

        expect(accessPosts(test)).toHaveLength(2);
        expect(test.executions.map(({ client }) => client)).toEqual([1, 2]);
        expect(test.closed).toEqual([1, 2]);
        expect(test.events.indexOf('client:1:execute:1')).toBeLessThan(test.events.indexOf('client:1:close'));
        expect(test.events.indexOf('client:1:close')).toBeLessThan(test.events.lastIndexOf('post:access'));
        expect(test.events.lastIndexOf('post:access')).toBeLessThan(test.events.indexOf('client:2:execute:2'));
    });

    it('stops before the next batch when renewal is refused and retains only the last valid checkpoint', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const statements = Array.from({ length: 101 }, (_, index) => `INSERT INTO t VALUES (${index});`);
        const source = sourceFile(root, statements.join('\n'));
        let clock = Date.parse('2026-08-07T12:00:00.000Z');
        const test = importHarness(root, {
            now: () => clock,
            post: async (attempt) => {
                if (attempt === 2) {
                    const denied: any = new Error('RAW_TRANSPORT_SECRET');
                    denied.response = { status: 403, data: { code: 'read_only_mode', message: 'Database writes are disabled.' } };
                    throw denied;
                }
                return {
                    url: 'libsql://physical-hostname.sentinel.invalid',
                    token: 'write-token-sentinel-1',
                    mode: 'write',
                    expires_at: '2026-08-07T12:10:00.000Z',
                };
            },
            execute: async () => {
                clock = Date.parse('2026-08-07T12:09:31.000Z');
            },
        });

        let caught: unknown;
        try {
            await databaseImportWithConfig('Analytics', source, { yes: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(test.executions).toHaveLength(1);
        const checkpoints = checkpointFiles(root);
        expect(checkpoints).toHaveLength(1);
        const checkpoint = JSON.parse(fs.readFileSync(checkpoints[0], 'utf8'));
        expect(checkpoint).toMatchObject({ lastCompletedBatch: 1, nextStatement: 100 });
        expect(report(caught, test)).not.toContain('Resume with:');
        expectNoSecrets(report(caught, test));
        expectNoSecrets(checkpoint);
    });

    it.each([
        {
            code: 'read_only_mode',
            message: 'Database writes are disabled.',
            status: 403,
        },
        {
            code: 'plan_denied',
            message: 'Database writes are unavailable on this plan.',
            status: 403,
        },
        {
            code: 'rate_limited',
            message: 'Database access is temporarily rate limited.',
            status: 429,
        },
    ])('preserves a $code renewal refusal and suppresses unsafe resume guidance', async ({ code, message, status }) => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const statements = Array.from({ length: 101 }, (_, index) => `INSERT INTO t VALUES (${index});`);
        const source = sourceFile(root, statements.join('\n'));
        let clock = Date.parse('2026-08-07T12:00:00.000Z');
        const test = importHarness(root, {
            now: () => clock,
            post: async (attempt) => {
                if (attempt === 2) {
                    const denied: any = new Error('RAW_TRANSPORT_SECRET');
                    denied.response = { status, data: { code, message } };
                    throw denied;
                }
                return {
                    url: 'libsql://physical-hostname.sentinel.invalid',
                    token: 'write-token-sentinel-1',
                    mode: 'write',
                    expires_at: '2026-08-07T12:10:00.000Z',
                };
            },
            execute: async () => {
                clock = Date.parse('2026-08-07T12:09:31.000Z');
            },
        });

        let caught: unknown;
        try {
            await databaseImportWithConfig('Analytics', source, { yes: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({ code, message, status });
        expect(checkpointFiles(root)).toHaveLength(1);
        expect(report(caught, test)).not.toContain('Resume with:');
        expectNoSecrets(report(caught, test));
    });

    it('preserves a structured batch refusal without offering a policy-invalid resume', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const statements = Array.from({ length: 101 }, (_, index) => `INSERT INTO t VALUES (${index});`);
        const source = sourceFile(root, statements.join('\n'));
        const test = importHarness(root, {
            execute: async ({ sql }) => {
                if (sql.includes('VALUES (100)')) {
                    throw new DatabaseOperationError(
                        'read_only_mode',
                        'Database writes were disabled during import.',
                        403,
                    );
                }
            },
        });

        let caught: unknown;
        try {
            await databaseImportWithConfig('Analytics', source, { yes: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({
            code: 'read_only_mode',
            message: 'Database writes were disabled during import.',
            status: 403,
        });
        expect(checkpointFiles(root)).toHaveLength(1);
        expect(report(caught, test)).not.toContain('Resume with:');
        expectNoSecrets(report(caught, test));
    });

    it('never replays a failed or unknown batch and emits the exact stable resume command for the checkpoint', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const statements = Array.from({ length: 101 }, (_, index) => `INSERT INTO t VALUES (${index});`);
        const source = sourceFile(root, statements.join('\n'));
        const test = importHarness(root, {
            execute: async ({ sql }) => {
                if (sql.includes('VALUES (100)')) throw new Error('RAW_TRANSPORT_SECRET');
            },
        });

        let caught: unknown;
        try {
            await databaseImportWithConfig('Analytics', source, { yes: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(test.executions).toHaveLength(2);
        const checkpoints = checkpointFiles(root);
        expect(checkpoints).toHaveLength(1);
        const checkpoint = JSON.parse(fs.readFileSync(checkpoints[0], 'utf8'));
        const digest = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
        expect(checkpoint).toMatchObject({
            version: 1,
            database: 'Analytics',
            lastCompletedBatch: 1,
            nextStatement: 100,
        });
        expect(checkpoint.source).toEqual({
            sha256: digest,
            sizeBytes: fs.statSync(source).size,
        });
        expect(checkpoint.completedSourceBytes).toBe(Buffer.byteLength(statements.slice(0, 100).join('\n')));
        expect(path.basename(checkpoints[0])).toContain('analytics');
        expect(path.basename(checkpoints[0])).toContain(digest.slice(0, 12));
        expect(path.basename(checkpoints[0])).toContain(String(fs.statSync(source).size));
        expect(fs.statSync(checkpoints[0]).mode & 0o777).toBe(0o600);
        expect(importFiles(root).filter((file) => file.endsWith('.tmp'))).toEqual([]);
        expect(report(caught, test)).toContain(
            resumeLine('Analytics', source, checkpoints[0]),
        );
        expectNoSecrets(report(caught, test));
        expectNoSecrets(checkpoint);
        expect(caught).toMatchObject({ code: 'import_failed' });
        expect(test.closed).toEqual([1]);
    });

    it('resumes strictly after committed batches when a later batch is interrupted mid-execution', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const statements = Array.from({ length: 201 }, (_, index) => `INSERT INTO t VALUES (${index});`);
        const source = sourceFile(root, statements.join('\n'));
        const interrupted = importHarness(root, {
            execute: async ({ sql }) => {
                if (sql.includes('VALUES (100)')) throw new Error('MID_BATCH_INTERRUPTION');
            },
        });

        await expect(
            databaseImportWithConfig('Analytics', source, { yes: true }, CONFIG, interrupted.dependencies),
        ).rejects.toMatchObject({ code: 'import_failed' });

        const [checkpoint] = checkpointFiles(root);
        expect(JSON.parse(fs.readFileSync(checkpoint, 'utf8'))).toMatchObject({
            lastCompletedBatch: 1,
            nextStatement: 100,
        });

        const resumed = importHarness(root);
        await databaseImportWithConfig(
            'Analytics',
            source,
            { yes: true, resume: checkpoint },
            CONFIG,
            resumed.dependencies,
        );

        expect(resumed.executions).toHaveLength(2);
        expect(resumed.executions[0].sql).toContain('VALUES (100)');
        expect(resumed.executions[0].sql).not.toContain('VALUES (99)');
        expect(resumed.executions[1].sql).toContain('VALUES (200)');
        expect(checkpointFiles(root)).toEqual([]);
    });

    it('does not claim resumability when atomic checkpoint publication fails after a committed batch', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const source = sourceFile(root, 'CREATE TABLE t (id);');
        const filesystem = Object.create(fs.promises) as typeof fs.promises;
        filesystem.rename = async (from: fs.PathLike, to: fs.PathLike) => {
            if (String(to).endsWith('.json')) throw new Error('CHECKPOINT_RENAME_SENTINEL');
            return fs.promises.rename(from, to);
        };
        const test = importHarness(root, { filesystem });

        let caught: unknown;
        try {
            await databaseImportWithConfig('Analytics', source, { yes: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(test.executions).toHaveLength(1);
        expect(checkpointFiles(root)).toEqual([]);
        expect(importFiles(root).filter((file) => file.endsWith('.tmp'))).toEqual([]);
        expect(report(caught, test)).not.toContain('Resume with:');
        expect(report(caught, test)).toMatch(/import_failed|checkpoint/i);
    });

    it('never follows a deterministic checkpoint target symlink before minting', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const statements = Array.from({ length: 101 }, (_, index) => `INSERT INTO t VALUES (${index});`);
        const source = sourceFile(root, statements.join('\n'));
        const interrupted = importHarness(root, {
            execute: async ({ sql }) => {
                if (sql.includes('VALUES (100)')) throw new Error('INITIAL_FAILURE');
            },
        });
        await expect(databaseImportWithConfig('Analytics', source, { yes: true }, CONFIG, interrupted.dependencies))
            .rejects.toMatchObject({ code: 'import_failed' });
        const [target] = checkpointFiles(root);
        expect(target).toBeDefined();
        const victim = path.join(root, 'victim.json');
        fs.writeFileSync(victim, 'VICTIM MUST REMAIN');
        fs.unlinkSync(target);
        fs.symlinkSync(victim, target);
        const test = importHarness(root);

        await expect(databaseImportWithConfig('Analytics', source, { yes: true }, CONFIG, test.dependencies))
            .rejects.toMatchObject({ code: 'import_failed' });

        expect(test.events).not.toContain('native:load');
        expect(test.posts).toEqual([]);
        expect(test.executions).toEqual([]);
        expect(fs.readFileSync(victim, 'utf8')).toBe('VICTIM MUST REMAIN');
        expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    });

    it('never follows a pre-existing symlinked imports ancestor when deriving a checkpoint', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const source = sourceFile(root, 'CREATE TABLE t (id);');
        const victimDirectory = path.join(root, 'victim-imports');
        const controlDirectory = path.join(root, '.solidactions');
        fs.mkdirSync(victimDirectory);
        fs.mkdirSync(controlDirectory);
        fs.writeFileSync(path.join(victimDirectory, 'keep.txt'), 'VICTIM MUST REMAIN');
        fs.symlinkSync(victimDirectory, path.join(controlDirectory, 'imports'), 'dir');
        const test = importHarness(root);

        await expect(databaseImportWithConfig('Analytics', source, { yes: true }, CONFIG, test.dependencies))
            .rejects.toMatchObject({ code: 'import_failed' });

        expect(test.events).not.toContain('native:load');
        expect(test.posts).toEqual([]);
        expect(fs.readdirSync(victimDirectory)).toEqual(['keep.txt']);
        expect(fs.readFileSync(path.join(victimDirectory, 'keep.txt'), 'utf8')).toBe('VICTIM MUST REMAIN');
    });

    it('does not retry or claim resumability when an imports-ancestor symlink appears after a committed batch', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const statements = Array.from({ length: 101 }, (_, index) => `INSERT INTO t VALUES (${index});`);
        const source = sourceFile(root, statements.join('\n'));
        const controlDirectory = path.join(root, '.solidactions');
        const imports = path.join(controlDirectory, 'imports');
        const displacedImports = path.join(controlDirectory, 'imports-displaced-by-attacker');
        const victimDirectory = path.join(root, 'victim-directory');
        fs.mkdirSync(controlDirectory);
        fs.mkdirSync(victimDirectory);
        fs.writeFileSync(path.join(victimDirectory, 'keep.txt'), 'VICTIM MUST REMAIN');
        let executions = 0;
        const test = importHarness(root, {
            execute: async () => {
                executions += 1;
                if (executions === 1) {
                    if (fs.existsSync(imports)) fs.renameSync(imports, displacedImports);
                    fs.symlinkSync(victimDirectory, imports, 'dir');
                }
            },
        });

        let caught: unknown;
        try {
            await databaseImportWithConfig('Analytics', source, { yes: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(test.executions).toHaveLength(1);
        expect(fs.lstatSync(imports).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(path.join(victimDirectory, 'keep.txt'), 'utf8')).toBe('VICTIM MUST REMAIN');
        expect(fs.readdirSync(victimDirectory)).toEqual(['keep.txt']);
        if (fs.existsSync(displacedImports)) {
            expect(fs.lstatSync(displacedImports).isDirectory()).toBe(true);
            expect(fs.realpathSync(displacedImports)).not.toBe(fs.realpathSync(victimDirectory));
        }
        expect(report(caught, test)).not.toContain('Resume with:');
        expect(caught).toMatchObject({ code: 'import_failed' });
    });
});

describe('database import resume validation', () => {
    it('refuses a directory supplied as --resume before native load or mint', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const source = sourceFile(root, 'CREATE TABLE t (id);');
        const resume = path.join(root, 'resume-directory');
        fs.mkdirSync(resume);
        const test = importHarness(root);

        await expect(databaseImportWithConfig(
            'Analytics', source, { yes: true, resume }, CONFIG, test.dependencies,
        )).rejects.toMatchObject({ code: 'import_failed' });

        expect(test.events).not.toContain('native:load');
        expect(test.posts).toEqual([]);
    });

    it('requires --resume to name a regular non-symlink checkpoint file', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const source = sourceFile(root, 'CREATE TABLE t (id);\nINSERT INTO t VALUES (1);');
        const victim = writeCheckpoint(root, checkpointFor(source, 'Analytics'), 'victim.json');
        const resume = path.join(path.dirname(victim), 'resume-link.json');
        fs.symlinkSync(victim, resume);
        const before = fs.readFileSync(victim);
        const test = importHarness(root);

        await expect(databaseImportWithConfig(
            'Analytics', source, { yes: true, resume }, CONFIG, test.dependencies,
        )).rejects.toMatchObject({ code: 'import_failed' });

        expect(test.events).not.toContain('native:load');
        expect(test.posts).toEqual([]);
        expect(fs.readFileSync(victim)).toEqual(before);
        expect(fs.lstatSync(resume).isSymbolicLink()).toBe(true);
    });

    it('refuses a --resume path beneath a symlinked ancestor before native load or mint', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const source = sourceFile(root, 'CREATE TABLE t (id);\nINSERT INTO t VALUES (1);');
        const victimDirectory = path.join(root, 'victim-imports');
        fs.mkdirSync(victimDirectory);
        const victim = path.join(victimDirectory, 'resume.json');
        fs.writeFileSync(victim, `${JSON.stringify(checkpointFor(source, 'Analytics'))}\n`, { mode: 0o600 });
        const linkedAncestor = path.join(root, 'linked-imports');
        fs.symlinkSync(victimDirectory, linkedAncestor, 'dir');
        const resume = path.join(linkedAncestor, 'resume.json');
        const before = fs.readFileSync(victim);
        const test = importHarness(root);

        await expect(databaseImportWithConfig(
            'Analytics', source, { yes: true, resume }, CONFIG, test.dependencies,
        )).rejects.toMatchObject({ code: 'import_failed' });

        expect(test.events).not.toContain('native:load');
        expect(test.posts).toEqual([]);
        expect(fs.readFileSync(victim)).toEqual(before);
    });

    it.each([
        ['wrong version', { version: 99 }],
        ['wrong database', { database: 'Other' }],
        ['wrong size', { source: { sha256: 'replace', sizeBytes: 999 } }],
        ['out-of-range statement', { nextStatement: 999, completedSourceBytes: 999 }],
        ['invalid source boundary', { nextStatement: 1, completedSourceBytes: 7 }],
    ])('rejects %s before native load or mint', async (_label, mutation) => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const source = sourceFile(root, 'CREATE TABLE t (id);\nINSERT INTO t VALUES (1);');
        const base = checkpointFor(source, 'Analytics');
        const value = {
            ...base,
            ...mutation,
            source: 'source' in mutation
                ? { ...base.source, ...(mutation.source as Record<string, unknown>) }
                : base.source,
        };
        const checkpoint = writeCheckpoint(root, value);
        const test = importHarness(root);

        await expect(databaseImportWithConfig(
            'Analytics',
            source,
            { yes: true, resume: checkpoint },
            CONFIG,
            test.dependencies,
        )).rejects.toMatchObject({ code: 'import_failed' });

        expect(test.events).not.toContain('native:load');
        expect(test.posts).toEqual([]);
        expect(test.executions).toEqual([]);
    });

    it.each([
        {
            label: 'batch count exceeds the deterministic boundary count',
            lastCompletedBatch: 2,
            nextStatement: 100,
        },
        {
            label: 'statement position is not a deterministic batch boundary',
            lastCompletedBatch: 1,
            nextStatement: 50,
        },
    ])('rejects a checkpoint whose $label before native load or mint', async ({ lastCompletedBatch, nextStatement }) => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const statements = Array.from({ length: 101 }, (_, index) => `INSERT INTO t VALUES (${index});`);
        const source = sourceFile(root, statements.join('\n'));
        const checkpoint = writeCheckpoint(root, checkpointFor(source, 'Analytics', {
            lastCompletedBatch,
            nextStatement,
            completedSourceBytes: Buffer.byteLength(statements.slice(0, nextStatement).join('\n')),
        }));
        const test = importHarness(root);

        await expect(databaseImportWithConfig(
            'Analytics', source, { yes: true, resume: checkpoint }, CONFIG, test.dependencies,
        )).rejects.toMatchObject({ code: 'import_failed' });

        expect(test.events).not.toContain('native:load');
        expect(test.posts).toEqual([]);
        expect(test.executions).toEqual([]);
    });

    it('rejects corrupt JSON and same-size source mutation before native load or mint', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const source = sourceFile(root, 'CREATE TABLE t (id);\nINSERT INTO t VALUES (1);');
        const corrupt = writeCheckpoint(root, {});
        fs.writeFileSync(corrupt, '{not-json', { mode: 0o600 });
        const corruptTest = importHarness(root);

        await expect(databaseImportWithConfig(
            'Analytics', source, { yes: true, resume: corrupt }, CONFIG, corruptTest.dependencies,
        )).rejects.toMatchObject({ code: 'import_failed' });
        expect(corruptTest.events).not.toContain('native:load');

        const valid = writeCheckpoint(root, checkpointFor(source, 'Analytics'), 'changed.json');
        const originalSize = fs.statSync(source).size;
        const changed = fs.readFileSync(source, 'utf8').replace('VALUES (1)', 'VALUES (2)');
        fs.writeFileSync(source, changed);
        expect(fs.statSync(source).size).toBe(originalSize);
        const changedTest = importHarness(root);

        await expect(databaseImportWithConfig(
            'Analytics', source, { yes: true, resume: valid }, CONFIG, changedTest.dependencies,
        )).rejects.toMatchObject({ code: 'import_failed' });
        expect(changedTest.events).not.toContain('native:load');
        expect(changedTest.posts).toEqual([]);
    });

    it('continues from a valid parser boundary, skips completed groups, and removes the checkpoint on success', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const firstPrefix = "INSERT INTO t VALUES ('first";
        const firstSuffix = "');";
        const first = `${firstPrefix}${'x'.repeat(520 * 1024 - firstPrefix.length - firstSuffix.length)}${firstSuffix}`;
        const second = "INSERT INTO t VALUES ('second');";
        const source = sourceFile(root, `${first}\n${second}`);
        const checkpointValue = checkpointFor(source, 'Analytics', {
            completedSourceBytes: Buffer.byteLength(first),
        });
        const checkpoint = writeCheckpoint(root, checkpointValue);
        const test = importHarness(root);

        await databaseImportWithConfig(
            'Analytics',
            source,
            { yes: true, resume: checkpoint },
            CONFIG,
            test.dependencies,
        );

        expect(test.executions).toEqual([{ client: 1, sql: managedEnvelope([second]) }]);
        expect(fs.existsSync(checkpoint)).toBe(false);
        expect(checkpointFiles(root)).toEqual([]);
        expect(test.stdout.join('\n')).toMatch(/Imported 2 statements/i);
        expect(test.stdout.join('\n')).toContain(String(fs.statSync(source).size));
    });

    it('preserves a valid checkpoint without resume guidance when policy denies access pre-execution', async () => {
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const statements = Array.from({ length: 101 }, (_, index) => `INSERT INTO t VALUES (${index});`);
        const source = sourceFile(root, statements.join('\n'));
        const completedSourceBytes = Buffer.byteLength(statements.slice(0, 100).join('\n'));
        const checkpoint = writeCheckpoint(root, checkpointFor(source, 'Analytics', {
            lastCompletedBatch: 1,
            nextStatement: 100,
            completedSourceBytes,
        }));
        const before = fs.readFileSync(checkpoint);
        const test = importHarness(root, {
            post: async () => {
                const denied: any = new Error('RAW_TRANSPORT_SECRET');
                denied.config = { headers: { Authorization: 'Bearer RAW_TRANSPORT_SECRET' } };
                denied.response = {
                    status: 403,
                    data: { code: 'read_only_mode', message: 'Database writes are disabled.' },
                    config: denied.config,
                };
                throw denied;
            },
        });

        let caught: unknown;
        try {
            await databaseImportWithConfig(
                'Analytics', source, { yes: true, resume: checkpoint }, CONFIG, test.dependencies,
            );
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({
            code: 'read_only_mode',
            message: 'Database writes are disabled.',
            status: 403,
        });
        expect(report(caught, test)).not.toContain('Resume with:');
        expect(test.executions).toEqual([]);
        expect(test.clients).toEqual([]);
        expect(fs.readFileSync(checkpoint)).toEqual(before);
        expectNoSecrets(report(caught, test));
    });
});

describe('database create --from real importer', () => {
    it.each([
        'CREATE TABLE t (id);\n-- DOWNLOAD INCOMPLETE: stream failed\n',
        'CREATE TABLE t (id)\n',
        `INSERT INTO t VALUES ('${'x'.repeat(8 * 1024 * 1024)}');`,
        '',
        ' \n-- comments only;\n/* still only a comment */\n',
        Buffer.from([0x43, 0x52, 0x45, 0x41, 0x54, 0x45, 0x20, 0xc3, 0x28, 0x3b]),
    ])('preflights marker, parse, and size failures before provisioning or native loading', async (sql) => {
        const databaseCreateWithConfig = await requireCreate();
        const root = tempRoot();
        const source = sourceFile(root, sql);
        const test = importHarness(root);

        await expect(databaseCreateWithConfig(
            'requested-name', { from: source }, CONFIG, test.dependencies,
        )).rejects.toMatchObject({ code: 'import_failed' });

        expect(test.posts).toEqual([]);
        expect(test.events).not.toContain('native:load');
        expect(test.confirm).not.toHaveBeenCalled();
    });

    it('provisions after preflight and imports the returned name without a second confirmation', async () => {
        const databaseCreateWithConfig = await requireCreate();
        const root = tempRoot();
        const statement = 'CREATE TABLE t (id);';
        const source = sourceFile(root, statement);
        const test = importHarness(root);

        await databaseCreateWithConfig('requested-name', { from: source }, CONFIG, test.dependencies);

        expect(test.posts.map((call) => call.body)).toEqual([
            { operation: 'create', name: 'requested-name' },
            { operation: 'access', name: 'Analytics', mode: 'write' },
        ]);
        expect(test.executions).toEqual([{ client: 1, sql: managedEnvelope([statement]) }]);
        expect(test.confirm).not.toHaveBeenCalled();
    });

    it('keeps --json create-from stdout as one undecorated create response', async () => {
        const databaseCreateWithConfig = await requireCreate();
        const root = tempRoot();
        const source = sourceFile(root, 'CREATE TABLE t (id);');
        const test = importHarness(root);
        const expected = {
            database: {
                name: 'Analytics',
                status: 'ready',
                deleted_at: null,
                purge_at: null,
                size_bytes: 0,
            },
        };

        await databaseCreateWithConfig('requested-name', { from: source, json: true }, CONFIG, test.dependencies);

        expect(test.stdout).toHaveLength(1);
        expect(JSON.parse(test.stdout[0])).toEqual(expected);
        expectNoSecrets(test.stdout);
    });

    it('leaves a newly created database in place and returns actionable import_failed guidance', async () => {
        const databaseCreateWithConfig = await requireCreate();
        const root = tempRoot();
        const statements = Array.from({ length: 101 }, (_, index) => `INSERT INTO t VALUES (${index});`);
        const source = sourceFile(root, statements.join('\n'));
        const test = importHarness(root, {
            execute: async ({ sql }) => {
                if (sql.includes('VALUES (100)')) throw new Error('RAW_TRANSPORT_SECRET');
            },
        });

        let caught: unknown;
        try {
            await databaseCreateWithConfig('requested-name', { from: source }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(test.posts.filter((call) => call.body.operation === 'create')).toHaveLength(1);
        expect(test.posts.filter((call) => call.body.operation === 'delete')).toEqual([]);
        expect(checkpointFiles(root)).toHaveLength(1);
        const rendered = report(caught, test);
        expect(rendered).toMatch(/import_failed/i);
        expect(rendered).toMatch(/created|new database/i);
        expect(rendered).toMatch(/remain|left in place/i);
        expect(rendered).toContain('--resume');
        expectNoSecrets(rendered);
    });

    it('namespaces a partial create-from checkpoint and guidance by the API-returned canonical name', async () => {
        const databaseCreateWithConfig = await requireCreate();
        const root = tempRoot();
        const statements = Array.from({ length: 101 }, (_, index) => `INSERT INTO t VALUES (${index});`);
        const source = sourceFile(root, statements.join('\n'));
        const test = importHarness(root, {
            execute: async ({ sql }) => {
                if (sql.includes('VALUES (100)')) throw new Error('CONTROLLED_SECOND_BATCH_FAILURE');
            },
        });

        let caught: unknown;
        try {
            await databaseCreateWithConfig('requested-name', { from: source }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        const checkpoints = checkpointFiles(root);
        expect(checkpoints).toHaveLength(1);
        expect(path.basename(checkpoints[0])).toMatch(/^analytics-/);
        expect(report(caught, test).split('\n')).toContain(resumeLine('Analytics', source, checkpoints[0]));
        expect(JSON.parse(fs.readFileSync(checkpoints[0], 'utf8'))).toMatchObject({ database: 'Analytics' });
    });

    it('makes a create-from checkpoint discoverable by a later plain import of the returned name without replay', async () => {
        const databaseCreateWithConfig = await requireCreate();
        const databaseImportWithConfig = await requireImport();
        const root = tempRoot();
        const statements = Array.from({ length: 101 }, (_, index) => `INSERT INTO t VALUES (${index});`);
        const source = sourceFile(root, statements.join('\n'));
        const interrupted = importHarness(root, {
            execute: async ({ sql }) => {
                if (sql.includes('VALUES (100)')) throw new Error('CONTROLLED_SECOND_BATCH_FAILURE');
            },
        });
        await expect(databaseCreateWithConfig(
            'requested-name', { from: source }, CONFIG, interrupted.dependencies,
        )).rejects.toMatchObject({ code: 'import_failed' });
        const [checkpoint] = checkpointFiles(root);
        const before = fs.readFileSync(checkpoint);
        const plain = importHarness(root);

        let caught: unknown;
        try {
            await databaseImportWithConfig('Analytics', source, { yes: true }, CONFIG, plain.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(plain.events).not.toContain('native:load');
        expect(plain.posts).toEqual([]);
        expect(plain.executions).toEqual([]);
        expect(fs.readFileSync(checkpoint)).toEqual(before);
        expect(report(caught, plain).split('\n')).toContain(resumeLine('Analytics', source, checkpoint));
    });
});

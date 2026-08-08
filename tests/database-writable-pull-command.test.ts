import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const CONFIG = {
    host: 'https://app.example.test',
    apiKey: 'control-plane-pat-sentinel',
    workspaceId: 'workspace-1146',
};

const WARNING = 'Writable live session: writes go to the live workspace database.';
const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        fs.chmodSync(root, 0o700);
        fs.rmSync(root, { recursive: true, force: true });
    }
});

async function requirePull(): Promise<Function> {
    const url = pathToFileURL(path.resolve(__dirname, '../src/commands/database.ts')).href;
    const module = await import(url) as Record<string, unknown>;
    expect(module.databasePullWithConfig, 'databasePullWithConfig export').toBeTypeOf('function');
    return module.databasePullWithConfig as Function;
}

function tempRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-database-writable-pull-'));
    roots.push(root);
    return root;
}

function lineSource(
    lines: string[],
    onRead: (line: string, index: number) => void = () => undefined,
): AsyncIterable<string> {
    return {
        async *[Symbol.asyncIterator]() {
            for (const [index, line] of lines.entries()) {
                onRead(line, index);
                yield line;
            }
        },
    };
}

type Execution = { client: number; method: 'execute' | 'executeMultiple'; sql: string };

interface HarnessOptions {
    lines?: string[];
    input?: AsyncIterable<string>;
    onRead?: (line: string, index: number) => void;
    now?: () => number;
    expiresAt?: string[];
    mint?: (attempt: number) => Promise<Record<string, unknown>>;
    execute?: (execution: Execution) => Promise<unknown>;
    sync?: (client: number, config: Record<string, unknown>) => Promise<void>;
    close?: (client: number, config: Record<string, unknown>) => Promise<void>;
    finalize?: () => Promise<unknown>;
    abortSignal?: AbortSignal;
}

function writableHarness(root: string, options: HarnessOptions = {}) {
    const events: string[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const posts: Array<{ url: string; body: Record<string, unknown>; options: Record<string, unknown> }> = [];
    const attachedConfigs: Record<string, unknown>[] = [];
    const finalizerConfigs: Record<string, unknown>[] = [];
    const executions: Execution[] = [];
    const closed: number[] = [];
    const expiresAt = options.expiresAt ?? ['2026-08-07T12:10:00.000Z'];
    let attached = 0;

    const dependencies: Record<string, unknown> = {
        cwd: root,
        tempPath: (target: string) => path.join(path.dirname(target), `.${path.basename(target)}.solidactions-task8.tmp`),
        now: options.now ?? (() => Date.parse('2026-08-07T12:00:00.000Z')),
        input: options.input ?? lineSource(options.lines ?? ['.exit'], (line, index) => {
            events.push(`input:${index + 1}`);
            options.onRead?.(line, index);
        }),
        abortSignal: options.abortSignal,
        loadClient: async () => ({
            createClient: (config: Record<string, unknown>) => {
                if (!Object.prototype.hasOwnProperty.call(config, 'syncUrl')) {
                    finalizerConfigs.push(config);
                    events.push('finalizer:create');
                    return {
                        execute: async (statement: unknown) => {
                            events.push('finalizer:checkpoint');
                            expect(statement).toBe('PRAGMA wal_checkpoint(TRUNCATE)');
                            return options.finalize?.() ?? {
                                columns: ['busy', 'log', 'checkpointed'],
                                rows: [['0', '1', '1']],
                            };
                        },
                        close: async () => events.push('finalizer:close'),
                    };
                }

                const client = ++attached;
                attachedConfigs.push(config);
                events.push(`client:${client}:create`);
                const temp = fileURLToPath(String(config.url));
                fs.writeFileSync(temp, `ATTACHED REPLICA ${client}`);

                const run = async (method: Execution['method'], statement: unknown) => {
                    const execution = { client, method, sql: String(statement) };
                    executions.push(execution);
                    events.push(`client:${client}:${method}`);
                    if (options.execute) return options.execute(execution);
                    return {
                        columns: [],
                        rows: [],
                        rowsAffected: 1,
                        lastInsertRowid: undefined,
                    };
                };

                return {
                    sync: async () => {
                        events.push(`client:${client}:sync`);
                        await options.sync?.(client, config);
                        fs.writeFileSync(`${temp}-wal`, `OWNED WAL ${client}`);
                        fs.writeFileSync(`${temp}-shm`, `OWNED SHM ${client}`);
                        fs.writeFileSync(`${temp}-client_wal_index`, `OWNED INDEX ${client}`);
                    },
                    execute: (statement: unknown) => run('execute', statement),
                    executeMultiple: (statement: unknown) => run('executeMultiple', statement),
                    close: async () => {
                        closed.push(client);
                        events.push(`client:${client}:close`);
                        await options.close?.(client, config);
                    },
                };
            },
        }),
        post: async (url: string, body: Record<string, unknown>, requestOptions: Record<string, unknown>) => {
            const attempt = posts.length + 1;
            posts.push({ url, body, options: requestOptions });
            events.push(`mint:${attempt}`);
            if (options.mint) {
                return { data: await options.mint(attempt) };
            }
            return {
                data: {
                    url: 'libsql://physical-hostname.sentinel.invalid',
                    token: `fresh-write-token-sentinel-${attempt}`,
                    mode: 'write',
                    expires_at: expiresAt[Math.min(attempt - 1, expiresAt.length - 1)],
                },
            };
        },
        stdout: (line: string) => {
            stdout.push(line);
            events.push(`stdout:${line}`);
        },
        stderr: (line: string) => {
            stderr.push(line);
            events.push('stderr');
        },
        confirm: vi.fn(async () => true as boolean | undefined),
        isTTY: true,
    };

    return {
        events,
        stdout,
        stderr,
        posts,
        attachedConfigs,
        finalizerConfigs,
        executions,
        closed,
        dependencies,
    };
}

function expectWriteAccess(posts: ReturnType<typeof writableHarness>['posts']): void {
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) {
        expect(post).toEqual({
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

function expectNoSecrets(value: unknown): void {
    const rendered = Buffer.isBuffer(value)
        ? value.toString('utf8')
        : value instanceof Uint8Array
            ? Buffer.from(value).toString('utf8')
            : typeof value === 'string'
                ? value
                : JSON.stringify(value);
    expect(rendered).not.toContain(CONFIG.apiKey);
    expect(rendered).not.toContain('fresh-write-token-sentinel');
    expect(rendered).not.toContain('physical-hostname.sentinel.invalid');
    expect(rendered).not.toContain('RAW_TRANSPORT_SECRET');
}

describe('database pull --writable foreground attached session', () => {
    it.each([
        { ending: '.exit', lines: ["INSERT INTO notes(body) VALUES ('one;two');", '.exit'] },
        { ending: 'EOF', lines: ["INSERT INTO notes(body) VALUES ('one;two');"] },
    ])('warns before consuming SQL and cleanly finalizes one write-through client on $ending', async ({ lines }) => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const target = path.join(root, 'analytics.db');
        const test = writableHarness(root, {
            lines,
        });

        await databasePullWithConfig('Analytics', target, { writable: true }, CONFIG, test.dependencies);

        expect(test.stdout[0]).toBe(WARNING);
        expect(test.events.indexOf('mint:1')).toBeLessThan(test.events.indexOf(`stdout:${WARNING}`));
        expect(test.events.indexOf('client:1:sync')).toBeLessThan(test.events.indexOf(`stdout:${WARNING}`));
        expect(test.events.indexOf(`stdout:${WARNING}`)).toBeLessThan(test.events.indexOf('input:1'));
        expectWriteAccess(test.posts);
        expect(test.attachedConfigs).toEqual([{
            url: pathToFileURL(path.join(root, '.analytics.db.solidactions-task8.tmp')).href,
            syncUrl: 'libsql://physical-hostname.sentinel.invalid',
            authToken: 'fresh-write-token-sentinel-1',
            intMode: 'string',
            readYourWrites: true,
            offline: false,
        }]);
        expect(test.events.indexOf('client:1:sync')).toBeLessThan(test.events.indexOf('input:1'));
        expect(test.executions).toEqual([{
            client: 1,
            method: 'execute',
            sql: "INSERT INTO notes(body) VALUES ('one;two');",
        }]);
        expect(test.closed).toEqual([1]);
        expect(test.events.indexOf('client:1:close')).toBeLessThan(test.events.indexOf('finalizer:create'));
        expect(test.finalizerConfigs).toEqual([{
            url: pathToFileURL(path.join(root, '.analytics.db.solidactions-task8.tmp')).href,
            intMode: 'string',
        }]);
        expect(fs.statSync(target).mode & 0o777).toBe(0o444);
        expectNoSecrets(fs.readFileSync(target));
        expectNoSecrets(test.stdout);
        expectNoSecrets(test.stderr);
    });

    it('accumulates multiline SQL and keeps an explicit transaction in one execution group', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const test = writableHarness(root, {
            lines: [
                "INSERT INTO notes(body) VALUES ('first;",
                "second');",
                'BEGIN;',
                "INSERT INTO notes(body) VALUES ('inside; transaction');",
                'COMMIT;',
                '.exit',
            ],
        });

        await databasePullWithConfig('Analytics', path.join(root, 'analytics.db'), { writable: true }, CONFIG, test.dependencies);

        expect(test.executions).toHaveLength(2);
        expect(test.executions[0]).toEqual({
            client: 1,
            method: 'execute',
            sql: "INSERT INTO notes(body) VALUES ('first;\nsecond');",
        });
        expect(test.executions[1].client).toBe(1);
        expect(test.executions[1].method).toBe('executeMultiple');
        expect(test.executions[1].sql).toBe("BEGIN;\nINSERT INTO notes(body) VALUES ('inside; transaction');\nCOMMIT;");
    });

    it('renders SELECT rows, exact DML affected count, and transaction-group success in the human shell', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const test = writableHarness(root, {
            lines: [
                'SELECT id, body FROM notes;',
                'UPDATE notes SET body = upper(body);',
                'BEGIN;',
                "INSERT INTO notes(body) VALUES ('grouped');",
                'COMMIT;',
                '.exit',
            ],
            execute: async ({ method, sql }) => {
                if (method === 'executeMultiple') return undefined;
                if (sql.startsWith('SELECT')) {
                    return {
                        columns: ['id', 'body'],
                        rows: [['1', 'alpha'], ['2', 'beta']],
                        rowsAffected: 0,
                    };
                }
                return { columns: [], rows: [], rowsAffected: 3 };
            },
        });

        await databasePullWithConfig('Analytics', path.join(root, 'analytics.db'), { writable: true }, CONFIG, test.dependencies);

        expect(test.stdout[0]).toBe(WARNING);
        expect(test.stdout[1]).toBe('id  body\n-----------\n1   alpha\n2   beta');
        expect(test.stdout[2]).toBe('Rows affected: 3');
        const groupOutput = test.stdout[3];
        expect(groupOutput).toMatch(/success|executed|complete/i);
        expect(groupOutput).not.toMatch(/rows affected|\bid\b|grouped/i);
        expect(test.stderr).toEqual([]);
    });

    it('renews 30 seconds before expiry before asking the input source for another line', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        let now = Date.parse('2026-08-07T12:00:00.000Z');
        const test = writableHarness(root, {
            now: () => now,
            expiresAt: ['2026-08-07T12:10:00.000Z', '2026-08-07T12:20:00.000Z'],
            lines: ['SELECT 1;', 'SELECT 2;', '.exit'],
            execute: async ({ sql }) => {
                if (sql === 'SELECT 1;') now = Date.parse('2026-08-07T12:09:31.000Z');
                return { columns: ['value'], rows: [['1']], rowsAffected: 0 };
            },
        });

        await databasePullWithConfig('Analytics', path.join(root, 'analytics.db'), { writable: true }, CONFIG, test.dependencies);

        expectWriteAccess(test.posts);
        expect(test.posts).toHaveLength(2);
        expect(test.events.indexOf('client:1:close')).toBeLessThan(test.events.indexOf('mint:2'));
        expect(test.events.indexOf('mint:2')).toBeLessThan(test.events.indexOf('client:2:sync'));
        expect(test.events.indexOf('client:2:sync')).toBeLessThan(test.events.indexOf('input:2'));
        expect(test.attachedConfigs[0].url).toBe(test.attachedConfigs[1].url);
        expect(test.attachedConfigs.map((config) => config.authToken)).toEqual([
            'fresh-write-token-sentinel-1',
            'fresh-write-token-sentinel-2',
        ]);
        expect(test.executions.map(({ client, sql }) => ({ client, sql }))).toEqual([
            { client: 1, sql: 'SELECT 1;' },
            { client: 2, sql: 'SELECT 2;' },
        ]);
        expect(test.closed).toEqual([1, 2]);
    });

    it('stops before consuming more input when proactive renewal is refused', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const target = path.join(root, 'analytics.db');
        const temp = path.join(root, '.analytics.db.solidactions-task8.tmp');
        let now = Date.parse('2026-08-07T12:00:00.000Z');
        const test = writableHarness(root, {
            now: () => now,
            lines: ['SELECT 1;', 'DELETE FROM audit_log;', '.exit'],
            execute: async () => {
                now = Date.parse('2026-08-07T12:09:31.000Z');
                return { columns: ['value'], rows: [['1']], rowsAffected: 0 };
            },
            mint: async (attempt) => {
                if (attempt === 2) {
                    throw Object.assign(new Error('RAW_TRANSPORT_SECRET fuse denied'), {
                        code: 'database_write_disabled',
                    });
                }
                return {
                    url: 'libsql://physical-hostname.sentinel.invalid',
                    token: 'fresh-write-token-sentinel-1',
                    mode: 'write',
                    expires_at: '2026-08-07T12:10:00.000Z',
                };
            },
        });

        let caught: unknown;
        try {
            await databasePullWithConfig('Analytics', target, { writable: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeDefined();
        expect(test.events).toContain('mint:2');
        expect(test.events).not.toContain('input:2');
        expect(test.executions.map(({ sql }) => sql)).toEqual(['SELECT 1;']);
        expect(test.closed).toEqual([1]);
        expect(test.finalizerConfigs).toEqual([{ url: pathToFileURL(temp).href, intMode: 'string' }]);
        expect(test.events.indexOf('client:1:close')).toBeLessThan(test.events.indexOf('finalizer:create'));
        expect(test.events).toContain('finalizer:checkpoint');
        expect(fs.statSync(target).mode & 0o777).toBe(0o444);
        expect(fs.existsSync(temp)).toBe(false);
        for (const suffix of ['-wal', '-shm', '-journal', '-client_wal_index']) {
            expect(fs.existsSync(`${temp}${suffix}`)).toBe(false);
        }
        expectNoSecrets(fs.readFileSync(target));
        expectNoSecrets(caught);
        expectNoSecrets(test.stdout);
        expectNoSecrets(test.stderr);
    });

    it('never replays an auth-expired statement and renews only for subsequent input', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const test = writableHarness(root, {
            lines: ["INSERT INTO ledger(value) VALUES ('once');", 'SELECT count(*) FROM ledger;', '.exit'],
            execute: async ({ client, sql }) => {
                if (client === 1) {
                    throw Object.assign(new Error(
                        'JWT expired: RAW_TRANSPORT_SECRET fresh-write-token-sentinel-1',
                    ), {
                        code: 'SQLITE_AUTH',
                    });
                }
                return { columns: ['count(*)'], rows: [['1']], rowsAffected: 0 };
            },
        });

        await databasePullWithConfig('Analytics', path.join(root, 'analytics.db'), { writable: true }, CONFIG, test.dependencies);

        expect(test.posts).toHaveLength(2);
        expect(test.executions.map(({ client, sql }) => ({ client, sql }))).toEqual([
            { client: 1, sql: "INSERT INTO ledger(value) VALUES ('once');" },
            { client: 2, sql: 'SELECT count(*) FROM ledger;' },
        ]);
        expect(test.events.indexOf('client:1:close')).toBeLessThan(test.events.indexOf('mint:2'));
        expect(test.stderr.join('\n')).toMatch(/unknown outcome/i);
        expectNoSecrets(test.stderr);
    });

    it('reports a non-auth execution failure safely and continues without reminting', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const test = writableHarness(root, {
            lines: ['BROKEN SQL;', 'SELECT 2;', '.exit'],
            execute: async ({ sql }) => {
                if (sql === 'BROKEN SQL;') throw new Error('RAW_TRANSPORT_SECRET syntax detail');
                return { columns: ['2'], rows: [['2']], rowsAffected: 0 };
            },
        });

        await databasePullWithConfig('Analytics', path.join(root, 'analytics.db'), { writable: true }, CONFIG, test.dependencies);

        expect(test.posts).toHaveLength(1);
        expect(test.executions.map(({ sql }) => sql)).toEqual(['BROKEN SQL;', 'SELECT 2;']);
        expect(test.stderr).toHaveLength(1);
        expectNoSecrets(test.stderr);
        expect(test.closed).toEqual([1]);
    });

    it('shares hardened SQL framing for comments, quoted identifiers, and trigger bodies', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const trigger = [
            'CREATE TRIGGER "audit;insert" AFTER INSERT ON "source;table" BEGIN',
            "  INSERT INTO audit_log(message) VALUES ('first; body');",
            "  UPDATE audit_log SET message = CASE WHEN message = 'first; body' THEN 'updated' ELSE message END;",
            'END;',
        ];
        const test = writableHarness(root, {
            lines: [
                '-- comment semicolon; is not a statement boundary',
                'CREATE TABLE "source;table" (id INTEGER);',
                ...trigger,
                '.exit',
            ],
        });

        await databasePullWithConfig(
            'Analytics',
            path.join(root, 'analytics.db'),
            { writable: true },
            CONFIG,
            test.dependencies,
        );

        expect(test.executions).toEqual([
            {
                client: 1,
                method: 'execute',
                sql: '-- comment semicolon; is not a statement boundary\nCREATE TABLE "source;table" (id INTEGER);',
            },
            {
                client: 1,
                method: 'execute',
                sql: trigger.join('\n'),
            },
        ]);
    });

    it('refuses .exit with incomplete buffered SQL without executing or replacing an old target', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const target = path.join(root, 'analytics.db');
        fs.writeFileSync(target, 'OLD REPLICA');
        const test = writableHarness(root, { lines: ["INSERT INTO notes(body) VALUES ('unfinished;", '.exit'] });

        let caught: unknown;
        try {
            await databasePullWithConfig('Analytics', target, { writable: true, yes: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(String((caught as Error)?.message ?? caught)).toMatch(/incomplete/i);
        expect(test.executions).toEqual([]);
        expect(test.closed).toEqual([1]);
        expect(fs.readFileSync(target, 'utf8')).toBe('OLD REPLICA');
        expect(fs.existsSync(path.join(root, '.analytics.db.solidactions-task8.tmp'))).toBe(false);
        expectNoSecrets(caught);
    });

    it('treats abort as an interrupt, consumes no later SQL, and publishes a read-only credential-free replica', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const controller = new AbortController();
        let reads = 0;
        const test = writableHarness(root, {
            abortSignal: controller.signal,
            input: {
                [Symbol.asyncIterator]() {
                    return {
                        async next() {
                            reads += 1;
                            if (reads === 1) return { done: false as const, value: 'SELECT 1;' };
                            controller.abort();
                            return { done: true as const, value: undefined };
                        },
                    };
                },
            },
        });
        const target = path.join(root, 'analytics.db');

        await databasePullWithConfig('Analytics', target, { writable: true }, CONFIG, test.dependencies);

        expect(test.executions.map(({ sql }) => sql)).toEqual(['SELECT 1;']);
        expect(reads).toBe(2);
        expect(test.closed).toEqual([1]);
        expect(test.finalizerConfigs).toHaveLength(1);
        expect(fs.statSync(target).mode & 0o777).toBe(0o444);
        expect(fs.readdirSync(root)).toEqual(['analytics.db']);
        expectNoSecrets(fs.readFileSync(target));
    });

    it('preserves confirmation and exclusive-temp safety before write access or input', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const target = path.join(root, 'analytics.db');
        fs.writeFileSync(target, 'OLD REPLICA');
        const declined = writableHarness(root, { lines: ['DELETE FROM audit_log;'] });
        declined.dependencies.confirm = vi.fn(async () => false);

        await databasePullWithConfig('Analytics', target, { writable: true }, CONFIG, declined.dependencies);

        expect(declined.posts).toEqual([]);
        expect(declined.events.some((event) => event.startsWith('input:'))).toBe(false);
        expect(fs.readFileSync(target, 'utf8')).toBe('OLD REPLICA');

        const temp = path.join(root, '.analytics.db.solidactions-task8.tmp');
        fs.writeFileSync(temp, 'SOMEONE ELSES TEMP');
        const collision = writableHarness(root);
        await expect(databasePullWithConfig(
            'Analytics',
            target,
            { writable: true, yes: true },
            CONFIG,
            collision.dependencies,
        )).rejects.toThrow(/temporary|already exists|failed/i);
        expect(collision.posts).toEqual([]);
        expect(fs.readFileSync(temp, 'utf8')).toBe('SOMEONE ELSES TEMP');
    });

    it.each([
        { ending: 'immediate EOF', lines: [] },
        { ending: 'whitespace EOF', lines: ['', '   ', '\t'] },
        { ending: 'whitespace .exit', lines: ['', '   ', '.exit'] },
    ])('treats $ending as an empty session and publishes normally', async ({ lines }) => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const target = path.join(root, 'analytics.db');
        const test = writableHarness(root, { lines });

        await databasePullWithConfig('Analytics', target, { writable: true }, CONFIG, test.dependencies);

        expect(test.stdout[0]).toBe(WARNING);
        expect(test.executions).toEqual([]);
        expect(test.closed).toEqual([1]);
        expect(test.finalizerConfigs).toHaveLength(1);
        expect(fs.statSync(target).mode & 0o777).toBe(0o444);
        expect(fs.readdirSync(root)).toEqual(['analytics.db']);
    });

    it.each(['normal exit', 'proactive renewal'] as const)(
        '%s close failure preserves the old target without finalization or further mint/input',
        async (phase) => {
            const databasePullWithConfig = await requirePull();
            const root = tempRoot();
            const target = path.join(root, 'analytics.db');
            const temp = path.join(root, '.analytics.db.solidactions-task8.tmp');
            fs.writeFileSync(target, 'OLD REPLICA');
            let now = Date.parse('2026-08-07T12:00:00.000Z');
            const lines = phase === 'normal exit' ? ['.exit'] : ['SELECT 1;', 'SELECT 2;'];
            const test = writableHarness(root, {
                lines,
                now: () => now,
                execute: async () => {
                    now = Date.parse('2026-08-07T12:09:31.000Z');
                    return { columns: ['value'], rows: [['1']], rowsAffected: 0 };
                },
                close: async (client) => {
                    if (client === 1) throw new Error('RAW_TRANSPORT_SECRET close failure');
                },
            });

            let caught: unknown;
            try {
                await databasePullWithConfig(
                    'Analytics',
                    target,
                    { writable: true, yes: true },
                    CONFIG,
                    test.dependencies,
                );
            } catch (error) {
                caught = error;
            }

            expect(caught).toBeDefined();
            expect(test.closed).toEqual([1]);
            expect(test.posts).toHaveLength(1);
            expect(test.events).not.toContain('input:2');
            expect(test.finalizerConfigs).toEqual([]);
            expect(fs.readFileSync(target, 'utf8')).toBe('OLD REPLICA');
            expect(fs.existsSync(temp)).toBe(false);
            for (const suffix of ['-wal', '-shm', '-journal', '-client_wal_index']) {
                expect(fs.existsSync(`${temp}${suffix}`)).toBe(false);
            }
            expectNoSecrets(caught);
            expectNoSecrets(test.stdout);
            expectNoSecrets(test.stderr);
        },
    );

    it('does not publish a replica when the replacement renewal client fails to sync', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const target = path.join(root, 'analytics.db');
        const temp = path.join(root, '.analytics.db.solidactions-task8.tmp');
        fs.writeFileSync(target, 'OLD REPLICA');
        let now = Date.parse('2026-08-07T12:00:00.000Z');
        const test = writableHarness(root, {
            lines: ['SELECT 1;', 'DELETE FROM audit_log;'],
            now: () => now,
            expiresAt: ['2026-08-07T12:10:00.000Z', '2026-08-07T12:20:00.000Z'],
            execute: async () => {
                now = Date.parse('2026-08-07T12:09:31.000Z');
                return { columns: ['value'], rows: [['1']], rowsAffected: 0 };
            },
            sync: async (client) => {
                if (client === 2) throw new Error('RAW_TRANSPORT_SECRET partial renewal sync');
            },
        });

        let caught: unknown;
        try {
            await databasePullWithConfig(
                'Analytics',
                target,
                { writable: true, yes: true },
                CONFIG,
                test.dependencies,
            );
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeDefined();
        expect(test.posts).toHaveLength(2);
        expect(test.closed).toEqual([1, 2]);
        expect(test.events).not.toContain('input:2');
        expect(test.finalizerConfigs).toEqual([]);
        expect(fs.readFileSync(target, 'utf8')).toBe('OLD REPLICA');
        expect(fs.existsSync(temp)).toBe(false);
        for (const suffix of ['-wal', '-shm', '-journal', '-client_wal_index']) {
            expect(fs.existsSync(`${temp}${suffix}`)).toBe(false);
        }
        expectNoSecrets(caught);
    });

    it('refuses a substituted temp symlink before credential-free finalization or chmod', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const target = path.join(root, 'analytics.db');
        const temp = path.join(root, '.analytics.db.solidactions-task8.tmp');
        const victim = path.join(root, 'victim.db');
        fs.writeFileSync(target, 'OLD REPLICA');
        fs.writeFileSync(victim, 'VICTIM CONTENT', { mode: 0o640 });
        const victimMode = fs.statSync(victim).mode & 0o777;
        const test = writableHarness(root, {
            lines: ['.exit'],
            close: async (client) => {
                if (client !== 1) return;
                fs.unlinkSync(temp);
                fs.symlinkSync(victim, temp);
            },
        });

        let caught: unknown;
        try {
            await databasePullWithConfig(
                'Analytics',
                target,
                { writable: true, yes: true },
                CONFIG,
                test.dependencies,
            );
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeDefined();
        expect(test.finalizerConfigs).toEqual([]);
        expect(fs.readFileSync(target, 'utf8')).toBe('OLD REPLICA');
        expect(fs.existsSync(temp)).toBe(false);
        expect(fs.readFileSync(victim, 'utf8')).toBe('VICTIM CONTENT');
        expect(fs.statSync(victim).mode & 0o777).toBe(victimMode);
        expectNoSecrets(caught);
    });

    it('refuses a substituted temp symlink before creating a proactive-renewal client', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const target = path.join(root, 'analytics.db');
        const temp = path.join(root, '.analytics.db.solidactions-task8.tmp');
        const victim = path.join(root, 'renewal-victim.db');
        fs.writeFileSync(target, 'OLD REPLICA');
        fs.writeFileSync(victim, 'RENEWAL VICTIM CONTENT', { mode: 0o640 });
        const victimMode = fs.statSync(victim).mode & 0o777;
        let now = Date.parse('2026-08-07T12:00:00.000Z');
        const test = writableHarness(root, {
            lines: ['SELECT 1;', 'DELETE FROM audit_log;'],
            now: () => now,
            expiresAt: ['2026-08-07T12:10:00.000Z', '2026-08-07T12:20:00.000Z'],
            execute: async () => {
                fs.unlinkSync(temp);
                fs.symlinkSync(victim, temp);
                now = Date.parse('2026-08-07T12:09:31.000Z');
                return { columns: ['value'], rows: [['1']], rowsAffected: 0 };
            },
        });

        let caught: unknown;
        try {
            await databasePullWithConfig(
                'Analytics',
                target,
                { writable: true, yes: true },
                CONFIG,
                test.dependencies,
            );
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeDefined();
        expect(test.posts).toHaveLength(1);
        expect(test.events).not.toContain('mint:2');
        expect(test.attachedConfigs).toHaveLength(1);
        expect(test.closed).toEqual([1]);
        expect(test.events).not.toContain('input:2');
        expect(test.finalizerConfigs).toEqual([]);
        expect(fs.readFileSync(target, 'utf8')).toBe('OLD REPLICA');
        expect(fs.existsSync(temp)).toBe(false);
        expect(fs.readFileSync(victim, 'utf8')).toBe('RENEWAL VICTIM CONTENT');
        expect(fs.statSync(victim).mode & 0o777).toBe(victimMode);
        expectNoSecrets(caught);
        expectNoSecrets(test.stdout);
        expectNoSecrets(test.stderr);
    });

    it.each([
        { label: 'at the window', expiresAt: '2026-08-07T12:00:30.000Z' },
        { label: 'inside the window', expiresAt: '2026-08-07T12:00:29.999Z' },
    ])('rejects access expiring $label before attached client creation or input', async ({ expiresAt }) => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const target = path.join(root, 'analytics.db');
        const temp = path.join(root, '.analytics.db.solidactions-task8.tmp');
        fs.writeFileSync(target, 'OLD REPLICA');
        const test = writableHarness(root, {
            lines: ['DELETE FROM audit_log;'],
            mint: async (attempt) => {
                if (attempt > 1) throw new Error('SECOND_MINT_MUST_NOT_HAPPEN');
                return {
                    url: 'libsql://physical-hostname.sentinel.invalid',
                    token: 'fresh-write-token-sentinel-1',
                    mode: 'write',
                    expires_at: expiresAt,
                };
            },
        });

        let caught: unknown;
        try {
            await databasePullWithConfig(
                'Analytics',
                target,
                { writable: true, yes: true },
                CONFIG,
                test.dependencies,
            );
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeDefined();
        expect(test.posts).toHaveLength(1);
        expect(test.attachedConfigs).toEqual([]);
        expect(test.finalizerConfigs).toEqual([]);
        expect(test.events.some((event) => event.startsWith('input:'))).toBe(false);
        expect(fs.readFileSync(target, 'utf8')).toBe('OLD REPLICA');
        expect(fs.existsSync(temp)).toBe(false);
        expectNoSecrets(caught);
    });

    it.each(['setup', 'finalization'] as const)(
        '%s failure preserves the old target and removes only owned temporary artifacts',
        async (failure) => {
            const databasePullWithConfig = await requirePull();
            const root = tempRoot();
            const target = path.join(root, 'analytics.db');
            const temp = path.join(root, '.analytics.db.solidactions-task8.tmp');
            const unrelated = path.join(root, '.unrelated.tmp');
            fs.writeFileSync(target, 'OLD REPLICA');
            fs.writeFileSync(unrelated, 'DO NOT REMOVE');
            const test = writableHarness(root, {
                lines: ['.exit'],
                sync: async () => {
                    if (failure === 'setup') throw new Error('RAW_TRANSPORT_SECRET setup');
                },
                finalize: async () => {
                    if (failure === 'finalization') throw new Error('RAW_TRANSPORT_SECRET checkpoint');
                    return { columns: ['busy', 'log', 'checkpointed'], rows: [['0', '0', '0']] };
                },
            });

            let caught: unknown;
            try {
                await databasePullWithConfig('Analytics', target, { writable: true, yes: true }, CONFIG, test.dependencies);
            } catch (error) {
                caught = error;
            }

            expect(caught).toBeDefined();
            expect(test.posts.length).toBeGreaterThan(0);
            if (failure === 'setup') {
                expect(test.events).toContain('client:1:sync');
                expect(test.closed).toEqual(test.attachedConfigs.map((_config, index) => index + 1));
            } else {
                expect(test.events).toContain('finalizer:checkpoint');
            }
            expect(fs.readFileSync(target, 'utf8')).toBe('OLD REPLICA');
            expect(fs.readFileSync(unrelated, 'utf8')).toBe('DO NOT REMOVE');
            expect(fs.existsSync(temp)).toBe(false);
            for (const suffix of ['-wal', '-shm', '-journal', '-client_wal_index']) {
                expect(fs.existsSync(`${temp}${suffix}`)).toBe(false);
            }
            expectNoSecrets(caught);
            expectNoSecrets(test.stdout);
            expectNoSecrets(test.stderr);
        },
    );

    it('fails closed on an invalid expires_at without accepting SQL or leaking access metadata', async () => {
        const databasePullWithConfig = await requirePull();
        const root = tempRoot();
        const target = path.join(root, 'analytics.db');
        const temp = path.join(root, '.analytics.db.solidactions-task8.tmp');
        fs.writeFileSync(target, 'OLD REPLICA');
        const test = writableHarness(root, {
            lines: ['DELETE FROM audit_log;'],
            expiresAt: ['not-a-timestamp'],
        });

        let caught: unknown;
        try {
            await databasePullWithConfig('Analytics', target, { writable: true, yes: true }, CONFIG, test.dependencies);
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeDefined();
        expect(test.posts).toHaveLength(1);
        expect(test.attachedConfigs).toEqual([]);
        expect(test.finalizerConfigs).toEqual([]);
        expect(test.events.some((event) => event.startsWith('input:'))).toBe(false);
        expect(test.executions).toEqual([]);
        expect(fs.readFileSync(target, 'utf8')).toBe('OLD REPLICA');
        expect(fs.existsSync(temp)).toBe(false);
        expectNoSecrets(caught);
        expectNoSecrets(test.stdout);
        expectNoSecrets(test.stderr);
    });
});

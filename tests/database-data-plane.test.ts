import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it, vi } from 'vitest';

interface DatabaseAccess {
    url: string;
    token: string;
    mode: 'read' | 'write';
    expires_at: string;
}

interface DatabaseConfig {
    host: string;
    apiKey: string;
    workspaceId: string;
}

interface ClientDependencies {
    loadClient: () => Promise<{ createClient: (config: Record<string, unknown>) => any }>;
    post: (
        url: string,
        body: Record<string, unknown>,
        options: { headers: Record<string, string> },
    ) => Promise<{ data: DatabaseAccess }>;
}

const APP_CONFIG: DatabaseConfig = {
    host: 'https://app.example.test',
    apiKey: 'pat-control-plane-only',
    workspaceId: 'workspace-1146',
};

const ACCESS: DatabaseAccess = {
    url: 'libsql://physical-db.sentinel.invalid?connection=full-url-sentinel',
    token: 'ephemeral-database-token-sentinel',
    mode: 'read',
    expires_at: '2026-08-07T12:10:00Z',
};

async function loadDataPlane(): Promise<Record<string, unknown>> {
    const moduleUrl = pathToFileURL(path.resolve(__dirname, '../src/utils/database-data-plane.ts')).href;

    try {
        return await import(moduleUrl) as Record<string, unknown>;
    } catch {
        return {};
    }
}

async function requireExport(name: string): Promise<Function> {
    const module = await loadDataPlane();
    expect(module[name], `${name} export`).toBeTypeOf('function');
    return module[name] as Function;
}

function dependencies(overrides: Partial<ClientDependencies> = {}): ClientDependencies {
    return {
        loadClient: async () => ({
            createClient: () => ({ close: () => undefined }),
        }),
        post: async () => ({ data: ACCESS }),
        ...overrides,
    };
}

describe('database access control-plane request', () => {
    it('POSTs access intent with the selected workspace and bearer headers', async () => {
        const requestDatabaseAccess = await requireExport('requestDatabaseAccess');
        const calls: unknown[][] = [];

        const access = await requestDatabaseAccess(APP_CONFIG, 'analytics', 'write', {
            post: async (...args: unknown[]) => {
                calls.push(args);
                return { data: { ...ACCESS, mode: 'write' } };
            },
        });

        expect(calls).toEqual([[
            'https://app.example.test/api/v1/databases',
            { operation: 'access', name: 'analytics', mode: 'write' },
            {
                headers: {
                    Accept: 'application/json',
                    Authorization: 'Bearer pat-control-plane-only',
                    'Content-Type': 'application/json',
                    'X-Workspace-Id': 'workspace-1146',
                },
            },
        ]]);
        expect(access).toEqual({ ...ACCESS, mode: 'write' });
    });

    it('retains stable product codes and messages returned by the app', async () => {
        const requestDatabaseAccess = await requireExport('requestDatabaseAccess');
        const appError: any = new Error('Request failed with status 409');
        appError.config = {
            url: `${APP_CONFIG.host}/api/v1/databases`,
            method: 'post',
            headers: {
                Authorization: `Bearer ${APP_CONFIG.apiKey}`,
                'X-Request-Metadata': 'CONTROL_REQUEST_SENTINEL',
            },
        };
        appError.request = {
            socket: 'CONTROL_REQUEST_SENTINEL',
            authorization: `Bearer ${APP_CONFIG.apiKey}`,
        };
        appError.cause = new Error(`transport cause contained ${APP_CONFIG.apiKey}`);
        appError.response = {
            status: 409,
            data: {
                code: 'read_only_mode',
                message: 'Database writes are temporarily unavailable for this workspace.',
            },
            config: appError.config,
            request: appError.request,
        };

        let caught: any;
        try {
            await requestDatabaseAccess(APP_CONFIG, 'analytics', 'write', {
                post: async () => { throw appError; },
            });
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({
            code: 'read_only_mode',
            message: 'Database writes are temporarily unavailable for this workspace.',
            status: 409,
        });
        expect(caught).not.toHaveProperty('config');
        expect(caught).not.toHaveProperty('request');
        expect(caught).not.toHaveProperty('response');
        expect(caught).not.toHaveProperty('cause');

        const publicFailure = JSON.stringify(caught);
        expect(String(caught)).not.toContain(APP_CONFIG.apiKey);
        expect(publicFailure).not.toContain(APP_CONFIG.apiKey);
        expect(publicFailure).not.toContain('CONTROL_REQUEST_SENTINEL');
    });

    it('discards an unstructured 502 proxy body instead of trusting its raw message', async () => {
        const requestDatabaseAccess = await requireExport('requestDatabaseAccess');
        const DatabaseOperationError = await requireExport('DatabaseOperationError');
        const rawMessage = [
            'RAW_PROXY_BODY_SENTINEL',
            'Turso provider failure',
            'physical-db.sentinel.invalid',
            ACCESS.url,
            APP_CONFIG.apiKey,
        ].join(' ');
        const proxyError: any = new Error(rawMessage);
        proxyError.config = {
            url: `${APP_CONFIG.host}/api/v1/databases`,
            headers: { Authorization: `Bearer ${APP_CONFIG.apiKey}` },
        };
        proxyError.request = { raw: rawMessage };
        proxyError.response = {
            status: 502,
            data: {
                code: '   ',
                message: rawMessage,
                body: rawMessage,
            },
            config: proxyError.config,
            request: proxyError.request,
        };
        const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        let caught: any;
        let renderedOutput = '';

        try {
            await requestDatabaseAccess(APP_CONFIG, 'analytics', 'read', {
                post: async () => { throw proxyError; },
            });
        } catch (error) {
            caught = error;
        } finally {
            renderedOutput = [
                ...stdout.mock.calls.flat(),
                ...stderr.mock.calls.flat(),
            ].map(String).join('\n');
            stdout.mockRestore();
            stderr.mockRestore();
        }

        expect(caught).not.toBe(proxyError);
        expect(caught).toBeInstanceOf(DatabaseOperationError as any);
        expect(caught).toMatchObject({
            code: 'upstream_unavailable',
            message: 'Database request failed.',
            status: 502,
        });
        expect(caught).not.toHaveProperty('config');
        expect(caught).not.toHaveProperty('request');
        expect(caught).not.toHaveProperty('response');
        expect(caught).not.toHaveProperty('cause');

        const renderedFailure = `${String(caught)}\n${JSON.stringify(caught)}\n${renderedOutput}`;
        for (const sentinel of [
            'RAW_PROXY_BODY_SENTINEL',
            'Turso',
            'physical-db.sentinel.invalid',
            ACCESS.url,
            APP_CONFIG.apiKey,
        ]) {
            expect(renderedFailure).not.toContain(sentinel);
        }
    });
});

describe('database direct-client lifecycle', () => {
    it('loads native support before minting and uses an in-memory string-int client', async () => {
        const withDatabaseClient = await requireExport('withDatabaseClient');
        const events: string[] = [];
        const clientConfigs: Array<Record<string, unknown>> = [];
        const appConfigBefore = JSON.stringify(APP_CONFIG);
        const client = {
            close: () => events.push('close'),
        };

        const result = await withDatabaseClient(
            APP_CONFIG,
            'analytics',
            'read',
            async (receivedClient: unknown) => {
                events.push('use');
                expect(receivedClient).toBe(client);
                return { rows: 1 };
            },
            dependencies({
                loadClient: async () => {
                    events.push('load');
                    return {
                        createClient: (config) => {
                            events.push('create');
                            clientConfigs.push(config);
                            return client;
                        },
                    };
                },
                post: async () => {
                    events.push('mint');
                    return { data: ACCESS };
                },
            }),
        );

        expect(events).toEqual(['load', 'mint', 'create', 'use', 'close']);
        expect(clientConfigs).toEqual([{
            url: ACCESS.url,
            authToken: ACCESS.token,
            intMode: 'string',
        }]);
        expect(result).toEqual({ rows: 1 });
        expect(result).not.toHaveProperty('token');
        expect(JSON.stringify(APP_CONFIG)).toBe(appConfigBefore);
        expect(JSON.stringify(APP_CONFIG)).not.toContain(ACCESS.token);
    });

    it('does not mint when the dynamic native-client gate fails', async () => {
        const withDatabaseClient = await requireExport('withDatabaseClient');
        let mintCount = 0;

        await expect(withDatabaseClient(
            APP_CONFIG,
            'analytics',
            'read',
            async () => undefined,
            dependencies({
                loadClient: async () => {
                    throw new Error('native binding path sentinel');
                },
                post: async () => {
                    mintCount++;
                    return { data: ACCESS };
                },
            }),
        )).rejects.toMatchObject({ code: 'database_client_unsupported' });

        expect(mintCount).toBe(0);
    });

    it('scrubs a direct-client constructor failure after mint without claiming a close', async () => {
        const withDatabaseClient = await requireExport('withDatabaseClient');
        const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const events: string[] = [];
        let caught: any;
        let renderedOutput = '';

        try {
            await withDatabaseClient(
                APP_CONFIG,
                'analytics',
                'read',
                async () => undefined,
                dependencies({
                    loadClient: async () => ({
                        createClient: () => {
                            events.push('create');
                            throw new Error(
                                `connect failed for ${ACCESS.url} on physical-db.sentinel.invalid using ${ACCESS.token}`,
                            );
                        },
                    }),
                    post: async () => {
                        events.push('mint');
                        return { data: ACCESS };
                    },
                }),
            );
        } catch (error) {
            caught = error;
        } finally {
            renderedOutput = [
                ...stdout.mock.calls.flat(),
                ...stderr.mock.calls.flat(),
            ].map(String).join('\n');
            stdout.mockRestore();
            stderr.mockRestore();
        }

        expect(events).toEqual(['mint', 'create']);
        expect({ code: caught?.code, message: caught?.message }).toEqual({
            code: 'upstream_unavailable',
            message: 'Database operation failed.',
        });

        const serializedFailure = JSON.stringify(caught);
        for (const sentinel of [ACCESS.url, 'physical-db.sentinel.invalid', ACCESS.token]) {
            expect(renderedOutput).not.toContain(sentinel);
            expect(String(caught)).not.toContain(sentinel);
            expect(serializedFailure).not.toContain(sentinel);
        }
    });

    it('closes the client in finally after success', async () => {
        const withDatabaseClient = await requireExport('withDatabaseClient');
        const close = vi.fn();

        await withDatabaseClient(
            APP_CONFIG,
            'analytics',
            'read',
            async () => 'ok',
            dependencies({
                loadClient: async () => ({ createClient: () => ({ close }) }),
            }),
        );

        expect(close).toHaveBeenCalledOnce();
    });

    it('maps a close-only rejection to a safe generic error without leaking cleanup details', async () => {
        const withDatabaseClient = await requireExport('withDatabaseClient');
        const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const close = vi.fn(async () => {
            throw new Error(`close failed for ${ACCESS.url} using ${ACCESS.token}`);
        });
        let caught: any;
        let renderedOutput = '';

        try {
            await withDatabaseClient(
                APP_CONFIG,
                'analytics',
                'read',
                async () => 'operation-completed',
                dependencies({
                    loadClient: async () => ({ createClient: () => ({ close }) }),
                }),
            );
        } catch (error) {
            caught = error;
        } finally {
            renderedOutput = [
                ...stdout.mock.calls.flat(),
                ...stderr.mock.calls.flat(),
            ].map(String).join('\n');
            stdout.mockRestore();
            stderr.mockRestore();
        }

        expect(close).toHaveBeenCalledOnce();
        expect({ code: caught?.code, message: caught?.message }).toEqual({
            code: 'upstream_unavailable',
            message: 'Database operation failed.',
        });

        const serializedFailure = JSON.stringify(caught);
        for (const sentinel of [ACCESS.url, 'physical-db.sentinel.invalid', ACCESS.token]) {
            expect(renderedOutput).not.toContain(sentinel);
            expect(String(caught)).not.toContain(sentinel);
            expect(serializedFailure).not.toContain(sentinel);
        }
    });

    it('keeps the primary safe operation failure when close also throws', async () => {
        const withDatabaseClient = await requireExport('withDatabaseClient');
        const close = vi.fn(async () => {
            throw new Error(`CLOSE_FAILURE_SENTINEL ${ACCESS.url} ${ACCESS.token}`);
        });
        let caught: any;

        try {
            await withDatabaseClient(
                APP_CONFIG,
                'analytics',
                'read',
                async () => {
                    throw new Error(`PRIMARY_FAILURE_SENTINEL ${ACCESS.url} ${ACCESS.token}`);
                },
                dependencies({
                    loadClient: async () => ({ createClient: () => ({ close }) }),
                }),
            );
        } catch (error) {
            caught = error;
        }

        expect(close).toHaveBeenCalledOnce();
        expect({ code: caught?.code, message: caught?.message }).toEqual({
            code: 'upstream_unavailable',
            message: 'Database operation failed.',
        });

        const renderedFailure = `${String(caught)}\n${JSON.stringify(caught)}`;
        expect(renderedFailure).not.toContain('PRIMARY_FAILURE_SENTINEL');
        expect(renderedFailure).not.toContain('CLOSE_FAILURE_SENTINEL');
        expect(renderedFailure).not.toContain(ACCESS.url);
        expect(renderedFailure).not.toContain(ACCESS.token);
    });

    it.each(['connect', 'query', 'sync'])('closes the client after a %s failure', async (phase) => {
        const withDatabaseClient = await requireExport('withDatabaseClient');
        const close = vi.fn();

        await expect(withDatabaseClient(
            APP_CONFIG,
            'analytics',
            'read',
            async () => {
                throw new Error(`${phase} failed`);
            },
            dependencies({
                loadClient: async () => ({ createClient: () => ({ close }) }),
            }),
        )).rejects.toBeDefined();

        expect(close).toHaveBeenCalledOnce();
    });
});

describe('database result normalization', () => {
    it('keeps integers exact and renders blobs without implementation-specific objects', async () => {
        const normalizeDatabaseValue = await requireExport('normalizeDatabaseValue');
        const formatDatabaseTableValue = await requireExport('formatDatabaseTableValue');
        const integer = 9_223_372_036_854_775_807n;
        const blob = new Uint8Array([0x00, 0xff, 0x10]).buffer;

        expect(normalizeDatabaseValue(integer)).toBe('9223372036854775807');
        expect(normalizeDatabaseValue(blob)).toEqual({ base64: 'AP8Q' });
        expect(formatDatabaseTableValue(integer)).toBe('9223372036854775807');
        expect(formatDatabaseTableValue(blob)).toBe('<blob 3 bytes>');
        expect(normalizeDatabaseValue(null)).toBeNull();
        expect(formatDatabaseTableValue(null)).toBe('NULL');
    });

    it('normalizes Buffer and offset views without encoding unrelated backing bytes', async () => {
        const normalizeDatabaseValue = await requireExport('normalizeDatabaseValue');
        const formatDatabaseTableValue = await requireExport('formatDatabaseTableValue');
        const buffer = Buffer.from([0x00, 0xff, 0x10]);
        const backing = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee]);
        const dataView = new DataView(backing.buffer, 1, 3);
        const slicedView = new Uint8Array(backing.buffer, 2, 2);

        expect(normalizeDatabaseValue(buffer)).toEqual({ base64: 'AP8Q' });
        expect(formatDatabaseTableValue(buffer)).toBe('<blob 3 bytes>');
        expect(normalizeDatabaseValue(dataView)).toEqual({ base64: 'u8zd' });
        expect(formatDatabaseTableValue(dataView)).toBe('<blob 3 bytes>');
        expect(normalizeDatabaseValue(slicedView)).toEqual({ base64: 'zN0=' });
        expect(formatDatabaseTableValue(slicedView)).toBe('<blob 2 bytes>');
    });
});

describe('database direct-client error boundary', () => {
    it.each(['connect', 'query', 'sync'])(
        'scrubs physical host, connection URL, and token from %s failures and public output',
        async (phase) => {
            const withDatabaseClient = await requireExport('withDatabaseClient');
            const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
            const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            let caught: any;
            let renderedOutput = '';

            try {
                await withDatabaseClient(
                    APP_CONFIG,
                    'analytics',
                    'read',
                    async () => {
                        throw new Error(
                            `${phase} failed for ${ACCESS.url} on physical-db.sentinel.invalid using ${ACCESS.token}`,
                        );
                    },
                    dependencies(),
                );
            } catch (error) {
                caught = error;
            } finally {
                renderedOutput = [
                    ...stdout.mock.calls.flat(),
                    ...stderr.mock.calls.flat(),
                ].map(String).join('\n');
                stdout.mockRestore();
                stderr.mockRestore();
            }

            const publicFailure = {
                code: caught?.code,
                message: caught?.message,
            };
            const serializedFailure = JSON.stringify(publicFailure);
            const forbidden = [ACCESS.url, 'physical-db.sentinel.invalid', ACCESS.token];

            expect(caught).toBeDefined();
            expect(publicFailure).toMatchInlineSnapshot(`
              {
                "code": "upstream_unavailable",
                "message": "Database operation failed.",
              }
            `);
            for (const sentinel of forbidden) {
                expect(renderedOutput).not.toContain(sentinel);
                expect(String(caught)).not.toContain(sentinel);
                expect(serializedFailure).not.toContain(sentinel);
            }
        },
    );
});

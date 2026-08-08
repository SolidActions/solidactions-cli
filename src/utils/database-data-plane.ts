import axios from 'axios';
import { augmentTokenMissingAbilityMessage, getApiHeaders } from './api';
import { Config } from './config';
import { loadDatabaseClientBeforeMint } from './database-client-support';

export type DatabaseAccessMode = 'read' | 'write';

export interface DatabaseAccess {
    url: string;
    token: string;
    mode: DatabaseAccessMode;
    expires_at: string;
}

export interface DatabaseResultSet {
    columns: Array<string>;
    rows: Array<ArrayLike<unknown>>;
    rowsAffected?: number;
    lastInsertRowid?: unknown;
}

interface DatabaseClientModule {
    createClient: (config: Record<string, unknown>) => DatabaseClient;
}

export interface DatabaseClient {
    execute: (statement: string | { sql: string; args?: unknown }) => Promise<DatabaseResultSet>;
    executeMultiple?: (sql: string) => Promise<void>;
    sync?: () => Promise<unknown>;
    close: () => void | Promise<void>;
    [key: string]: unknown;
}

export interface DatabaseRequestDependencies {
    controlPlaneTimeoutMs?: number;
    post?: (
        url: string,
        body: Record<string, unknown>,
        options: {
            headers: Record<string, string>;
            responseType?: 'stream';
            signal?: AbortSignal;
            timeout?: number;
        },
    ) => Promise<{ data: unknown; status?: number }>;
}

export interface DatabaseClientDependencies extends DatabaseRequestDependencies {
    dataPlaneTimeoutMs?: number;
    loadClient?: () => Promise<DatabaseClientModule>;
}

export const DEFAULT_DATABASE_CONTROL_PLANE_TIMEOUT_MS = 30_000;
export const DEFAULT_DATABASE_DATA_PLANE_TIMEOUT_MS = 120_000;

export class DatabaseOperationError extends Error {
    readonly code: string;
    readonly status?: number;

    constructor(code: string, message: string, status?: number) {
        super(message);
        this.code = code;
        if (status !== undefined) {
            this.status = status;
        }

        // A public command error is deliberately data-only. In particular, it
        // must never retain an upstream stack, request, response, config, or
        // cause that could contain either control- or data-plane credentials.
        delete this.stack;
    }
}

export function safeDatabaseRequestError(error: unknown): DatabaseOperationError {
    const augmented = augmentTokenMissingAbilityMessage(error);
    const response = (augmented as any)?.response;
    const status = typeof response?.status === 'number' ? response.status : undefined;
    const codeCandidate = typeof response?.data?.code === 'string'
        ? response.data.code.trim()
        : '';
    const stableCode = codeCandidate.length > 0 ? codeCandidate : null;
    const code = stableCode ?? 'upstream_unavailable';
    const appMessage = stableCode !== null
        && typeof response?.data?.message === 'string'
        && response.data.message.trim().length > 0
        ? response.data.message
        : 'Database request failed.';
    const message = code === 'unauthenticated'
        ? `${appMessage} Run solidactions login to authenticate again.`
        : appMessage;

    return new DatabaseOperationError(code, message, status);
}

function positiveTimeout(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : fallback;
}

class DatabaseDeadlineElapsed extends DatabaseOperationError {
    constructor(message: string) {
        super('upstream_unavailable', message);
    }
}

async function requestWithDeadline<T>(
    operation: (signal: AbortSignal, timeoutMs: number) => Promise<T>,
    timeoutMs: number,
): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new DatabaseDeadlineElapsed('Database request timed out.'));
        }, timeoutMs);
    });

    try {
        return await Promise.race([operation(controller.signal, timeoutMs), deadline]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Bound a Hrana operation and actively invoke its cancellation/close hook when
 * the deadline expires. Callers can inject a shorter timeout per command.
 */
export async function runDatabaseClientOperationWithDeadline<T>(
    operation: () => Promise<T>,
    onTimeout: (() => void | Promise<void>) | undefined,
    timeoutMs = DEFAULT_DATABASE_DATA_PLANE_TIMEOUT_MS,
): Promise<T> {
    const boundedTimeout = positiveTimeout(timeoutMs, DEFAULT_DATABASE_DATA_PLANE_TIMEOUT_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            try {
                void Promise.resolve(onTimeout?.()).catch(() => undefined);
            } finally {
                reject(new DatabaseDeadlineElapsed('Database operation timed out.'));
            }
        }, boundedTimeout);
    });

    try {
        return await Promise.race([Promise.resolve().then(operation), deadline]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Call the single CLI database control-plane endpoint and discard all Axios
 * transport state at the error boundary.
 */
export async function requestDatabaseOperation<T>(
    config: Config,
    body: Record<string, unknown>,
    dependencies: DatabaseRequestDependencies = {},
): Promise<T> {
    const post = dependencies.post ?? axios.post;
    const timeoutMs = positiveTimeout(
        dependencies.controlPlaneTimeoutMs,
        DEFAULT_DATABASE_CONTROL_PLANE_TIMEOUT_MS,
    );

    try {
        const response = await requestWithDeadline(
            (signal, timeout) => post(
                `${config.host}/api/v1/databases`,
                body,
                {
                    headers: getApiHeaders(config, 'application/json'),
                    signal,
                    timeout,
                },
            ),
            timeoutMs,
        );

        return response.data as T;
    } catch (error) {
        throw safeDatabaseRequestError(error);
    }
}

/** Request the existing server-side SQL dump as a stream. */
export async function requestDatabaseDumpStream(
    config: Config,
    name: string,
    dependencies: DatabaseRequestDependencies = {},
): Promise<unknown> {
    const post = dependencies.post ?? axios.post;
    const timeoutMs = positiveTimeout(
        dependencies.controlPlaneTimeoutMs,
        DEFAULT_DATABASE_CONTROL_PLANE_TIMEOUT_MS,
    );

    try {
        const response = await requestWithDeadline(
            (signal, timeout) => post(
                `${config.host}/api/v1/databases`,
                { operation: 'dump', name },
                {
                    headers: {
                        ...getApiHeaders(config, 'application/json'),
                        Accept: 'application/sql',
                    },
                    responseType: 'stream',
                    signal,
                    timeout,
                },
            ),
            timeoutMs,
        );

        return response.data;
    } catch (error) {
        throw safeDatabaseRequestError(error);
    }
}

function safeDirectClientError(): DatabaseOperationError {
    return new DatabaseOperationError('upstream_unavailable', 'Database operation failed.');
}

/**
 * Request a short-lived direct database credential from the app control plane.
 * Any Axios transport object is discarded at this boundary.
 */
export async function requestDatabaseAccess(
    config: Config,
    name: string,
    mode: DatabaseAccessMode,
    dependencies: DatabaseRequestDependencies = {},
): Promise<DatabaseAccess> {
    return requestDatabaseOperation<DatabaseAccess>(
        config,
        { operation: 'access', name, mode },
        dependencies,
    );
}

/**
 * Run one foreground operation with an ephemeral direct client. Native support
 * is loaded before access is minted, and the client is always closed once it
 * exists. Direct-client details are collapsed to a credential-safe error.
 */
export async function withDatabaseClient<T>(
    config: Config,
    name: string,
    mode: DatabaseAccessMode,
    operation: (client: DatabaseClient) => Promise<T>,
    dependencies: DatabaseClientDependencies = {},
): Promise<T> {
    const { createClient, access } = await loadDatabaseClientBeforeMint(
        () => requestDatabaseAccess(config, name, mode, {
            post: dependencies.post,
            controlPlaneTimeoutMs: dependencies.controlPlaneTimeoutMs,
        }),
        { loadClient: dependencies.loadClient },
    );

    let client: DatabaseClient;
    try {
        client = createClient({
            url: access.url,
            authToken: access.token,
            intMode: 'string',
        }) as DatabaseClient;
    } catch {
        throw safeDirectClientError();
    }

    const dataPlaneTimeoutMs = positiveTimeout(
        dependencies.dataPlaneTimeoutMs,
        DEFAULT_DATABASE_DATA_PLANE_TIMEOUT_MS,
    );
    let closePromise: Promise<void> | undefined;
    const closeClient = (): Promise<void> => {
        closePromise ??= runDatabaseClientOperationWithDeadline(
            async () => { await client.close(); },
            undefined,
            dataPlaneTimeoutMs,
        );
        return closePromise;
    };
    let primaryFailure: DatabaseOperationError | undefined;
    try {
        return await runDatabaseClientOperationWithDeadline(
            () => operation(client),
            closeClient,
            dataPlaneTimeoutMs,
        );
    } catch (error) {
        primaryFailure = error instanceof DatabaseDeadlineElapsed
            ? new DatabaseOperationError(error.code, error.message, error.status)
            : safeDirectClientError();
        throw primaryFailure;
    } finally {
        try {
            await closeClient();
        } catch {
            if (!primaryFailure) {
                throw safeDirectClientError();
            }
        }
    }
}

function blobBytes(value: unknown): Uint8Array | null {
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }

    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }

    return null;
}

/** Normalize direct-client values into the stable JSON contract. */
export function normalizeDatabaseValue(value: unknown): unknown {
    if (typeof value === 'bigint') {
        return value.toString(10);
    }

    const bytes = blobBytes(value);
    if (bytes) {
        return { base64: Buffer.from(bytes).toString('base64') };
    }

    return value;
}

/** Render one direct-client value as a concise, implementation-neutral cell. */
export function formatDatabaseTableValue(value: unknown): string {
    if (value === null) {
        return 'NULL';
    }

    if (typeof value === 'bigint') {
        return value.toString(10);
    }

    const bytes = blobBytes(value);
    if (bytes) {
        return `<blob ${bytes.byteLength} bytes>`;
    }

    return String(value);
}

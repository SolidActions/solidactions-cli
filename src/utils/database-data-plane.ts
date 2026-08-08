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
    close: () => void | Promise<void>;
    [key: string]: unknown;
}

export interface DatabaseRequestDependencies {
    post?: (
        url: string,
        body: Record<string, unknown>,
        options: { headers: Record<string, string> },
    ) => Promise<{ data: unknown }>;
}

export interface DatabaseClientDependencies extends DatabaseRequestDependencies {
    loadClient?: () => Promise<DatabaseClientModule>;
}

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

function safeAppError(error: unknown): DatabaseOperationError {
    const augmented = augmentTokenMissingAbilityMessage(error);
    const response = (augmented as any)?.response;
    const status = typeof response?.status === 'number' ? response.status : undefined;
    const codeCandidate = typeof response?.data?.code === 'string'
        ? response.data.code.trim()
        : '';
    const stableCode = codeCandidate.length > 0 ? codeCandidate : null;
    const code = stableCode ?? 'upstream_unavailable';
    const message = stableCode !== null
        && typeof response?.data?.message === 'string'
        && response.data.message.trim().length > 0
        ? response.data.message
        : 'Database request failed.';

    return new DatabaseOperationError(code, message, status);
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

    try {
        const response = await post(
            `${config.host}/api/v1/databases`,
            body,
            { headers: getApiHeaders(config, 'application/json') },
        );

        return response.data as T;
    } catch (error) {
        throw safeAppError(error);
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
        () => requestDatabaseAccess(config, name, mode, { post: dependencies.post }),
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

    let primaryFailure: DatabaseOperationError | undefined;
    try {
        return await operation(client);
    } catch {
        primaryFailure = safeDirectClientError();
        throw primaryFailure;
    } finally {
        try {
            await client.close();
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

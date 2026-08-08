import * as readline from 'readline';
import { requireConfigWithWorkspace } from '../utils/api';
import { Config } from '../utils/config';
import {
    DatabaseOperationError,
    DatabaseRequestDependencies,
    requestDatabaseOperation,
} from '../utils/database-data-plane';
import { renderTable } from '../utils/table';

export interface DatabaseRecord {
    name: string;
    status: string;
    deleted_at: string | null;
    purge_at: string | null;
    size_bytes: number;
}

interface DatabaseListResponse {
    databases: DatabaseRecord[];
    quota: {
        used: number;
        limit: number;
    };
}

interface DatabaseMutationResponse {
    database: DatabaseRecord;
}

interface DatabaseListOptions {
    json?: boolean;
}

interface DatabaseCreateOptions {
    from?: string;
    json?: boolean;
}

interface DatabaseDeleteOptions {
    yes?: boolean;
    json?: boolean;
}

interface DatabaseUndeleteOptions {
    json?: boolean;
}

export interface DatabaseCommandDependencies extends DatabaseRequestDependencies {
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
    confirm?: (message: string) => Promise<boolean | undefined>;
    isTTY?: boolean;
    importDatabase?: (name: string, file: string) => Promise<void>;
}

interface ResolvedCommandDependencies {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
    confirm: (message: string) => Promise<boolean>;
    isTTY: boolean;
    importDatabase: (name: string, file: string) => Promise<void>;
    post: DatabaseCommandDependencies['post'];
}

function defaultConfirmation(message: string): Promise<boolean> {
    const input = readline.createInterface({ input: process.stdin, output: process.stdout });

    return new Promise((resolve) => {
        let settled = false;
        const finish = (confirmed: boolean) => {
            if (settled) return;
            settled = true;
            resolve(confirmed);
        };

        input.once('close', () => finish(false));
        input.question(`${message} [y/N] `, (answer) => {
            finish(/^y(?:es)?$/i.test(answer.trim()));
            input.close();
        });
    });
}

async function unavailableImportHandoff(name: string, _file: string): Promise<void> {
    throw new DatabaseOperationError(
        'import_failed',
        `Database "${name}" was created, but SQL import is not available yet. The database remains in place.`,
    );
}

function resolveDependencies(dependencies: DatabaseCommandDependencies): ResolvedCommandDependencies {
    return {
        stdout: dependencies.stdout ?? ((line) => console.log(line)),
        stderr: dependencies.stderr ?? ((line) => console.error(line)),
        confirm: async (message) => (await (dependencies.confirm ?? defaultConfirmation)(message)) === true,
        isTTY: dependencies.isTTY ?? process.stdin.isTTY === true,
        importDatabase: dependencies.importDatabase ?? unavailableImportHandoff,
        post: dependencies.post,
    };
}

function requestDependencies(dependencies: ResolvedCommandDependencies): DatabaseRequestDependencies {
    return { post: dependencies.post };
}

function stableDatabaseRecord(database: DatabaseRecord | null | undefined): DatabaseRecord {
    if (
        !database
        || typeof database.name !== 'string'
        || typeof database.status !== 'string'
        || typeof database.size_bytes !== 'number'
        || (database.deleted_at !== null && typeof database.deleted_at !== 'string')
        || (database.purge_at !== null && typeof database.purge_at !== 'string')
    ) {
        throw new DatabaseOperationError('upstream_unavailable', 'The database response was invalid.');
    }

    return {
        name: database.name,
        status: database.status,
        deleted_at: database.deleted_at,
        purge_at: database.purge_at,
        size_bytes: database.size_bytes,
    };
}

function stableDatabaseResponse(data: DatabaseMutationResponse): DatabaseMutationResponse {
    return { database: stableDatabaseRecord(data?.database) };
}

function stableListResponse(data: DatabaseListResponse): DatabaseListResponse {
    if (
        !data
        || !Array.isArray(data.databases)
        || typeof data.quota?.used !== 'number'
        || typeof data.quota?.limit !== 'number'
    ) {
        throw new DatabaseOperationError('upstream_unavailable', 'The database response was invalid.');
    }

    return {
        databases: data.databases.map(stableDatabaseRecord),
        quota: {
            used: data.quota.used,
            limit: data.quota.limit,
        },
    };
}

function databaseRows(databases: DatabaseRecord[]): string[][] {
    return databases.map((database) => [
        database.name,
        database.status,
        String(database.size_bytes),
        database.deleted_at ?? '-',
        database.purge_at ?? '-',
    ]);
}

function renderDatabaseTable(databases: DatabaseRecord[]): string {
    return renderTable(
        ['NAME', 'STATUS', 'SIZE (BYTES)', 'DELETED AT', 'PURGE AT'],
        databaseRows(databases),
    ).join('\n');
}

function renderMutation(
    operation: 'create' | 'delete' | 'undelete',
    database: DatabaseRecord,
): string {
    const verb = operation === 'create'
        ? 'created'
        : operation === 'delete'
            ? 'deleted'
            : 'restored';

    return `Database "${database.name}" ${verb}.\n${renderDatabaseTable([database])}`;
}

function writeJson(stdout: (line: string) => void, data: unknown): void {
    stdout(JSON.stringify(data, null, 2));
}

export async function databaseListWithConfig(
    options: DatabaseListOptions,
    config: Config,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    const io = resolveDependencies(dependencies);
    const data = stableListResponse(await requestDatabaseOperation<DatabaseListResponse>(
        config,
        { operation: 'list' },
        requestDependencies(io),
    ));

    if (options.json) {
        writeJson(io.stdout, data);
        return;
    }

    io.stdout(`${renderDatabaseTable(data.databases)}\nQuota: ${data.quota.used} / ${data.quota.limit}`);
}

export async function databaseCreateWithConfig(
    name: string,
    options: DatabaseCreateOptions,
    config: Config,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    const io = resolveDependencies(dependencies);
    const data = stableDatabaseResponse(await requestDatabaseOperation<DatabaseMutationResponse>(
        config,
        { operation: 'create', name },
        requestDependencies(io),
    ));

    if (options.from) {
        try {
            await io.importDatabase(data.database.name, options.from);
        } catch {
            throw new DatabaseOperationError(
                'import_failed',
                `Database "${data.database.name}" was created, but its SQL import failed. The database remains in place.`,
            );
        }
    }

    if (options.json) {
        writeJson(io.stdout, data);
        return;
    }

    io.stdout(renderMutation('create', data.database));
}

export async function databaseDeleteWithConfig(
    name: string,
    options: DatabaseDeleteOptions,
    config: Config,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    const io = resolveDependencies(dependencies);

    if (!options.yes) {
        if (options.json || !io.isTTY) {
            throw new DatabaseOperationError(
                'confirmation_required',
                'Database deletion requires --yes in JSON or non-interactive mode.',
            );
        }

        if (!await io.confirm(`Delete database "${name}"?`)) {
            io.stdout('Cancelled.');
            return;
        }
    }

    const data = stableDatabaseResponse(await requestDatabaseOperation<DatabaseMutationResponse>(
        config,
        { operation: 'delete', name },
        requestDependencies(io),
    ));

    if (options.json) {
        writeJson(io.stdout, data);
        return;
    }

    io.stdout(renderMutation('delete', data.database));
}

export async function databaseUndeleteWithConfig(
    name: string,
    options: DatabaseUndeleteOptions,
    config: Config,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    const io = resolveDependencies(dependencies);
    const data = stableDatabaseResponse(await requestDatabaseOperation<DatabaseMutationResponse>(
        config,
        { operation: 'undelete', name },
        requestDependencies(io),
    ));

    if (options.json) {
        writeJson(io.stdout, data);
        return;
    }

    io.stdout(renderMutation('undelete', data.database));
}

export async function databaseList(
    options: DatabaseListOptions,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    await databaseListWithConfig(options, await requireConfigWithWorkspace(), dependencies);
}

export async function databaseCreate(
    name: string,
    options: DatabaseCreateOptions,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    await databaseCreateWithConfig(name, options, await requireConfigWithWorkspace(), dependencies);
}

export async function databaseDelete(
    name: string,
    options: DatabaseDeleteOptions,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    await databaseDeleteWithConfig(name, options, await requireConfigWithWorkspace(), dependencies);
}

export async function databaseUndelete(
    name: string,
    options: DatabaseUndeleteOptions,
    dependencies: DatabaseCommandDependencies = {},
): Promise<void> {
    await databaseUndeleteWithConfig(name, options, await requireConfigWithWorkspace(), dependencies);
}

interface DatabaseClientModule {
    createClient: (...args: any[]) => any;
}

interface DatabaseClientSupportDependencies {
    loadClient?: () => Promise<DatabaseClientModule>;
}

export class DatabaseClientUnsupportedError extends Error {
    readonly code = 'database_client_unsupported';

    constructor() {
        super('Database commands are not supported on this platform.');
        this.name = 'DatabaseClientUnsupportedError';
    }
}

/**
 * Load the native-capable client module before requesting a short-lived
 * credential. Import and binding failures are deliberately collapsed to a
 * stable product error so low-level module paths and implementation details do
 * not reach users. Mint failures are left untouched for the API error mapper.
 */
export async function loadDatabaseClientBeforeMint<T>(
    mintAccess: () => Promise<T>,
    dependencies: DatabaseClientSupportDependencies = {},
): Promise<{ createClient: DatabaseClientModule['createClient']; access: T }> {
    let clientModule: DatabaseClientModule;

    try {
        clientModule = await (dependencies.loadClient ?? (() => import('@libsql/client')))();
        if (typeof clientModule.createClient !== 'function') {
            throw new Error('Database client factory is unavailable.');
        }
    } catch {
        throw new DatabaseClientUnsupportedError();
    }

    const access = await mintAccess();

    return {
        createClient: clientModule.createClient,
        access,
    };
}

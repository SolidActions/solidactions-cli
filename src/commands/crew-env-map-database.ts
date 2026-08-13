import axios from 'axios';
import chalk from 'chalk';
import { formatValidationError, getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { resolveCrewId } from '../utils/crew';
import { requestDatabaseOperation } from '../utils/database-data-plane';
import { envNameError, isReservedEnvName, isValidEnvName, reservedEnvNameError } from '../utils/env';

export const CREW_DATABASE_SCOPE_WARNING = 'Applies to production, staging, and dev crew sandboxes';

export interface WorkspaceDatabaseListRecord {
    id: string;
    name: string;
    status: string;
    deleted_at: string | null;
}

interface WorkspaceDatabaseListResponse {
    databases: WorkspaceDatabaseListRecord[];
}

export function matchWorkspaceDatabase(
    input: string,
    databases: WorkspaceDatabaseListRecord[],
): WorkspaceDatabaseListRecord | null {
    return databases.find((database) => (
        database.deleted_at === null
        && database.status === 'ready'
        && (database.id === input || database.name.toLowerCase() === input.toLowerCase())
    )) ?? null;
}

export async function crewEnvMapDatabase(
    crewArg: string,
    key: string,
    databaseArg: string,
): Promise<void> {
    if (!isValidEnvName(key)) {
        console.error(chalk.red(envNameError(key)));
        process.exit(1);
    }
    if (isReservedEnvName(key)) {
        console.error(chalk.red(reservedEnvNameError(key)));
        process.exit(1);
    }

    const config = await requireConfigWithWorkspace();
    const crew = await resolveCrewId(config, crewArg);

    try {
        const result = await requestDatabaseOperation<WorkspaceDatabaseListResponse>(
            config,
            { operation: 'list' },
        );
        const database = matchWorkspaceDatabase(databaseArg, result.databases ?? []);
        if (!database) {
            console.error(chalk.red(`Ready database "${databaseArg}" not found in this workspace.`));
            process.exit(1);
        }

        await axios.put(
            `${config.host}/api/v1/crews/${crew.id}/variables/${key}`,
            {
                source_type: 'workspace_database',
                workspace_database_id: database.id,
            },
            { headers: getApiHeaders(config, 'application/json') },
        );

        console.log(chalk.green(`Database "${database.name}" mapped to "${key}" for crew "${crew.name}".`));
        console.log(chalk.yellow(CREW_DATABASE_SCOPE_WARNING));
    } catch (error: any) {
        if (error.response?.status === 422) {
            console.error(chalk.red(formatValidationError(error.response.data)));
        } else if (typeof error.message === 'string') {
            console.error(chalk.red(error.message));
        } else {
            console.error(chalk.red('Failed to map the workspace database.'));
        }
        process.exit(1);
    }
}

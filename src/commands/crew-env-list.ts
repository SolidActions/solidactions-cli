import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { resolveCrewId } from '../utils/crew';

export interface CrewEnvListOptions {
    json?: boolean;
}

interface CrewVariable {
    id: number | string;
    env_name: string;
    is_secret: boolean;
    production_value: string | null;
    staging_value: string | null;
    dev_value: string | null;
    source_type?: string;
    workspace_database_name?: string | null;
    token?: string;
}

/**
 * Format a value for display. A null/undefined value means the env is
 * unset and always renders as '-'. Otherwise, a secret's value is ALWAYS
 * masked with a fixed placeholder — regardless of what the server sent —
 * so a server-side masking bug can never leak a raw secret into stdout.
 */
export function formatValue(value: string | null, isSecret: boolean): string {
    if (value === null || value === undefined) {
        return chalk.gray('-');
    }
    if (isSecret) {
        return chalk.yellow('••••••');
    }
    return value.substring(0, 18);
}

export async function crewEnvList(crewArg: string, options: CrewEnvListOptions = {}): Promise<void> {
    const config = await requireConfigWithWorkspace();
    const crew = await resolveCrewId(config, crewArg);

    try {
        const response = await axios.get(`${config.host}/api/v1/crews/${crew.id}/variables`, {
            headers: getApiHeaders(config),
        });
        const variables: CrewVariable[] = response.data?.data ?? [];

        if (options.json) {
            const safeVariables = variables.map((variable) => {
                if (variable.source_type !== 'workspace_database') {
                    return variable;
                }

                const {
                    production_value: _productionValue,
                    staging_value: _stagingValue,
                    dev_value: _devValue,
                    token: _token,
                    ...metadata
                } = variable;

                return metadata;
            });
            console.log(JSON.stringify(safeVariables, null, 2));
            return;
        }

        console.log(chalk.blue(`Variables for crew "${crew.name}":`));

        if (variables.length === 0) {
            console.log(chalk.gray('No variables found.'));
            return;
        }

        console.log('');
        console.log(chalk.gray(
            'KEY'.padEnd(24) +
            chalk.green('PRODUCTION').padEnd(20) +
            chalk.yellow('STAGING').padEnd(20) +
            chalk.blue('DEV').padEnd(20) +
            'TYPE'
        ));
        console.log(chalk.gray('-'.repeat(100)));

        for (const variable of variables) {
            const key = variable.env_name || '?';
            const isDatabase = variable.source_type === 'workspace_database';
            const type = isDatabase
                ? chalk.blue(`database:${variable.workspace_database_name ?? 'not-configured'}`)
                : variable.is_secret ? chalk.yellow('secret') : chalk.gray('plain');

            console.log(
                key.substring(0, 22).padEnd(24) +
                (isDatabase ? chalk.gray('-') : formatValue(variable.production_value, variable.is_secret)).padEnd(20) +
                (isDatabase ? chalk.gray('-') : formatValue(variable.staging_value, variable.is_secret)).padEnd(20) +
                (isDatabase ? chalk.gray('-') : formatValue(variable.dev_value, variable.is_secret)).padEnd(20) +
                type
            );
        }

        console.log('');
        console.log(chalk.gray(`${variables.length} variable(s)`));
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions login --global" to re-configure.'));
            } else if (error.response.status === 404) {
                console.error(chalk.red(error.response.data?.message || `Crew "${crewArg}" not found.`));
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

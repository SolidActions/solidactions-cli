import axios from 'axios';
import chalk from 'chalk';
import { formatValidationError, getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { crewEnvError, isValidCrewEnv, resolveCrewId } from '../utils/crew';
import { envNameError, isReservedEnvName, isValidEnvName, reservedEnvNameError } from '../utils/env';

export interface CrewEnvSetOptions {
    env?: string;
    /** Commander --no-secret negation: undefined/true = secret (default), false = plain. */
    secret?: boolean;
}

type CrewEnvValueLike = 'production' | 'staging' | 'dev' | 'all';

/**
 * Maps a --env selection + value into the PUT body's column shape
 * (mirrors GlobalVariableController's columns). `all` (the default) writes
 * the same value to all three environments; staging/dev sources are always
 * 'value' since the CLI never sets inheritance.
 */
export function buildVariableBody(environment: CrewEnvValueLike, value: string, isSecret: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = { is_secret: isSecret };

    if (environment === 'production' || environment === 'all') {
        body.production_value = value;
    }
    if (environment === 'staging' || environment === 'all') {
        body.staging_value = value;
        body.staging_source = 'value';
    }
    if (environment === 'dev' || environment === 'all') {
        body.dev_value = value;
        body.dev_source = 'value';
    }

    return body;
}

export async function crewEnvSet(crewArg: string, key: string, value: string, options: CrewEnvSetOptions = {}): Promise<void> {
    if (!isValidEnvName(key)) {
        console.error(chalk.red(envNameError(key)));
        process.exit(1);
    }
    if (isReservedEnvName(key)) {
        console.error(chalk.red(reservedEnvNameError(key)));
        process.exit(1);
    }

    const environment = options.env || 'all';
    if (!isValidCrewEnv(environment)) {
        console.error(chalk.red(crewEnvError(environment)));
        process.exit(1);
    }

    const config = await requireConfigWithWorkspace();
    const crew = await resolveCrewId(config, crewArg);

    // Secrets are the default for crew variables (deliberately unlike
    // project `env set`'s regex heuristic) — --no-secret opts out.
    const isSecret = options.secret !== false;
    const body = buildVariableBody(environment, value, isSecret);

    try {
        await axios.put(
            `${config.host}/api/v1/crews/${crew.id}/variables/${key}`,
            body,
            { headers: getApiHeaders(config, 'application/json') },
        );
        console.log(chalk.green(`Variable "${key}" set for crew "${crew.name}" (${environment}).`));
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions login --global" to re-configure.'));
            } else if (error.response.status === 404) {
                console.error(chalk.red(error.response.data?.message || `Crew "${crewArg}" not found.`));
            } else if (error.response.status === 422) {
                console.error(chalk.red(formatValidationError(error.response.data)));
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

import axios from 'axios';
import chalk from 'chalk';
import prompts from 'prompts';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { resolveCrewId } from '../utils/crew';

export interface CrewEnvDeleteOptions {
    yes?: boolean;
}

export async function crewEnvDelete(crewArg: string, key: string, options: CrewEnvDeleteOptions = {}): Promise<void> {
    const config = await requireConfigWithWorkspace();
    const crew = await resolveCrewId(config, crewArg);

    if (!options.yes) {
        const response = await prompts({
            type: 'confirm',
            name: 'confirm',
            message: `Delete variable "${key}" from crew "${crew.name}"?`,
            initial: false,
        });

        if (!response.confirm) {
            console.log(chalk.gray('Cancelled.'));
            return;
        }
    }

    try {
        const response = await axios.delete(`${config.host}/api/v1/crews/${crew.id}/variables/${key}`, {
            headers: getApiHeaders(config),
        });
        console.log(chalk.green(response.data?.message || `Variable "${key}" deleted from crew "${crew.name}".`));
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions login --global" to re-configure.'));
            } else if (error.response.status === 404) {
                console.error(chalk.red(error.response.data?.message || `Variable "${key}" not found for crew "${crew.name}".`));
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

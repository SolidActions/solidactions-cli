import axios from 'axios';
import chalk from 'chalk';
import prompts from 'prompts';
import { describeProjectEnvironments, getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

export async function envDelete(keyOrProject: string, keyIfProject?: string, options: { yes?: boolean; env?: string } = {}) {
    const config = await requireConfigWithWorkspace();

    // Determine mode: if keyIfProject is provided, it's project mapping delete
    const isProjectMode = keyIfProject !== undefined;
    const projectName = isProjectMode ? keyOrProject : undefined;
    const key = isProjectMode ? keyIfProject : keyOrProject;
    const environment = options.env ?? 'dev';
    const projectSlug = projectName && environment === 'production' ? projectName : `${projectName}-${environment}`;

    try {
        if (isProjectMode) {
            // Delete project variable
            console.log(chalk.blue(`Deleting variable "${key}" from project "${projectName}" (${environment})...`));

            // First, get the variable to find its ID
            const listResponse = await axios.get(`${config.host}/api/v1/projects/${projectSlug}/variable-mappings`, {
                headers: getApiHeaders(config),
            });

            const mappings = listResponse.data || [];
            const mapping = mappings.find((m: any) => m.env_name === key);

            if (!mapping) {
                console.error(chalk.red(`Variable "${key}" not found in project "${projectName}" (${environment}).`));
                process.exit(1);
            }

            // Confirm deletion unless --yes flag is provided
            if (!options.yes) {
                const response = await prompts({
                    type: 'confirm',
                    name: 'confirm',
                    message: mapping.is_yaml_declared
                        ? `Clear YAML-declared variable "${key}"? (The mapping will be preserved but value cleared)`
                        : `Delete variable "${key}" from project "${projectName}" (${environment})?`,
                    initial: false,
                });

                if (!response.confirm) {
                    console.log(chalk.gray('Cancelled.'));
                    return;
                }
            }

            // Delete the mapping
            await axios.delete(`${config.host}/api/v1/projects/${projectSlug}/variable-mappings/${mapping.id}`, {
                headers: getApiHeaders(config),
            });

            if (mapping.is_yaml_declared) {
                console.log(chalk.green(`Variable "${key}" cleared successfully.`));
            } else {
                console.log(chalk.green(`Variable "${key}" deleted successfully.`));
            }
        } else {
            // Delete global variable
            console.log(chalk.blue(`Deleting global variable "${key}"...`));

            // First, get the variable to find its ID
            const listResponse = await axios.get(`${config.host}/api/v1/variables`, {
                headers: getApiHeaders(config),
            });

            const variables = listResponse.data?.data || [];
            const variable = variables.find((v: any) => v.key === key);

            if (!variable) {
                console.error(chalk.red(`Global variable "${key}" not found.`));
                process.exit(1);
            }

            // Confirm deletion unless --yes flag is provided
            if (!options.yes) {
                const response = await prompts({
                    type: 'confirm',
                    name: 'confirm',
                    message: `Delete global variable "${key}"? This may affect projects using this variable.`,
                    initial: false,
                });

                if (!response.confirm) {
                    console.log(chalk.gray('Cancelled.'));
                    return;
                }
            }

            // Delete the variable
            await axios.delete(`${config.host}/api/v1/variables/${variable.id}`, {
                headers: getApiHeaders(config),
            });

            console.log(chalk.green(`Global variable "${key}" deleted successfully.`));
        }
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions login --global" to re-configure.'));
            } else if (error.response.status === 404) {
                if (isProjectMode) {
                    const envsList = await describeProjectEnvironments(config, projectName!);
                    console.error(chalk.red(`Project "${projectName}" has no ${environment} environment${envsList ? ` (exists in: ${envsList})` : ''}.`));
                } else {
                    console.error(chalk.red(`Variable "${key}" not found.`));
                }
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

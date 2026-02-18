import axios from 'axios';
import chalk from 'chalk';
import prompts from 'prompts';
import { getConfig } from './init';

export async function envDelete(keyOrProject: string, keyIfProject?: string, options: { yes?: boolean } = {}) {
    const config = getConfig();
    if (!config?.apiKey) {
        console.error(chalk.red('Not initialized. Run "solidactions init <api-key>" first.'));
        process.exit(1);
    }

    // Determine mode: if keyIfProject is provided, it's project mapping delete
    const isProjectMode = keyIfProject !== undefined;
    const projectName = isProjectMode ? keyOrProject : undefined;
    const key = isProjectMode ? keyIfProject : keyOrProject;

    try {
        if (isProjectMode) {
            // Delete project variable mapping
            console.log(chalk.blue(`Deleting variable mapping "${key}" from project "${projectName}"...`));

            // First, get the mapping to find its ID
            const listResponse = await axios.get(`${config.host}/api/v1/projects/${projectName}/variable-mappings`, {
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                    'Accept': 'application/json',
                },
            });

            const mappings = listResponse.data || [];
            const mapping = mappings.find((m: any) => m.env_name === key);

            if (!mapping) {
                console.error(chalk.red(`Variable mapping "${key}" not found in project "${projectName}".`));
                process.exit(1);
            }

            // Confirm deletion unless --yes flag is provided
            if (!options.yes) {
                const response = await prompts({
                    type: 'confirm',
                    name: 'confirm',
                    message: mapping.is_yaml_declared
                        ? `Clear YAML-declared variable "${key}"? (The mapping will be preserved but value cleared)`
                        : `Delete variable mapping "${key}" from project "${projectName}"?`,
                    initial: false,
                });

                if (!response.confirm) {
                    console.log(chalk.gray('Cancelled.'));
                    return;
                }
            }

            // Delete the mapping
            await axios.delete(`${config.host}/api/v1/projects/${projectName}/variable-mappings/${mapping.id}`, {
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                    'Accept': 'application/json',
                },
            });

            if (mapping.is_yaml_declared) {
                console.log(chalk.green(`Variable mapping "${key}" cleared successfully.`));
            } else {
                console.log(chalk.green(`Variable mapping "${key}" deleted successfully.`));
            }
        } else {
            // Delete global variable
            console.log(chalk.blue(`Deleting global variable "${key}"...`));

            // First, get the variable to find its ID
            const listResponse = await axios.get(`${config.host}/api/v1/variables`, {
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                    'Accept': 'application/json',
                },
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
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                    'Accept': 'application/json',
                },
            });

            console.log(chalk.green(`Global variable "${key}" deleted successfully.`));
        }
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions init <api-key>" to re-configure.'));
            } else if (error.response.status === 404) {
                console.error(chalk.red(isProjectMode ? `Project "${projectName}" not found.` : `Variable "${key}" not found.`));
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

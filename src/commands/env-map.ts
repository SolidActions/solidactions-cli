import axios from 'axios';
import chalk from 'chalk';
import prompts from 'prompts';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

export async function envMap(projectName: string, projectKey: string, globalKey: string, options: { yes?: boolean } = {}) {
    const config = await requireConfigWithWorkspace();

    console.log(chalk.blue(`Mapping global variable "${globalKey}" to project key "${projectKey}" in "${projectName}"...`));

    try {
        // First, get the global variable ID by key
        const varsResponse = await axios.get(`${config.host}/api/v1/variables`, {
            headers: getApiHeaders(config),
        });

        const variables = varsResponse.data.data || varsResponse.data;
        const globalVar = variables.find((v: any) => v.key === globalKey);

        if (!globalVar) {
            console.error(chalk.red(`Global variable "${globalKey}" not found.`));
            console.log(chalk.gray('Create it with: solidactions env set ' + globalKey + ' <value>'));
            process.exit(1);
        }

        // Check if project key already has a mapping
        if (!options.yes) {
            const mappingsResponse = await axios.get(
                `${config.host}/api/v1/projects/${projectName}/variable-mappings`,
                { headers: getApiHeaders(config) }
            );
            const mappings = mappingsResponse.data || [];
            const existing = mappings.find((m: any) => m.env_name === projectKey);

            if (existing && (existing.has_value || existing.global_variable_id)) {
                const currentSource = existing.global_variable_id
                    ? `mapped to global "${existing.global_variable_key || 'unknown'}"`
                    : 'has a local value';
                console.log(chalk.yellow(`"${projectKey}" already ${currentSource} in "${projectName}".`));
                const confirm = await prompts({
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Overwrite mapping?',
                    initial: false,
                });
                if (!confirm.proceed) {
                    console.log(chalk.gray('Cancelled.'));
                    return;
                }
            }
        }

        // Create the mapping
        await axios.post(`${config.host}/api/v1/projects/${projectName}/variable-mappings`, {
            project_key: projectKey,
            global_variable_id: globalVar.id,
        }, {
            headers: getApiHeaders(config, 'application/json'),
        });

        console.log(chalk.green(`Variable mapping created!`));
        console.log(chalk.gray(`  ${globalKey} -> ${projectKey} (in ${projectName})`));
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions login <api-key>" to re-configure.'));
            } else if (error.response.status === 404) {
                console.error(chalk.red(`Project "${projectName}" not found.`));
            } else if (error.response.status === 422) {
                console.error(chalk.red('Validation error:'), error.response.data.message || error.response.data.errors);
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

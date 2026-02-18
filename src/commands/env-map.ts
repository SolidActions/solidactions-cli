import axios from 'axios';
import chalk from 'chalk';
import { getConfig } from './init';

export async function envMap(projectName: string, projectKey: string, globalKey: string) {
    const config = getConfig();
    if (!config?.apiKey) {
        console.error(chalk.red('Not initialized. Run "solidactions init <api-key>" first.'));
        process.exit(1);
    }

    console.log(chalk.blue(`Mapping global variable "${globalKey}" to project key "${projectKey}" in "${projectName}"...`));

    try {
        // First, get the global variable ID by key
        const varsResponse = await axios.get(`${config.host}/api/v1/variables`, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
            },
        });

        const variables = varsResponse.data.data || varsResponse.data;
        const globalVar = variables.find((v: any) => v.key === globalKey);

        if (!globalVar) {
            console.error(chalk.red(`Global variable "${globalKey}" not found.`));
            console.log(chalk.gray('Create it with: solidactions env:create ' + globalKey + ' <value>'));
            process.exit(1);
        }

        // Create the mapping
        await axios.post(`${config.host}/api/v1/projects/${projectName}/variable-mappings`, {
            project_key: projectKey,
            global_variable_id: globalVar.id,
        }, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
        });

        console.log(chalk.green(`Variable mapping created!`));
        console.log(chalk.gray(`  ${globalKey} -> ${projectKey} (in ${projectName})`));
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions init <api-key>" to re-configure.'));
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

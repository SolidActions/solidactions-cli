import axios from 'axios';
import chalk from 'chalk';
import { getConfig } from './init';

interface EnvSetOptions {
    secret?: boolean;
    env?: string;
}

export async function envSet(keyOrProject: string, valueOrKey?: string, valueIfProject?: string, options: EnvSetOptions = {}): Promise<void> {
    const config = getConfig();
    if (!config?.apiKey) {
        console.error(chalk.red('Not initialized. Run "solidactions init <api-key>" first.'));
        process.exit(1);
    }

    // Detect mode based on arguments
    const isProjectMode = valueIfProject !== undefined;

    if (isProjectMode) {
        // Project mode: solidactions env:set <project> <key> <value>
        const projectName = keyOrProject;
        const key = valueOrKey!;
        const value = valueIfProject;
        const environment = options.env || 'dev';

        // Build project slug
        const projectSlug = environment === 'production'
            ? projectName
            : `${projectName}-${environment}`;

        // Auto-detect secrets
        const isSecret = options.secret || /secret|key|token|password|credential/i.test(key);

        try {
            // Use bulk endpoint for upsert
            const response = await axios.post(
                `${config.host}/api/v1/projects/${projectSlug}/variable-mappings/bulk`,
                {
                    variables: [{
                        key,
                        value,
                        is_secret: isSecret,
                    }]
                },
                {
                    headers: {
                        'Authorization': `Bearer ${config.apiKey}`,
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                    },
                }
            );

            const { created, updated } = response.data;
            const action = created > 0 ? 'created' : 'updated';
            console.log(chalk.green(`Variable "${key}" ${action} in project "${projectName}" (${environment}).`));
        } catch (error: any) {
            if (error.response) {
                if (error.response.status === 401) {
                    console.error(chalk.red('Authentication failed. Run "solidactions init <api-key>" to re-configure.'));
                } else if (error.response.status === 404) {
                    console.error(chalk.red(`Project "${projectSlug}" not found.`));
                } else if (error.response.status === 422) {
                    console.error(chalk.red('Validation error:'), error.response.data);
                } else {
                    console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
                }
            } else {
                console.error(chalk.red('Connection failed:'), error.message);
            }
            process.exit(1);
        }
    } else {
        // Global mode: solidactions env:set <key> <value>
        const key = keyOrProject;
        const value = valueOrKey!;
        const isSecret = options.secret || false;

        try {
            // Check if variable already exists
            const getResponse = await axios.get(`${config.host}/api/v1/variables`, {
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                    'Accept': 'application/json',
                },
            });

            const variables = getResponse.data?.data || [];
            const existing = variables.find((v: any) => v.key === key);

            let action: string;

            if (existing) {
                // Update existing variable
                await axios.put(
                    `${config.host}/api/v1/variables/${existing.id}`,
                    {
                        key,
                        production_value: value,
                        is_secret: isSecret,
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${config.apiKey}`,
                            'Accept': 'application/json',
                            'Content-Type': 'application/json',
                        },
                    }
                );
                action = 'updated';
            } else {
                // Create new variable
                await axios.post(
                    `${config.host}/api/v1/variables`,
                    {
                        key,
                        production_value: value,
                        is_secret: isSecret,
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${config.apiKey}`,
                            'Accept': 'application/json',
                            'Content-Type': 'application/json',
                        },
                    }
                );
                action = 'created';
            }

            console.log(chalk.green(`Global variable "${key}" ${action} successfully.`));
        } catch (error: any) {
            if (error.response) {
                if (error.response.status === 401) {
                    console.error(chalk.red('Authentication failed. Run "solidactions init <api-key>" to re-configure.'));
                } else if (error.response.status === 422) {
                    console.error(chalk.red('Validation error:'), error.response.data);
                } else {
                    console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
                }
            } else {
                console.error(chalk.red('Connection failed:'), error.message);
            }
            process.exit(1);
        }
    }
}

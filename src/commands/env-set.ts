import axios from 'axios';
import chalk from 'chalk';
import prompts from 'prompts';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

interface EnvSetOptions {
    secret?: boolean;
    env?: string;
    yes?: boolean;
    stagingValue?: string;
    devValue?: string;
    stagingInherit?: boolean;
    devInherit?: boolean;
    devInheritStaging?: boolean;
}

export async function envSet(keyOrProject: string, valueOrKey?: string, valueIfProject?: string, options: EnvSetOptions = {}): Promise<void> {
    const config = await requireConfigWithWorkspace();

    // Detect mode based on arguments
    const isProjectMode = valueIfProject !== undefined;

    if (isProjectMode) {
        // Project mode: solidactions env set <project> <key> <value>
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
            // Check if variable already has a value
            if (!options.yes) {
                const mappingsResponse = await axios.get(
                    `${config.host}/api/v1/projects/${projectSlug}/variable-mappings?reveal=true`,
                    { headers: getApiHeaders(config) }
                );
                const mappings = mappingsResponse.data || [];
                const existing = mappings.find((m: any) => m.env_name === key);

                if (existing && existing.has_value) {
                    console.log(chalk.yellow(`Variable "${key}" already has a value in "${projectName}" (${environment}).`));
                    const confirm = await prompts({
                        type: 'confirm',
                        name: 'proceed',
                        message: 'Overwrite?',
                        initial: false,
                    });
                    if (!confirm.proceed) {
                        console.log(chalk.gray('Cancelled.'));
                        return;
                    }
                }
            }

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
                    headers: getApiHeaders(config, 'application/json'),
                }
            );

            const { created, updated } = response.data;
            const action = created > 0 ? 'created' : 'updated';
            console.log(chalk.green(`Variable "${key}" ${action} in project "${projectName}" (${environment}).`));
        } catch (error: any) {
            if (error.response) {
                if (error.response.status === 401) {
                    console.error(chalk.red('Authentication failed. Run "solidactions login <api-key>" to re-configure.'));
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
        // Global mode: solidactions env set <key> <value>
        const key = keyOrProject;
        const value = valueOrKey!;
        const isSecret = options.secret || false;

        // Build the request body with per-environment values
        const body: Record<string, any> = {
            key,
            production_value: value,
            is_secret: isSecret,
        };

        // Handle staging value and inheritance
        if (options.stagingInherit) {
            body.staging_source = 'inherit_production';
        } else if (options.stagingValue !== undefined) {
            body.staging_value = options.stagingValue;
            body.staging_source = 'value';
        }

        // Handle dev value and inheritance
        if (options.devInheritStaging) {
            body.dev_source = 'inherit_staging';
        } else if (options.devInherit) {
            body.dev_source = 'inherit_production';
        } else if (options.devValue !== undefined) {
            body.dev_value = options.devValue;
            body.dev_source = 'value';
        }

        try {
            // Check if variable already exists
            const getResponse = await axios.get(`${config.host}/api/v1/variables`, {
                headers: getApiHeaders(config),
            });

            const variables = getResponse.data?.data || [];
            const existing = variables.find((v: any) => v.key === key);

            let action: string;

            if (existing) {
                if (!options.yes) {
                    console.log(chalk.yellow(`Global variable "${key}" already exists.`));
                    const confirm = await prompts({
                        type: 'confirm',
                        name: 'proceed',
                        message: 'Overwrite?',
                        initial: false,
                    });
                    if (!confirm.proceed) {
                        console.log(chalk.gray('Cancelled.'));
                        return;
                    }
                }

                await axios.put(
                    `${config.host}/api/v1/variables/${existing.id}`,
                    body,
                    {
                        headers: getApiHeaders(config, 'application/json'),
                    }
                );
                action = 'updated';
            } else {
                await axios.post(
                    `${config.host}/api/v1/variables`,
                    body,
                    {
                        headers: getApiHeaders(config, 'application/json'),
                    }
                );
                action = 'created';
            }

            const typeLabel = isSecret ? 'secret' : 'variable';
            console.log(chalk.green(`Global ${typeLabel} "${key}" ${action} successfully.`));

            // Show summary of per-environment values
            if (options.stagingValue) {
                console.log(chalk.gray(`  Staging: ${isSecret ? '********' : options.stagingValue}`));
            } else if (options.stagingInherit) {
                console.log(chalk.gray('  Staging: (inherits from production)'));
            }
            if (options.devValue) {
                console.log(chalk.gray(`  Dev: ${isSecret ? '********' : options.devValue}`));
            } else if (options.devInheritStaging) {
                console.log(chalk.gray('  Dev: (inherits from staging)'));
            } else if (options.devInherit) {
                console.log(chalk.gray('  Dev: (inherits from production)'));
            }
        } catch (error: any) {
            if (error.response) {
                if (error.response.status === 401) {
                    console.error(chalk.red('Authentication failed. Run "solidactions login <api-key>" to re-configure.'));
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
}

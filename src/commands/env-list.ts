import axios from 'axios';
import chalk from 'chalk';
import { getConfig } from './init';

interface EnvListOptions {
    env?: string;
}

/**
 * Format a value for display, with inherited badge if applicable.
 */
function formatEnvValue(value: string | null, source: string | null, isSecret: boolean): string {
    if (isSecret) {
        return chalk.yellow('••••••');
    }
    if (value === null || value === undefined) {
        if (source && source.startsWith('inherit_')) {
            return chalk.gray('(inherited)');
        }
        return chalk.gray('-');
    }
    const displayValue = value.substring(0, 18);
    if (source && source.startsWith('inherit_')) {
        return chalk.gray(`${displayValue} (inh)`);
    }
    return displayValue;
}

export async function envList(projectName?: string, options: EnvListOptions = {}) {
    const config = getConfig();
    if (!config?.apiKey) {
        console.error(chalk.red('Not initialized. Run "solidactions init <api-key>" first.'));
        process.exit(1);
    }

    try {
        if (projectName) {
            // List project variable mappings
            const environment = options.env || 'dev';
            const projectSlug = environment === 'production'
                ? projectName
                : `${projectName}-${environment}`;

            console.log(chalk.blue(`Environment variables for project "${projectName}" (${environment}):`));

            const response = await axios.get(`${config.host}/api/v1/projects/${projectSlug}/variable-mappings`, {
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                    'Accept': 'application/json',
                },
            });

            const mappings = response.data || [];

            if (mappings.length === 0) {
                console.log(chalk.gray('No variable mappings found.'));
                return;
            }

            console.log('');
            console.log(chalk.gray('KEY'.padEnd(30) + 'VALUE'.padEnd(30) + 'SOURCE'.padEnd(12) + 'GLOBAL KEY'));
            console.log(chalk.gray('-'.repeat(100)));

            for (const mapping of mappings) {
                const key = mapping.env_name || '?';
                const value = mapping.is_secret ? chalk.yellow('********') : (mapping.value || '-');
                const source = mapping.source || 'manual';
                const globalKey = mapping.global_variable_key || chalk.gray('(local)');

                const sourceColor = source === 'yaml' ? chalk.cyan : (source === 'override' ? chalk.yellow : chalk.gray);

                console.log(
                    key.padEnd(30) +
                    (mapping.is_secret ? chalk.yellow('********'.padEnd(30)) : (mapping.value || '-').toString().substring(0, 28).padEnd(30)) +
                    sourceColor(source.padEnd(12)) +
                    (mapping.global_variable_key || chalk.gray('(local)'))
                );
            }

            console.log('');
            console.log(chalk.gray(`${mappings.length} variable(s)`));
        } else {
            // List global variables with per-environment values
            console.log(chalk.blue('Global environment variables:'));

            const response = await axios.get(`${config.host}/api/v1/variables`, {
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                    'Accept': 'application/json',
                },
            });

            const variables = response.data?.data || [];

            if (variables.length === 0) {
                console.log(chalk.gray('No global variables found.'));
                return;
            }

            console.log('');

            // If --env filter is set, show only that environment's values
            if (options.env) {
                const env = options.env.toLowerCase();
                console.log(chalk.gray('KEY'.padEnd(30) + 'VALUE'.padEnd(40) + 'TYPE'));
                console.log(chalk.gray('-'.repeat(80)));

                for (const variable of variables) {
                    const key = variable.key || '?';
                    let value: string | null = null;
                    let source: string | null = null;

                    if (env === 'production') {
                        value = variable.production_value;
                    } else if (env === 'staging') {
                        value = variable.staging_source === 'inherit_production'
                            ? variable.production_value
                            : variable.staging_value;
                        source = variable.staging_source;
                    } else if (env === 'dev') {
                        if (variable.dev_source === 'inherit_production') {
                            value = variable.production_value;
                        } else if (variable.dev_source === 'inherit_staging') {
                            value = variable.staging_source === 'inherit_production'
                                ? variable.production_value
                                : variable.staging_value;
                        } else {
                            value = variable.dev_value;
                        }
                        source = variable.dev_source;
                    }

                    const displayValue = formatEnvValue(value, source, variable.is_secret);
                    const type = variable.is_secret ? chalk.yellow('secret') : chalk.gray('plain');

                    console.log(
                        key.padEnd(30) +
                        displayValue.padEnd(40) +
                        type
                    );
                }
            } else {
                // Show all environments in columns
                console.log(chalk.gray(
                    'KEY'.padEnd(24) +
                    chalk.green('PRODUCTION').padEnd(20) +
                    chalk.yellow('STAGING').padEnd(20) +
                    chalk.blue('DEV').padEnd(20) +
                    'TYPE'
                ));
                console.log(chalk.gray('-'.repeat(100)));

                for (const variable of variables) {
                    const key = variable.key || '?';

                    // Production value
                    const prodValue = formatEnvValue(variable.production_value, null, variable.is_secret);

                    // Staging value with inheritance
                    const stagingValue = formatEnvValue(
                        variable.staging_source === 'inherit_production' ? variable.production_value : variable.staging_value,
                        variable.staging_source,
                        variable.is_secret
                    );

                    // Dev value with inheritance chain
                    let devActualValue = variable.dev_value;
                    if (variable.dev_source === 'inherit_production') {
                        devActualValue = variable.production_value;
                    } else if (variable.dev_source === 'inherit_staging') {
                        devActualValue = variable.staging_source === 'inherit_production'
                            ? variable.production_value
                            : variable.staging_value;
                    }
                    const devValue = formatEnvValue(devActualValue, variable.dev_source, variable.is_secret);

                    const type = variable.is_secret ? chalk.yellow('secret') : chalk.gray('plain');

                    console.log(
                        key.substring(0, 22).padEnd(24) +
                        prodValue.padEnd(20) +
                        stagingValue.padEnd(20) +
                        devValue.padEnd(20) +
                        type
                    );
                }
            }

            console.log('');
            console.log(chalk.gray(`${variables.length} variable(s)`));
            if (!options.env) {
                console.log(chalk.gray('Use --env <production|staging|dev> to filter by environment'));
            }
        }
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions init <api-key>" to re-configure.'));
            } else if (error.response.status === 404) {
                console.error(chalk.red(projectName ? `Project "${projectName}" not found for the specified environment.` : 'Resource not found.'));
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

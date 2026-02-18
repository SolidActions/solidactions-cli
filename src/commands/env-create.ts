import axios from 'axios';
import chalk from 'chalk';
import { getConfig } from './init';

interface EnvCreateOptions {
    secret?: boolean;
    stagingValue?: string;
    devValue?: string;
    stagingInherit?: boolean;
    devInherit?: boolean;
    devInheritStaging?: boolean;
}

export async function envCreate(key: string, value: string, options: EnvCreateOptions = {}) {
    const config = getConfig();
    if (!config?.apiKey) {
        console.error(chalk.red('Not initialized. Run "solidactions init <api-key>" first.'));
        process.exit(1);
    }

    console.log(chalk.blue(`Creating global variable "${key}"...`));

    // Build the request body with per-environment values
    const body: Record<string, any> = {
        key,
        production_value: value,
        is_secret: options.secret || false,
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
        await axios.post(`${config.host}/api/v1/variables`, body, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
        });

        const typeLabel = options.secret ? 'secret' : 'variable';
        console.log(chalk.green(`Global ${typeLabel} "${key}" created successfully!`));

        // Show summary of what was set
        console.log(chalk.gray(`  Production: ${options.secret ? '********' : value}`));
        if (options.stagingValue) {
            console.log(chalk.gray(`  Staging: ${options.secret ? '********' : options.stagingValue}`));
        } else if (options.stagingInherit) {
            console.log(chalk.gray('  Staging: (inherits from production)'));
        }
        if (options.devValue) {
            console.log(chalk.gray(`  Dev: ${options.secret ? '********' : options.devValue}`));
        } else if (options.devInheritStaging) {
            console.log(chalk.gray('  Dev: (inherits from staging)'));
        } else if (options.devInherit) {
            console.log(chalk.gray('  Dev: (inherits from production)'));
        }
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions init <api-key>" to re-configure.'));
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

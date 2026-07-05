import axios from 'axios';
import chalk from 'chalk';
import prompts from 'prompts';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { isReservedEnvName, reservedEnvNameError } from '../utils/env';

/** Returns true when stdin is not an interactive terminal (CI, pipes, scripts). */
export function isNonTty(): boolean {
    return !process.stdin.isTTY;
}

/** Printed before a 2-arg (global-scope) write — Jordan's runs 3-7 footgun. */
export const GLOBAL_ENV_SCOPE_NOTE = [
    'Note: --global specified — creating a GLOBAL variable.',
    "  Global variables are NOT visible to a project's plain `env:` YAML declarations",
    '  unless you map them (`solidactions env map …`).',
    '  For a project variable, use: solidactions env set <project> KEY value',
].join('\n');

interface EnvSetOptions {
    secret?: boolean;
    env?: string;
    yes?: boolean;
    stagingValue?: string;
    devValue?: string;
    stagingInherit?: boolean;
    devInherit?: boolean;
    devInheritStaging?: boolean;
    global?: boolean;
}

export async function envSet(keyOrProject: string, valueOrKey?: string, valueIfProject?: string, options: EnvSetOptions = {}): Promise<void> {
    // Detect mode based on arguments
    const isProjectMode = valueIfProject !== undefined;

    // Jordan Wall #4 (Sweep C, → 1.23.0): a 2-positional-arg call used to fall
    // through to GLOBAL scope silently, so a typo'd `env set KEY VALUE` (meant
    // for a project) wrote a global var the workflow never reads. Global
    // writes now require an explicit --global. Runs before any
    // config/network work so a plain argument mistake never needs a login.
    if (!isProjectMode && !options.global) {
        process.stderr.write(chalk.red(
            'env set needs either a project or --global — pick one:\n' +
            '  solidactions env set KEY VALUE --global      (global variable)\n' +
            '  solidactions env set <project> KEY VALUE     (project variable)\n'
        ));
        process.exit(1);
    }

    // --global never takes a project positional — reject the ambiguous combo too.
    if (isProjectMode && options.global) {
        process.stderr.write(chalk.red(
            'env set: --global does not take a project argument — pick one:\n' +
            '  solidactions env set KEY VALUE --global      (global variable)\n' +
            '  solidactions env set <project> KEY VALUE     (project variable)\n'
        ));
        process.exit(1);
    }

    const config = await requireConfigWithWorkspace();

    if (isProjectMode) {
        // Project mode: solidactions env set <project> <key> <value>
        const projectName = keyOrProject;
        const key = valueOrKey!;
        const value = valueIfProject;

        if (isReservedEnvName(key)) {
            console.error(chalk.red(reservedEnvNameError(key)));
            process.exit(1);
        }

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
                    if (isNonTty()) {
                        console.error(chalk.red(
                            `Variable "${key}" already has a value in "${projectName}" (${environment}). ` +
                            `Pass -y / --yes to overwrite without confirmation.`
                        ));
                        process.exit(1);
                    }
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

        if (isReservedEnvName(key)) {
            console.error(chalk.red(reservedEnvNameError(key)));
            process.exit(1);
        }

        console.log(chalk.yellow(GLOBAL_ENV_SCOPE_NOTE));

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
                    if (isNonTty()) {
                        console.error(chalk.red(
                            `Global variable "${key}" already exists. ` +
                            `Pass -y / --yes to overwrite without confirmation.`
                        ));
                        process.exit(1);
                    }
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

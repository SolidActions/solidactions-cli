import axios from 'axios';
import chalk from 'chalk';
import { describeProjectEnvironments, getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

interface EnvResetOptions {
    env?: string;
}

function describeRestoredSource(mapping: any): string {
    const sourceType = mapping.source_type || mapping.source || 'unknown';

    if (sourceType === 'oauth_connection') {
        const connection = mapping.oauth_connection_name || mapping.oauth_connection_id;
        return connection ? `oauth_connection "${connection}"` : 'oauth_connection';
    }

    if (sourceType === 'global_variable') {
        const globalKey = mapping.global_variable_key;
        return globalKey ? `global_variable "${globalKey}"` : 'global_variable';
    }

    return sourceType;
}

export async function envReset(projectName: string, key: string, options: EnvResetOptions = {}): Promise<void> {
    const config = await requireConfigWithWorkspace();
    const environment = options.env || 'dev';
    const projectSlug = environment === 'production'
        ? projectName
        : `${projectName}-${environment}`;

    try {
        const listResponse = await axios.get(
            `${config.host}/api/v1/projects/${projectSlug}/variable-mappings`,
            { headers: getApiHeaders(config) }
        );
        const mappings = listResponse.data || [];
        const mapping = mappings.find((candidate: any) => candidate.env_name === key);

        if (!mapping) {
            console.error(chalk.red(
                `Variable "${key}" has no variable mapping in project "${projectName}" (${environment}).`
            ));
            process.exit(1);
        }

        const resetResponse = await axios.post(
            `${config.host}/api/v1/projects/${projectSlug}/variable-mappings/${mapping.id}/reset`,
            {},
            { headers: getApiHeaders(config, 'application/json') }
        );
        const restored = resetResponse.data.mapping;

        console.log(chalk.green(
            `Variable "${key}" reset to ${describeRestoredSource(restored)} ` +
            `in project "${projectName}" (${environment}).`
        ));
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions login --global" to re-configure.'));
            } else if (error.response.status === 404) {
                const envsList = await describeProjectEnvironments(config, projectName);
                console.error(chalk.red(
                    `Project "${projectName}" has no ${environment} environment` +
                    `${envsList ? ` (exists in: ${envsList})` : ''}.`
                ));
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

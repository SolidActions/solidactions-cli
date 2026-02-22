import fs from 'fs';
import path from 'path';
import axios from 'axios';
import chalk from 'chalk';
import prompts from 'prompts';
import { getConfig } from './init';
import { SolidActionsConfig, parseEnvFile, getYamlDeclaredVars, loadSolidActionsConfig } from '../utils/env';

interface EnvPushOptions {
    env?: string;
    newOnly?: boolean;
    includeUndeclared?: boolean;
    yes?: boolean;
}

export async function envPush(projectName: string, sourcePath: string, options: EnvPushOptions = {}): Promise<void> {
    const config = getConfig();
    if (!config?.apiKey) {
        console.error(chalk.red('Not initialized. Run "solidactions init <api-key>" first.'));
        process.exit(1);
    }

    const sourceDir = path.resolve(sourcePath);
    const environment = options.env || 'dev';

    // Read solidactions.yaml
    const yamlPath = path.join(sourceDir, 'solidactions.yaml');
    if (!fs.existsSync(yamlPath)) {
        console.error(chalk.red('solidactions.yaml not found in ' + sourceDir));
        console.log(chalk.gray('Make sure you\'re in a SolidActions project directory.'));
        process.exit(1);
    }

    let yamlConfig: SolidActionsConfig;
    try {
        yamlConfig = loadSolidActionsConfig(yamlPath);
    } catch (err: any) {
        console.error(chalk.red('Failed to parse solidactions.yaml:'), err.message);
        process.exit(1);
    }

    // Get YAML-declared vars
    const declaredVars = getYamlDeclaredVars(yamlConfig);

    // Determine env file
    const envFileName = environment === 'production' ? '.env' : `.env.${environment}`;
    const envFilePath = path.join(sourceDir, envFileName);

    if (!fs.existsSync(envFilePath)) {
        console.error(chalk.red(`${envFileName} not found in ${sourceDir}`));
        console.log(chalk.gray(`Create ${envFileName} with your environment variables, or use a different --env.`));
        process.exit(1);
    }

    // Parse the .env file
    const envValues = parseEnvFile(envFilePath);

    if (envValues.size === 0) {
        console.log(chalk.yellow(`${envFileName} is empty — nothing to push.`));
        process.exit(0);
    }

    // Filter to YAML-declared vars only (unless --include-undeclared)
    let keysToProcess: string[];
    if (options.includeUndeclared) {
        keysToProcess = Array.from(envValues.keys());
    } else {
        if (declaredVars.size === 0) {
            console.log(chalk.yellow('No environment variables declared in solidactions.yaml.'));
            console.log(chalk.gray('Use --include-undeclared to push all vars from the .env file.'));
            process.exit(0);
        }
        keysToProcess = Array.from(envValues.keys()).filter(k => declaredVars.has(k));

        // Warn about YAML-declared vars missing from .env
        for (const key of declaredVars) {
            if (!envValues.has(key)) {
                console.log(chalk.yellow(`⚠ ${key}: declared in YAML but not found in ${envFileName}`));
            }
        }
    }

    if (keysToProcess.length === 0) {
        console.log(chalk.yellow('No matching variables to push.'));
        if (!options.includeUndeclared && envValues.size > 0) {
            console.log(chalk.gray('Your .env has variables not declared in solidactions.yaml. Use --include-undeclared to push them.'));
        }
        process.exit(0);
    }

    // Build project slug
    const projectSlug = environment === 'production'
        ? projectName
        : `${projectName}-${environment}`;

    console.log(chalk.blue(`Pushing env vars to "${projectName}" (${environment})...`));

    // Fetch current server state
    let serverMappings: any[] = [];
    try {
        const response = await axios.get(`${config.host}/api/v1/projects/${projectSlug}/variable-mappings`, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
            },
        });
        serverMappings = response.data || [];
    } catch (error: any) {
        if (error.response?.status === 401) {
            console.error(chalk.red('Authentication failed. Run "solidactions init <api-key>" to re-configure.'));
            process.exit(1);
        } else if (error.response?.status === 404) {
            console.error(chalk.red(`Project "${projectSlug}" not found.`));
            console.log(chalk.gray(`Deploy first with: solidactions deploy ${projectName} --env ${environment}` + (environment !== 'production' ? ' --create' : '')));
            process.exit(1);
        }
        throw error;
    }

    // Build a lookup of server state by env_name
    const serverState = new Map<string, any>();
    for (const mapping of serverMappings) {
        serverState.set(mapping.env_name, mapping);
    }

    // Build diff
    interface PushEntry {
        key: string;
        value: string;
        is_secret: boolean;
        action: 'create' | 'update' | 'skip';
    }

    const entries: PushEntry[] = [];

    for (const key of keysToProcess) {
        const value = envValues.get(key)!;
        const isSecret = /secret|key|token|password|credential/i.test(key);
        const existing = serverState.get(key);

        let action: 'create' | 'update' | 'skip';
        if (!existing || existing.status === 'not_configured' || existing.has_value === false) {
            action = 'create';
        } else {
            action = 'update';
        }

        // If --new-only, skip updates
        if (options.newOnly && action === 'update') {
            action = 'skip';
        }

        entries.push({ key, value, is_secret: isSecret, action });
    }

    const toCreate = entries.filter(e => e.action === 'create');
    const toUpdate = entries.filter(e => e.action === 'update');
    const toSkip = entries.filter(e => e.action === 'skip');
    const toPush = entries.filter(e => e.action !== 'skip');

    if (toPush.length === 0) {
        console.log(chalk.yellow('Nothing to push — all variables are already configured.'));
        if (toSkip.length > 0) {
            console.log(chalk.gray(`${toSkip.length} variable(s) skipped (--new-only).`));
        }
        process.exit(0);
    }

    // Display diff table
    console.log('');
    console.log(chalk.bold('  KEY'.padEnd(36) + 'ACTION'.padEnd(12) + 'NOTES'));
    console.log(chalk.gray('  ' + '─'.repeat(56)));

    for (const entry of entries) {
        const keyCol = ('  ' + entry.key).padEnd(36);
        let actionCol: string;
        let notesCol: string;

        switch (entry.action) {
            case 'create':
                actionCol = chalk.green('create'.padEnd(12));
                notesCol = chalk.gray('(new)');
                break;
            case 'update':
                actionCol = chalk.yellow('update'.padEnd(12));
                notesCol = chalk.gray('(has existing value)');
                break;
            case 'skip':
                actionCol = chalk.gray('skip'.padEnd(12));
                notesCol = chalk.gray('(--new-only)');
                break;
        }

        console.log(keyCol + actionCol + notesCol);
    }
    console.log('');

    // Confirm unless --yes
    if (!options.yes) {
        const summary = [];
        if (toCreate.length > 0) summary.push(`${toCreate.length} create`);
        if (toUpdate.length > 0) summary.push(`${toUpdate.length} update`);
        if (toSkip.length > 0) summary.push(`${toSkip.length} skip`);

        const response = await prompts({
            type: 'confirm',
            name: 'confirm',
            message: `Push ${toPush.length} variable(s) to ${projectSlug}? (${summary.join(', ')})`,
            initial: true,
        });

        if (!response.confirm) {
            console.log(chalk.gray('Cancelled.'));
            return;
        }
    }

    // Push via bulk API
    const variables = toPush.map(e => ({
        key: e.key,
        value: e.value,
        is_secret: e.is_secret,
    }));

    try {
        const response = await axios.post(
            `${config.host}/api/v1/projects/${projectSlug}/variable-mappings/bulk`,
            { variables },
            {
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
            }
        );

        const { created, updated } = response.data;
        console.log(chalk.green(`\n✓ Pushed ${toPush.length} variable(s) to ${projectSlug}`));
        console.log(chalk.gray(`  ${created} created, ${updated} updated` + (toSkip.length > 0 ? `, ${toSkip.length} skipped` : '')));
    } catch (error: any) {
        console.error(chalk.red('Failed to push environment variables:'), error.response?.data?.message || error.message);
        process.exit(1);
    }
}

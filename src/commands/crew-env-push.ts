import fs from 'fs';
import path from 'path';
import axios from 'axios';
import chalk from 'chalk';
import prompts from 'prompts';
import { formatValidationError, getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { crewEnvError, isValidCrewEnv, resolveCrewId } from '../utils/crew';
import { isReservedEnvName, parseEnvFile, RESERVED_ENV_PREFIX } from '../utils/env';
import { buildVariableBody } from './crew-env-set';

export interface CrewEnvPushOptions {
    env?: string;
    /** Commander --no-secret negation: undefined/true = secret (default), false = plain. */
    secret?: boolean;
    yes?: boolean;
}

interface ServerCrewVariable {
    id: number | string;
    env_name: string;
    is_secret: boolean;
    production_value: string | null;
    staging_value: string | null;
    staging_source: string | null;
    dev_value: string | null;
    dev_source: string | null;
}

export type PushAction = 'create' | 'update' | 'skip';

export interface PushEntry {
    key: string;
    action: PushAction;
    body: Record<string, unknown>;
}

/**
 * Pure: decide create/update/skip for one key. `skip` only fires for a
 * plain (non-secret, no secret-status change) variable whose server-side
 * value(s) already match what we're about to push — secrets are always
 * masked server-side so we can never prove a secret push is a no-op.
 */
export function diffPushEntry(
    key: string,
    value: string,
    environment: 'production' | 'staging' | 'dev' | 'all',
    isSecret: boolean,
    existing: ServerCrewVariable | undefined,
): PushEntry {
    const body = buildVariableBody(environment, value, isSecret);

    if (!existing) {
        return { key, action: 'create', body };
    }

    if (existing.is_secret !== isSecret || isSecret) {
        return { key, action: 'update', body };
    }

    const productionUnchanged = !(environment === 'production' || environment === 'all')
        || existing.production_value === value;
    const stagingUnchanged = !(environment === 'staging' || environment === 'all')
        || (existing.staging_value === value && existing.staging_source === 'value');
    const devUnchanged = !(environment === 'dev' || environment === 'all')
        || (existing.dev_value === value && existing.dev_source === 'value');

    const unchanged = productionUnchanged && stagingUnchanged && devUnchanged;
    return { key, action: unchanged ? 'skip' : 'update', body };
}

export async function crewEnvPush(crewArg: string, filePath: string = '.env', options: CrewEnvPushOptions = {}): Promise<void> {
    const environment = options.env || 'all';
    if (!isValidCrewEnv(environment)) {
        console.error(chalk.red(crewEnvError(environment)));
        process.exit(1);
    }

    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
        console.error(chalk.red(`${filePath} not found.`));
        process.exit(1);
    }

    const envValues = parseEnvFile(resolvedPath);
    if (envValues.size === 0) {
        console.log(chalk.yellow(`${filePath} is empty — nothing to push.`));
        process.exit(0);
    }

    const reservedKeys = Array.from(envValues.keys()).filter(isReservedEnvName);
    if (reservedKeys.length > 0) {
        console.error(chalk.red(`Refusing to push — reserved ${RESERVED_ENV_PREFIX} names found: ${reservedKeys.join(', ')}`));
        process.exit(1);
    }

    const config = await requireConfigWithWorkspace();
    const crew = await resolveCrewId(config, crewArg);

    // Secrets are the default for crew variables — --no-secret opts out,
    // and applies uniformly to every key in this push.
    const isSecret = options.secret !== false;

    let serverVariables: ServerCrewVariable[];
    try {
        const response = await axios.get(`${config.host}/api/v1/crews/${crew.id}/variables`, {
            headers: getApiHeaders(config),
        });
        serverVariables = response.data?.data ?? [];
    } catch (error: any) {
        if (error.response?.status === 401) {
            console.error(chalk.red('Authentication failed. Run "solidactions login <api-key>" to re-configure.'));
        } else if (error.response?.status === 404) {
            console.error(chalk.red(error.response.data?.message || `Crew "${crewArg}" not found.`));
        } else {
            console.error(chalk.red('Failed to read existing variables:'), error.response?.data?.message || error.message);
        }
        process.exit(1);
    }

    const serverState = new Map<string, ServerCrewVariable>();
    for (const variable of serverVariables) {
        serverState.set(variable.env_name, variable);
    }

    const entries: PushEntry[] = Array.from(envValues.entries()).map(([key, value]) =>
        diffPushEntry(key, value, environment, isSecret, serverState.get(key)),
    );

    const toCreate = entries.filter((e) => e.action === 'create');
    const toUpdate = entries.filter((e) => e.action === 'update');
    const toSkip = entries.filter((e) => e.action === 'skip');
    const toPush = entries.filter((e) => e.action !== 'skip');

    // Diff table — values are NEVER printed, only a fixed mask placeholder.
    console.log('');
    console.log(chalk.bold('  KEY'.padEnd(36) + 'ACTION'.padEnd(10) + 'VALUE'.padEnd(12) + 'NOTES'));
    console.log(chalk.gray('  ' + '─'.repeat(66)));

    for (const entry of entries) {
        const keyCol = ('  ' + entry.key).padEnd(36);
        let actionCol: string;
        let notesCol: string;

        switch (entry.action) {
            case 'create':
                actionCol = chalk.green('create'.padEnd(10));
                notesCol = chalk.gray('(new)');
                break;
            case 'update':
                actionCol = chalk.yellow('update'.padEnd(10));
                notesCol = chalk.gray('(changed)');
                break;
            case 'skip':
                actionCol = chalk.gray('skip'.padEnd(10));
                notesCol = chalk.gray('(unchanged)');
                break;
        }

        console.log(keyCol + actionCol + chalk.yellow('••••••').padEnd(12) + notesCol);
    }

    // Printed unconditionally (not just inside the prompt message) so the
    // counts are visible with --yes and in captured/injected-prompt output.
    const summary = [];
    if (toCreate.length > 0) summary.push(`${toCreate.length} create`);
    if (toUpdate.length > 0) summary.push(`${toUpdate.length} update`);
    if (toSkip.length > 0) summary.push(`${toSkip.length} skip`);

    console.log('');
    console.log(chalk.gray(summary.join(', ')));
    console.log('');

    if (toPush.length === 0) {
        console.log(chalk.yellow('Nothing to push — all variables are already up to date.'));
        process.exit(0);
    }

    if (!options.yes) {
        const response = await prompts({
            type: 'confirm',
            name: 'confirm',
            message: `Push ${toPush.length} variable(s) to crew "${crew.name}" (${environment})? (${summary.join(', ')})`,
            initial: true,
        });

        if (!response.confirm) {
            console.log(chalk.gray('Cancelled.'));
            return;
        }
    }

    for (const entry of toPush) {
        try {
            await axios.put(
                `${config.host}/api/v1/crews/${crew.id}/variables/${entry.key}`,
                entry.body,
                { headers: getApiHeaders(config, 'application/json') },
            );
        } catch (error: any) {
            if (error.response?.status === 422) {
                console.error(chalk.red(`Failed to push "${entry.key}":`), formatValidationError(error.response.data));
            } else {
                console.error(chalk.red(`Failed to push "${entry.key}":`), error.response?.data?.message || error.message);
            }
            process.exit(1);
        }
    }

    console.log(chalk.green(`\n✓ Pushed ${toPush.length} variable(s) to crew "${crew.name}"`));
    console.log(chalk.gray(`  ${toCreate.length} created, ${toUpdate.length} updated` + (toSkip.length > 0 ? `, ${toSkip.length} skipped` : '')));
}

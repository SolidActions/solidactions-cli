import fs from 'fs';
import path from 'path';
import axios from 'axios';
import chalk from 'chalk';
import readline from 'readline';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { writeSecretFileSync } from '../utils/secure-write';

interface EnvPullOptions {
    env?: string;
    output?: string;
    yes?: boolean;
    updateOauth?: boolean;
}

/**
 * Prompt the user for confirmation (unless --yes flag is set).
 */
async function confirm(message: string): Promise<boolean> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        rl.question(`${message} [y/n]: `, (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
        });
    });
}

/**
 * The copy-pasteable next step a reader of either surface should run (#140).
 *
 * Both the CLI note and the `.env` comment END with this line, with the ACTUAL
 * pulled environment substituted, so whoever hits the missing value can paste
 * one command and go rather than reverse-engineering the flag.
 */
export function devEnvHintLine(environment: string): string {
    return `To run locally with live platform vars + this database: solidactions dev <your-workflow-file> --env ${environment}`;
}

/**
 * Is this mapping a workspace database?
 *
 * A database mapping ALWAYS pulls with a null value: the platform deliberately
 * does not resolve database credentials to a file-writing command. Without an
 * explicit branch it lands in the generic `# KEY= (no value configured)` line,
 * where a blank reads as broken or unsupported — the failure this issue exists
 * to fix. The absence is a security posture, and both surfaces must say so.
 */
function isDatabaseMapping(variable: any): boolean {
    return variable?.source_type === 'workspace_database';
}

/** Best-known display name for a mapped database, however the mapping is bound. */
function databaseDisplayName(variable: any): string {
    return variable?.workspace_database_name
        || variable?.yaml_default_workspace_database_name
        || 'unknown';
}

export async function envPull(projectName: string, options: EnvPullOptions = {}) {
    const config = await requireConfigWithWorkspace();

    const environment = options.env || 'dev';

    // Build the project slug for lookup
    const projectSlug = environment === 'production'
        ? projectName
        : `${projectName}-${environment}`;

    // Determine output file
    const outputFile = options.output || (environment === 'production' ? '.env' : `.env.${environment}`);
    const outputPath = path.resolve(outputFile);

    console.log(chalk.blue(`Pulling variables from "${projectName}" (${environment})...`));

    try {
        // First, check if there are any secrets
        const checkResponse = await axios.get(`${config.host}/api/v1/projects/${projectSlug}/variable-mappings?resolve_oauth=true`, {
            headers: getApiHeaders(config),
        });

        const mappings = checkResponse.data || [];

        if (mappings.length === 0) {
            console.log(chalk.yellow('No variables found for this project.'));
            process.exit(0);
        }

        // Check for secrets (skip confirmation for --update-oauth since OAuth tokens are always secrets)
        const hasSecrets = mappings.some((m: any) => m.is_secret);

        if (hasSecrets && !options.yes && !options.updateOauth) {
            console.log(chalk.yellow('\nThis project contains secret values.'));
            const confirmed = await confirm('This will expose secret values in plain text. Continue?');
            if (!confirmed) {
                console.log(chalk.gray('Cancelled.'));
                process.exit(0);
            }
        }

        // Now fetch with reveal=true to get actual values
        const response = await axios.get(`${config.host}/api/v1/projects/${projectSlug}/variable-mappings?reveal=true&resolve_oauth=true`, {
            headers: getApiHeaders(config),
        });

        const variables = response.data || [];

        // --update-oauth: Only pull OAuth tokens and merge into existing .env
        if (options.updateOauth) {
            const oauthVars = variables.filter((v: any) => v.source_type === 'oauth_connection');

            if (oauthVars.length === 0) {
                console.log(chalk.yellow('No OAuth variables found for this project.'));
                process.exit(0);
            }

            // Build OAuth variable names set and their formatted lines
            const oauthKeySet = new Set(oauthVars.map((v: any) => v.env_name));
            const oauthLines: string[] = [];

            for (const variable of oauthVars) {
                const value = variable.resolved_value ?? variable.value;
                if (value === null || value === undefined) {
                    continue;
                }

                // Add expiry comment
                const connName = variable.oauth_connection_name || 'OAuth';
                if (variable.token_expires_at) {
                    oauthLines.push(`# OAuth: ${connName} (expires ${variable.token_expires_at})`);
                } else {
                    oauthLines.push(`# OAuth: ${connName} (short-lived, re-pull to refresh)`);
                }

                // Format value
                let formattedValue = value;
                if (typeof value === 'string' && (
                    value.includes(' ') || value.includes('"') || value.includes("'") ||
                    value.includes('\n') || value.includes('=') || value.includes('#')
                )) {
                    formattedValue = `"${value.replace(/"/g, '\\"')}"`;
                }
                oauthLines.push(`${variable.env_name}=${formattedValue}`);
            }

            if (!fs.existsSync(outputPath)) {
                // No .env file — create with just OAuth vars
                console.log(chalk.yellow('No .env file found — creating with OAuth vars only. Run a full env:pull for all variables.'));
                const content = oauthLines.join('\n') + '\n';
                writeSecretFileSync(outputPath, content);
            } else {
                // Merge into existing .env file
                const existingContent = fs.readFileSync(outputPath, 'utf-8');
                const existingLines = existingContent.split('\n');
                const preservedLines: string[] = [];

                for (let i = 0; i < existingLines.length; i++) {
                    const line = existingLines[i];
                    const nextLine = existingLines[i + 1];

                    // Skip OAuth comment lines if the next line is a skipped OAuth var
                    if (line.startsWith('# OAuth:') && nextLine) {
                        const nextMatch = nextLine.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
                        if (nextMatch && oauthKeySet.has(nextMatch[1])) {
                            continue;
                        }
                    }

                    // Skip existing OAuth var lines
                    const varMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
                    if (varMatch && oauthKeySet.has(varMatch[1])) {
                        continue;
                    }

                    // Skip previous "OAuth tokens (updated ...)" header
                    if (line.startsWith('# OAuth tokens (updated ')) {
                        continue;
                    }

                    preservedLines.push(line);
                }

                // Strip trailing blank lines from preserved content
                while (preservedLines.length > 0 && preservedLines[preservedLines.length - 1].trim() === '') {
                    preservedLines.pop();
                }

                // Append OAuth section
                preservedLines.push('');
                preservedLines.push(`# OAuth tokens (updated ${new Date().toISOString()})`);
                preservedLines.push(...oauthLines);
                preservedLines.push('');

                writeSecretFileSync(outputPath, preservedLines.join('\n'));
            }

            console.log(chalk.green(`\n✓ Updated ${oauthVars.length} OAuth token(s) in ${outputFile}`));

            // Print any OAuth warnings
            for (const variable of oauthVars) {
                if (variable.oauth_warning) {
                    console.log(chalk.yellow(`  ⚠ ${variable.env_name}: ${variable.oauth_warning}`));
                }
            }
            return;
        }

        // Full pull: Build .env file content
        const lines: string[] = [];
        lines.push(`# Variables pulled from SolidActions for ${projectName} / ${environment}.`);
        lines.push('# NOTE: this .env is NOT read by `solidactions dev`. Local dev vars come from');
        lines.push('# the platform (dev fetches them with `-e <env>`); pass ad-hoc values with `-i`.');
        lines.push(`# Generated by solidactions env pull on ${new Date().toISOString()}`);
        lines.push('');

        let count = 0;
        let secretCount = 0;
        const databaseVars: Array<{ key: string; dbName: string }> = [];

        for (const variable of variables) {
            const key = variable.env_name;
            const value = variable.resolved_value ?? variable.value;

            // A mapped database explains itself IN PLACE, before the generic
            // no-value branch can render it as a blank (#140).
            if (isDatabaseMapping(variable)) {
                const dbName = databaseDisplayName(variable);
                lines.push(`# ${key}: mapped database (${dbName}). Credentials resolve live at run time via`);
                lines.push(`# 'solidactions dev --env ${environment}' or in deployed workflows — never stored in this file.`);
                lines.push(`# ${devEnvHintLine(environment)}`);
                databaseVars.push({ key, dbName });
                continue;
            }

            if (value === null || value === undefined) {
                // Skip variables with no value
                lines.push(`# ${key}= (no value configured)`);
                continue;
            }

            // Add OAuth expiry comment above OAuth-sourced variables
            if (variable.source_type === 'oauth_connection') {
                const connName = variable.oauth_connection_name || 'OAuth';
                if (variable.token_expires_at) {
                    lines.push(`# OAuth: ${connName} (expires ${variable.token_expires_at})`);
                } else {
                    lines.push(`# OAuth: ${connName} (short-lived, re-pull to refresh)`);
                }
            }

            // Quote values that contain special characters
            let formattedValue = value;
            if (typeof value === 'string' && (
                value.includes(' ') ||
                value.includes('"') ||
                value.includes("'") ||
                value.includes('\n') ||
                value.includes('=') ||
                value.includes('#')
            )) {
                // Escape double quotes and wrap in double quotes
                formattedValue = `"${value.replace(/"/g, '\\"')}"`;
            }

            lines.push(`${key}=${formattedValue}`);
            count++;

            if (variable.is_secret) {
                secretCount++;
            }
        }

        lines.push('');

        // Write to file
        writeSecretFileSync(outputPath, lines.join('\n'));

        console.log(chalk.green(`\n✓ Wrote ${count} variables to ${outputFile}`));
        if (secretCount > 0) {
            console.log(chalk.yellow(`  (includes ${secretCount} secret value${secretCount > 1 ? 's' : ''})`));
        }

        // Say out loud why each mapped database has no value here. The same
        // explanation is written into the .env at the variable's own position;
        // an agent reads one surface or the other, so both must carry it.
        for (const { key, dbName } of databaseVars) {
            console.log(chalk.cyan(
                `\nNOTE: ${key} is a mapped database (${dbName}) — credentials are resolved live at run time `
                + `('solidactions dev --env ${environment}' locally, automatic in deployed workflows) `
                + 'and are never written to files.',
            ));
            console.log(chalk.cyan(`  ${devEnvHintLine(environment)}`));
        }

        // Print any OAuth warnings
        for (const variable of variables) {
            if (variable.oauth_warning) {
                console.log(chalk.yellow(`  ⚠ ${variable.env_name}: ${variable.oauth_warning}`));
            }
        }

    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions login --global" to re-configure.'));
            } else if (error.response.status === 404) {
                console.error(chalk.red(`Project "${projectSlug}" not found.`));
                if (environment !== 'production') {
                    console.log(chalk.gray(`Try deploying with: solidactions project deploy ${projectName} -e ${environment} --create`));
                }
            } else if (error.response.status === 403) {
                // Only the reveal step is named as the culprit — a 403 here can
                // also be a workspace-scope or project-policy denial, and
                // blaming env:reveal for those sends the user to the wrong fix.
                const detail = typeof error.response.data?.message === 'string' ? error.response.data.message : undefined;
                const needsReveal = error.response.data?.required_ability === 'env:reveal';
                const lead = needsReveal
                    ? "Reading variable values requires the 'env:reveal' ability."
                    : 'Permission denied.';
                console.error(chalk.red(detail ? `${lead}\n\n${detail}` : lead));
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else if (!axios.isAxiosError(error) && error.code) {
            // A filesystem failure writing the .env — not a connection problem.
            console.error(chalk.red(`Failed to write ${outputFile}: ${error.message}`));
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

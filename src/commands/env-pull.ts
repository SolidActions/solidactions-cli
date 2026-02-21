import fs from 'fs';
import path from 'path';
import axios from 'axios';
import chalk from 'chalk';
import readline from 'readline';
import { getConfig } from './init';

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

export async function envPull(projectName: string, options: EnvPullOptions = {}) {
    const config = getConfig();
    if (!config?.apiKey) {
        console.error(chalk.red('Not initialized. Run "solidactions init <api-key>" first.'));
        process.exit(1);
    }

    const environment = options.env || 'dev';

    // Build the project slug for lookup
    const projectSlug = environment === 'production'
        ? projectName
        : `${projectName}-${environment}`;

    // Determine output file
    const outputFile = options.output || (environment === 'production' ? '.env' : `.env.${environment}`);
    const outputPath = path.resolve(outputFile);

    console.log(chalk.blue(`Pulling environment variables from "${projectName}" (${environment})...`));

    try {
        // First, check if there are any secrets
        const checkResponse = await axios.get(`${config.host}/api/v1/projects/${projectSlug}/variable-mappings?resolve_oauth=true`, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
            },
        });

        const mappings = checkResponse.data || [];

        if (mappings.length === 0) {
            console.log(chalk.yellow('No environment variables found for this project.'));
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
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
            },
        });

        const variables = response.data || [];

        // --update-oauth: Only pull OAuth tokens and merge into existing .env
        if (options.updateOauth) {
            const oauthVars = variables.filter((v: any) => v.source_type === 'oauth_connection');

            if (oauthVars.length === 0) {
                console.log(chalk.yellow('No OAuth variables found for this project.'));
                process.exit(0);
            }

            // Build OAuth env var names set and their formatted lines
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
                fs.writeFileSync(outputPath, content);
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

                fs.writeFileSync(outputPath, preservedLines.join('\n'));
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
        lines.push(`# Environment variables for ${projectName} (${environment})`);
        lines.push(`# Generated by solidactions env:pull on ${new Date().toISOString()}`);
        lines.push('');

        let count = 0;
        let secretCount = 0;

        for (const variable of variables) {
            const key = variable.env_name;
            const value = variable.resolved_value ?? variable.value;

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
        fs.writeFileSync(outputPath, lines.join('\n'));

        console.log(chalk.green(`\n✓ Wrote ${count} variables to ${outputFile}`));
        if (secretCount > 0) {
            console.log(chalk.yellow(`  (includes ${secretCount} secret value${secretCount > 1 ? 's' : ''})`));
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
                console.error(chalk.red('Authentication failed. Run "solidactions init <api-key>" to re-configure.'));
            } else if (error.response.status === 404) {
                console.error(chalk.red(`Project "${projectSlug}" not found.`));
                if (environment !== 'production') {
                    console.log(chalk.gray(`Try deploying with: solidactions deploy ${projectName} --env ${environment} --create`));
                }
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

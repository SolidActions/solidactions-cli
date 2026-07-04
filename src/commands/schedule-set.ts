import axios from 'axios';
import chalk from 'chalk';
import prompts from 'prompts';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

export function buildSchedulePayload(
    cron: string,
    options: { workflow?: string; input?: string; timezone?: string },
    inputData?: Record<string, any>,
): Record<string, any> {
    const payload: Record<string, any> = { cron };
    if (options.workflow) {
        payload.workflow = options.workflow;
    }
    if (inputData) {
        payload.input = inputData;
    }
    if (options.timezone) {
        payload.timezone = options.timezone;
    }
    return payload;
}

/** True when the user asked for a timezone the server did not apply (pre-item-5-App server). */
export function timezoneMismatch(requested: string | undefined, returned: string | undefined): boolean {
    return requested !== undefined && returned !== requested;
}

export async function scheduleSet(projectName: string, cron: string, options: { workflow?: string; input?: string; timezone?: string; yes?: boolean }) {
    const config = await requireConfigWithWorkspace();

    // Parse input JSON if provided
    let inputData: Record<string, any> | undefined;
    if (options.input) {
        try {
            inputData = JSON.parse(options.input);
        } catch {
            console.error(chalk.red('Invalid JSON input.'));
            process.exit(1);
        }
    }

    // Check for existing schedule on the same workflow
    if (!options.yes) {
        try {
            const listResponse = await axios.get(`${config.host}/api/v1/projects/${projectName}/schedules`, {
                headers: getApiHeaders(config),
            });
            const schedules = listResponse.data.data || listResponse.data || [];
            const existing = schedules.find((s: any) => {
                if (options.workflow) {
                    return s.workflow_name === options.workflow || s.workflow_slug === options.workflow;
                }
                return true; // No workflow specified — any existing schedule is a match
            });

            if (existing) {
                const workflowName = existing.workflow_name || existing.workflow_slug || 'unknown';
                console.log(chalk.yellow(`"${workflowName}" already has a schedule: ${existing.cron_expression}`));
                const confirm = await prompts({
                    type: 'select',
                    name: 'action',
                    message: 'What would you like to do?',
                    choices: [
                        { title: 'Replace existing schedule', value: 'replace' },
                        { title: 'Add another schedule', value: 'add' },
                        { title: 'Cancel', value: 'cancel' },
                    ],
                });
                if (confirm.action === 'cancel' || confirm.action === undefined) {
                    console.log(chalk.gray('Cancelled.'));
                    return;
                }
                if (confirm.action === 'replace') {
                    // Delete the existing schedule first
                    await axios.delete(`${config.host}/api/v1/projects/${projectName}/schedules/${existing.id}`, {
                        headers: getApiHeaders(config),
                    });
                    console.log(chalk.gray(`Removed old schedule (${existing.cron_expression}).`));
                }
            }
        } catch {
            // If we can't check, proceed anyway
        }
    }

    console.log(chalk.blue(`Setting schedule for project "${projectName}"...`));

    try {
        const payload = buildSchedulePayload(cron, options, inputData);

        const response = await axios.post(`${config.host}/api/v1/projects/${projectName}/schedules`, payload, {
            headers: getApiHeaders(config, 'application/json'),
        });

        // Verify, don't trust: a server predating timezone support silently
        // strips the field, but the schedule is already persisted by this point —
        // it's live and running in the wrong timezone. Report the persisted fact
        // and the remedy, not a hypothetical.
        const returnedTz: string | undefined = response.data?.schedule?.timezone;
        if (timezoneMismatch(options.timezone, returnedTz)) {
            console.error(chalk.red(`A schedule was created but is running in ${returnedTz ?? 'UTC'} — not ${options.timezone} as requested.`));
            console.error(chalk.red(`Your server may not support schedule timezones yet; update the server or delete the schedule with: solidactions schedule delete ${projectName} ${options.workflow ?? '<workflow>'}`));
            process.exit(1);
        }

        console.log(chalk.green(`Schedule set successfully!`));
        console.log(chalk.gray(`  Cron: ${cron}`));
        if (options.timezone) {
            console.log(chalk.gray(`  Timezone: ${options.timezone}`));
        }
        if (options.workflow) {
            console.log(chalk.gray(`  Workflow: ${options.workflow}`));
        }
        if (inputData) {
            console.log(chalk.gray(`  Input: ${JSON.stringify(inputData)}`));
        }
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions login <api-key>" to re-configure.'));
            } else if (error.response.status === 404) {
                console.error(chalk.red(`Project "${projectName}" not found.`));
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

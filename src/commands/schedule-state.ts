import axios from 'axios';
import chalk from 'chalk';
import { authFailedLine, formatApiFailure, getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { resolveProjectSlug } from '../utils/project-ref';
import { isUsableProjectRef } from './project-view';

export interface ScheduleStateOptions {
    env?: string;
}

type ScheduleTarget = 'enable' | 'disable';

function renderScheduleStateError(error: any, projectName: string, scheduleId: string, host: string): never {
    if (error.response) {
        if (error.response.status === 401) {
            console.error(chalk.red(authFailedLine(host)));
        } else if (error.response.status === 404) {
            console.error(chalk.red(error.response.data?.message ?? `Project "${projectName}" or schedule ${scheduleId} not found.`));
        } else if (error.response.status === 422) {
            console.error(chalk.red(error.response.data?.message ?? 'Validation error.'));
        } else {
            console.error(chalk.red(formatApiFailure(error.response.status, error.response.data)));
        }
    } else {
        console.error(chalk.red('Connection failed:'), error.message);
    }
    process.exit(1);
}

async function setScheduleTarget(
    projectName: string,
    scheduleId: string,
    target: ScheduleTarget,
    options: ScheduleStateOptions = {},
): Promise<void> {
    const config = await requireConfigWithWorkspace();
    const enabled = target === 'enable';

    if (!isUsableProjectRef(projectName, options.env)) return;

    try {
        const projectSlug = await resolveProjectSlug(config, projectName, options.env);
        await axios.patch(
            `${config.host}/api/v1/projects/${encodeURIComponent(projectSlug)}/schedules/${encodeURIComponent(scheduleId)}`,
            { enabled },
            { headers: getApiHeaders(config, 'application/json') },
        );
        console.log(chalk.green(`Schedule ${scheduleId} ${enabled ? 'enabled' : 'disabled'}.`));
        console.log(chalk.gray('This is a sticky override and survives redeploy until changed or reset.'));
    } catch (error: any) {
        renderScheduleStateError(error, projectName, scheduleId, config.host);
    }
}

export async function scheduleEnable(
    projectName: string,
    scheduleId: string,
    options: ScheduleStateOptions = {},
): Promise<void> {
    await setScheduleTarget(projectName, scheduleId, 'enable', options);
}

export async function scheduleDisable(
    projectName: string,
    scheduleId: string,
    options: ScheduleStateOptions = {},
): Promise<void> {
    await setScheduleTarget(projectName, scheduleId, 'disable', options);
}

export async function scheduleReset(
    projectName: string,
    scheduleId: string,
    options: ScheduleStateOptions = {},
): Promise<void> {
    const config = await requireConfigWithWorkspace();

    if (!isUsableProjectRef(projectName, options.env)) return;

    try {
        const projectSlug = await resolveProjectSlug(config, projectName, options.env);
        await axios.post(
            `${config.host}/api/v1/projects/${encodeURIComponent(projectSlug)}/schedules/${encodeURIComponent(scheduleId)}/reset`,
            {},
            { headers: getApiHeaders(config, 'application/json') },
        );
        console.log(chalk.green(`Schedule ${scheduleId} reset. YAML controls this schedule again.`));
    } catch (error: any) {
        renderScheduleStateError(error, projectName, scheduleId, config.host);
    }
}

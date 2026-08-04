import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { projectSlugForView } from './project-view';

export interface ScheduleStateOptions {
    env?: string;
}

type ScheduleTarget = 'enable' | 'disable';

function renderScheduleStateError(error: any, projectName: string, scheduleId: string): never {
    if (error.response) {
        if (error.response.status === 401) {
            console.error(chalk.red('Authentication failed. Run "solidactions login --global" to re-configure.'));
        } else if (error.response.status === 404) {
            console.error(chalk.red(error.response.data?.message ?? `Project "${projectName}" or schedule ${scheduleId} not found.`));
        } else if (error.response.status === 422) {
            console.error(chalk.red(error.response.data?.message ?? 'Validation error.'));
        } else {
            console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data?.message ?? error.response.data);
        }
    } else {
        console.error(chalk.red('Connection failed:'), error.message);
    }
    process.exit(1);
}

function resolveProjectSlug(projectName: string, options: ScheduleStateOptions): string {
    try {
        return projectSlugForView(projectName, options.env);
    } catch (error: any) {
        console.error(chalk.red(error.message));
        process.exit(1);
    }
}

async function setScheduleTarget(
    projectName: string,
    scheduleId: string,
    target: ScheduleTarget,
    options: ScheduleStateOptions = {},
): Promise<void> {
    const config = await requireConfigWithWorkspace();
    const projectSlug = resolveProjectSlug(projectName, options);
    const enabled = target === 'enable';

    try {
        await axios.patch(
            `${config.host}/api/v1/projects/${encodeURIComponent(projectSlug)}/schedules/${encodeURIComponent(scheduleId)}`,
            { enabled },
            { headers: getApiHeaders(config, 'application/json') },
        );
        console.log(chalk.green(`Schedule ${scheduleId} ${enabled ? 'enabled' : 'disabled'}.`));
        console.log(chalk.gray('This is a sticky override and survives redeploy until changed or reset.'));
    } catch (error: any) {
        renderScheduleStateError(error, projectName, scheduleId);
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
    const projectSlug = resolveProjectSlug(projectName, options);

    try {
        await axios.post(
            `${config.host}/api/v1/projects/${encodeURIComponent(projectSlug)}/schedules/${encodeURIComponent(scheduleId)}/reset`,
            {},
            { headers: getApiHeaders(config, 'application/json') },
        );
        console.log(chalk.green(`Schedule ${scheduleId} reset. YAML controls this schedule again.`));
    } catch (error: any) {
        renderScheduleStateError(error, projectName, scheduleId);
    }
}

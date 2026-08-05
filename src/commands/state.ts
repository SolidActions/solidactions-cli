import axios from 'axios';
import chalk from 'chalk';
import { formatValidationError, getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import type { Config } from '../utils/config';
import { buildProjectSlug } from '../utils/slug';

export type StateEnvironment = 'production' | 'staging' | 'dev';

export interface StateCommandOptions {
    env?: string;
}

type StateTarget =
    | { type: 'project'; project: string }
    | { type: 'workflow'; project: string; workflow: string };

const STATE_ENVIRONMENTS: StateEnvironment[] = ['production', 'staging', 'dev'];

export function resolveStateEnvironment(environment?: string): StateEnvironment {
    const resolved = environment ?? 'dev';
    if (!STATE_ENVIRONMENTS.includes(resolved as StateEnvironment)) {
        throw new Error('Environment must be production, staging, or dev.');
    }

    return resolved as StateEnvironment;
}

export function projectSlugForState(project: string, environment: StateEnvironment): string {
    const slug = buildProjectSlug(project, environment);
    if (!slug || slug === `-${environment}`) {
        throw new Error('Project must contain at least one letter or number.');
    }

    return slug;
}

function stateUrl(config: Config, target: StateTarget, environment: StateEnvironment): string {
    const projectSlug = encodeURIComponent(projectSlugForState(target.project, environment));
    const base = `${config.host}/api/v1/projects/${projectSlug}`;

    if (target.type === 'workflow') {
        return `${base}/workflows/${encodeURIComponent(target.workflow)}/enabled`;
    }

    return `${base}/enabled`;
}

function inverseVerb(enabled: boolean): 'enable' | 'disable' {
    return enabled ? 'disable' : 'enable';
}

function printDisableResult(target: StateTarget, environment: StateEnvironment): void {
    if (target.type === 'workflow') {
        console.log(chalk.green(`Workflow "${target.workflow}" in project "${target.project}" (${environment}) disabled.`));
    } else {
        console.log(chalk.green(`Project "${target.project}" (${environment}) disabled.`));
    }

    console.log('New root starts are blocked through CLI/API, schedules, webhooks, MCP, manual dead-letter retry, and manual rerun paths.');
    console.log('Already-created roots continue, including their queued work, automatic retries, child legs, sleeping/signal-waiting phases, and running work.');
    console.log('Deploy will not undo this manual state.');
}

function printEnableResult(target: StateTarget, environment: StateEnvironment): void {
    if (target.type === 'workflow') {
        console.log(chalk.green(`Workflow "${target.workflow}" in project "${target.project}" (${environment}) enabled.`));
        console.log('Direct starts require an enabled parent project.');
        console.log('Scheduled starts additionally require an enabled schedule.');
        console.log('Enabling this workflow does not enable its project or schedule.');
    } else {
        console.log(chalk.green(`Project "${target.project}" (${environment}) enabled.`));
        console.log('Direct starts require an enabled target workflow.');
        console.log('Scheduled starts additionally require an enabled schedule.');
        console.log('Enabling this project does not enable its workflows or schedules.');
    }

    console.log('Deploy will not undo this manual state.');
}

function printInverseCommand(target: StateTarget, environment: StateEnvironment, enabled: boolean): void {
    const verb = inverseVerb(enabled);
    const command = target.type === 'workflow'
        ? `solidactions workflow ${verb} ${target.project} ${target.workflow} --env ${environment}`
        : `solidactions project ${verb} ${target.project} --env ${environment}`;

    console.log(chalk.gray(`Undo: ${command}`));
}

function errorMessage(error: any, target: StateTarget): string {
    if (!error.response) {
        return `Connection failed: ${error.message}`;
    }

    if (error.response.status === 401) {
        return 'Authentication failed. Run "solidactions login --global" to re-configure.';
    }

    if (error.response.status === 422) {
        return formatValidationError(error.response.data);
    }

    const serverMessage = error.response.data?.message;
    if (typeof serverMessage === 'string' && serverMessage.trim() !== '') {
        return serverMessage;
    }

    if (error.response.status === 404) {
        return target.type === 'workflow'
            ? `Project or workflow "${target.workflow}" not found.`
            : `Project "${target.project}" not found.`;
    }

    return `Failed to update state: ${error.response.status}`;
}

export async function setStateWithConfig(
    target: StateTarget,
    enabled: boolean,
    options: StateCommandOptions,
    config: Config,
): Promise<void> {
    let environment: StateEnvironment;
    let url: string;
    try {
        environment = resolveStateEnvironment(options.env);
        url = stateUrl(config, target, environment);
    } catch (error: any) {
        console.error(chalk.red(error.message));
        process.exit(1);
        return;
    }

    try {
        await axios.put(
            url,
            { enabled },
            { headers: getApiHeaders(config, 'application/json') },
        );

        if (enabled) {
            printEnableResult(target, environment);
        } else {
            printDisableResult(target, environment);
        }
        printInverseCommand(target, environment, enabled);
    } catch (error: any) {
        console.error(chalk.red(errorMessage(error, target)));
        process.exit(1);
    }
}

async function setState(target: StateTarget, enabled: boolean, options: StateCommandOptions): Promise<void> {
    const config = await requireConfigWithWorkspace();
    await setStateWithConfig(target, enabled, options, config);
}

export async function projectEnable(project: string, options: StateCommandOptions = {}): Promise<void> {
    await setState({ type: 'project', project }, true, options);
}

export async function projectDisable(project: string, options: StateCommandOptions = {}): Promise<void> {
    await setState({ type: 'project', project }, false, options);
}

export async function workflowEnable(
    project: string,
    workflow: string,
    options: StateCommandOptions = {},
): Promise<void> {
    await setState({ type: 'workflow', project, workflow }, true, options);
}

export async function workflowDisable(
    project: string,
    workflow: string,
    options: StateCommandOptions = {},
): Promise<void> {
    await setState({ type: 'workflow', project, workflow }, false, options);
}

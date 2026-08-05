import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import type { Config } from '../utils/config';
import { sanitizeDisplayText } from '../utils/source-provenance';
import { workflowEffectiveState } from '../utils/workflow-state';
import { projectSlugForState, resolveStateEnvironment } from './state';

export interface WorkflowViewOptions {
    env?: string;
    json?: boolean;
}

export interface WorkflowViewData {
    type: 'workflow';
    name: string;
    slug: string;
    enabled: boolean;
    enabled_source: 'manual' | 'yaml';
    retired: boolean;
    project_enabled: boolean;
    effective_enabled: boolean;
    project_name: string;
    project_slug: string;
    environment: string;
    [key: string]: unknown;
}

interface AmbiguityCandidate {
    slug?: unknown;
    retired?: unknown;
}

function display(value: unknown, fallback = 'unknown', maxLength = 255): string {
    return sanitizeDisplayText(value, maxLength) ?? fallback;
}

// The API's `enabled_source` stays `manual|yaml` even when a workflow is
// retired: retirement (app WorkflowSyncService.php:80) nulls `yaml_enabled`
// but the projection doesn't special-case retirement, so a non-overridden
// retired workflow still reports 'yaml'. Decided NOT to add a third API
// value for this (see app plan decision ledger for #1098's PM fix round) —
// fix the contradictory wording here instead.
function enabledSourceLabel(source: unknown, retired: boolean): string {
    if (source === 'manual') return 'manual override (deploy will not change it)';
    if (source === 'yaml') return retired ? 'YAML-managed (retired)' : 'YAML declaration';
    return display(source);
}

export function formatWorkflowView(workflow: WorkflowViewData): string[] {
    return [
        `Workflow: ${display(workflow.name)}`,
        `Slug: ${display(workflow.slug)}`,
        `Project: ${display(workflow.project_name)}`,
        `Project slug: ${display(workflow.project_slug)}`,
        `Environment: ${display(workflow.environment, 'unknown', 32)}`,
        `Workflow enabled: ${workflow.enabled ? 'on' : 'off'}`,
        `Enabled source: ${enabledSourceLabel(workflow.enabled_source, workflow.retired)}`,
        `Project enabled: ${workflow.project_enabled ? 'on' : 'off'}`,
        `Retired: ${workflow.retired ? 'yes' : 'no'}`,
        `Effective state: ${workflowEffectiveState(workflow)}`,
    ];
}

function serverMessage(error: any, fallback: string): string {
    return display(error.response?.data?.message, fallback, 500);
}

function printAmbiguity(error: any): void {
    console.error(chalk.red(serverMessage(error, 'More than one workflow has that name.')));

    const candidates = Array.isArray(error.response?.data?.candidates)
        ? error.response.data.candidates as AmbiguityCandidate[]
        : [];
    for (const candidate of candidates) {
        const slug = display(candidate.slug);
        const lifecycle = candidate.retired === true ? 'retired' : 'active';
        console.error(`  ${slug} (${lifecycle})`);
    }
    console.error('Re-run with an exact slug.');
}

function printWorkflowViewError(error: any): void {
    if (!error.response) {
        console.error(chalk.red('Connection failed:'), display(error.message, 'Unknown network error.', 500));
        return;
    }

    if (error.response.status === 401) {
        console.error(chalk.red('Authentication failed. Run "solidactions login --global" to re-configure.'));
        return;
    }

    // The GET workflow endpoint uses the v1 {code, message} convention;
    // fall back to the legacy `error` key defensively (e.g. older servers,
    // or the sibling PUT .../enabled route, which still uses `error`).
    const errorCode = error.response.data?.code ?? error.response.data?.error;
    if (error.response.status === 409 && errorCode === 'ambiguous_workflow') {
        printAmbiguity(error);
        return;
    }

    const fallback = error.response.status === 404
        ? 'Project or workflow not found.'
        : `Failed to view workflow: ${error.response.status}`;
    console.error(chalk.red(serverMessage(error, fallback)));
}

export async function workflowViewWithConfig(
    project: string,
    workflow: string,
    options: WorkflowViewOptions,
    config: Config,
): Promise<void> {
    let projectSlug: string;
    try {
        const environment = resolveStateEnvironment(options.env);
        projectSlug = projectSlugForState(project, environment);
    } catch (error: any) {
        console.error(chalk.red(error.message));
        process.exit(1);
        return;
    }

    try {
        const response = await axios.get(
            `${config.host}/api/v1/projects/${encodeURIComponent(projectSlug)}/workflows/${encodeURIComponent(workflow)}`,
            { headers: getApiHeaders(config) },
        );
        const data: WorkflowViewData = response.data.data;

        if (options.json) {
            process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
            return;
        }

        for (const line of formatWorkflowView(data)) {
            console.log(line);
        }
    } catch (error: any) {
        printWorkflowViewError(error);
        process.exit(1);
    }
}

export async function workflowView(
    project: string,
    workflow: string,
    options: WorkflowViewOptions = {},
): Promise<void> {
    const config = await requireConfigWithWorkspace();
    await workflowViewWithConfig(project, workflow, options, config);
}

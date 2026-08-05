// src/utils/webhook-formatters.ts
import chalk from 'chalk';
import { workflowEffectiveState, type WorkflowEffectiveState } from './workflow-state';

export interface WebhookRow {
    workflow_name?: string;
    workflow_slug?: string;
    webhook_path_url?: string;
    webhook_url?: string;
    webhook_secret?: string;
    enabled?: boolean;
    project_enabled?: boolean;
    retired?: boolean;
    effective_enabled?: boolean;
}

export interface FormatOptions {
    showSecrets: boolean;
}

function columnWidth(min: number, values: string[]): number {
    return Math.max(min, ...values.map(v => v.length)) + 2;
}

export type WebhookState = WorkflowEffectiveState;

export function webhookState(webhook: WebhookRow): WebhookState {
    return workflowEffectiveState(webhook);
}

function colorizeState(state: WebhookState, width: number): string {
    const padded = state.padEnd(width);
    if (state === 'on') return chalk.green(padded);
    if (state === 'off') return chalk.red(padded);
    if (state === 'blocked (project off)') return chalk.yellow(padded);
    return chalk.gray(padded);
}

export function formatTable(webhooks: WebhookRow[], opts: FormatOptions): string[] {
    const names = webhooks.map(w => w.workflow_name || w.workflow_slug || '?');
    const states = webhooks.map(webhookState);
    const urls = webhooks.map(w => w.webhook_path_url || w.webhook_url || '?');

    const nameWidth = columnWidth(30, names);
    const stateWidth = columnWidth(22, states);
    const urlWidth = columnWidth(60, urls);

    const headerPlain = opts.showSecrets
        ? 'WORKFLOW'.padEnd(nameWidth) + 'STATE'.padEnd(stateWidth) + 'URL'.padEnd(urlWidth) + 'SECRET'
        : 'WORKFLOW'.padEnd(nameWidth) + 'STATE'.padEnd(stateWidth) + 'URL';

    const dividerWidth = opts.showSecrets
        ? nameWidth + stateWidth + urlWidth + 64
        : nameWidth + stateWidth + urlWidth;

    const lines: string[] = [];
    lines.push(chalk.gray(headerPlain));
    lines.push(chalk.gray('-'.repeat(dividerWidth)));

    for (let i = 0; i < webhooks.length; i++) {
        const name = names[i];
        const state = states[i];
        const url = urls[i];
        let line = name.padEnd(nameWidth)
            + colorizeState(state, stateWidth)
            + chalk.cyan(url.padEnd(urlWidth));
        if (opts.showSecrets) {
            const secret = webhooks[i].webhook_secret || '-';
            line += chalk.gray(secret);
        }
        lines.push(line);
    }

    return lines;
}

export function formatJson(webhooks: WebhookRow[], opts: FormatOptions): string {
    const rows = webhooks.map(w => {
        const base: {
            workflow: string | null;
            url: string | null;
            state: WebhookState;
            enabled?: boolean;
            project_enabled?: boolean;
            retired?: boolean;
            effective_enabled?: boolean;
            secret?: string;
        } = {
            workflow: w.workflow_name ?? w.workflow_slug ?? null,
            url: w.webhook_path_url ?? w.webhook_url ?? null,
            state: webhookState(w),
            enabled: w.enabled,
            project_enabled: w.project_enabled,
            retired: w.retired,
            effective_enabled: w.effective_enabled,
        };
        if (opts.showSecrets) {
            base.secret = w.webhook_secret ?? '';
        }
        return base;
    });
    return JSON.stringify(rows, null, 2);
}

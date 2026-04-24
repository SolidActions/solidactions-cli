// src/utils/webhook-formatters.ts
import chalk from 'chalk';

export interface WebhookRow {
    workflow_name?: string;
    workflow_slug?: string;
    webhook_path_url?: string;
    webhook_url?: string;
    webhook_secret?: string;
}

export interface FormatOptions {
    showSecrets: boolean;
}

function columnWidth(min: number, values: string[]): number {
    return Math.max(min, ...values.map(v => v.length)) + 2;
}

export function formatTable(webhooks: WebhookRow[], opts: FormatOptions): string[] {
    const names = webhooks.map(w => w.workflow_name || w.workflow_slug || '?');
    const urls = webhooks.map(w => w.webhook_path_url || w.webhook_url || '?');

    const nameWidth = columnWidth(30, names);
    const urlWidth = columnWidth(60, urls);

    const headerPlain = opts.showSecrets
        ? 'WORKFLOW'.padEnd(nameWidth) + 'URL'.padEnd(urlWidth) + 'SECRET'
        : 'WORKFLOW'.padEnd(nameWidth) + 'URL';

    const dividerWidth = opts.showSecrets ? nameWidth + urlWidth + 64 : nameWidth + urlWidth;

    const lines: string[] = [];
    lines.push(chalk.gray(headerPlain));
    lines.push(chalk.gray('-'.repeat(dividerWidth)));

    for (let i = 0; i < webhooks.length; i++) {
        const name = names[i];
        const url = urls[i];
        let line = name.padEnd(nameWidth) + chalk.cyan(url.padEnd(urlWidth));
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
        const base: { workflow: string | null; url: string | null; secret?: string } = {
            workflow: w.workflow_name ?? w.workflow_slug ?? null,
            url: w.webhook_path_url ?? w.webhook_url ?? null,
        };
        if (opts.showSecrets) {
            base.secret = w.webhook_secret ?? '';
        }
        return base;
    });
    return JSON.stringify(rows, null, 2);
}

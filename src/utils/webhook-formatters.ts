// src/utils/webhook-formatters.ts
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

export function formatTable(_webhooks: WebhookRow[], _opts: FormatOptions): string[] {
    throw new Error('formatTable: not implemented');
}

export function formatJson(_webhooks: WebhookRow[], _opts: FormatOptions): string {
    throw new Error('formatJson: not implemented');
}

import chalk from 'chalk';
import { requireConfigWithWorkspace } from '../utils/api';
import { shellArg } from '../utils/connect-link';
import { callProjectsSandbox } from '../utils/mcp';
import { err, out } from '../utils/output';

export interface AppPreviewOptions {
    page?: string;
}

function fail(line: string): never {
    err(line, chalk.red);
    process.exit(1);
}

/** The doc id for --page, or null when it is not a positive whole number a JSON integer can hold. */
function parsePage(value: string): number | null {
    if (!/^[1-9][0-9]*$/.test(value)) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
}

export async function appPreview(app: string, options: AppPreviewOptions): Promise<void> {
    const project = app.trim();
    if (project === '') {
        fail('app preview: give the app name, e.g. solidactions app preview my-app.');
    }
    const args: Record<string, unknown> = { action: 'preview_link', project };
    if (options.page !== undefined) {
        const page = parsePage(options.page);
        if (page === null) {
            fail("app preview: --page needs a whole number (the page's doc id), e.g. --page 12.");
        }
        args.page = page;
    }

    const config = await requireConfigWithWorkspace();

    let result: Awaited<ReturnType<typeof callProjectsSandbox>>;
    try {
        result = await callProjectsSandbox(config, args);
    } catch (error: any) {
        fail(`error: ${error.message}`);
    }

    if (!result.ok) {
        const refusal = result.data?.error ?? result.data ?? {};
        const code = typeof refusal.code === 'string' ? refusal.code : '';
        const message = typeof refusal.message === 'string' && refusal.message !== ''
            ? refusal.message
            : code !== '' ? code : 'the server refused the request';
        err(`error: ${message}`, chalk.red);
        if (code === 'no_dev_copy') {
            err(`Deploy it to dev first: solidactions project deploy ${shellArg(project)} . -e dev`, chalk.red);
        } else if (code === 'rate_limited' && typeof refusal.retry_after === 'number') {
            err(`Try again in ${refusal.retry_after} seconds.`, chalk.red);
        } else if (code === 'invalid_action') {
            err('This server may be older than the CLI expects: preview links need app v0.295.0 or later.', chalk.red);
        }
        process.exit(1);
    }

    const data = result.data ?? {};
    if (typeof data.link !== 'string' || data.link === '') {
        fail('Failed: the server answered without a preview link.');
    }

    out(`Preview link for ${project} (dev copy):`);
    // Same style as the device-login URL: two-space indent, blue underline, the link alone on its line.
    out('  ' + data.link, chalk.blue.underline);
    if (typeof data.note === 'string' && data.note !== '') {
        out(data.note);
    }
    if (data.shares_production_data === true) {
        const names = Array.isArray(data.databases) && data.databases.length > 0
            ? data.databases.filter((name: unknown) => typeof name === 'string').join(', ')
            : 'unknown';
        out(`Warning: this dev copy shares data with production (databases: ${names || 'unknown'}). What you press in the preview changes that data.`, chalk.yellow);
    }
}

import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { ConnectLink, connectLinkFailureLine, connectLinkPath, formatExpiry, plainText, waitCommandLine } from '../utils/connect-link';

export const WAIT_POLL_INTERVAL_MS = 5_000;
export const WAIT_DEFAULT_TIMEOUT = '15m';
export const WAIT_MAX_FAILED_CHECKS = 5;
export const WAIT_EXIT_TIMEOUT = 2;
export const WAIT_EXIT_INTERRUPTED = 130;

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };
const MAX_TIMEOUT_MS = 24 * 3_600_000;

export interface ConnectionWaitOptions {
    timeout?: string;
}

export function parseWaitTimeout(value: string): number {
    const match = /^(\d+)([smh]?)$/.exec(value.trim());
    if (!match) {
        throw new Error(`--timeout must look like 30s, 15m or 1h (got "${value}").`);
    }
    const ms = Number(match[1]) * UNIT_MS[match[2] || 's'];
    if (ms < 1_000 || ms > MAX_TIMEOUT_MS) {
        throw new Error('--timeout must be between 1s and 24h.');
    }
    return ms;
}

function pollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
    if (env.SOLIDACTIONS_TEST_HOOKS === '1') {
        const override = Number(env.SOLIDACTIONS_CONNECTION_WAIT_INTERVAL_MS);
        if (Number.isInteger(override) && override > 0) return override;
    }
    return WAIT_POLL_INTERVAL_MS;
}

function isTransient(error: any): boolean {
    const status = error?.response?.status;
    return status === undefined || status === 429 || status >= 500;
}

function fail(line: string, code = 1): never {
    console.error(chalk.red(plainText(line)));
    process.exit(code);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryCommand(link: ConnectLink): string {
    const flag = link.mode === 'reconnect' ? '--reconnect' : '--name';
    return `solidactions connection connect ${link.platform} ${flag} ${link.name}`;
}

function printConnected(link: ConnectLink): void {
    const name = link.connection?.name ?? link.name;
    const by = link.connected_by?.name ? `, by ${link.connected_by.name}` : '';
    console.log(plainText(`Connected: ${name} (${link.platform_name})${by}.`));
    if (!link.bindings || link.bindings.length === 0) {
        console.log('Bindings: none.');
        return;
    }
    for (const binding of link.bindings) {
        console.log(plainText(`  project ${binding.project} uses it as ${binding.var}`));
    }
}

export async function connectionWait(requestId: string, options: ConnectionWaitOptions): Promise<void> {
    const timeoutText = (options.timeout ?? WAIT_DEFAULT_TIMEOUT).trim();
    let timeoutMs = 0;
    try {
        timeoutMs = parseWaitTimeout(timeoutText);
    } catch (error: any) {
        fail(`connection wait: ${error.message}`);
    }

    const config = await requireConfigWithWorkspace();

    // Ctrl-C: the link stays open on the server; say how to pick the wait up again.
    process.once('SIGINT', () => {
        console.error(chalk.gray(plainText(`Still waiting: resume with ${waitCommandLine(requestId)}`)));
        process.exit(WAIT_EXIT_INTERRUPTED);
    });

    const interval = pollIntervalMs();
    const deadline = Date.now() + timeoutMs;
    let failedChecks = 0;
    let last: ConnectLink | null = null;
    let announced = false;

    while (true) {
        try {
            const response = await axios.get(`${config.host}${connectLinkPath(requestId)}`, { headers: getApiHeaders(config) });
            failedChecks = 0;
            last = response.data as ConnectLink;
            switch (last.status) {
                case 'connected':
                    printConnected(last);
                    return;
                case 'expired':
                    fail(`Connect link ${last.id} expired before anyone connected ${last.name}. Ask for a new one: ${retryCommand(last)}`);
                case 'cancelled':
                    fail(`Connect link ${last.id} for ${last.name} was cancelled.`);
                case 'requested':
                case 'opened':
                    if (!announced) {
                        console.log(plainText(`Waiting for someone to connect ${last.platform_name} as ${last.name} (request ${last.id}, link expires ${formatExpiry(last.expires_at)}).`));
                        announced = true;
                    }
                    break;
                default:
                    fail(`Failed: connect link ${requestId} has an unknown status "${String(last.status)}".`);
            }
        } catch (error: any) {
            if (!isTransient(error)) {
                fail(connectLinkFailureLine(error, config.host));
            }
            failedChecks += 1;
            if (failedChecks >= WAIT_MAX_FAILED_CHECKS) {
                fail(`${connectLinkFailureLine(error, config.host)} (gave up after ${WAIT_MAX_FAILED_CHECKS} failed checks in a row)`);
            }
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            const state = last ? `is ${last.status}` : 'status unknown (last check failed)';
            const expires = last?.expires_at ? ` (link expires ${formatExpiry(last.expires_at)})` : '';
            fail(`Still waiting after ${timeoutText}: connect link ${requestId} ${state}${expires}. Run ${waitCommandLine(requestId)} again to keep waiting.`, WAIT_EXIT_TIMEOUT);
        }
        await sleep(Math.min(interval, remaining));
    }
}

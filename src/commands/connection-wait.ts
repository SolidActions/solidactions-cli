import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { ConnectLink, connectLinkFailureLine, formatExpiry, shellArg, waitCommandLine } from '../utils/connect-link';
import { err, out } from '../utils/output';

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

/** True for the abort our own deadline timer fires (axios rejects with a CanceledError). */
function isDeadlineAbort(error: any): boolean {
    return error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError';
}

/**
 * True only for a usable status payload: a non-null object with a string
 * `status`, plus the fields each status prints (`name`, `platform_name`,
 * `expires_at` for requested/opened; `name`, `platform`, `mode` for expired,
 * feeding the retry command; `name`, `platform_name` for connected, feeding
 * the `Connected:` line). Anything else is answered with the one-line
 * unusable-status failure, never a retry.
 */
function hasUsableStatus(body: unknown): body is ConnectLink {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return false;
    }
    const link = body as ConnectLink;
    if (typeof link.status !== 'string') {
        return false;
    }
    if (link.status === 'requested' || link.status === 'opened') {
        return typeof link.name === 'string' && typeof link.platform_name === 'string' && typeof link.expires_at === 'string';
    }
    if (link.status === 'expired') {
        return typeof link.name === 'string' && typeof link.platform === 'string' && typeof link.mode === 'string';
    }
    if (link.status === 'connected') {
        return typeof link.name === 'string' && typeof link.platform_name === 'string';
    }
    return true;
}

/**
 * The `connected`-payload fields `printConnected` consumes, checked before
 * anything is printed: `bindings` (missing means none) must be an array of
 * objects with string `project`/`var`; `connection`/`connected_by` must be
 * null or objects. Returns the one failure line, or null when usable.
 */
function connectedPayloadProblem(link: ConnectLink): string | null {
    const id = typeof link.id === 'string' ? link.id : 'unknown';
    if (link.bindings !== undefined && link.bindings !== null) {
        if (!Array.isArray(link.bindings)) {
            return `Failed: connect link ${id} answered connected with unusable bindings.`;
        }
        for (const binding of link.bindings) {
            if (typeof binding !== 'object' || binding === null || typeof binding.project !== 'string' || typeof binding.var !== 'string') {
                return `Failed: connect link ${id} answered connected with unusable bindings.`;
            }
        }
    }
    for (const key of ['connection', 'connected_by'] as const) {
        const value = link[key];
        if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) {
            return `Failed: connect link ${id} answered connected with an unusable ${key}.`;
        }
    }
    return null;
}

function fail(line: string, code = 1): never {
    err(line, chalk.red);
    process.exit(code);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryCommand(link: ConnectLink): string {
    const flag = link.mode === 'reconnect' ? '--reconnect' : '--name';
    return `solidactions connection connect ${shellArg(link.platform)} ${flag} ${shellArg(link.name)}`;
}

function printConnected(link: ConnectLink): void {
    const name = link.connection?.name ?? link.name;
    const by = link.connected_by?.name ? `, by ${link.connected_by.name}` : '';
    out(`Connected: ${name} (${link.platform_name})${by}.`);
    if (!link.bindings || link.bindings.length === 0) {
        out('Bindings: none.');
        return;
    }
    for (const binding of link.bindings) {
        out(`  project ${binding.project} uses it as ${binding.var}`);
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
        err(`Still waiting: resume with ${waitCommandLine(requestId)}`, chalk.gray);
        process.exit(WAIT_EXIT_INTERRUPTED);
    });

    const interval = pollIntervalMs();
    const deadline = Date.now() + timeoutMs;
    let failedChecks = 0;
    let last: ConnectLink | null = null;
    let announced = false;

    function failTimeout(): never {
        const state = last ? `is ${last.status}` : 'status unknown (last check failed)';
        const expires = last?.expires_at ? ` (link expires ${formatExpiry(last.expires_at)})` : '';
        fail(`Still waiting after ${timeoutText}: connect link ${requestId} ${state}${expires}. Run ${waitCommandLine(requestId)} again to keep waiting.`, WAIT_EXIT_TIMEOUT);
    }

    while (true) {
        // Admission: never send a request once the deadline has passed. The
        // sleep below wakes at the deadline at the latest, so reaching here
        // past it means the budget is spent without another GET.
        if (Date.now() >= deadline) {
            failTimeout();
        }
        const remaining = deadline - Date.now();
        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), remaining);
        let statusResponse: { data: unknown };
        try {
            // Transport only: this catch counts failed CHECKS (network, 429,
            // 5xx) and handles the abort/timeout path. Interpreting the 200
            // below runs outside this catch, so a payload that cannot be used
            // can never be counted as a transient failure.
            statusResponse = await axios.get(`${config.host}/api/v1/connections/requests/${encodeURIComponent(requestId)}`, {
                headers: getApiHeaders(config),
                signal: controller.signal,
            });
        } catch (error: any) {
            clearTimeout(abortTimer);
            // Our own deadline abort is the timeout, not a transient failure:
            // the link may still be open, so keep the exit-2 resume behavior.
            if (isDeadlineAbort(error)) {
                failTimeout();
            }
            if (!isTransient(error)) {
                fail(connectLinkFailureLine(error, config.host));
            }
            failedChecks += 1;
            if (failedChecks >= WAIT_MAX_FAILED_CHECKS) {
                fail(`${connectLinkFailureLine(error, config.host)} (gave up after ${WAIT_MAX_FAILED_CHECKS} failed checks in a row)`);
            }
            const after = deadline - Date.now();
            if (after <= 0) {
                failTimeout();
            }
            await sleep(Math.min(interval, after));
            continue;
        }
        clearTimeout(abortTimer);
        try {
            if (!hasUsableStatus(statusResponse.data)) {
                fail(`Failed: connect link ${requestId}: the server's answer has no usable status.`);
            }
            last = statusResponse.data;
            switch (last.status) {
                case 'connected': {
                    const problem = connectedPayloadProblem(last);
                    if (problem !== null) {
                        fail(problem);
                    }
                    printConnected(last);
                    return;
                }
                case 'expired':
                    fail(`Connect link ${last.id} expired before anyone connected ${last.name}. Ask for a new one: ${retryCommand(last)}`);
                case 'cancelled':
                    fail(`Connect link ${last.id} for ${last.name} was cancelled.`);
                case 'requested':
                case 'opened':
                    if (!announced) {
                        out(`Waiting for someone to connect ${last.platform_name} as ${last.name} (request ${last.id}, link expires ${formatExpiry(last.expires_at)}).`);
                        announced = true;
                    }
                    break;
                default:
                    fail(`Failed: connect link ${requestId} has an unknown status "${String(last.status)}".`);
            }
        } catch {
            // Interpreting a 200 never retries and never exits 2: any failure
            // to use the payload is the same one-line answer as I2.
            fail(`Failed: connect link ${requestId}: the server's answer has no usable status.`);
        }
        // Only a fully interpreted 200 resets the consecutive-failure count.
        failedChecks = 0;

        const after = deadline - Date.now();
        if (after <= 0) {
            failTimeout();
        }
        await sleep(Math.min(interval, after));
    }
}

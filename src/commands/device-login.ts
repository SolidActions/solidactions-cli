import axios from 'axios';
import chalk from 'chalk';
import { Config } from '../utils/config';
import { fetchWorkspaces, WorkspaceLookupRecord, WorkspaceScope } from '../utils/workspace-lookup';
import {
    completeLogin,
    persistPreflightedLoginCredential,
    preflightDeviceLoginWrite,
    resolveLoginHost,
} from './login';

// Public device-flow client id — not a secret; matches the server-seeded
// oauth_clients row (config('services.cli.oauth_client_id') on the app side).
const CLI_OAUTH_CLIENT_ID = '9f1b6e2a-9c1e-4b6e-8f0a-6c9f2b1e7d4c';

// CLI capability scopes requested at device-code issuance — the server
// rejects any scope not pre-registered via Passport::tokensCan().
const CLI_SCOPES = 'env deploy runs docs';

interface DeviceCodeResponse {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in: number;
    interval: number;
}

export interface TokenResponse {
    access_token: string;
    expires_in: number;
}

export async function requestDeviceCode(host: string): Promise<DeviceCodeResponse> {
    const response = await axios.post(`${host}/oauth/device/code`, {
        client_id: CLI_OAUTH_CLIENT_ID,
        scope: CLI_SCOPES,
    });
    return response.data;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll POST /oauth/token per RFC 8628 §3.5: repeat at `intervalSeconds`,
 * honoring `authorization_pending` (keep polling) and `slow_down` (add
 * `slowDownIncrementSeconds` to the interval and keep polling). Rejects on
 * any other OAuth error, including a server-sent `expired_token`.
 * `slowDownIncrementSeconds` defaults to the RFC-recommended 5s and is only
 * overridden by tests, to keep them fast.
 *
 * `expiresInSeconds` bounds the loop client-side to the device code's own
 * lifetime, so a server that never emits `expired_token` (and just keeps
 * returning `authorization_pending`) can't cause an infinite poll.
 */
export async function pollForToken(
    host: string,
    clientId: string,
    deviceCode: string,
    intervalSeconds: number,
    expiresInSeconds: number,
    slowDownIncrementSeconds = 5,
): Promise<TokenResponse> {
    let interval = intervalSeconds;
    let elapsed = 0;

    while (true) {
        if (elapsed + interval > expiresInSeconds) {
            throw new Error('device code expired — run `solidactions login --device` again');
        }
        await sleep(interval * 1000);
        elapsed += interval;

        try {
            const response = await axios.post(`${host}/oauth/token`, {
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                device_code: deviceCode,
                client_id: clientId,
            });
            return response.data;
        } catch (error: any) {
            const oauthError = error?.response?.data?.error;
            if (oauthError === 'authorization_pending') {
                continue;
            }
            if (oauthError === 'slow_down') {
                interval += slowDownIncrementSeconds;
                continue;
            }
            if (oauthError === 'expired_token') {
                throw new Error('device code expired — run `solidactions login --device` again');
            }
            throw new Error(oauthError || error.message);
        }
    }
}

export async function deviceLogin(
    options: { dev?: boolean; host?: string; workspace?: string; local?: boolean; global?: boolean; gitignore?: boolean },
): Promise<void> {
    const resolved = resolveLoginHost(options);
    const host = resolved.host;
    const preflight = await preflightDeviceLoginWrite(options);

    console.log(chalk.blue('Requesting device authorization...'));
    const code = await requestDeviceCode(host);

    // Deliberately the bare verification_uri, never verification_uri_complete:
    // the server ignores prefilled codes (phishing defense) — the user types
    // the code shown here.
    console.log('');
    console.log(chalk.green('To finish signing in, visit:'));
    console.log('  ' + chalk.blue.underline(code.verification_uri));
    console.log(chalk.gray('  and enter code: ') + chalk.bold(code.user_code));
    console.log('');
    console.log(chalk.gray('Waiting for approval in your browser...'));

    let token: TokenResponse;
    try {
        token = await pollForToken(host, CLI_OAUTH_CLIENT_ID, code.device_code, code.interval || 5, code.expires_in);
    } catch (error: any) {
        console.error(chalk.red('Device login failed:'), error.message);
        process.exit(1);
        return;
    }

    const config: Config = { host, apiKey: token.access_token };
    await persistPreflightedLoginCredential(config, preflight, options);

    let workspaces: WorkspaceLookupRecord[];
    let scope: WorkspaceScope | null;
    try {
        ({ workspaces, scope } = await fetchWorkspaces(config));
    } catch (e: any) {
        if (e.response?.status === 401) {
            console.error(chalk.red(`Authentication was saved to ${preflight.targetPath}, but the server rejected it during workspace discovery.`));
        } else {
            console.error(chalk.red(
                `Authentication was saved to ${preflight.targetPath}, but workspace discovery failed: ${e.message}`,
            ));
        }
        console.error(chalk.yellow('Run `solidactions workspace set <name>` when workspace access is available.'));
        process.exit(1);
        return;
    }

    await completeLogin(config, workspaces, options, scope, preflight);
}

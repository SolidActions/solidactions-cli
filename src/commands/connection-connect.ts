import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import {
    CONNECT_LINK_MAX_BINDINGS,
    ConnectLink,
    ConnectLinkBinding,
    connectLinkFailureLine,
    formatExpiry,
    parseBinding,
    plainText,
    waitCommandLine,
} from '../utils/connect-link';

export interface ConnectionConnectOptions {
    name?: string;
    reconnect?: string;
    bind?: string[];
}

function fail(line: string): never {
    console.error(chalk.red(plainText(line)));
    process.exit(1);
}

export async function connectionConnect(platform: string | undefined, options: ConnectionConnectOptions): Promise<void> {
    if (options.name !== undefined && options.reconnect !== undefined) {
        fail('connection connect: give --name NAME for a new connection or --reconnect NAME for an existing one, not both.');
    }
    const reconnect = options.reconnect !== undefined;
    const name = (reconnect ? options.reconnect : options.name)?.trim() ?? '';
    if (name === '') {
        fail('connection connect: --name NAME is required (or --reconnect NAME to refresh an existing connection).');
    }
    let resolvedPlatform = platform?.trim() ?? '';
    if (!reconnect && resolvedPlatform === '') {
        fail('connection connect: give the platform, e.g. solidactions connection connect gmail --name gmail-main (solidactions oauth-action platforms lists them).');
    }
    const rawBindings = options.bind ?? [];
    if (rawBindings.length > CONNECT_LINK_MAX_BINDINGS) {
        fail(`connection connect: at most ${CONNECT_LINK_MAX_BINDINGS} --bind options.`);
    }
    let bindings: ConnectLinkBinding[] = [];
    try {
        bindings = rawBindings.map(parseBinding);
    } catch (error: any) {
        fail(`connection connect: ${error.message}`);
    }

    const config = await requireConfigWithWorkspace();

    if (resolvedPlatform === '') {
        let connections: Array<{ name?: string; provider?: string }> = [];
        try {
            const response = await axios.get(`${config.host}/api/v1/connections`, { headers: getApiHeaders(config) });
            connections = Array.isArray(response.data?.data) ? response.data.data : [];
        } catch (error: any) {
            fail(`${connectLinkFailureLine(error, config.host)} (looking up ${name}'s platform; give it to skip the lookup: solidactions connection connect <platform> --reconnect ${name})`);
        }
        const match = connections.find((connection) => connection.name === name);
        if (!match?.provider) {
            fail(`No connection named ${name} in this workspace; solidactions connection list shows the names.`);
        }
        resolvedPlatform = match.provider;
    }

    let link: ConnectLink;
    try {
        const response = await axios.post(
            `${config.host}/api/v1/connections/requests`,
            { platform: resolvedPlatform, name, mode: reconnect ? 'reconnect' : 'connect', bindings },
            { headers: getApiHeaders(config, 'application/json') },
        );
        link = response.data;
    } catch (error: any) {
        fail(connectLinkFailureLine(error, config.host));
    }
    if (typeof link?.id !== 'string' || typeof link?.url !== 'string') {
        fail('Failed: the server answered without a connect link.');
    }

    const expiry = typeof link.expires_at === 'string' ? ` (expires ${formatExpiry(link.expires_at)})` : '';
    const text = typeof link.text === 'string' && link.text.trim() !== ''
        ? link.text
        : `Connect link: ${link.url}\nRequest id: ${link.id}${expiry}.`;
    console.log(plainText(text));
    console.log('When it is done, run:');
    console.log(`  ${waitCommandLine(plainText(link.id))}`);
}

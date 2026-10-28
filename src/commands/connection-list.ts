import axios from 'axios';
import chalk from 'chalk';
import { authFailedLine, formatApiFailure, getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { plainText } from '../utils/connect-link';
import { err, out } from '../utils/output';
import { renderTable, sanitizeCell, truncateCell } from '../utils/table';

interface OAuthConnection {
    name: string;
    provider: string;
    status: string;
    error_message: string | null;
    last_used_at: string | null;
    allow_source_use?: boolean;
}

const ERROR_SNIPPET_WIDTH = 40;

function connectionStatus(connection: OAuthConnection): string {
    const status = plainText(connection.status || '?');
    const error = connection.error_message?.trim();

    if (!error) {
        return status;
    }

    return `${status} — ${truncateCell(sanitizeCell(plainText(error)), ERROR_SNIPPET_WIDTH)}`;
}

function sourceUse(connection: OAuthConnection): string {
    if (connection.allow_source_use === true) return 'yes';
    if (connection.allow_source_use === false) return 'no';
    return '-';
}

export async function connectionList(): Promise<void> {
    const config = await requireConfigWithWorkspace();

    try {
        const response = await axios.get(`${config.host}/api/v1/connections`, {
            headers: getApiHeaders(config),
        });
        const connections: OAuthConnection[] = response.data.data || [];

        if (connections.length === 0) {
            out('No connections found.', chalk.gray);
            return;
        }

        out('Connections:\n', chalk.blue);

        const rows = connections.map((connection) => [
            plainText(connection.name || '?'),
            plainText(connection.provider || '?'),
            connectionStatus(connection),
            plainText(connection.last_used_at || '-'),
            sourceUse(connection),
        ]);
        const lines = renderTable(['NAME', 'PROVIDER', 'STATUS', 'LAST USED', 'DATA SOURCE'], rows, {
            minWidths: [24, 14, 20],
        });

        out(lines[0], chalk.gray);
        out(lines[1], chalk.gray);
        for (const line of lines.slice(2)) {
            out(line);
        }

        out('');
        out(`${connections.length} connection(s)`, chalk.gray);
    } catch (error: any) {
        if (error.response?.status === 401) {
            err(authFailedLine(config.host), chalk.red);
        } else if (error.response) {
            err(formatApiFailure(error.response.status, error.response.data), chalk.red);
        } else {
            err(`Connection failed: ${error.message}`, chalk.red);
        }
        process.exit(1);
    }
}

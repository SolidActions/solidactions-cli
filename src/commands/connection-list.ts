import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { renderTable, sanitizeCell, truncateCell } from '../utils/table';

interface OAuthConnection {
    name: string;
    provider: string;
    status: string;
    error_message: string | null;
    last_used_at: string | null;
}

const ERROR_SNIPPET_WIDTH = 40;

function connectionStatus(connection: OAuthConnection): string {
    const status = connection.status || '?';
    const error = connection.error_message?.trim();

    if (!error) {
        return status;
    }

    return `${status} — ${truncateCell(sanitizeCell(error), ERROR_SNIPPET_WIDTH)}`;
}

export async function connectionList(): Promise<void> {
    const config = await requireConfigWithWorkspace();

    try {
        const response = await axios.get(`${config.host}/api/v1/connections`, {
            headers: getApiHeaders(config),
        });
        const connections: OAuthConnection[] = response.data.data || [];

        if (connections.length === 0) {
            console.log(chalk.gray('No connections found.'));
            return;
        }

        console.log(chalk.blue('Connections:\n'));

        const rows = connections.map((connection) => [
            connection.name || '?',
            connection.provider || '?',
            connectionStatus(connection),
            connection.last_used_at || '-',
        ]);
        const lines = renderTable(['NAME', 'PROVIDER', 'STATUS', 'LAST USED'], rows, {
            minWidths: [24, 14, 20],
        });

        console.log(chalk.gray(lines[0]));
        console.log(chalk.gray(lines[1]));
        for (const line of lines.slice(2)) {
            console.log(line);
        }

        console.log('');
        console.log(chalk.gray(`${connections.length} connection(s)`));
    } catch (error: any) {
        if (error.response?.status === 401) {
            console.error(chalk.red('Authentication failed. Run "solidactions login --global" to re-configure.'));
        } else if (error.response) {
            console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

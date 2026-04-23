import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

interface ActionsSearchOptions {
    method?: string;
}

interface PicaAction {
    platform: string;
    method: string;
    path: string;
    title: string;
    action_id: string;
    parameters?: Record<string, any>;
}

export async function actionsSearch(platform: string, query: string | undefined, options: ActionsSearchOptions) {
    const config = await requireConfigWithWorkspace();

    try {
        const params: Record<string, string> = { platform };
        if (query) params.q = query;
        if (options.method) params.method = options.method;

        const response = await axios.get(`${config.host}/api/v1/pica-actions`, {
            headers: getApiHeaders(config),
            params,
        });

        const actions: PicaAction[] = response.data.actions || [];

        if (actions.length === 0) {
            console.log('No actions found.');
            return;
        }

        for (const action of actions) {
            const method = (action.method || 'GET').toUpperCase().padEnd(6);
            const path = action.path || '';
            const title = action.title || '';

            console.log(`${chalk.cyan(method)} ${chalk.white(path.padEnd(55))} ${chalk.gray('— ' + title)}`);

            if (action.parameters && Object.keys(action.parameters).length > 0) {
                const paramsJson = JSON.stringify(action.parameters);
                const trimmed = paramsJson.length > 120 ? paramsJson.substring(0, 117) + '...' : paramsJson;
                console.log(chalk.gray(`  parameters: ${trimmed}`));
            }

            // Build example fetch snippet
            const platformEnvVar = platform.toUpperCase().replace(/-/g, '_');
            const exampleMethod = (action.method || 'GET').toUpperCase();
            const examplePath = path.replace(/\{[^}]+\}/g, (m) => {
                const name = m.slice(1, -1);
                return '${' + name + '}';
            });

            console.log(chalk.gray('  example:'));
            console.log(chalk.gray('    const res = await fetch('));
            console.log(chalk.gray(`      \`\${process.env.SA_PROXY_URL}/${platform}${examplePath}\`,`));
            console.log(chalk.gray(`      { method: '${exampleMethod}', headers: {`));
            console.log(chalk.gray('          Authorization: `Bearer ${process.env.SA_PROXY_TOKEN}`,'));
            console.log(chalk.gray(`          'X-SA-Connection': process.env.YOUR_${platformEnvVar}_CONNECTION,`));
            console.log(chalk.gray('      }});'));
            console.log(chalk.gray('    const data = await res.json();'));
            console.log('');
        }

        console.log(chalk.gray(`${actions.length} action(s) found`));
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions login <api-key>" to re-configure.'));
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

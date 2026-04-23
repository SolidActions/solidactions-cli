import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

interface PicaAction {
    platform: string;
    method: string;
    path: string;
    title: string;
    action_id: string;
}

export async function actionsList(platform: string) {
    const config = await requireConfigWithWorkspace();

    try {
        const response = await axios.get(`${config.host}/api/v1/pica-actions`, {
            headers: getApiHeaders(config),
            params: { platform },
        });

        const actions: PicaAction[] = response.data.actions || [];

        if (actions.length === 0) {
            console.log('No actions found.');
            return;
        }

        for (const action of actions) {
            const method = (action.method || 'GET').toUpperCase().padEnd(6);
            const path = (action.path || '').padEnd(55);
            const title = action.title || '';

            console.log(`${chalk.cyan(method)} ${chalk.white(path)} ${chalk.gray('— ' + title)}`);
        }

        console.log('');
        console.log(chalk.gray(`${actions.length} action(s) — use "solidactions actions search ${platform} <query>" for full detail`));
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

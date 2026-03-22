import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

export async function projectList() {
    const config = await requireConfigWithWorkspace();

    console.log(chalk.blue('Projects:\n'));

    try {
        const response = await axios.get(`${config.host}/api/v1/projects`, {
            headers: getApiHeaders(config),
        });

        const projects = response.data.data || [];

        if (projects.length === 0) {
            console.log(chalk.gray('No projects found.'));
            return;
        }

        console.log(chalk.gray('NAME'.padEnd(25) + 'STATUS'.padEnd(15) + 'SNAPSHOT'.padEnd(30) + 'ENVIRONMENTS'));
        console.log(chalk.gray('-'.repeat(100)));

        for (const project of projects) {
            const name = (project.name || '?').padEnd(25);
            const status = project.status || '?';
            const statusColor = status === 'ready' ? chalk.green : status === 'building' ? chalk.yellow : chalk.gray;
            const snapshot = (project.snapshot_name || '-').padEnd(30);
            const envs = (project.environments || [project.environment || 'production']).join(', ');

            console.log(
                name +
                statusColor(status.padEnd(15)) +
                chalk.gray(snapshot) +
                chalk.gray(envs)
            );
        }

        console.log('');
        console.log(chalk.gray(`${projects.length} project(s)`));
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions init <api-key>" to re-configure.'));
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

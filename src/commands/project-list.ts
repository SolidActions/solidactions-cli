import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { renderTable } from '../utils/table';

interface ProjectListOptions {
    json?: boolean;
}

export async function projectList(options: ProjectListOptions = {}) {
    const config = await requireConfigWithWorkspace();

    try {
        const response = await axios.get(`${config.host}/api/v1/projects`, {
            headers: getApiHeaders(config),
        });

        const projects = response.data.data || [];

        if (options.json) {
            console.log(JSON.stringify(projects, null, 2));
            return;
        }

        // Header is only printed after the fetch succeeds — an auth/network
        // failure used to print "Projects:" followed immediately by the error.
        console.log(chalk.blue('Projects:\n'));

        if (projects.length === 0) {
            console.log(chalk.gray('No projects found.'));
            return;
        }

        const rows = projects.map((project: any) => {
            const envs = (project.environments || [project.environment || 'production']).join(', ');
            return [project.name || '?', project.status || '?', project.snapshot_name || '-', envs];
        });

        const lines = renderTable(['NAME', 'STATUS', 'SNAPSHOT', 'ENVIRONMENTS'], rows, {
            minWidths: [25, 15, 30],
        });
        console.log(chalk.gray(lines[0]));
        console.log(chalk.gray(lines[1]));
        for (const line of lines.slice(2)) {
            console.log(line);
        }

        console.log('');
        console.log(chalk.gray(`${projects.length} project(s)`));
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

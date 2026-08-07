import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { renderTable, sanitizeCell, truncateCell } from '../utils/table';

interface ProjectListOptions {
    json?: boolean;
}

interface EnvironmentDetail {
    environment: string;
    slug: string;
    enabled: boolean;
}

function projectEnvironments(project: any): string {
    const details: EnvironmentDetail[] | undefined = project.environment_details;
    if (Array.isArray(details) && details.length > 0) {
        return details
            .map((detail) => `${detail.environment}:${detail.enabled ? 'on' : 'off'}`)
            .join(', ');
    }

    return (project.environments || [project.environment || 'production']).join(', ');
}

function colorizeEnvironmentStates(value: string): string {
    return value.replace(/\b(on|off)\b/g, (state) => (
        state === 'on' ? chalk.green(state) : chalk.red(state)
    ));
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

        // Reconstruction below colorizes only the final ENVIRONMENTS cell. Use
        // the renderer's exact sanitized/truncated value so adding ANSI color
        // can never reintroduce discarded content or corrupt prefix slicing.
        const environmentCells = projects.map((project: any) => (
            truncateCell(sanitizeCell(projectEnvironments(project)))
        ));
        const rows = projects.map((project: any, index: number) => [
            project.name || '?',
            project.status || '?',
            project.snapshot_name || '-',
            environmentCells[index],
        ]);

        const lines = renderTable(['NAME', 'STATUS', 'SNAPSHOT', 'ENVIRONMENTS'], rows, {
            minWidths: [25, 15, 30],
        });
        console.log(chalk.gray(lines[0]));
        console.log(chalk.gray(lines[1]));
        for (let index = 0; index < projects.length; index++) {
            const line = lines[index + 2];
            const environmentCell = environmentCells[index];
            const prefix = line.slice(0, line.length - environmentCell.length);
            console.log(prefix + colorizeEnvironmentStates(environmentCell));
        }

        console.log('');
        console.log(chalk.gray(`${projects.length} project(s)`));
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions login --global" to re-configure.'));
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`), error.response.data);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

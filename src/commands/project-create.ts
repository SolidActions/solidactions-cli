/**
 * solidactions project create <name> [-e <environment>]
 *
 * Creates a project + environment via POST /api/v1/projects WITHOUT uploading
 * any source or triggering a build. This is the empty-project path the web UI
 * already offers; `project deploy` creates-on-demand but always builds.
 *
 * `-e` defaults to `production`. Non-production environments are created
 * standalone — the server links to an existing production root if one exists
 * but no longer auto-creates one (#312).
 */

import axios from 'axios';
import chalk from 'chalk';
import { Config } from '../utils/config';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { buildProjectSlug, slugifyName } from '../utils/slug';

export interface ProjectCreateOptions {
    env?: string;
}

/**
 * Core implementation — accepts an injected config so tests can point at a
 * stub server without touching the filesystem config.
 */
export async function projectCreateWithConfig(
    name: string,
    options: ProjectCreateOptions,
    config: Config,
): Promise<void> {
    const environment = options.env ?? 'production';

    // Reject names that produce no usable slug (e.g. "!!!" or non-Latin scripts)
    // up front, with a clear client-side message instead of an opaque 422.
    // Name/slug length is left to the server, which owns those limits.
    if (slugifyName(name) === '') {
        console.error(chalk.red(`Invalid project name "${name}": it must contain letters or numbers (a-z, 0-9).`));
        process.exit(1);
    }

    const slug = buildProjectSlug(name, environment);

    const envLabel = environment !== 'production' ? ` (${environment})` : '';
    console.log(chalk.blue(`Creating project "${name}"${envLabel}...`));

    try {
        const response = await axios.post(
            `${config.host}/api/v1/projects`,
            { name, slug, environment },
            { headers: getApiHeaders(config, 'application/json') },
        );

        const createdSlug = response.data?.slug || slug;
        console.log(chalk.green(`✓ Project "${name}"${envLabel} created.`));
        console.log(chalk.gray(`  slug: ${createdSlug}`));
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions login --global" to re-configure.'));
            } else {
                console.error(chalk.red('Failed to create project:'), error.response.data?.message || error.message);
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

/** Entry point wired into the CLI — resolves config, then delegates. */
export async function projectCreate(name: string, options: ProjectCreateOptions): Promise<void> {
    const config = await requireConfigWithWorkspace();
    await projectCreateWithConfig(name, options, config);
}

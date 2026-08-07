import fs from 'fs';
import path from 'path';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { extract } from 'tar';
import axios from 'axios';
import chalk from 'chalk';
import prompts from 'prompts';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

export async function pull(projectName: string, destPath?: string, options: { yes?: boolean } = {}) {
    const config = await requireConfigWithWorkspace();

    const destination = destPath ? path.resolve(destPath) : process.cwd();

    // Warn if destination has existing files
    if (fs.existsSync(destination)) {
        const entries = fs.readdirSync(destination);
        if (entries.length > 0 && !options.yes) {
            console.log(chalk.yellow(`Destination "${destination}" is not empty (${entries.length} items).`));
            console.log(chalk.yellow('Pulling will overwrite existing files.'));
            const response = await prompts({
                type: 'confirm',
                name: 'proceed',
                message: 'Continue?',
                initial: false,
            });
            if (!response.proceed) {
                console.log(chalk.gray('Cancelled.'));
                process.exit(0);
            }
        }
    }

    console.log(chalk.blue(`Pulling project "${projectName}"...`));

    try {
        const response = await axios.get(`${config.host}/api/v1/projects/${projectName}/source`, {
            headers: { ...getApiHeaders(config), 'Accept': 'application/octet-stream' },
            responseType: 'arraybuffer',
        });

        const buffer = Buffer.from(response.data);

        console.log(chalk.gray(`Downloaded ${buffer.length} bytes`));
        console.log(chalk.yellow(`Extracting to ${destination}...`));

        fs.mkdirSync(destination, { recursive: true });

        // The server streams back the exact archive `deploy` uploaded: a
        // root-level Dockerfile plus every project file nested under
        // tenantcode/ (see deploy.ts:510-527). Unwrap it here so the pulled
        // project's files land at dest root, matching what the user actually
        // wrote — dropping the generated Dockerfile and any noCache
        // cache-buster entries (deploy.ts's cacheBusterEntry).
        const readable = Readable.from(buffer);
        await pipeline(
            readable,
            createGunzip(),
            extract({
                cwd: destination,
                strip: 1,
                // `filter` receives the pre-strip path (verified against this
                // version of the `tar` package).
                filter: (entryPath) => {
                    const top = entryPath.split('/')[0];
                    return top === 'tenantcode' && !/\/sa-nocache-[0-9a-f-]+$/.test(entryPath);
                },
            })
        );

        console.log(chalk.green(`Project "${projectName}" pulled successfully!`));
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 404) {
                console.error(chalk.red(`Project "${projectName}" not found.`));
            } else if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions login --global" to re-configure.'));
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`));
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

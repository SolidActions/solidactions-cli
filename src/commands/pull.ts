import fs from 'fs';
import path from 'path';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { extract } from 'tar';
import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

export async function pull(projectName: string, destPath?: string) {
    const config = await requireConfigWithWorkspace();

    const destination = destPath ? path.resolve(destPath) : process.cwd();

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

        const readable = Readable.from(buffer);
        await pipeline(
            readable,
            createGunzip(),
            extract({ cwd: destination, strip: 0 })
        );

        console.log(chalk.green(`Project "${projectName}" pulled successfully!`));
    } catch (error: any) {
        if (error.response) {
            if (error.response.status === 404) {
                console.error(chalk.red(`Project "${projectName}" not found.`));
            } else if (error.response.status === 401) {
                console.error(chalk.red('Authentication failed. Run "solidactions init <api-key>" to re-configure.'));
            } else {
                console.error(chalk.red(`Failed: ${error.response.status}`));
            }
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

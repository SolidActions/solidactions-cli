import fs from 'fs';
import path from 'path';
import axios from 'axios';
import chalk from 'chalk';
import AdmZip from 'adm-zip';
import { getConfig } from './init';

export async function pull(projectName: string, destPath?: string) {
    const config = getConfig();
    if (!config?.apiKey) {
        console.error(chalk.red('Not initialized. Run `solidactions init <api-key>` first.'));
        process.exit(1);
    }

    const destination = destPath ? path.resolve(destPath) : process.cwd();

    console.log(chalk.blue(`Pulling project "${projectName}"...`));

    try {
        const response = await axios.get(`${config.host}/api/v1/projects/${projectName}/source`, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/octet-stream',
            },
            responseType: 'arraybuffer',
        });

        const zipBuffer = Buffer.from(response.data);
        const tempZipPath = path.join(destination, '.steps-pull-temp.zip');

        // Write the zip to a temp file
        fs.writeFileSync(tempZipPath, zipBuffer);

        console.log(chalk.gray(`Downloaded ${zipBuffer.length} bytes`));
        console.log(chalk.yellow(`Extracting to ${destination}...`));

        // Extract the zip
        const zip = new AdmZip(tempZipPath);
        zip.extractAllTo(destination, true);

        // Clean up temp file
        fs.unlinkSync(tempZipPath);

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

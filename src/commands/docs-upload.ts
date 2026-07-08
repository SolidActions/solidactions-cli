import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import chalk from 'chalk';
import { formatValidationError, getApiHeaders, requireConfigWithWorkspace } from '../utils/api';

export interface DocsUploadOptions {
    folder?: string;
    title?: string;
}

/**
 * Uploads one or more local files to SA-Docs media (`POST /api/v1/docs/media`),
 * sequentially. `--title` is only valid for a single file — with multiple
 * files, every upload would otherwise silently collide on the same title.
 */
export async function docsUpload(files: string[], options: DocsUploadOptions = {}): Promise<void> {
    if (options.title && files.length > 1) {
        console.error(chalk.red('--title can only be used when uploading a single file.'));
        process.exit(1);
    }

    const config = await requireConfigWithWorkspace();

    let hadError = false;

    for (const file of files) {
        const absPath = path.resolve(file);
        const displayName = path.basename(absPath);

        if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
            console.error(chalk.red(`✗ ${displayName} — file not found`));
            hadError = true;
            continue;
        }

        const form = new FormData();
        form.append('file', fs.createReadStream(absPath));
        if (options.folder) form.append('folder_path', options.folder);
        if (options.title) form.append('title', options.title);

        try {
            const response = await axios.post(`${config.host}/api/v1/docs/media`, form, {
                headers: {
                    ...form.getHeaders(),
                    ...getApiHeaders(config),
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            });

            // The 201 body nests the created doc under a `doc` key.
            const doc = response.data?.doc;
            const location = doc?.folder_path || '/';
            console.log(chalk.green(`✓ ${displayName} → ${location} (doc ${doc?.id})`));
        } catch (error: any) {
            hadError = true;

            if (error.response) {
                const { status, data } = error.response;
                if (status === 413) {
                    console.error(chalk.red(`✗ ${displayName} — ${data?.message || 'File exceeds the maximum upload size (20MB).'}`));
                } else if (status === 401) {
                    console.error(chalk.red(`✗ ${displayName} — Authentication failed. Run "solidactions login <api-key>" to re-configure.`));
                } else if (status === 422) {
                    console.error(chalk.red(`✗ ${displayName} — ${formatValidationError(data)}`));
                } else {
                    console.error(chalk.red(`✗ ${displayName} — ${data?.message || `request failed with status ${status}`}`));
                }
            } else {
                console.error(chalk.red(`✗ ${displayName} — ${error.message}`));
            }
        }
    }

    if (hadError) {
        process.exit(1);
    }
}

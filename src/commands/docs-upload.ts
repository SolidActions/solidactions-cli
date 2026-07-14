import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import chalk from 'chalk';
import { formatValidationError, getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { Config } from '../utils/config';

export interface DocsUploadOptions {
    folder?: string;
    title?: string;
    /** Doc id, or a docs path like "marketing/hero.png", whose bytes to replace. */
    replace?: string;
}

/**
 * Resolve `--replace` to a doc id. A purely numeric value is an id; anything else
 * is a docs path, resolved against the doc's *title* via GET /docs/by-path.
 *
 * Note the title is not always the local filename: `docs pull` sanitizes
 * filesystem-illegal characters and may suffix collisions. For path-based work
 * on a pulled folder, `docs push` is the right verb.
 */
async function resolveReplaceTarget(config: Config, replace: string): Promise<number> {
    if (/^\d+$/.test(replace)) {
        return Number(replace);
    }

    const slash = replace.lastIndexOf('/');
    const folderPath = slash === -1 ? undefined : replace.slice(0, slash);
    const title = slash === -1 ? replace : replace.slice(slash + 1);

    // A trailing slash ("marketing/") leaves no title to look up. Fail here rather
    // than asking the server to resolve an empty title and reporting its 404.
    if (title === '') {
        console.error(chalk.red(`✗ --replace "${replace}" names a folder, not a doc`));
        return process.exit(1);
    }

    try {
        const params: Record<string, string> = {};
        if (folderPath) params.folder_path = folderPath;
        params.title = title;
        const response = await axios.get(`${config.host}/api/v1/docs/by-path`, {
            params,
            headers: getApiHeaders(config),
        });
        return response.data.doc.id;
    } catch (error: any) {
        const status = error.response?.status;
        const code = error.response?.data?.code;
        if (status === 422 && code === 'folder_path_not_found') {
            console.error(chalk.red(`✗ no folder "${folderPath}" in this workspace`));
        } else if (status === 404) {
            console.error(chalk.red(`✗ no doc titled "${title}"${folderPath ? ` in "${folderPath}"` : ' at the docs root'}`));
        } else {
            console.error(chalk.red(`✗ could not resolve "${replace}" — ${error.response?.data?.message ?? error.message}`));
        }
        return process.exit(1);
    }
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
    if (options.replace && files.length > 1) {
        console.error(chalk.red('--replace can only be used when uploading a single file.'));
        process.exit(1);
    }
    if (options.replace && (options.title || options.folder)) {
        console.error(chalk.red('--replace cannot be combined with --title or --folder — replace never renames or moves a doc.'));
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
        if (!options.replace) {
            if (options.folder) form.append('folder_path', options.folder);
            if (options.title) form.append('title', options.title);
        }

        // Resolved once (--replace forbids multiple files), and kept so error messages
        // can name the numeric doc id rather than echoing back a path.
        const replaceDocId = options.replace ? await resolveReplaceTarget(config, options.replace) : null;

        const url = replaceDocId !== null
            ? `${config.host}/api/v1/docs/${replaceDocId}/media`
            : `${config.host}/api/v1/docs/media`;

        try {
            const response = await axios.post(url, form, {
                headers: {
                    ...form.getHeaders(),
                    ...getApiHeaders(config),
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            });

            // The 201/200 body nests the created/updated doc under a `doc` key.
            const doc = response.data?.doc;
            if (options.replace) {
                console.log(chalk.green(`✓ ${displayName} → doc ${doc?.id} (replaced, rev ${doc?.current_version_id})`));
            } else {
                const location = doc?.folder_path || '/';
                console.log(chalk.green(`✓ ${displayName} → ${location} (doc ${doc?.id})`));
            }
        } catch (error: any) {
            hadError = true;

            if (error.response) {
                const { status, data } = error.response;
                if (status === 413) {
                    console.error(chalk.red(`✗ ${displayName} — ${data?.message || 'File exceeds the maximum upload size (20MB).'}`));
                } else if (status === 401) {
                    console.error(chalk.red(`✗ ${displayName} — Authentication failed. Run "solidactions login --global" to re-configure.`));
                } else if (status === 404 && data?.code === 'media_not_found') {
                    console.error(chalk.red(`✗ ${displayName} — doc ${replaceDocId} is not a media doc`));
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

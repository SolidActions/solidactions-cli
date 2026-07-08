/**
 * solidactions docs pull <folder> [dest]
 *
 * Downloads a Docs folder tree from SA-Docs into a local markdown tree (the
 * inverse of `docs push`): BFS-walks the folder via `docs_vault list`,
 * bulk-fetches doc bodies via `docs_vault bulk_read`, and writes each doc as
 * <dest>/<relative-folder>/<sanitized-title>.md plus a revision manifest
 * (<dest>/.solidactions-docs.json) recording id/title/current_revision_id
 * per file for later diffing.
 *
 * Media handling (docs whose body references binary assets) arrives in a
 * later task — every doc here is written as markdown with manifest
 * `media: false`.
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import prompts from 'prompts';
import { Config } from '../utils/config';
import { requireConfigWithWorkspace } from '../utils/api';
import { callDocsTool } from '../utils/mcp';

export const DOCS_MANIFEST = '.solidactions-docs.json';

export interface DocsManifest {
    folder_path: string;
    docs: Record<string, {
        id: number;
        title: string;
        current_revision_id: number | null;
        media: boolean;
    }>;
}

export interface DocsPullOptions {
    yes?: boolean;
    json?: boolean;
}

const CHUNK_SIZE = 50;

/** Characters that are unsafe as filesystem path segments, plus control chars. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[/\\:*?"<>|\x00-\x1f]/g;

/**
 * Replace filesystem-unsafe characters (/ \ : * ? " < > | and control chars)
 * in a doc title with underscores so it can be used as a file basename.
 */
export function sanitizeTitle(title: string): string {
    return title.replace(UNSAFE_CHARS, '_');
}

/** Row collected during the BFS list walk, before bodies are fetched. */
interface DocRow {
    id: number;
    title: string;
    /** Relative folder path from the pull root, '' for the root itself, using '/' separators. */
    relative: string;
}

/** Row after bulk_read/read has filled in body + revision. */
interface FetchedDoc extends DocRow {
    body: string;
    current_revision_id: number | null;
}

/** The last non-empty path segment of a '/'-separated folder path. */
function lastSegment(folderPath: string): string {
    const segments = folderPath.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? folderPath;
}

/**
 * BFS-walk `folderPath` via `docs_vault list`, collecting every doc row with
 * its relative folder path. Returns null (with the list error message
 * already known to the caller) if the root list call fails.
 */
async function listTree(config: Config, folderPath: string): Promise<{ ok: true; rows: DocRow[] } | { ok: false; isRoot: boolean; code: string; message: string }> {
    const rows: DocRow[] = [];
    const queue: Array<{ folder_path: string; relative: string }> = [{ folder_path: folderPath, relative: '' }];
    let first = true;

    while (queue.length > 0) {
        const { folder_path, relative } = queue.shift()!;
        const result = await callDocsTool(config, 'docs_vault', { action: 'list', folder_path });

        if (!result.ok) {
            // A subfolder returned by the server itself failed to list is surfaced the
            // same way as a root failure — only the root failure triggers the
            // single-doc fallback (isRoot distinguishes the two).
            return { ok: false, isRoot: first, code: result.data?.code ?? 'unknown_error', message: result.data?.message ?? 'MCP returned an error with no message' };
        }
        first = false;

        for (const folder of result.data?.folders ?? []) {
            const childRelative = relative ? `${relative}/${folder.name}` : folder.name;
            queue.push({ folder_path: folder.folder_path, relative: childRelative });
        }
        for (const doc of result.data?.docs ?? []) {
            rows.push({ id: doc.id, title: doc.title, relative });
        }
    }

    return { ok: true, rows };
}

/** Fetch bodies + revisions for every collected row via bulk_read, chunked at CHUNK_SIZE ids. */
async function fetchBodies(config: Config, rows: DocRow[]): Promise<FetchedDoc[]> {
    const byId = new Map<number, DocRow>();
    for (const row of rows) byId.set(row.id, row);

    const fetched: FetchedDoc[] = [];
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
        const chunk = rows.slice(i, i + CHUNK_SIZE);
        const result = await callDocsTool(config, 'docs_vault', {
            action: 'bulk_read',
            items: chunk.map((r) => ({ id: r.id })),
        });

        if (!result.ok) {
            const code = result.data?.code ?? 'unknown_error';
            const message = result.data?.message ?? 'MCP returned an error with no message';
            process.stderr.write(chalk.red(`error: ${code}: ${message}\n`));
            process.exit(1);
        }

        const resultRows = result.data?.results ?? [];
        for (const row of resultRows) {
            const original = byId.get(row.id);
            if (!original) continue;
            fetched.push({
                ...original,
                body: row.body ?? '',
                current_revision_id: row.current_revision_id ?? null,
            });
        }
    }

    return fetched;
}

/**
 * Write every fetched doc to disk under `destination`, tracking sanitized
 * filename collisions per directory (suffix "-2", "-3", ... before the
 * extension). Returns the manifest docs map and the ordered list of written
 * files (for --json output).
 */
function writeDocs(destination: string, docs: FetchedDoc[]): { manifestDocs: DocsManifest['docs']; files: Array<{ path: string; action: 'written' }> } {
    const manifestDocs: DocsManifest['docs'] = {};
    const files: Array<{ path: string; action: 'written' }> = [];
    const usedNamesByDir = new Map<string, Set<string>>();

    for (const doc of docs) {
        const dirRel = doc.relative;
        const dirAbs = dirRel ? path.join(destination, ...dirRel.split('/')) : destination;
        fs.mkdirSync(dirAbs, { recursive: true });

        let used = usedNamesByDir.get(dirRel);
        if (!used) {
            used = new Set();
            usedNamesByDir.set(dirRel, used);
        }

        const sanitized = sanitizeTitle(doc.title);
        let candidate = sanitized;
        let suffix = 2;
        while (used.has(candidate)) {
            candidate = `${sanitized}-${suffix}`;
            suffix++;
        }
        used.add(candidate);

        const fileName = `${candidate}.md`;
        const relPath = dirRel ? `${dirRel}/${fileName}` : fileName;

        fs.writeFileSync(path.join(dirAbs, fileName), doc.body, 'utf8');

        manifestDocs[relPath] = {
            id: doc.id,
            title: doc.title,
            current_revision_id: doc.current_revision_id,
            media: false,
        };
        files.push({ path: relPath, action: 'written' });
    }

    return { manifestDocs, files };
}

/**
 * Core implementation — accepts an injected config so tests can point at a
 * stub server without touching the filesystem config.
 */
export async function docsPullWithConfig(
    folderPath: string,
    dest: string | undefined,
    options: DocsPullOptions,
    config: Config,
): Promise<void> {
    const destInput = dest ?? `./${lastSegment(folderPath)}`;
    const destination = path.resolve(destInput);

    // Overwrite-confirm: warn + confirm on a non-empty destination before any network I/O.
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

    let rows: DocRow[];

    const listResult = await listTree(config, folderPath);
    if (listResult.ok) {
        rows = listResult.rows;
    } else if (listResult.isRoot && listResult.code === 'folder_path_not_found') {
        // Single-doc fallback: the target might be a doc path, not a folder.
        const dir = path.dirname(folderPath);
        const title = path.basename(folderPath);
        const readArgs: Record<string, unknown> = { action: 'read', path: dir === '.' ? { title } : { folder_path: dir, title } };
        const readResult = await callDocsTool(config, 'docs_vault', readArgs);

        if (!readResult.ok) {
            const readCode = readResult.data?.code ?? 'unknown_error';
            const readMessage = readResult.data?.message ?? 'MCP returned an error with no message';
            process.stderr.write(chalk.red(`error: ${listResult.code}: ${listResult.message}\n`));
            process.stderr.write(chalk.red(`error: ${readCode}: ${readMessage}\n`));
            process.exit(1);
        }

        const data = readResult.data;
        const fetched: FetchedDoc[] = [{
            id: data.id,
            title: data.title,
            relative: '',
            body: data.body ?? '',
            current_revision_id: data.current_revision_id ?? null,
        }];

        report(destination, folderPath, fetched, options);
        return;
    } else {
        process.stderr.write(chalk.red(`error: ${listResult.code}: ${listResult.message}\n`));
        process.exit(1);
        return;
    }

    const fetched = await fetchBodies(config, rows);
    report(destination, folderPath, fetched, options);
}

/** Write the docs + manifest to disk and print the result (chalk lines or --json). */
function report(destination: string, folderPath: string, fetched: FetchedDoc[], options: DocsPullOptions): void {
    fs.mkdirSync(destination, { recursive: true });
    const { manifestDocs, files } = writeDocs(destination, fetched);

    const manifest: DocsManifest = { folder_path: folderPath, docs: manifestDocs };
    fs.writeFileSync(path.join(destination, DOCS_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    if (options.json) {
        console.log(JSON.stringify({ manifest, files }));
        process.exit(0);
    }

    console.log(chalk.green(`pulled ${files.length} doc${files.length === 1 ? '' : 's'} → ${destination}`));
    for (const file of files) {
        console.log(chalk.gray(`  ${file.path}`));
    }
    process.exit(0);
}

/**
 * Entry point called from index.ts.
 */
export async function docsPull(folder: string, dest: string | undefined, options: DocsPullOptions): Promise<void> {
    const config = await requireConfigWithWorkspace();
    await docsPullWithConfig(folder, dest, options, config);
}

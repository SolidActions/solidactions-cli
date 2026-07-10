/**
 * solidactions docs push <dir>
 *
 * Recursively uploads a local markdown tree into SA-Docs via the docs MCP
 * server's `docs_vault bulk_create` tool, mirroring folder structure.
 *
 * Prints a report distinguishing fully-published docs from "properties pending"
 * ones (docs whose frontmatter properties couldn't be validated yet).
 */

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import chalk from 'chalk';
import { Config } from '../utils/config';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { callDocsTool } from '../utils/mcp';
import { DOCS_MANIFEST, DocsManifest, readManifest, sha256Hex, writeManifest } from '../utils/docs-manifest';

export interface DocsPushOptions {
    onConflict?: 'skip' | 'overwrite' | 'rename';
    type?: string;
    /** Nest the whole upload under this base folder path in SA-Docs. */
    folder?: string;
    dryRun?: boolean;
    json?: boolean;
    /** Overwrite tracked docs without a base_revision guard, ignoring server-side drift. */
    force?: boolean;
}

const CHUNK_SIZE = 50;

interface DocItem {
    title: string;
    body: string;
    relative_folder_path?: string;
    /** local file path for correlating results back to filenames */
    _filePath: string;
}

interface BulkCreateResultRow {
    index: number;
    status: string;
    id?: string;
    folder_path?: string;
    action?: string;
    /** Server-side reason when `status === 'error'` (e.g. a trashed doc holds the title). */
    error?: string;
    code?: string;
    property_validation?: {
        status: string;
        missing: string[];
        invalid: Array<{ key: string; reason: string }>;
        schema: unknown[];
    };
}

interface BulkCreateSummary {
    created?: number;
    overwritten?: number;
    skipped?: number;
    renamed?: number;
    errors?: number;
    folders_created?: number;
    planned_create?: number;
    planned_overwrite?: number;
    planned_skip?: number;
    planned_rename?: number;
}

interface PendingItem {
    file: string;
    missing: string[];
    invalid: Array<{ key: string; reason: string }>;
}

interface ResultRow extends BulkCreateResultRow {
    file: string;
}

interface TrackedWritten {
    file: string;
    id: number;
    current_revision_id: number | null;
}

interface TrackedDrifted {
    file: string;
    /** The revision the server is currently at. */
    their: number | null;
    /** The revision our manifest thought was current (what we sent as base_revision). */
    base: number | null;
}

interface TrackedPlanned {
    file: string;
    id: number;
}

interface TrackedUnchanged {
    file: string;
    id: number;
}

/** A tracked doc/media entry whose id no longer exists server-side (deleted remotely). */
interface TrackedMissing {
    file: string;
    id: number;
}

/**
 * Recursively walk `dir` and collect all *.md files.
 * Returns a list of absolute paths.
 */
function walkMarkdownFiles(dir: string): string[] {
    const results: string[] = [];

    const walk = (current: string): void => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const abs = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(abs);
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
                results.push(abs);
            }
        }
    };

    walk(dir);
    return results;
}

const SKIP_DIRS = new Set(['node_modules']);

/**
 * Recursively walk `dir` and collect relative paths of non-.md files that
 * are not present in the manifest — never uploaded by `docs push`; `docs
 * upload` is the way to create media docs from these. Dotfiles and
 * dot-directories are excluded (`entry.name.startsWith('.')` also covers the
 * `.solidactions-docs.json` sidecar itself).
 */
function walkUntrackedBinaries(dir: string, manifest: DocsManifest | null): string[] {
    const results: string[] = [];

    const walk = (current: string): void => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
            const abs = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(abs);
            } else if (entry.isFile() && !entry.name.endsWith('.md')) {
                const relPath = path.relative(dir, abs).split(path.sep).join('/');
                if (!manifest?.docs[relPath]) {
                    results.push(relPath);
                }
            }
        }
    };

    walk(dir);
    return results;
}

/**
 * Convert an absolute file path to a bulk_create item, relative to `rootDir`.
 */
function fileToItem(absPath: string, rootDir: string): DocItem {
    const title = path.basename(absPath, '.md');
    const body = fs.readFileSync(absPath, 'utf8');
    const relDir = path.relative(rootDir, path.dirname(absPath));
    // Use POSIX separators; omit if file is in the root dir
    const relative_folder_path = relDir === '' ? undefined : relDir.split(path.sep).join('/');

    const item: DocItem = { title, body, _filePath: absPath };
    if (relative_folder_path !== undefined) {
        item.relative_folder_path = relative_folder_path;
    }
    return item;
}

/**
 * Merge two BulkCreateSummary objects by summing all numeric fields.
 */
function mergeSummaries(a: BulkCreateSummary, b: BulkCreateSummary): BulkCreateSummary {
    const keys: Array<keyof BulkCreateSummary> = [
        'created', 'overwritten', 'skipped', 'renamed', 'errors', 'folders_created',
        'planned_create', 'planned_overwrite', 'planned_skip', 'planned_rename',
    ];
    const result: BulkCreateSummary = {};
    for (const key of keys) {
        const aVal = a[key] ?? 0;
        const bVal = b[key] ?? 0;
        if (aVal !== 0 || bVal !== 0) {
            (result as any)[key] = aVal + bVal;
        }
    }
    return result;
}

/**
 * Format the merged summary into human-readable totals line.
 * Normal run: created/overwritten/skipped/renamed. Dry-run: planned_*.
 */
function formatSummaryLine(summary: BulkCreateSummary, dryRun: boolean): string {
    const parts: string[] = [];
    if (dryRun) {
        if (summary.planned_create) parts.push(`${summary.planned_create} planned create`);
        if (summary.planned_overwrite) parts.push(`${summary.planned_overwrite} planned overwrite`);
        if (summary.planned_skip) parts.push(`${summary.planned_skip} planned skip`);
        if (summary.planned_rename) parts.push(`${summary.planned_rename} planned rename`);
    } else {
        if (summary.created) parts.push(`${summary.created} created`);
        if (summary.overwritten) parts.push(`${summary.overwritten} updated`);
        if (summary.skipped) parts.push(`${summary.skipped} skipped`);
        if (summary.renamed) parts.push(`${summary.renamed} renamed`);
        if (summary.errors) parts.push(`${summary.errors} errors`);
    }
    return parts.join(', ') || '0 docs';
}

/**
 * Core implementation — accepts an injected config so tests can point at a
 * stub server without touching the filesystem config.
 */
export async function docsPushWithConfig(
    dir: string,
    options: DocsPushOptions,
    config: Config,
): Promise<void> {
    const absDir = path.resolve(dir);

    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
        process.stderr.write(chalk.red(`error: "${dir}" is not a directory.\n`));
        process.exit(1);
    }

    const allFiles = walkMarkdownFiles(absDir);

    // A missing/unparseable manifest means nothing is tracked — everything is untracked,
    // matching the existing (pre-drift-guard) bulk_create behavior byte-for-byte.
    const manifest = readManifest(absDir, { warnOnParseError: true });
    const trackedMediaEntries = Object.entries(manifest?.docs ?? {}).filter(([, e]) => e.media);

    // A pulled folder of images alone (no .md files) must still be pushable — the early
    // exit only fires when there's truly nothing to push.
    if (allFiles.length === 0 && trackedMediaEntries.length === 0) {
        process.stderr.write(chalk.red(`error: no .md files or tracked media found under "${dir}" — nothing to push.\n`));
        process.exit(1);
    }

    // Partition into tracked (relative path present in the pull manifest) vs. untracked.
    // A media doc titled *.md (e.g. `notes.md`) is bytes, not markdown — it's owned by
    // the media pass below, not this markdown pass, or its bytes would be sent through
    // docs_edit as a text body and corrupt the doc.
    const trackedFiles: Array<{ absPath: string; relPath: string }> = [];
    const untrackedFiles: string[] = [];
    for (const f of allFiles) {
        const relPath = path.relative(absDir, f).split(path.sep).join('/');
        const entry = manifest?.docs[relPath];
        if (entry?.media) {
            continue;
        }
        if (entry) {
            trackedFiles.push({ absPath: f, relPath });
        } else {
            untrackedFiles.push(f);
        }
    }

    const trackedWritten: TrackedWritten[] = [];
    const trackedDrifted: TrackedDrifted[] = [];
    const trackedPlanned: TrackedPlanned[] = [];
    const trackedUnchanged: TrackedUnchanged[] = [];
    const trackedMissing: TrackedMissing[] = [];

    for (const { absPath, relPath } of trackedFiles) {
        const entry = manifest!.docs[relPath];
        const body = fs.readFileSync(absPath, 'utf8');
        const bodyHash = sha256Hex(body);

        // Skip-unchanged applies regardless of --force or --dry-run: force answers
        // drift, not staleness, and an old manifest lacking body_sha256 (undefined)
        // never matches, so it always falls through to a write (graceful degradation).
        if (entry.body_sha256 != null && entry.body_sha256 === bodyHash) {
            trackedUnchanged.push({ file: relPath, id: entry.id });
            continue;
        }

        // --dry-run must never live-write: preview the tracked doc instead of calling docs_edit.
        if (options.dryRun) {
            trackedPlanned.push({ file: relPath, id: entry.id });
            continue;
        }

        const editArgs: Record<string, unknown> = { action: 'write', id: entry.id, body };
        if (!options.force && entry.current_revision_id !== null) {
            editArgs.base_revision = entry.current_revision_id;
        }

        let mcpResult: Awaited<ReturnType<typeof callDocsTool>>;
        try {
            mcpResult = await callDocsTool(config, 'docs_edit', editArgs);
        } catch (e: any) {
            process.stderr.write(chalk.red(`error: ${e.message}\n`));
            process.exit(1);
        }

        if (!mcpResult.ok) {
            const code = mcpResult.data?.code ?? 'unknown_error';
            if (code === 'doc_not_found') {
                // The tracked doc was deleted remotely since the last pull. Not a genuine
                // drift/error: report it and move on rather than aborting the whole push.
                trackedMissing.push({ file: relPath, id: entry.id });
                continue;
            }
            const message = mcpResult.data?.message ?? 'MCP returned an error with no message';
            process.stderr.write(chalk.red(`error: ${code}: ${message}\n`));
            process.exit(1);
        }

        const data = mcpResult.data;
        if (data?.stale === true || data?.code === 'stale_revision') {
            trackedDrifted.push({ file: relPath, their: data.current_revision_id ?? null, base: entry.current_revision_id });
            continue;
        }

        entry.current_revision_id = data?.current_revision_id ?? entry.current_revision_id;
        entry.body_sha256 = bodyHash;
        trackedWritten.push({ file: relPath, id: entry.id, current_revision_id: entry.current_revision_id });

        // Persist immediately so a later failure (another tracked write, or an
        // untracked bulk_create error) never loses this file's refreshed revision.
        writeManifest(absDir, manifest!);
    }

    // Media pass: tracked binaries (media: true) replace via POST /api/v1/docs/{id}/media,
    // sharing the report arrays above.
    for (const [relPath, entry] of trackedMediaEntries) {
        const absPath = path.join(absDir, ...relPath.split('/'));

        // Existence before hash: a pull whose media download failed records
        // `media: true, body_sha256: null` and writes no file. push never deletes.
        if (!fs.existsSync(absPath)) {
            continue;
        }

        const bytes = fs.readFileSync(absPath);
        const bodyHash = sha256Hex(bytes);

        if (entry.body_sha256 != null && entry.body_sha256 === bodyHash) {
            trackedUnchanged.push({ file: relPath, id: entry.id });
            continue;
        }

        if (options.dryRun) {
            trackedPlanned.push({ file: relPath, id: entry.id });
            continue;
        }

        const form = new FormData();
        form.append('file', bytes, { filename: path.basename(relPath) });
        if (!options.force && entry.current_revision_id !== null) {
            form.append('base_revision', String(entry.current_revision_id));
        }

        let doc: any;
        try {
            const response = await axios.post(`${config.host}/api/v1/docs/${entry.id}/media`, form, {
                headers: { ...form.getHeaders(), ...getApiHeaders(config) },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            });
            doc = response.data?.doc;
        } catch (error: any) {
            const status = error.response?.status;
            const data = error.response?.data;
            if (status === 409 && data?.code === 'stale_revision') {
                trackedDrifted.push({ file: relPath, their: data.current_revision_id ?? null, base: entry.current_revision_id });
                continue;
            }
            if (status === 404 && data?.code === 'doc_not_found') {
                // The tracked doc was deleted remotely since the last pull — same
                // treatment as the markdown pass. `media_not_found` is a different case
                // (doc exists but isn't a media doc) and is not handled here.
                trackedMissing.push({ file: relPath, id: entry.id });
                continue;
            }
            process.stderr.write(chalk.red(`error: ${relPath}: ${data?.message ?? error.message}\n`));
            process.exit(1);
        }

        // The REST presenter names the revision `current_version_id`; MCP docs_edit
        // names it `current_revision_id`. Reading the wrong one nulls the entry and
        // silently disarms the drift guard on every later push.
        entry.current_revision_id = doc?.current_version_id ?? entry.current_revision_id;
        entry.body_sha256 = bodyHash;
        trackedWritten.push({ file: relPath, id: entry.id, current_revision_id: entry.current_revision_id });

        writeManifest(absDir, manifest!);
    }

    const untrackedMedia = walkUntrackedBinaries(absDir, manifest);

    const items: DocItem[] = untrackedFiles.map((f) => fileToItem(f, absDir));

    // Untracked docs (new files, or files re-orphaned by a deleted-remotely re-pull)
    // must land back under the folder this directory was pulled into, not the docs
    // root — an explicit --folder always overrides the manifest's recorded folder.
    const effectiveFolder = options.folder ?? manifest?.folder_path;
    const folderInferredFromManifest = !options.folder && !!manifest?.folder_path;

    // Chunk into groups of CHUNK_SIZE
    const chunks: DocItem[][] = [];
    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
        chunks.push(items.slice(i, i + CHUNK_SIZE));
    }

    if (folderInferredFromManifest && items.length > 0 && !options.json) {
        console.log(chalk.gray(`creating untracked docs under "${effectiveFolder}" (from ${DOCS_MANIFEST})`));
    }

    const onConflict = options.onConflict ?? 'skip';
    const allResultRows: ResultRow[] = [];
    let mergedSummary: BulkCreateSummary = {};

    for (const chunk of chunks) {
        const callArgs: Record<string, unknown> = {
            action: 'bulk_create',
            on_conflict: onConflict,
            items: chunk.map(({ title, body, relative_folder_path }) => {
                const item: Record<string, unknown> = { title, body };
                if (relative_folder_path !== undefined) {
                    item.relative_folder_path = relative_folder_path;
                }
                return item;
            }),
        };

        if (options.type) {
            callArgs.type = options.type;
        }
        if (effectiveFolder) {
            // Top-level base for every item; each item's relative_folder_path nests under it.
            // Explicit --folder wins; otherwise defaults to the manifest's folder_path so
            // untracked docs in a pulled directory land back in the folder they came from.
            callArgs.folder_path = effectiveFolder;
        }
        if (options.dryRun) {
            callArgs.dry_run = true;
        }

        let mcpResult: Awaited<ReturnType<typeof callDocsTool>>;
        try {
            mcpResult = await callDocsTool(config, 'docs_vault', callArgs);
        } catch (e: any) {
            process.stderr.write(chalk.red(`error: ${e.message}\n`));
            process.exit(1);
        }

        if (!mcpResult.ok) {
            const code = mcpResult.data?.code ?? 'unknown_error';
            const message = mcpResult.data?.message ?? 'MCP returned an error with no message';
            process.stderr.write(chalk.red(`error: ${code}: ${message}\n`));
            process.exit(1);
        }

        const data = mcpResult.data;
        const rows: BulkCreateResultRow[] = data?.results ?? [];
        const summary: BulkCreateSummary = data?.summary ?? {};

        // Correlate rows back to source files using chunk index
        for (const row of rows) {
            const sourceFile = chunk[row.index]?._filePath ?? '(unknown)';
            allResultRows.push({
                ...row,
                file: path.relative(absDir, sourceFile),
            });
        }

        mergedSummary = mergeSummaries(mergedSummary, summary);
    }

    // Collect pending items (results that have property_validation)
    const pendingItems: PendingItem[] = allResultRows
        .filter((r) => r.property_validation != null)
        .map((r) => ({
            file: r.file,
            missing: r.property_validation!.missing ?? [],
            invalid: r.property_validation!.invalid ?? [],
        }));

    const exitCode = trackedDrifted.length > 0 ? 1 : 0;

    // --json: output single JSON object
    if (options.json) {
        console.log(JSON.stringify({
            summary: mergedSummary,
            pending: pendingItems,
            results: allResultRows,
            tracked: { written: trackedWritten, drifted: trackedDrifted, planned: trackedPlanned, unchanged: trackedUnchanged, missing: trackedMissing },
            untracked_media: untrackedMedia,
        }));
        process.exit(exitCode);
    }

    // Human-readable output
    if (options.dryRun) {
        if (trackedPlanned.length > 0) {
            console.log(chalk.cyan(`tracked: ${trackedPlanned.length} planned write`));
            for (const p of trackedPlanned) {
                console.log(chalk.gray(`  ${p.file}`));
            }
        }
        if (trackedUnchanged.length > 0) {
            console.log(chalk.gray(`tracked: ${trackedUnchanged.length} planned unchanged (skip)`));
            for (const u of trackedUnchanged) {
                console.log(chalk.gray(`  ${u.file}`));
            }
        }
    } else if (trackedWritten.length > 0 || trackedDrifted.length > 0 || trackedUnchanged.length > 0) {
        console.log(chalk.green(`tracked: ${trackedWritten.length} written, ${trackedDrifted.length} drifted, ${trackedUnchanged.length} unchanged`));
        for (const w of trackedWritten) {
            console.log(chalk.gray(`  ${w.file}`));
        }
    }

    if (untrackedMedia.length > 0) {
        for (const file of untrackedMedia.slice(0, 10)) {
            process.stderr.write(chalk.yellow(`${file}: not pushed — use \`solidactions docs upload\`\n`));
        }
        if (untrackedMedia.length > 10) {
            process.stderr.write(chalk.yellow(`… and ${untrackedMedia.length - 10} more\n`));
        }
    }

    for (const m of trackedMissing) {
        process.stderr.write(chalk.yellow(`${m.file}: doc ${m.id} no longer exists (deleted remotely) — re-pull to untrack it, then push to re-create (restore or empty it from the trash first, or the title stays taken)\n`));
    }

    const summaryLine = formatSummaryLine(mergedSummary, !!options.dryRun);
    if (options.dryRun) {
        console.log(chalk.cyan(`[dry-run preview] ${summaryLine}`));
    } else if (items.length > 0) {
        // Suppress "done: 0 docs" when there was nothing to bulk_create — printing it
        // alongside a successful tracked/media write reads as a contradiction.
        console.log(chalk.green(`done: ${summaryLine}`));
    }

    // `done: N errors` on its own says nothing. Name the file and the server's reason.
    const erroredRows = allResultRows.filter((r) => r.status === 'error');
    if (erroredRows.length > 0 && !options.json) {
        for (const row of erroredRows) {
            process.stderr.write(chalk.red(`${row.file}: ${row.error ?? row.code ?? 'unknown error'}\n`));
        }
    }

    if (pendingItems.length > 0) {
        console.log(chalk.yellow(`\nProperties pending (${pendingItems.length} doc${pendingItems.length === 1 ? '' : 's'}):`));
        for (const item of pendingItems) {
            console.log(chalk.yellow(`  ${item.file}`));
            if (item.missing.length > 0) {
                console.log(chalk.yellow(`    missing: ${item.missing.join(', ')}`));
            }
            for (const inv of item.invalid) {
                console.log(chalk.yellow(`    invalid: ${inv.key} — ${inv.reason}`));
            }
        }
    }

    if (trackedDrifted.length > 0) {
        process.stderr.write(chalk.red(`\ndrift: ${trackedDrifted.length} tracked doc${trackedDrifted.length === 1 ? '' : 's'} changed on the server since the last pull:\n`));
        for (const d of trackedDrifted) {
            process.stderr.write(chalk.red(`  ${d.file} (local base_revision ${d.base}, server now at ${d.their})\n`));
        }
        process.stderr.write(chalk.red('re-pull to merge, or pass --force to overwrite\n'));
    }

    process.exit(exitCode);
}

/**
 * Entry point called from index.ts.
 */
export async function docsPush(dir: string, options: DocsPushOptions): Promise<void> {
    const config = await requireConfigWithWorkspace();
    await docsPushWithConfig(dir, options, config);
}

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
 * Media docs (blob-backed, empty body) are two-stage classified: a
 * candidate filter on the bulk_read row's properties, then an authoritative
 * confirm against `GET /api/v1/docs/{id}/media` — a 404 `media_not_found`
 * means the candidate was a false positive and it's written as markdown
 * like any other doc.
 */

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import chalk from 'chalk';
import prompts from 'prompts';
import { Config } from '../utils/config';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { callDocsTool } from '../utils/mcp';
import { DOCS_MANIFEST, DocsManifest, ManifestEntry, readManifest, sha256Hex, writeManifest } from '../utils/docs-manifest';

// Re-exported for backward compatibility: tests and docs-push import these from here.
export { DOCS_MANIFEST, sha256Hex };
export type { DocsManifest, ManifestEntry };

/** Extension appended to a media file's sanitized title when the title itself has none. */
const MIME_EXTENSIONS: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
};

export interface DocsPullOptions {
    yes?: boolean;
    json?: boolean;
    /**
     * Discard unpushed local changes detected against the destination's
     * `.solidactions-docs.json` manifest (body_sha256 mismatch) and proceed.
     * Implies the generic non-empty-destination confirmation — no prompt.
     */
    overwrite?: boolean;
}

const CHUNK_SIZE = 50;

/** Characters that are unsafe as filesystem path segments, plus control chars. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[/\\:*?"<>|\x00-\x1f]/g;

/**
 * Replace filesystem-unsafe characters (/ \ : * ? " < > | and control chars)
 * with underscores so a server-provided name (doc title or folder name) is
 * safe to use as a single filesystem path segment. Also neutralizes bare
 * `.` and `..` segments (which would otherwise resolve to the current or
 * parent directory — a path-traversal risk for folder names in particular).
 */
export function sanitizeSegment(name: string): string {
    const replaced = name.replace(UNSAFE_CHARS, '_');
    if (replaced === '.') return '_';
    if (replaced === '..') return '__';
    return replaced;
}

/**
 * Replace filesystem-unsafe characters (/ \ : * ? " < > | and control chars)
 * in a doc title with underscores so it can be used as a file basename.
 */
export function sanitizeTitle(title: string): string {
    return sanitizeSegment(title);
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
    properties: Record<string, unknown>;
}

/**
 * A doc is a media *candidate* when the bulk_read row carries blob metadata
 * and an empty body. This is a cheap pre-filter, not authoritative — the
 * media endpoint confirm can still return a false positive (see
 * `resolveMedia`).
 */
function isMediaCandidate(doc: FetchedDoc): boolean {
    const props = doc.properties;
    return Boolean(props.blob_sha && props.mime && props.size) && doc.body === '';
}

interface MediaResolution {
    isMedia: boolean;
    mime?: string;
    /** Downloaded bytes, or null if the signed-URL download failed (still `media: true`). */
    bytes?: Buffer | null;
    warning?: string;
}

/**
 * Authoritatively confirm a media candidate against `GET /api/v1/docs/{id}/media`
 * and, if confirmed, download the returned signed URL (no auth headers — it's
 * a pre-signed R2 URL). Returns `{ isMedia: false }` for the false-positive
 * 404 `media_not_found` case, in which the caller falls back to the D1
 * markdown write path.
 */
async function resolveMedia(config: Config, doc: FetchedDoc): Promise<MediaResolution> {
    const confirm = await axios.get(`${config.host}/api/v1/docs/${doc.id}/media`, {
        headers: getApiHeaders(config),
        validateStatus: () => true,
    });

    if (confirm.status === 404 && confirm.data?.code === 'media_not_found') {
        return { isMedia: false };
    }

    if (confirm.status !== 200) {
        const code = confirm.data?.code ?? 'unknown_error';
        const message = confirm.data?.message ?? 'media confirm request failed';
        process.stderr.write(chalk.red(`error: ${code}: ${message}\n`));
        process.exit(1);
    }

    const { url, mime } = confirm.data;
    const download = await axios.get(url, { responseType: 'arraybuffer', validateStatus: () => true });
    if (download.status !== 200) {
        return { isMedia: true, mime, bytes: null, warning: `warn: failed to download media for doc ${doc.id} (${doc.title}): HTTP ${download.status}` };
    }

    return { isMedia: true, mime, bytes: Buffer.from(download.data) };
}

/**
 * Compare each manifest-tracked file against its recorded `body_sha256` to
 * find unpushed local edits. An entry without a hash (old manifest) or whose
 * file is missing locally is never reported as modified — graceful
 * degradation to "no detection" rather than a false refusal.
 */
function detectLocalModifications(destination: string, manifest: DocsManifest): string[] {
    const modified: string[] = [];
    for (const [relPath, entry] of Object.entries(manifest.docs)) {
        if (entry.body_sha256 == null) continue;
        const absPath = path.join(destination, relPath);
        // Only hash regular files. A corrupt manifest key naming a directory would
        // otherwise throw EISDIR and abort the pull before it starts.
        let stat: fs.Stats;
        try {
            stat = fs.statSync(absPath);
        } catch {
            continue; // missing locally — graceful degradation, never a false refusal
        }
        if (!stat.isFile()) continue;
        const currentHash = sha256Hex(fs.readFileSync(absPath));
        if (currentHash !== entry.body_sha256) {
            modified.push(relPath);
        }
    }
    return modified;
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
            const safeName = sanitizeSegment(folder.name);
            const childRelative = relative ? `${relative}/${safeName}` : safeName;
            queue.push({ folder_path: folder.folder_path, relative: childRelative });
        }
        for (const doc of result.data?.docs ?? []) {
            rows.push({ id: doc.id, title: doc.title, relative });
        }
    }

    return { ok: true, rows };
}

/** The bulk_read row status that means "body/revision were returned successfully". */
const BULK_READ_OK_STATUS = 'found';

/**
 * Fetch bodies + revisions for every collected row via bulk_read, chunked at
 * CHUNK_SIZE ids. A row whose status isn't `BULK_READ_OK_STATUS` (e.g. a
 * server-side `error` or `not_found`), or a requested id absent from the
 * response entirely, is soft-skipped: a warning naming the doc, no file
 * written, no manifest entry — mirroring the media download soft-skip.
 */
async function fetchBodies(config: Config, rows: DocRow[]): Promise<{ fetched: FetchedDoc[]; warnings: string[] }> {
    const byId = new Map<number, DocRow>();
    for (const row of rows) byId.set(row.id, row);

    const fetched: FetchedDoc[] = [];
    const warnings: string[] = [];
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
        const seenIds = new Set<number>();
        for (const row of resultRows) {
            const original = byId.get(row.id);
            if (!original) continue;
            seenIds.add(row.id);

            if (row.status !== BULK_READ_OK_STATUS) {
                warnings.push(`warn: skipping doc ${row.id} (${original.title}): bulk_read returned status "${row.status ?? 'unknown'}"`);
                continue;
            }

            fetched.push({
                ...original,
                body: row.body ?? '',
                current_revision_id: row.current_revision_id ?? null,
                properties: row.properties ?? {},
            });
        }

        for (const requested of chunk) {
            if (!seenIds.has(requested.id)) {
                warnings.push(`warn: skipping doc ${requested.id} (${requested.title}): missing from bulk_read results`);
            }
        }
    }

    return { fetched, warnings };
}

/**
 * A fetched doc resolved to its final on-disk path (including per-directory
 * collision suffixes), with media confirmed/downloaded and its content hash
 * computed. No filesystem writes happen while building this — see
 * `commitDocs`. Kept separate so a caller can inspect the plan (e.g. to
 * check for an unpushed-local-changes conflict) before anything touches
 * disk.
 */
interface PlannedDoc {
    doc: FetchedDoc;
    relPath: string;
    dirRel: string;
    fileName: string;
    isMedia: boolean;
    /** Bytes to write for a media doc; null if the signed-URL download failed. */
    mediaBytes: Buffer | null;
    bodySha256: string | null;
}

/**
 * Resolve every fetched doc into a `PlannedDoc` — final relative path and
 * content hash — confirming/downloading media as needed. This is the only
 * place that talks to the media confirm/download endpoints; it performs no
 * filesystem writes.
 */
async function planDocs(docs: FetchedDoc[], config: Config): Promise<{ planned: PlannedDoc[]; warnings: string[] }> {
    const planned: PlannedDoc[] = [];
    const warnings: string[] = [];
    const usedNamesByDir = new Map<string, Set<string>>();

    for (const doc of docs) {
        const dirRel = doc.relative;

        let used = usedNamesByDir.get(dirRel);
        if (!used) {
            used = new Set();
            usedNamesByDir.set(dirRel, used);
        }

        const media = isMediaCandidate(doc) ? await resolveMedia(config, doc) : { isMedia: false as const };
        if (media.warning) warnings.push(media.warning);

        const sanitized = sanitizeTitle(doc.title);
        let base = sanitized;
        let ext = '.md';
        if (media.isMedia) {
            const titleExt = path.extname(sanitized);
            if (titleExt) {
                base = sanitized.slice(0, -titleExt.length);
                ext = titleExt;
            } else {
                base = sanitized;
                ext = (media.mime && MIME_EXTENSIONS[media.mime]) ?? '';
            }
        }

        let candidate = base;
        let suffix = 2;
        while (used.has(`${candidate}${ext}`)) {
            candidate = `${base}-${suffix}`;
            suffix++;
        }
        used.add(`${candidate}${ext}`);

        const fileName = `${candidate}${ext}`;
        const relPath = dirRel ? `${dirRel}/${fileName}` : fileName;

        let bodySha256: string | null;
        let mediaBytes: Buffer | null = null;
        if (media.isMedia) {
            if (media.bytes) {
                mediaBytes = media.bytes;
                bodySha256 = sha256Hex(media.bytes);
            } else {
                // Download failure: warning already recorded above; the doc is still
                // tracked (manifest entry written by commitDocs) but there is nothing
                // to write to disk.
                bodySha256 = null;
            }
        } else {
            bodySha256 = sha256Hex(doc.body);
        }

        planned.push({ doc, relPath, dirRel, fileName, isMedia: media.isMedia, mediaBytes, bodySha256 });
    }

    return { planned, warnings };
}

/**
 * Write every planned doc to disk under `destination` and build the
 * manifest docs map. The only step in the whole pull that creates
 * directories or writes/overwrites files — called only after any
 * unpushed-local-changes conflict has already refused, so it never clobbers
 * a file the caller decided to keep.
 */
function commitDocs(destination: string, planned: PlannedDoc[]): { manifestDocs: DocsManifest['docs']; files: Array<{ path: string; action: 'written' }> } {
    const manifestDocs: DocsManifest['docs'] = {};
    const files: Array<{ path: string; action: 'written' }> = [];

    for (const p of planned) {
        const dirAbs = p.dirRel ? path.join(destination, ...p.dirRel.split('/')) : destination;
        fs.mkdirSync(dirAbs, { recursive: true });

        // A destination path that already exists as a directory would make writeFileSync
        // throw EISDIR mid-walk, after earlier docs were written and before the manifest
        // is saved — a half-pulled tree with a stale sidecar. Fail cleanly instead.
        const targetAbs = path.join(dirAbs, p.fileName);
        if (fs.existsSync(targetAbs) && !fs.statSync(targetAbs).isFile()) {
            process.stderr.write(chalk.red(`error: "${p.relPath}" exists and is not a regular file — cannot write doc ${p.doc.id} (${p.doc.title}).\n`));
            process.exit(1);
        }

        if (p.isMedia) {
            if (p.mediaBytes) {
                fs.writeFileSync(targetAbs, p.mediaBytes);
                files.push({ path: p.relPath, action: 'written' });
            }
            // else: download failure, warning already recorded by planDocs; skip the
            // write but still record the manifest entry below so the doc isn't lost.
        } else {
            fs.writeFileSync(targetAbs, p.doc.body, 'utf8');
            files.push({ path: p.relPath, action: 'written' });
        }

        manifestDocs[p.relPath] = {
            id: p.doc.id,
            title: p.doc.title,
            current_revision_id: p.doc.current_revision_id,
            media: p.isMedia,
            body_sha256: p.bodySha256,
        };
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

    // Captured once, before the walk, so deletion propagation (below) can diff
    // against the folder tree as it stood before this pull. Already read below
    // for overwrite protection — hoisted here rather than read twice.
    const previousManifest = fs.existsSync(destination) ? readManifest(destination) : null;
    let usedSingleDocFallback = false;

    // Overwrite-confirm: warn + confirm on a non-empty destination before any network I/O.
    // The unpushed-local-changes conflict refusal (detectLocalModifications) happens later,
    // in report() — only once the server walk is known can it tell a real conflict (the
    // doc still exists remotely) from an edited orphan (kept + warned, no flag needed).
    if (fs.existsSync(destination)) {
        if (!fs.statSync(destination).isDirectory()) {
            process.stderr.write(chalk.red(`error: destination "${destination}" exists and is not a directory.\n`));
            process.exit(1);
        }

        const entries = fs.readdirSync(destination);
        if (entries.length > 0 && !options.yes && !options.overwrite) {
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
        usedSingleDocFallback = true;
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
            properties: data.properties ?? {},
        }];

        await report(destination, folderPath, fetched, options, config, [], previousManifest, usedSingleDocFallback);
        return;
    } else {
        process.stderr.write(chalk.red(`error: ${listResult.code}: ${listResult.message}\n`));
        process.exit(1);
        return;
    }

    const { fetched, warnings: fetchWarnings } = await fetchBodies(config, rows);
    await report(destination, folderPath, fetched, options, config, fetchWarnings, previousManifest, usedSingleDocFallback);
}

/** Write the docs + manifest to disk and print the result (chalk lines or --json). */
async function report(
    destination: string,
    folderPath: string,
    fetched: FetchedDoc[],
    options: DocsPullOptions,
    config: Config,
    extraWarnings: string[],
    previousManifest: DocsManifest | null,
    usedSingleDocFallback: boolean,
): Promise<void> {
    const { planned, warnings } = await planDocs(fetched, config);

    // Unpushed-local-changes protection: now that the server walk is known, refuse only
    // for a file whose doc still exists remotely — i.e. its relative path is part of this
    // pull's plan and would be overwritten by commitDocs below. A modified file whose
    // relPath is NOT in the plan is an orphan, not a conflict: it is left alone here and
    // the deletion-propagation block further down keeps it and warns (no --overwrite
    // needed). This check must run before commitDocs — nothing may be written to disk
    // before a real conflict has had the chance to refuse.
    if (previousManifest && !options.overwrite) {
        const modified = detectLocalModifications(destination, previousManifest);
        const plannedPaths = new Set(planned.map((p) => p.relPath));
        const conflicts = modified.filter((relPath) => plannedPaths.has(relPath));
        if (conflicts.length > 0) {
            const noun = conflicts.length === 1 ? 'file has' : 'files have';
            process.stderr.write(chalk.red(`${conflicts.length} ${noun} unpushed local changes:\n`));
            for (const file of conflicts) {
                process.stderr.write(chalk.red(`  ${file}\n`));
            }
            process.stderr.write(chalk.red('push your changes first, or pass --overwrite to discard them.\n'));
            process.exit(1);
        }
    }

    fs.mkdirSync(destination, { recursive: true });
    const { manifestDocs, files } = commitDocs(destination, planned);

    const manifest: DocsManifest = { folder_path: folderPath, docs: manifestDocs };
    writeManifest(destination, manifest);

    for (const warning of [...extraWarnings, ...warnings]) {
        process.stderr.write(chalk.yellow(`${warning}\n`));
    }

    const removed: string[] = [];
    const keptModified: string[] = [];

    // Deletion propagation is only safe when the old manifest describes the SAME
    // folder we just pulled. Otherwise every tracked file looks like an orphan and
    // the unmodified ones would be deleted. The single-doc fallback writes a
    // one-entry manifest, so it can never speak for a folder's contents either.
    const canPropagateDeletions =
        previousManifest !== null &&
        !usedSingleDocFallback &&
        previousManifest.folder_path === folderPath;

    if (canPropagateDeletions) {
        const destPrefix = path.resolve(destination) + path.sep;

        for (const [relPath, entry] of Object.entries(previousManifest!.docs)) {
            if (manifestDocs[relPath]) continue;

            const absPath = path.resolve(destination, ...relPath.split('/'));

            // Containment: a hand-edited or corrupt manifest key such as "../../etc/passwd"
            // would otherwise resolve outside the pull destination. `docs pull` never writes
            // such a key (titles are sanitized), but this loop is the only code in the CLI
            // that deletes files — never let it act on a path it did not create.
            if (!absPath.startsWith(destPrefix)) continue;

            // Only ever remove regular files. A directory here means a corrupt manifest;
            // rmSync would throw mid-pull, leaving a half-deleted tree.
            //
            // The whole entry is guarded: the new manifest is already on disk by now, so an
            // uncaught throw would abort the report, silently skip every later orphan, and
            // print a raw stack trace instead of this command's normal error format. One bad
            // entry must cost only that entry.
            try {
                const stat = fs.statSync(absPath);
                if (!stat.isFile()) continue;

                const currentHash = sha256Hex(fs.readFileSync(absPath));
                if (entry.body_sha256 != null && entry.body_sha256 === currentHash) {
                    fs.rmSync(absPath);
                    removed.push(relPath);
                } else {
                    keptModified.push(relPath);
                }
            } catch {
                // Vanished mid-run, unreadable, or refuses inspection: never delete blind.
                continue;
            }
        }
    }

    if (options.json) {
        console.log(JSON.stringify({ manifest, files, removed, kept_modified: keptModified }));
        process.exit(0);
    }

    console.log(chalk.green(`pulled ${files.length} doc${files.length === 1 ? '' : 's'} → ${destination}`));
    for (const file of files) {
        console.log(chalk.gray(`  ${file.path}`));
    }
    for (const file of removed) {
        console.log(chalk.gray(`- removed (deleted remotely): ${file}`));
    }
    for (const file of keptModified) {
        process.stderr.write(chalk.yellow(`! kept ${file} — deleted remotely but modified locally\n`));
        process.stderr.write(chalk.yellow('  (it is now untracked; `docs push` will re-create it)\n'));
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

/**
 * solidactions doc pull <folder> [dest]
 *
 * Downloads a Docs folder tree from SA-Docs into a local file tree (the
 * inverse of `doc push`): BFS-walks the folder via `docs_read` `list`,
 * bulk-fetches doc bodies via `docs_read` `bulk_read`, and writes each doc as
 * <dest>/<relative-folder>/<sanitized-title>.md — visual docs as `.html` and
 * canvases as `.canvas.json` — plus a revision manifest
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
import { authFailedLine, getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import { callDocsTool } from '../utils/mcp';
import { escapeJsonDisplayText, sanitizeDisplayText } from '../utils/source-provenance';
import { DOCS_MANIFEST, DocsManifest, ManifestEntry, readManifest, sha256Hex, writeManifest } from '../utils/docs-manifest';

// Re-exported for backward compatibility: tests and doc-push import these from here.
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

export interface DocPullOptions {
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

/** Server-derived text (a title, code, message, or a path built from titles and folder names) as printed (cli#189). Display only. */
function shown(value: unknown): string {
    return sanitizeDisplayText(value, 1024) ?? '(untitled)';
}

/**
 * Command error boundary (cli#189): an escaping error — a filesystem throw
 * embedding a server-derived path, or a server-bearing exception like
 * `McpRpcError` — prints through shown() like every other server-derived
 * message. Keeps the diagnostic meaning; exits 1, as the top-level handler
 * would.
 */
function reportWriteError(error: unknown): never {
    process.stderr.write(chalk.red(`error: ${shown(error instanceof Error ? error.message : String(error))}\n`));
    process.exit(1);
}

/** Row collected during the BFS list walk, before bodies are fetched. */
interface DocRow {
    id: number;
    title: string;
    /** Relative folder path from the pull root, '' for the root itself, using '/' separators. */
    relative: string;
    /** The list row's doc_type slug (null for untyped docs), plus whether the row carried the key. */
    docType?: string | null;
    docTypeKnown: boolean;
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

    if (confirm.status === 401) {
        process.stderr.write(chalk.red(authFailedLine(config.host)) + '\n');
        process.exit(1);
    }

    if (confirm.status !== 200) {
        const code = confirm.data?.code ?? 'unknown_error';
        const message = confirm.data?.message ?? 'media confirm request failed';
        process.stderr.write(chalk.red(`error: ${shown(code)}: ${shown(message)}\n`));
        process.exit(1);
    }

    const { url, mime } = confirm.data;
    const download = await axios.get(url, { responseType: 'arraybuffer', validateStatus: () => true });
    if (download.status !== 200) {
        return { isMedia: true, mime, bytes: null, warning: `warn: failed to download media for doc ${doc.id} (${shown(doc.title)}): HTTP ${download.status}` };
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
 * BFS-walk `folderPath` via `docs_read` `list`, collecting every doc row with
 * its relative folder path. Returns null (with the list error message
 * already known to the caller) if the root list call fails.
 */
async function listTree(config: Config, folderPath: string): Promise<{ ok: true; rows: DocRow[] } | { ok: false; isRoot: boolean; code: string; message: string }> {
    const rows: DocRow[] = [];
    const queue: Array<{ folder_path: string; relative: string }> = [{ folder_path: folderPath, relative: '' }];
    let first = true;

    while (queue.length > 0) {
        const { folder_path, relative } = queue.shift()!;
        const result = await callDocsTool(config, { action: 'list', folder_path });

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
            rows.push({
                id: doc.id,
                title: doc.title,
                relative,
                docType: doc.doc_type == null ? null : (doc.doc_type.slug ?? null),
                docTypeKnown: Object.prototype.hasOwnProperty.call(doc, 'doc_type'),
            });
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
        const result = await callDocsTool(config, {
            action: 'bulk_read',
            items: chunk.map((r) => ({ id: r.id })),
        });

        if (!result.ok) {
            const code = result.data?.code ?? 'unknown_error';
            const message = result.data?.message ?? 'MCP returned an error with no message';
            process.stderr.write(chalk.red(`error: ${shown(code)}: ${shown(message)}\n`));
            process.exit(1);
        }

        const resultRows = result.data?.results ?? [];
        const seenIds = new Set<number>();
        for (const row of resultRows) {
            const original = byId.get(row.id);
            if (!original) continue;
            seenIds.add(row.id);

            if (row.status !== BULK_READ_OK_STATUS) {
                warnings.push(`warn: skipping doc ${row.id} (${shown(original.title)}): bulk_read returned status "${shown(row.status ?? 'unknown')}"`);
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
                warnings.push(`warn: skipping doc ${requested.id} (${shown(requested.title)}): missing from bulk_read results`);
            }
        }
    }

    return { fetched, warnings };
}

/**
 * Fill in the doc type for fetched docs whose list row did not carry a
 * `doc_type` key (cli#157): one `read_doc {id}` per unknown doc. A doc whose
 * type still cannot be read keeps `null` (written as .md) with a warning.
 */
async function backfillDocTypes(config: Config, fetched: FetchedDoc[]): Promise<string[]> {
    const warnings: string[] = [];
    for (const doc of fetched) {
        if (doc.docTypeKnown) continue;
        let slug: string | null = null;
        let readOk = false;
        try {
            const result = await callDocsTool(config, { action: 'read_doc', id: doc.id });
            if (result.ok) {
                readOk = true;
                slug = result.data?.doc_type?.slug ?? null;
            }
        } catch {
            readOk = false;
        }
        // A successful read that simply reports no type (doc_type: null) is a
        // valid untyped doc, not a failure — warn only when the type could
        // not be read at all.
        if (!readOk) {
            warnings.push(`warn: could not read the type of doc ${doc.id} (${shown(doc.title)}); writing it as .md`);
        }
        doc.docType = slug;
        doc.docTypeKnown = true;
    }
    return warnings;
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

/** Previously-manifested paths for the single-doc fallback allocator (cli#153 C1). */
export interface SingleDocReserved {
    usedNames: Map<string, Set<string>>;
    pathById: Map<number, string>;
    /** Previous manifest title per doc id; an unchanged title keeps its collision path (R2-I2). */
    titleById: Map<number, string>;
}

/**
 * Allocate the first free `<base>[ -N]<ext>` name not present in `used`,
 * recording the winner in `used`.
 */
function allocateName(used: Set<string>, base: string, ext: string): string {
    let candidate = base;
    let suffix = 2;
    const usedFolded = new Set([...used].map((name) => name.toLowerCase()));
    while (usedFolded.has(`${candidate}${ext}`.toLowerCase())) {
        candidate = `${base}-${suffix}`;
        suffix++;
    }
    const fileName = `${candidate}${ext}`;
    used.add(fileName);
    return fileName;
}

/**
 * Whether `file` is the allocator's own output for `base` + `ext`: exactly
 * `<base><ext>` or `<base>-N<ext>` with an integer N >= 2.
 */
function isCollisionVariant(file: string, base: string, ext: string): boolean {
    if (file === `${base}${ext}`) return true;
    if (!file.startsWith(`${base}-`) || !file.endsWith(ext)) return false;
    const middle = file.slice(base.length + 1, file.length - ext.length);
    return middle !== '' && Number.isInteger(Number(middle)) && Number(middle) >= 2;
}

/**
 * Resolve every fetched doc into a `PlannedDoc` — final relative path and
 * content hash — confirming/downloading media as needed. This is the only
 * place that talks to the media confirm/download endpoints; it performs no
 * filesystem writes.
 *
 * The optional `reserved` parameter serves the single-doc fallback pull
 * (cli#153 C1): `usedNames` seeds the `-2`/`-3` allocator per directory
 * with the file names the previous manifest assigns, and `pathById` frees
 * each pulled doc's own tracked name back to it, so a stable title
 * reallocates its own path (reuse in effect) while every other tracked
 * name still forces a suffix. When the tracked title is unchanged and the
 * tracked path is a collision variant of that title in the same folder,
 * the doc keeps that exact path (R2-I2); a renamed/stale path still
 * reallocates. Folder pulls reserve only paths whose title, directory and
 * extension stay unchanged, keeping their exact spelling regardless of list
 * order without reserving the old names of docs that move away.
 */
async function planDocs(docs: FetchedDoc[], config: Config, reserved?: SingleDocReserved, previousManifest?: DocsManifest | null): Promise<{ planned: PlannedDoc[]; warnings: string[] }> {
    const planned: PlannedDoc[] = [];
    const warnings: string[] = [];
    const usedNamesByDir = new Map<string, Set<string>>();
    if (reserved) {
        for (const [dir, names] of reserved.usedNames) {
            usedNamesByDir.set(dir, new Set(names));
        }
    }

    const pathById = reserved?.pathById ?? new Map<number, string>();
    const titleById = reserved?.titleById ?? new Map<number, string>();
    if (!reserved && previousManifest) {
        for (const [rel, entry] of Object.entries(previousManifest.docs)) {
            if (pathById.has(entry.id)) continue;
            pathById.set(entry.id, rel);
            titleById.set(entry.id, entry.title);
        }
    }
    const prepared: Array<{ doc: FetchedDoc; media: MediaResolution; base: string; ext: string; bodySha256: string | null; mediaBytes: Buffer | null }> = [];
    for (const doc of docs) {
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
        } else if (doc.docType === 'visual') {
            ext = '.html';
        } else if (doc.docType === 'canvas') {
            ext = '.canvas.json';
        }

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

        prepared.push({ doc, media, base, ext, bodySha256, mediaBytes });
    }

    const stablePath = (doc: FetchedDoc, base: string, ext: string): string | undefined => {
        const ownRelPath = pathById.get(doc.id);
        if (ownRelPath === undefined || titleById.get(doc.id) !== doc.title) return undefined;
        const slash = ownRelPath.lastIndexOf('/');
        const ownDir = slash === -1 ? '' : ownRelPath.slice(0, slash);
        const ownFile = slash === -1 ? ownRelPath : ownRelPath.slice(slash + 1);
        return ownDir === doc.relative && isCollisionVariant(ownFile, base, ext) ? ownRelPath : undefined;
    };
    if (!reserved) {
        for (const { doc, base, ext } of prepared) {
            const rel = stablePath(doc, base, ext);
            if (rel === undefined) continue;
            const used = usedNamesByDir.get(doc.relative) ?? new Set<string>();
            used.add(path.posix.basename(rel));
            usedNamesByDir.set(doc.relative, used);
        }
    }
    for (const { doc, media, base, ext, bodySha256, mediaBytes } of prepared) {
        const dirRel = doc.relative;
        const used = usedNamesByDir.get(dirRel) ?? new Set<string>();
        usedNamesByDir.set(dirRel, used);
        const ownRelPath = pathById.get(doc.id);
        if (reserved && ownRelPath !== undefined && path.posix.dirname(ownRelPath) === (dirRel || '.')) {
            // Exact ownership matters: freeing Page.md must not free page.md
            // when another tracked doc owns that differently cased name.
            used.delete(path.posix.basename(ownRelPath));
        }
        const keptPath = stablePath(doc, base, ext);
        const fileName = keptPath === undefined ? allocateName(used, base, ext) : path.posix.basename(keptPath);
        const relPath = keptPath ?? (dirRel ? `${dirRel}/${fileName}` : fileName);
        used.add(fileName);
        planned.push({ doc, relPath, dirRel, fileName, isMedia: media.isMedia, mediaBytes, bodySha256 });
    }

    return { planned, warnings };
}

/**
 * Write every planned doc to disk under `destination` and build the
 * manifest docs map. The only step in the whole pull that creates
 * directories or writes/overwrites files — called only after every refusal
 * (unpushed local changes, rename conflicts, a target that is not a regular
 * file) has had its chance, so it never stops half-way or clobbers a file
 * the caller decided to keep.
 */
function commitDocs(destination: string, planned: PlannedDoc[]): { manifestDocs: DocsManifest['docs']; files: Array<{ path: string; action: 'written' }> } {
    const manifestDocs: DocsManifest['docs'] = {};
    const files: Array<{ path: string; action: 'written' }> = [];

    for (const p of planned) {
        const dirAbs = p.dirRel ? path.join(destination, ...p.dirRel.split('/')) : destination;
        fs.mkdirSync(dirAbs, { recursive: true });
        const targetAbs = path.join(dirAbs, p.fileName);

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
 * Manifest-clobber protection, against the RESOLVED folder: the argument itself for a folder
 * pull, the doc's own folder for a single-doc pull (cli#153). Runs once the server has said
 * which one the argument is, and before anything is written. --overwrite bypasses it.
 */
function refuseManifestClobber(previousManifest: DocsManifest | null, resolvedFolder: string, argument: string, destination: string, options: DocPullOptions): void {
    if (previousManifest === null || previousManifest.folder_path === resolvedFolder || options.overwrite) {
        return;
    }
    process.stderr.write(chalk.red(`error: "${shown(destination)}" already tracks "${shown(previousManifest.folder_path)}".\n`));
    process.stderr.write(chalk.red(`Pulling "${shown(argument)}" here would replace its manifest, and local edits to the\n`));
    process.stderr.write(chalk.red('previously tracked files would no longer be protected from being overwritten.\n'));
    process.stderr.write(chalk.red('Pull into a different directory, or pass --overwrite to replace the manifest.\n'));
    process.exit(1);
}

/**
 * Core implementation — accepts an injected config so tests can point at a
 * stub server without touching the filesystem config.
 */
export async function docPullWithConfig(
    folderPath: string,
    dest: string | undefined,
    options: DocPullOptions,
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
        let entries: string[];
        try {
            if (!fs.statSync(destination).isDirectory()) {
                process.stderr.write(chalk.red(`error: destination "${shown(destination)}" exists and is not a directory.\n`));
                process.exit(1);
            }
            entries = fs.readdirSync(destination);
        } catch (error) {
            // cli#191: one line naming the destination, never a raw scandir stack.
            process.stderr.write(chalk.red(`error: cannot read ${shown(destination)}: ${shown((error as Error).message)}\n`));
            process.exit(1);
        }
        if (entries.length > 0 && !options.yes && !options.overwrite) {
            if (process.stdin.isTTY !== true) {
                // cli#176: nobody can answer the prompt; a script must not read "Cancelled" as success.
                process.stderr.write(chalk.red(`error: ${shown(destination)} is not empty and there is no terminal to confirm the pull; pass -y to pull into it.\n`));
                process.exit(1);
            }
            console.log(chalk.yellow(`Destination "${shown(destination)}" is not empty (${entries.length} items).`));
            console.log(chalk.yellow("Pulling overwrites tracked files; local files the folder doesn't track are refused unless --overwrite."));
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

    // Manifest-clobber protection runs later, once the server has said whether the
    // argument is a folder or a doc: refuseManifestClobber compares against the
    // RESOLVED folder (the argument for a folder pull, the doc's own folder for a
    // single-doc pull), still before anything is written.
    let rows: DocRow[];

    const listResult = await listTree(config, folderPath);
    if (listResult.ok) {
        rows = listResult.rows;
        refuseManifestClobber(previousManifest, folderPath, folderPath, destination, options);
    } else if (listResult.isRoot && listResult.code === 'folder_path_not_found') {
        // Single-doc fallback: the target might be a doc path, not a folder.
        usedSingleDocFallback = true;
        const dir = path.dirname(folderPath);
        const title = path.basename(folderPath);
        const readArgs: Record<string, unknown> = { action: 'read_doc', path: dir === '.' ? { title } : { folder_path: dir, title } };
        const readResult = await callDocsTool(config, readArgs);

        if (!readResult.ok) {
            const readCode = readResult.data?.code ?? 'unknown_error';
            const readMessage = readResult.data?.message ?? 'MCP returned an error with no message';
            process.stderr.write(chalk.red(`error: ${shown(listResult.code)}: ${shown(listResult.message)}\n`));
            process.stderr.write(chalk.red(`error: ${shown(readCode)}: ${shown(readMessage)}\n`));
            process.exit(1);
        }

        const data = readResult.data;
        const fetched: FetchedDoc[] = [{
            id: data.id,
            title: data.title,
            relative: '',
            docType: data.doc_type?.slug ?? null,
            docTypeKnown: true,
            body: data.body ?? '',
            current_revision_id: data.current_revision_id ?? null,
            properties: data.properties ?? {},
        }];

        // The doc's real folder, not the argument (cli#153): a later `doc push` creates
        // untracked files under the manifest's folder_path.
        const docFolder = typeof data.folder_path === 'string' ? data.folder_path : (dir === '.' ? '' : dir);
        refuseManifestClobber(previousManifest, docFolder, folderPath, destination, options);

        await report(destination, docFolder, fetched, options, config, [], previousManifest, usedSingleDocFallback);
        return;
    } else {
        process.stderr.write(chalk.red(`error: ${shown(listResult.code)}: ${shown(listResult.message)}\n`));
        process.exit(1);
        return;
    }

    const { fetched, warnings: fetchWarnings } = await fetchBodies(config, rows);
    const typeWarnings = await backfillDocTypes(config, fetched);
    await report(destination, folderPath, fetched, options, config, [...fetchWarnings, ...typeWarnings], previousManifest, usedSingleDocFallback);
}

/**
 * Safety guards shared by deletion propagation and rename cleanup (cli#157):
 * lexical containment in the destination, a regular file, physical
 * containment of the real parent directory (no symlink escape), and never a
 * file this pull just wrote. The only code in the CLI that deletes files —
 * never act on a path it did not create.
 */
function isSafeToRemoveTrackedFile(absPath: string, destPrefix: string, realDest: string, writtenIdentities: Set<string>): boolean {
    // Containment: a hand-edited or corrupt manifest key such as "../../etc/passwd"
    // would otherwise resolve outside the pull destination.
    if (!absPath.startsWith(destPrefix)) return false;

    // Only ever remove regular files. A directory here means a corrupt manifest;
    // rmSync would throw mid-pull, leaving a half-deleted tree.
    let stat: fs.Stats;
    try {
        stat = fs.statSync(absPath);
    } catch {
        return false;
    }
    if (!stat.isFile()) return false;

    // Physical containment: the lexical check above only guards the string. If
    // an intermediate path segment is a symlink to a directory OUTSIDE the
    // destination, statSync/rmSync all follow it transparently.
    let realParent: string;
    try {
        realParent = fs.realpathSync(path.dirname(absPath));
    } catch {
        return false;
    }
    if (realParent !== realDest && !realParent.startsWith(realDest + path.sep)) return false;

    // Identity: never delete a file this pull just wrote.
    if (writtenIdentities.has(`${stat.dev}:${stat.ino}`)) return false;

    return true;
}

/** Resolve directory aliases even when a planned file or its parent does not exist yet. */
function physicalTargetPath(absPath: string): string {
    const missing: string[] = [];
    let existing = absPath;
    while (true) {
        try {
            return path.join(fs.realpathSync(existing), ...missing.reverse());
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            try {
                if (fs.lstatSync(existing).isSymbolicLink()) {
                    existing = path.resolve(path.dirname(existing), fs.readlinkSync(existing));
                    continue;
                }
            } catch (linkError) {
                if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT') throw linkError;
            }
            const parent = path.dirname(existing);
            if (parent === existing) throw error;
            missing.push(path.basename(existing));
            existing = parent;
        }
    }
}

/** The first symbolic link on `rel`'s way (inside `destination`, the destination itself excluded), as a relative path; null when there is none. */
function linkOnTheWay(destination: string, rel: string): string | null {
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) {
        const abs = path.join(destination, ...parts.slice(0, i));
        try {
            if (fs.lstatSync(abs).isSymbolicLink()) return parts.slice(0, i).join('/');
        } catch {
            return null; // the rest does not exist yet
        }
    }
    return null;
}

function refuseLink(rel: string, link: string, doc: { id: number; title: string }): never {
    const where = link === rel ? '' : ` (or sits under one: ${shown(link)})`;
    process.stderr.write(chalk.red(`error: ${shown(rel)} is a symbolic link${where}; this pull would write doc ${doc.id} ("${shown(doc.title)}") through it.\n`));
    process.stderr.write(chalk.red('Replace it with a regular file or folder and pull again.\n'));
    process.exit(1);
}

/** One line for a path that cannot be resolved (spec §2.3): the ELOOP wording, or the error code and message. Never returns. */
function explainUnresolvable(label: string, error: unknown): never {
    const code = (error as NodeJS.ErrnoException).code ?? 'ERROR';
    const reason = code === 'ELOOP' ? 'too many symbolic links (ELOOP). Fix or remove the link and pull again.' : `${code} ${(error as Error).message}.`;
    process.stderr.write(chalk.red(`error: cannot resolve ${shown(label)}: ${shown(reason)}\n`));
    process.exit(1);
}

/** physicalTargetPath, but a resolution error becomes one line (spec §2.3). A planned target with a link on the way gets the symbolic-link refusal. */
function resolveOrExplain(destination: string, rel: string, target?: { id: number; title: string }): string {
    const abs = path.resolve(destination, ...rel.split('/'));
    try {
        return physicalTargetPath(abs);
    } catch (error) {
        if (target) {
            const link = linkOnTheWay(destination, rel);
            if (link !== null) refuseLink(rel, link, target);
        }
        explainUnresolvable(rel, error);
    }
}

/**
 * Refuse, before any write, a pull that would write a planned doc through a
 * symbolic link or to a place that resolves outside the destination. Covers
 * every planned doc, including a failed media download: commitDocs still
 * creates its directory. Also refuse, unless `--overwrite`, a planned write
 * over a regular file the pull does not own (cli#167): one the previous
 * manifest does not track with a hash and whose bytes differ from the
 * pulled ones. A file already holding the pulled bytes is adopted, and a
 * rename's own source file (a case-only retitle on a case-insensitive
 * filesystem) is never "untracked".
 */
function checkPlannedWrites(
    destination: string,
    planned: PlannedDoc[],
    previousManifest: DocsManifest | null,
    options: DocPullOptions,
    renameMoves: RenameMove[],
): void {
    // First, so a destination that is itself a looping link gets one line, not a raw ELOOP from the sidecar check below.
    let realDest: string;
    try {
        realDest = physicalTargetPath(path.resolve(destination));
    } catch (error) {
        explainUnresolvable(destination, error);
    }
    // The manifest sidecar is written at the end of every pull: never through a link.
    try {
        if (fs.lstatSync(path.join(destination, DOCS_MANIFEST)).isSymbolicLink()) {
            process.stderr.write(chalk.red(`error: ${DOCS_MANIFEST} is a symbolic link; this pull would write the docs manifest through it.\n`));
            process.stderr.write(chalk.red('Replace it with a regular file or folder and pull again.\n'));
            process.exit(1);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') explainUnresolvable(DOCS_MANIFEST, error);
    }
    for (const p of planned) {
        const link = linkOnTheWay(destination, p.relPath);
        if (link !== null) refuseLink(p.relPath, link, p.doc);
        const physical = resolveOrExplain(destination, p.relPath, p.doc);
        // Belt and braces behind linkOnTheWay, which refuses every link first; kept in case the physical path ever diverges without one.
        if (physical !== realDest && !physical.startsWith(realDest + path.sep)) {
            process.stderr.write(chalk.red(`error: ${shown(p.relPath)} resolves outside the destination (${shown(physical)}); this pull would write doc ${p.doc.id} ("${shown(p.doc.title)}") there.\n`));
            process.exit(1);
        }
    }
    if (options.overwrite) return;

    const untracked: string[] = [];
    for (const p of planned) {
        if (p.isMedia && p.mediaBytes === null) continue; // a failed download writes nothing
        const tracked = previousManifest?.docs[p.relPath];
        if (tracked !== undefined && tracked.body_sha256 != null) continue; // checked as unpushed local changes
        const targetAbs = path.join(destination, ...p.relPath.split('/'));
        let targetStat: fs.Stats;
        let current: Buffer;
        try {
            targetStat = fs.statSync(targetAbs);
            if (!targetStat.isFile()) continue;
            current = fs.readFileSync(targetAbs);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? 'ERROR';
            if (code === 'ENOENT') continue; // absent: nothing to overwrite here
            untracked.push(`${p.relPath} (cannot be read: ${code})`); // present but unverifiable: not owned
            continue;
        }
        if (sha256Hex(current) === p.bodySha256) continue;
        const ownSource = renameMoves.find((m) => m.id === p.doc.id)?.sourceIdentity;
        if (ownSource === `${targetStat.dev}:${targetStat.ino}`) continue;
        untracked.push(p.relPath);
    }
    if (untracked.length > 0) {
        const one = untracked.length === 1;
        process.stderr.write(chalk.red(`${untracked.length} ${one ? 'file exists' : 'files exist'} locally but ${one ? 'is' : 'are'} not tracked:\n`));
        for (const rel of untracked) process.stderr.write(chalk.red(`  ${shown(rel)}\n`));
        process.stderr.write(chalk.red('Move them aside and pull again, or pass --overwrite to replace them.\n'));
        process.exit(1);
    }
}

interface RenameMove {
    oldRel: string;
    newRel: string;
    id: number;
    title: string;
    /** `old` holds a regular file (following a symlink); absent, a directory or a dangling link is nothing to keep or remove. */
    sourcePresent: boolean;
    /** Device + inode of a present source, following filesystem aliases. */
    sourceIdentity: string | null;
    /** The present source's bytes differ from its recorded hash (or cannot be read). Always false without a source. */
    modified: boolean;
    replacementWritten: boolean;
    /** `new` is the very file at `old` (a case-only rename on a case-insensitive filesystem). */
    targetIsSource: boolean;
}

/** Write the docs + manifest to disk and print the result (chalk lines or --json). */
async function report(
    destination: string,
    folderPath: string,
    fetched: FetchedDoc[],
    options: DocPullOptions,
    config: Config,
    extraWarnings: string[],
    previousManifest: DocsManifest | null,
    usedSingleDocFallback: boolean,
): Promise<void> {
    // Single-doc fallback merging into a manifest that tracks the same folder
    // must not steal a filename another tracked doc owns (cli#153 C1): the
    // pulled doc reuses its own tracked path, and the allocator avoids every
    // path the manifest assigns to other ids. Folder pulls pass nothing.
    let reserved: SingleDocReserved | undefined;
    if (usedSingleDocFallback && previousManifest !== null && previousManifest.folder_path === folderPath) {
        const usedNames = new Map<string, Set<string>>();
        const pathById = new Map<number, string>();
        const titleById = new Map<number, string>();
        for (const [relPath, entry] of Object.entries(previousManifest.docs)) {
            pathById.set(entry.id, relPath);
            titleById.set(entry.id, entry.title);
            const slash = relPath.lastIndexOf('/');
            const dir = slash === -1 ? '' : relPath.slice(0, slash);
            const file = slash === -1 ? relPath : relPath.slice(slash + 1);
            let names = usedNames.get(dir);
            if (!names) {
                names = new Set();
                usedNames.set(dir, names);
            }
            names.add(file);
        }
        reserved = { usedNames, pathById, titleById };
    }
    const { planned, warnings } = await planDocs(fetched, config, reserved, previousManifest);

    // Same doc id under a different path is a rename (PM ruling 2, cli#157):
    // the previous manifest tracks a planned doc under a DIFFERENT path `old`,
    // whatever is on disk at `old` (cli#157 FR4-C1). What is at `old` decides
    // only what happens to `old`; the target checks below apply to every
    // rename. Every rename ends one of three ways:
    //   (a) `old` is removed only after its replacement is written (nothing to
    //       remove when `old` holds no regular file);
    //   (b) `old`'s tracking (and file, if any) is kept, the replacement is
    //       not written;
    //   (c) the pull refuses here, before any write.
    // Never: bytes lost, an untracked file overwritten without --overwrite,
    // or one doc's tracking attached to another doc's bytes.
    const renameMoves: RenameMove[] = [];
    if (previousManifest) {
        const pathById = new Map<number, string>();
        for (const [relPath, entry] of Object.entries(previousManifest.docs)) {
            if (!pathById.has(entry.id)) pathById.set(entry.id, relPath);
        }
        for (const p of planned) {
            const old = pathById.get(p.doc.id);
            if (old === undefined || old === p.relPath) continue;
            const absOld = path.join(destination, ...old.split('/'));
            let sourceStat: fs.Stats | null = null;
            try {
                const stat = fs.statSync(absOld);
                if (stat.isFile()) sourceStat = stat;
            } catch {
                sourceStat = null;
            }
            let modified = false;
            let targetIsSource = false;
            if (sourceStat !== null) {
                const entry = previousManifest.docs[old];
                let currentHash: string | null = null;
                try {
                    currentHash = sha256Hex(fs.readFileSync(absOld));
                } catch {
                    currentHash = null;
                }
                modified = currentHash === null || currentHash !== entry.body_sha256;
                try {
                    const targetStat = fs.statSync(path.join(destination, ...p.relPath.split('/')));
                    targetIsSource = targetStat.dev === sourceStat.dev && targetStat.ino === sourceStat.ino;
                } catch {
                    targetIsSource = false;
                }
            }
            renameMoves.push({
                oldRel: old,
                newRel: p.relPath,
                id: p.doc.id,
                title: p.doc.title,
                sourcePresent: sourceStat !== null,
                sourceIdentity: sourceStat === null ? null : `${sourceStat.dev}:${sourceStat.ino}`,
                modified,
                // A failed media download plans a new path but writes nothing there.
                replacementWritten: !p.isMedia || p.mediaBytes !== null,
                targetIsSource,
            });
        }
        const plannedPaths = new Map(planned.map((p) => [p.relPath, p]));
        const plannedByIdentity = new Map<string, PlannedDoc[]>();
        const plannedByPhysicalPath = new Map<string, PlannedDoc[]>();
        for (const p of planned) {
            const physicalPath = resolveOrExplain(destination, p.relPath, p.doc);
            const physicalTargets = plannedByPhysicalPath.get(physicalPath) ?? [];
            physicalTargets.push(p);
            plannedByPhysicalPath.set(physicalPath, physicalTargets);
            try {
                const stat = fs.statSync(path.join(destination, ...p.relPath.split('/')));
                if (!stat.isFile()) continue;
                const identity = `${stat.dev}:${stat.ino}`;
                const targets = plannedByIdentity.get(identity) ?? [];
                targets.push(p);
                plannedByIdentity.set(identity, targets);
            } catch {
                // An absent target cannot alias a present source.
                continue;
            }
        }
        // Path claims matter even without a source (a failed download restores
        // its old tracking). Present sources also need protection from writes
        // through another name, hard link, symlink or directory component alias.
        const plannedTargetForSource = (m: RenameMove): PlannedDoc | undefined =>
            plannedPaths.get(m.oldRel)
            ?? plannedByPhysicalPath.get(resolveOrExplain(destination, m.oldRel))?.find((p) => p.doc.id !== m.id)
            ?? (m.sourceIdentity === null
                ? undefined
                : plannedByIdentity.get(m.sourceIdentity)?.find((p) => p.doc.id !== m.id));

        // Edited sources cannot be discarded by --overwrite during a rename.
        // Report a cross-doc collision first, including an alias's actual path.
        for (const m of renameMoves) {
            if (!m.modified) continue;
            const taker = plannedTargetForSource(m);
            if (!taker) continue;
            const oldTitle = previousManifest.docs[m.oldRel]?.title ?? `#${m.id}`;
            process.stderr.write(chalk.red(`error: ${shown(m.oldRel)} holds unpublished edits for doc ${m.id} ("${shown(oldTitle)}", now written as ${shown(m.newRel)}), but this pull would write doc ${taker.doc.id} ("${shown(taker.doc.title)}") to ${shown(taker.relPath)}, the same file.\n`));
            process.stderr.write(chalk.red(`Move or rename the edited ${shown(m.oldRel)} (or push it first) and pull again.\n`));
            process.exit(1);
        }
        // A rename whose replacement will not be written keeps its old file and
        // tracking (b) — which is only possible while no other doc in this pull
        // claims the old path. Otherwise refuse (cli#157 issuecomment-5962867475):
        // no relocation or re-allocation of names.
        for (const m of renameMoves) {
            if (m.replacementWritten) continue;
            const taker = plannedTargetForSource(m);
            if (!taker) continue;
            process.stderr.write(chalk.red(`error: doc ${m.id} ("${shown(m.title)}") failed to download to ${shown(m.newRel)}, so ${shown(m.oldRel)} must keep its previous file and tracking, but this pull would put doc ${taker.doc.id} ("${shown(taker.doc.title)}") at ${shown(taker.relPath)}, the same file.\n`));
            process.stderr.write(chalk.red('Nothing was written. Pull again once the download succeeds.\n'));
            process.exit(1);
        }
        // An edited source whose replacement will not be written cannot move
        // and must not lose its tracking: refuse, with or without --overwrite.
        for (const m of renameMoves) {
            if (m.replacementWritten || !m.modified) continue;
            process.stderr.write(chalk.red(`error: ${shown(m.oldRel)} holds unpublished edits for doc ${m.id}, which is now ${shown(m.newRel)}, but its download failed.\n`));
            process.stderr.write(chalk.red(`Nothing was written. Push ${shown(m.oldRel)} first (or move it aside), then pull again once the download succeeds.\n`));
            process.exit(1);
        }
        const blocked = renameMoves.filter((m) => m.modified);
        if (blocked.length > 0) {
            for (const m of blocked) {
                process.stderr.write(chalk.red(`error: ${shown(m.oldRel)} holds unpublished edits for doc ${m.id} ("${shown(m.title)}"), which is now written as ${shown(m.newRel)}.\n`));
                process.stderr.write(chalk.red(`Nothing was written. Push ${shown(m.oldRel)} first (or move it aside) and pull again.\n`));
            }
            process.exit(1);
        }
        // Two writes through different names of one file cannot both retain
        // their own doc's bytes and hash. Refuse compositions involving a
        // rename or legacy case-folded names that already alias one file.
        // Other non-rename-only target handling is outside this rule.
        // Physical paths cover absent targets under aliased directories, where
        // there is no inode yet to compare.
        const renamedIds = new Set(renameMoves.map((m) => m.id));
        for (const targets of [...plannedByIdentity.values(), ...plannedByPhysicalPath.values()]) {
            const writes = targets.filter((p) => !p.isMedia || p.mediaBytes !== null);
            if (writes.length < 2) continue;
            const foldedPaths = new Set(writes.map((p) => p.relPath.toLowerCase()));
            if (!writes.some((p) => renamedIds.has(p.doc.id)) && foldedPaths.size === writes.length) continue;
            const [first, second] = writes;
            process.stderr.write(chalk.red(`error: ${shown(first.relPath)} (doc ${first.doc.id}) and ${shown(second.relPath)} (doc ${second.doc.id}) are the same file on this filesystem; this pull would write different docs through those names.\n`));
            process.stderr.write(chalk.red('Nothing was written. Move the aliased files apart and pull again.\n'));
            process.exit(1);
        }
        // A rename target that is a symbolic link would be written through, to
        // a file this pull does not own (possibly outside the destination):
        // refuse, with or without --overwrite.
        for (const m of renameMoves) {
            if (!m.replacementWritten) continue;
            let isLink = false;
            try {
                isLink = fs.lstatSync(path.join(destination, ...m.newRel.split('/'))).isSymbolicLink();
            } catch {
                isLink = false;
            }
            if (!isLink) continue;
            process.stderr.write(chalk.red(`error: ${shown(m.newRel)} is a symbolic link; this pull would write doc ${m.id} ("${shown(m.title)}", renamed from ${shown(m.oldRel)}) through it.\n`));
            process.stderr.write(chalk.red(`Replace ${shown(m.newRel)} with a regular file (or remove it) and pull again.\n`));
            process.exit(1);
        }
        // A rename target holding an untracked local file (not in the previous
        // manifest) would be overwritten: refuse unless --overwrite, whatever
        // the source's state. A file already holding exactly the bytes this
        // pull writes loses nothing and is adopted. A target tracked by another
        // doc with a recorded hash is protected by the unpushed-local-changes
        // check below; one tracked without a hash cannot be verified there, so
        // it is checked here like an untracked file. A target that is the
        // source itself is governed by the source rules above.
        if (!options.overwrite) {
            for (const m of renameMoves) {
                if (!m.replacementWritten || m.targetIsSource) continue;
                const targetEntry = previousManifest.docs[m.newRel];
                if (targetEntry !== undefined && targetEntry.body_sha256 != null) continue;
                const absNew = path.join(destination, ...m.newRel.split('/'));
                let existing: Buffer | null = null;
                let unreadable = '';
                try {
                    if (!fs.statSync(absNew).isFile()) continue;
                    existing = fs.readFileSync(absNew);
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code ?? 'ERROR';
                    if (code === 'ENOENT') continue;
                    unreadable = ` (cannot be read: ${code})`; // present but unverifiable: not owned
                }
                if (existing !== null && sha256Hex(existing) === plannedPaths.get(m.newRel)?.bodySha256) continue;
                const state = (targetEntry === undefined ? 'exists locally but is not tracked' : `holds local bytes with no recorded hash (tracked for doc ${targetEntry.id})`) + unreadable;
                process.stderr.write(chalk.red(`error: ${shown(m.newRel)} ${state}; this pull would overwrite it with doc ${m.id} ("${shown(m.title)}", renamed from ${shown(m.oldRel)}).\n`));
                process.stderr.write(chalk.red(`Move ${shown(m.newRel)} aside and pull again, or pass --overwrite to replace it.\n`));
                process.exit(1);
            }
        }
    }
    const handledOldPaths = new Set(renameMoves.map((m) => m.oldRel));

    // After the rename block (which keeps its own messages for rename cases) and before anything
    // else that reads or writes the plan: no planned write may go through a link or outside.
    checkPlannedWrites(destination, planned, previousManifest, options, renameMoves);

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
                process.stderr.write(chalk.red(`  ${shown(file)}\n`));
            }
            process.stderr.write(chalk.red('push your changes first, or pass --overwrite to discard them.\n'));
            process.exit(1);
        }
    }

    // A destination path that already exists as a directory would make writeFileSync
    // throw EISDIR mid-walk, after earlier docs were written and before the manifest
    // is saved — a half-pulled tree with a stale sidecar. Refuse before any write.
    for (const p of planned) {
        const targetAbs = path.join(destination, ...p.relPath.split('/'));
        if (fs.existsSync(targetAbs) && !fs.statSync(targetAbs).isFile()) {
            process.stderr.write(chalk.red(`error: "${shown(p.relPath)}" exists and is not a regular file — cannot write doc ${p.doc.id} (${shown(p.doc.title)}).\n`));
            process.exit(1);
        }
    }

    // Every throw below can carry a server-derived path (commitDocs writes
    // title-named files): the command boundary in `docPull` prints it
    // sanitised.
    fs.mkdirSync(destination, { recursive: true });
    const destPrefix = path.resolve(destination) + path.sep;
    const realDest = fs.realpathSync(destination);
    const { manifestDocs, files } = commitDocs(destination, planned);

    // cli#167: a media doc whose download failed must not be tracked over a
    // local file the previous manifest does not track, with a hash, for that
    // same doc: nothing was written, so the manifest would claim bytes the
    // pull never gave it. A rename keeps its restore-old-entry handling below.
    const renamedIds = new Set(renameMoves.map((m) => m.id));
    for (const p of planned) {
        if (!p.isMedia || p.mediaBytes !== null || renamedIds.has(p.doc.id)) continue;
        const tracked = previousManifest?.docs[p.relPath];
        if (tracked !== undefined && tracked.id === p.doc.id && tracked.body_sha256 != null) continue;
        let holdsLocalFile = false;
        try {
            holdsLocalFile = fs.statSync(path.join(destination, ...p.relPath.split('/'))).isFile();
        } catch {
            holdsLocalFile = false;
        }
        if (!holdsLocalFile) continue;
        delete manifestDocs[p.relPath];
        process.stderr.write(chalk.yellow(`! doc ${p.doc.id} ("${shown(p.doc.title)}") failed to download and ${shown(p.relPath)} holds a local file; not tracking it — pull again later\n`));
    }

    // Identity of every file this pull actually wrote, keyed by dev:ino. Used by the
    // deletion-propagation loop below to recognize an "orphan" that is really just the
    // same file this pull wrote under a different manifest key (e.g. a case-only title
    // rename on a case-insensitive filesystem) — that file must never be deleted.
    // writtenPathByIdentity names the path this pull wrote for each identity, so
    // rename cleanup can warn instead of silently keeping an old path that
    // aliases a written file (cli#167 M2).
    const writtenIdentities = new Set<string>();
    const writtenPathByIdentity = new Map<string, string>();
    for (const file of files) {
        try {
            const stat = fs.statSync(path.join(destination, ...file.path.split('/')));
            const identity = `${stat.dev}:${stat.ino}`;
            writtenIdentities.add(identity);
            writtenPathByIdentity.set(identity, file.path);
        } catch {
            continue;
        }
    }

    // Rename cleanup (PM ruling 2, cli#157): each unmodified old twin is gone
    // now that the new file is written — but never one this pull just wrote
    // for another doc (e.g. a new markdown doc that now takes `page.md`).
    // Edited sources were all refused before any write, even with --overwrite.
    // A twin whose replacement was NOT written (a failed media download plans
    // a new path but writes nothing) keeps its old file and its old manifest
    // entry — deleting it would destroy the only good copy. Without an old
    // file the old entry is still kept, so the doc is not tracked (with no
    // hash) at a new path that may hold an untracked file. The refusals above
    // guarantee no other doc in this pull claims that old path.
    for (const m of renameMoves) {
        if (!m.replacementWritten) {
            delete manifestDocs[m.newRel];
            const oldEntry = previousManifest?.docs[m.oldRel];
            if (oldEntry !== undefined) {
                manifestDocs[m.oldRel] = oldEntry;
            }
            if (m.sourcePresent) {
                process.stderr.write(chalk.yellow(`! kept ${shown(m.oldRel)} — doc ${m.id} download failed; still tracked as ${shown(m.oldRel)}\n`));
            } else {
                process.stderr.write(chalk.yellow(`! doc ${m.id} download failed; still tracked as ${shown(m.oldRel)}, which is not present locally\n`));
            }
            continue;
        }
        if (!m.sourcePresent) continue;
        const absOld = path.resolve(destination, ...m.oldRel.split('/'));
        // cli#167 M2: the old path is the same file as one this pull just
        // wrote under another name (a link) — it is kept, loudly, so the
        // extra name is not mistaken for an orphan. The same-file case
        // (targetIsSource) stays silent: there is no extra name.
        if (!m.targetIsSource) {
            let oldIdentity: string | null = null;
            try {
                const oldStat = fs.statSync(absOld);
                if (oldStat.isFile()) oldIdentity = `${oldStat.dev}:${oldStat.ino}`;
            } catch {
                oldIdentity = null;
            }
            const writtenPath = oldIdentity === null ? undefined : writtenPathByIdentity.get(oldIdentity);
            if (writtenPath !== undefined) {
                process.stderr.write(chalk.yellow(`! kept ${shown(m.oldRel)}: it is the same file as ${shown(writtenPath)} (a link); the extra name is not tracked — remove it yourself if you don't need it\n`));
            }
        }
        if (!isSafeToRemoveTrackedFile(absOld, destPrefix, realDest, writtenIdentities)) continue;
        try {
            fs.rmSync(absOld);
        } catch {
            continue;
        }
    }

    let docs = manifestDocs;
    if (usedSingleDocFallback && previousManifest !== null && previousManifest.folder_path === folderPath) {
        // A single-doc pull speaks for one doc only: keep every other tracked entry (cli#153),
        // dropping any stale key that pointed at this same doc id.
        const pulledIds = new Set(Object.values(manifestDocs).map((entry) => entry.id));
        docs = Object.fromEntries(Object.entries(previousManifest.docs).filter(([, entry]) => !pulledIds.has(entry.id)));
        Object.assign(docs, manifestDocs);
    }
    const manifest: DocsManifest = { folder_path: folderPath, docs };
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

    if (previousManifest !== null && !canPropagateDeletions) {
        if (usedSingleDocFallback) {
            process.stderr.write(chalk.yellow("deletions not propagated: single-doc pull cannot speak for a folder's contents\n"));
        } else if (previousManifest.folder_path !== folderPath) {
            process.stderr.write(chalk.yellow(`deletions not propagated: this directory tracks "${shown(previousManifest.folder_path)}", not "${shown(folderPath)}"\n`));
        }
    }

    const keptModifiedMedia = new Set<string>();

    if (canPropagateDeletions) {
        for (const [relPath, entry] of Object.entries(previousManifest!.docs)) {
            if (manifestDocs[relPath]) continue;
            // Rename cleanup (cli#157) already handled this path: never a
            // "deleted remotely" orphan warning for it.
            if (handledOldPaths.has(relPath)) continue;

            const absPath = path.resolve(destination, ...relPath.split('/'));

            // The whole entry is guarded: the new manifest is already on disk by now, so an
            // uncaught throw would abort the report, silently skip every later orphan, and
            // print a raw stack trace instead of this command's normal error format. One bad
            // entry must cost only that entry.
            try {
                if (!isSafeToRemoveTrackedFile(absPath, destPrefix, realDest, writtenIdentities)) continue;

                const currentHash = sha256Hex(fs.readFileSync(absPath));
                if (entry.body_sha256 != null && entry.body_sha256 === currentHash) {
                    fs.rmSync(absPath);
                    removed.push(relPath);
                } else {
                    keptModified.push(relPath);
                    if (entry.media) keptModifiedMedia.add(relPath);
                }
            } catch {
                // Vanished mid-run, unreadable, or refuses inspection: never delete blind.
                continue;
            }
        }
    }

    if (options.json) {
        console.log(escapeJsonDisplayText(JSON.stringify({ manifest, files, removed, kept_modified: keptModified })));
        process.exit(0);
    }

    console.log(chalk.green(`pulled ${files.length} doc${files.length === 1 ? '' : 's'} → ${shown(destination)}`));
    for (const file of files) {
        console.log(chalk.gray(`  ${shown(file.path)}`));
    }
    for (const file of removed) {
        console.log(chalk.gray(`- removed (deleted remotely): ${shown(file)}`));
    }
    for (const file of keptModified) {
        process.stderr.write(chalk.yellow(`! kept ${shown(file)} — deleted remotely but modified locally\n`));
        if (keptModifiedMedia.has(file)) {
            process.stderr.write(chalk.yellow('  (it is now untracked; use `solidactions doc upload` to re-create it)\n'));
        } else {
            process.stderr.write(chalk.yellow('  (it is now untracked; `doc push` will re-create it)\n'));
        }
    }
    process.exit(0);
}

/**
 * Entry point called from index.ts.
 *
 * Command-level error boundary (cli#189): any error escaping the command's
 * work — a server-bearing exception like `McpRpcError` as well as a
 * filesystem throw — prints one sanitised red `error: ` line and exits 1.
 * The command's own `process.exit` calls terminate the process and never
 * reach this catch.
 */
export async function docPull(folder: string, dest: string | undefined, options: DocPullOptions): Promise<void> {
    try {
        const config = await requireConfigWithWorkspace();
        await docPullWithConfig(folder, dest, options, config);
    } catch (error) {
        reportWriteError(error);
    }
}

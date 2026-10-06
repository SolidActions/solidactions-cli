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
import { DOCS_MANIFEST, DocsManifest, docsFrom, entryAt, ManifestEntry, readManifest, sha256Hex, writeManifest } from '../utils/docs-manifest';
import {
    acquireLock,
    Authorized,
    faultsFromEnv,
    isReservedName,
    LinkOnTheWayError,
    lockNameFor,
    LockHeldError,
    nameKey,
    PlacedWrite,
    PlannedWrite,
    PublicationRefusedError,
    releaseLock,
    UnsupportedTargetError,
    writeAll,
    type WriteStop,
} from '../utils/doc-pull-writes';

// Re-exported for backward compatibility: tests and doc-push import these from here.
export { DOCS_MANIFEST, sha256Hex };
export type { DocsManifest, ManifestEntry };

/** Extension appended to a media file's sanitized title when the title itself has none. A Map: a server MIME is never an inherited name (PM ruling 14). */
const MIME_EXTENSIONS = new Map<string, string>([
    ['image/png', '.png'],
    ['image/jpeg', '.jpg'],
    ['image/gif', '.gif'],
    ['image/webp', '.webp'],
    ['application/pdf', '.pdf'],
]);

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
export interface DocRow {
    id: number;
    title: string;
    /** Relative folder path from the pull root, '' for the root itself, using '/' separators. */
    relative: string;
    /** The list row's doc_type slug (null for untyped docs), plus whether the row carried the key. */
    docType?: string | null;
    docTypeKnown: boolean;
}

/** Row after bulk_read/read has filled in body + revision. */
export interface FetchedDoc extends DocRow {
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
function detectLocalModifications(destination: string, manifest: DocsManifest, seen: SeenTargets): string[] {
    const modified: string[] = [];
    for (const [relPath, entry] of Object.entries(manifest.docs)) {
        if (entry.body_sha256 == null) continue;
        const absPath = path.join(destination, relPath);
        // Only hash regular files. A corrupt manifest key naming a directory would
        // otherwise throw EISDIR and abort the pull before it starts.
        let stat: fs.Stats;
        try {
            stat = fs.statSync(absPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') observe(seen, relPath, { kind: 'absent' });
            continue; // missing locally — graceful degradation, never a false refusal
        }
        if (!stat.isFile()) continue;
        const currentHash = sha256Hex(fs.readFileSync(absPath));
        observe(seen, relPath, { kind: 'sha256', sha256: currentHash });
        if (currentHash !== entry.body_sha256) {
            modified.push(relPath);
        }
    }
    return modified;
}

/**
 * What the preflight checks saw at each target, by relative path (spec §1.3 step 2). The write refuses a target
 * that is no longer in that state; a later read never widens it. The first observation of a path stands.
 */
type SeenTargets = Map<string, Authorized>;

function observe(seen: SeenTargets, relPath: string, state: Authorized): void {
    if (!seen.has(relPath)) seen.set(relPath, state);
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
    // Per parent folder: the segment each sanitised name was given, and the keys taken, so folders that differ
    // only by case or normalisation (or take a reserved name) get distinct segments (cli#168).
    const segmentsByParent = new Map<string, { given: Map<string, string>; keys: Set<string> }>();
    const segmentFor = (parent: string, sanitized: string): string => {
        const taken = segmentsByParent.get(parent) ?? { given: new Map<string, string>(), keys: new Set<string>() };
        segmentsByParent.set(parent, taken);
        const known = taken.given.get(sanitized);
        if (known !== undefined) return known;
        const start = isReservedName(sanitized, DOCS_MANIFEST) ? `_${sanitized}` : sanitized;
        let segment = start;
        for (let suffix = 2; taken.keys.has(nameKey(segment)); suffix++) segment = `${start}-${suffix}`;
        taken.given.set(sanitized, segment);
        taken.keys.add(nameKey(segment));
        return segment;
    };

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
            const safeName = segmentFor(relative, sanitizeSegment(folder.name));
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
 * the writes in `report`. Kept separate so a caller can inspect the plan (e.g. to
 * check for an unpushed-local-changes conflict) before anything touches
 * disk.
 */
export interface PlannedDoc {
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

/** A name the pull keeps for itself (the manifest, its lock, the temp-file prefix) takes a leading `_`; the usual `-N` suffix cannot leave a reserved prefix. */
const withoutReservedName = (base: string, ext: string): string => (isReservedName(`${base}${ext}`, DOCS_MANIFEST) ? `_${base}` : base);

/**
 * Allocate the first free `<base>[ -N]<ext>` name not present in `used`,
 * recording the winner in `used`. Names are compared by `nameKey` (NFC, case-folded), so two
 * docs that differ only by case or by Unicode normalisation never share a file (cli#168).
 */
function allocateName(used: Set<string>, base: string, ext: string): string {
    const first = withoutReservedName(base, ext);
    let candidate = first;
    let suffix = 2;
    const usedKeys = new Set([...used].map(nameKey));
    while (usedKeys.has(nameKey(`${candidate}${ext}`))) {
        candidate = `${first}-${suffix}`;
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
                ext = (media.mime && MIME_EXTENSIONS.get(media.mime)) ?? '';
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
                // tracked (manifest entry recorded after the writes) but there is nothing
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
        return ownDir === doc.relative && !isReservedName(ownFile, DOCS_MANIFEST) && isCollisionVariant(ownFile, base, ext) ? ownRelPath : undefined;
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

/** The manifest entry for a planned doc, in the shape the manifest stores. Writes nothing. */
function manifestEntryFor(p: PlannedDoc): ManifestEntry {
    // A failed media download writes nothing, but its entry (no hash) is still how the doc is tracked.
    return {
        id: p.doc.id,
        title: p.doc.title,
        current_revision_id: p.doc.current_revision_id,
        media: p.isMedia,
        body_sha256: p.bodySha256,
    };
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

/** True when `abs` is an existing directory; any stat failure is left to the destination checks below. */
function isExistingDirectory(abs: string): boolean {
    try {
        return fs.statSync(abs).isDirectory();
    } catch {
        return false;
    }
}

/** The lock file this pull created, and where; it is removed on every way out (spec §1.4). */
interface HeldLock {
    destination: string | null;
}

/**
 * Take the destination's lock (spec §1.4): one O_EXCL file, `<destination>/.solidactions-docs.json.lock`, holding this
 * pid. An existing one refuses with nothing else changed; it is never removed or liveness-tested except by the pull that
 * created it, so a killed pull's lock stays until the user deletes it.
 */
function takeLock(destination: string, lock: HeldLock): void {
    try {
        acquireLock(destination, DOCS_MANIFEST);
    } catch (error) {
        if (error instanceof LockHeldError) {
            process.stderr.write(chalk.red(`error: ${shown(path.join(destination, error.lockName))} exists: another doc pull may be writing to ${shown(destination)}. If none is running, delete that file and pull again.\n`));
            process.exit(1);
        }
        try {
            fs.readdirSync(destination);
        } catch (readError) {
            process.stderr.write(chalk.red(`error: cannot read ${shown(destination)}: ${shown((readError as Error).message)}\n`));
            process.exit(1);
        }
        process.stderr.write(chalk.red(`error: cannot write ${shown(lockNameFor(DOCS_MANIFEST))}: ${shown((error as Error).message)} — nothing was changed.\n`));
        process.exit(1);
    }
    lock.destination = destination;
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
    // The lock taken below is removed on every way out: a process.exit anywhere in the pull (refusal, error, a "no"
    // at the prompt) runs the exit listener, and an interrupt exits through it too. Only a SIGKILL leaves it (spec §1.6).
    const lock: HeldLock = { destination: null };
    const releaseHeld = (): void => {
        if (lock.destination !== null) releaseLock(lock.destination, DOCS_MANIFEST);
        lock.destination = null;
    };
    const onInterrupt = (): never => process.exit(130);
    const onTerminate = (): never => process.exit(143);
    process.on('exit', releaseHeld);
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    try {
        await pullInto(folderPath, dest, options, config, lock);
    } finally {
        process.removeListener('exit', releaseHeld);
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onTerminate);
        releaseHeld();
    }
}

async function pullInto(
    folderPath: string,
    dest: string | undefined,
    options: DocPullOptions,
    config: Config,
    lock: HeldLock,
): Promise<void> {
    const destInput = dest ?? `./${lastSegment(folderPath)}`;
    const destination = path.resolve(destInput);

    // cli#168: take the lock before anything reads the destination, so the plan below is built on a manifest
    // no other pull can change while this one runs (spec §1.3 step 1, §1.4).
    if (isExistingDirectory(destination)) takeLock(destination, lock);

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
            entries = fs.readdirSync(destination).filter((name) => name !== lockNameFor(DOCS_MANIFEST));
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

        await report(destination, docFolder, fetched, options, config, [], previousManifest, usedSingleDocFallback, new Set([data.id]), lock);
        return;
    } else {
        process.stderr.write(chalk.red(`error: ${shown(listResult.code)}: ${shown(listResult.message)}\n`));
        process.exit(1);
        return;
    }

    const { fetched, warnings: fetchWarnings } = await fetchBodies(config, rows);
    const typeWarnings = await backfillDocTypes(config, fetched);
    await report(destination, folderPath, fetched, options, config, [...fetchWarnings, ...typeWarnings], previousManifest, usedSingleDocFallback, new Set(rows.map((row) => row.id)), lock);
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
 * every planned doc, including a failed media download: the write still
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
    seen: SeenTargets,
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
        const tracked = entryAt(previousManifest, p.relPath);
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
            if (code === 'ENOENT') {
                observe(seen, p.relPath, { kind: 'absent' });
                continue; // absent: nothing to overwrite here
            }
            untracked.push(`${p.relPath} (cannot be read: ${code})`); // present but unverifiable: not owned
            continue;
        }
        observe(seen, p.relPath, { kind: 'sha256', sha256: sha256Hex(current) });
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

export interface RenameMove {
    oldRel: string;
    newRel: string;
    id: number;
    title: string;
    /** `old` holds a regular file (following a symlink); absent, a directory or a dangling link is nothing to keep or remove. */
    sourcePresent: boolean;
    /** Device + inode of a present source, following filesystem aliases. */
    sourceIdentity: string | null;
    /** sha256 of the present source's bytes; null without a source or when they cannot be read. */
    sourceHash: string | null;
    /**
     * The present source holds edits: its bytes differ from its recorded hash (or cannot be read) and are not bytes this
     * pull itself writes there (rule 5, settled once every planned write is known). Always false without a source.
     */
    modified: boolean;
    replacementWritten: boolean;
    /** `new` is the very file at `old` (a case-only rename on a case-insensitive filesystem). */
    targetIsSource: boolean;
}

/** What one planned doc came to, which is all the manifest is made of (spec §1.3, PM ruling 12 rule 3). */
export interface DocOutcome {
    id: number;
    /** placed: written (or tracked with no bytes after a failed download); kept-previous: its earlier entry stays; dropped: no entry; refused: not written, its earlier entry carried. */
    kind: 'placed' | 'kept-previous' | 'dropped' | 'refused';
    /** The entries this run records for the doc's own bytes, by path: the file it placed (or tracked with no bytes). Wins over any `kept` entry at the same name (rule 3). */
    placed: Map<string, ManifestEntry>;
    /** The earlier entries the doc keeps, by path: a refused doc's, a kept-previous one's, a placed renamed doc's old twin after a stop. */
    kept: Map<string, ManifestEntry>;
}

/** True when anything at all (a link included) is at `abs`. */
function entryExists(abs: string): boolean {
    try {
        fs.lstatSync(abs);
        return true;
    } catch {
        return false;
    }
}

/** A regular file (following links) at `rel`, and the hash of its bytes; the hash is null when there is none or it cannot be read. */
function localFile(destination: string, rel: string): { present: boolean; hash: string | null } {
    const abs = path.join(destination, ...rel.split('/'));
    try {
        if (!fs.statSync(abs).isFile()) return { present: false, hash: null };
    } catch {
        return { present: false, hash: null };
    }
    try {
        return { present: true, hash: sha256Hex(fs.readFileSync(abs)) };
    } catch {
        return { present: true, hash: null };
    }
}

/** What is at `rel` when a failed download's earlier entry is dropped for want of its file (manager ruling on cli#168 I1(b)): a string literal. */
function absentState(destination: string, rel: string): string {
    return entryExists(path.join(destination, ...rel.split('/'))) ? 'is not a regular file' : 'is not present locally';
}

/**
 * One outcome per planned doc, after the writes: the files this pull placed, and for every other doc what its
 * manifest entry should be (cli#183, cli#190, cli#167). A failed download keeps the tracking it had while the file at its
 * path is the one the entry names; a doc the pull never got to keeps its earlier entry. An earlier entry with a hash is
 * kept only while a file is at its path: a missing file drops the doc's tracking with a warning (manager ruling on cli#168,
 * issuecomment-6013479498, I1(b)), so the gate never meets a kept entry with a hash for a missing file.
 * `pendingWarnings` receives the `! …` lines printed after a successful pull.
 */
export function decideOutcomes(
    destination: string,
    planned: PlannedDoc[],
    placedPaths: Set<string>,
    stopped: boolean,
    previousManifest: DocsManifest | null,
    folderPath: string,
    renameMoves: RenameMove[],
    listedIds: Set<number>,
    pendingWarnings: string[],
): DocOutcome[] {
    const outcomes: DocOutcome[] = [];
    const earlierById = new Map<number, Map<string, ManifestEntry>>();
    if (previousManifest !== null && previousManifest.folder_path === folderPath) {
        for (const [relPath, entry] of Object.entries(previousManifest.docs)) {
            const earlier = earlierById.get(entry.id) ?? new Map<string, ManifestEntry>();
            earlier.set(relPath, entry);
            earlierById.set(entry.id, earlier);
        }
    }
    const renamedIds = new Set(renameMoves.map((m) => m.id));
    const plannedIds = new Set(planned.map((q) => q.doc.id));
    const failedDownload = (p: PlannedDoc): boolean => p.isMedia && p.mediaBytes === null;

    for (const p of planned) {
        const entry = manifestEntryFor(p);
        if (!failedDownload(p)) {
            if (placedPaths.has(p.relPath)) {
                // A stopped pull never removes a renamed doc's old twin, so that file keeps its tracking too (listed first, so
                // the next pull sees the rename and finishes it). A twin that is gone keeps no entry with a hash (I1(b)).
                const move = stopped ? renameMoves.find((m) => m.id === p.doc.id && m.sourcePresent) : undefined;
                const oldEntry = move === undefined ? undefined : entryAt(previousManifest, move.oldRel);
                const kept = new Map<string, ManifestEntry>();
                if (move !== undefined && oldEntry !== undefined && (oldEntry.body_sha256 == null || localFile(destination, move.oldRel).present)) kept.set(move.oldRel, oldEntry);
                outcomes.push({ id: p.doc.id, kind: 'placed', placed: new Map([[p.relPath, entry]]), kept });
            } else {
                outcomes.push({ id: p.doc.id, kind: 'refused', placed: new Map(), kept: new Map(earlierById.get(p.doc.id)) });
            }
            continue;
        }
        if (renamedIds.has(p.doc.id)) continue; // decided with its rename below

        // cli#183: a failed download at a path the previous manifest tracked for the same doc keeps
        // that entry unchanged (revision and hash), as a failed rename does: nothing was written,
        // so the manifest must not claim a newer revision or drop the hash of the file still there.
        // The entry is kept only while the file is the one it names: exactly its hash (INV-C), or no file for an entry
        // with no hash. A missing file drops the tracking (I1(b)).
        //
        // cli#167: a media doc whose download failed must not be tracked over a
        // local file the previous manifest does not track, with a hash, for that
        // same doc: nothing is written, so the manifest would claim bytes the
        // pull never gave it. A rename keeps its restore-old-entry handling below.
        //
        // cli#190: if that local file is another doc's (tracked with a hash at this path), that
        // doc's tracking is kept when it is still on the server and not moved by this pull.
        const tracked = entryAt(previousManifest, p.relPath);
        const local = localFile(destination, p.relPath);
        const ownEntry = tracked !== undefined && tracked.id === p.doc.id ? tracked : undefined;
        if (ownEntry !== undefined && (ownEntry.body_sha256 == null ? !local.present : local.hash === ownEntry.body_sha256)) {
            outcomes.push({ id: p.doc.id, kind: 'kept-previous', placed: new Map(), kept: new Map([[p.relPath, ownEntry]]) });
            continue;
        }
        if (ownEntry !== undefined && ownEntry.body_sha256 != null && !local.present) {
            outcomes.push({ id: p.doc.id, kind: 'dropped', placed: new Map(), kept: new Map() });
            const state = absentState(destination, p.relPath);
            pendingWarnings.push(`! doc ${p.doc.id} ("${shown(p.doc.title)}") failed to download and ${shown(p.relPath)} ${state}; not tracking it — pull again later.`);
            continue;
        }
        if (!local.present) {
            outcomes.push({ id: p.doc.id, kind: 'placed', placed: new Map([[p.relPath, entry]]), kept: new Map() });
            continue;
        }
        const otherDoc = tracked !== undefined && tracked.id !== p.doc.id && tracked.body_sha256 != null ? tracked : undefined;
        outcomes.push({ id: p.doc.id, kind: 'dropped', placed: new Map(), kept: new Map() });
        if (otherDoc !== undefined && local.hash === otherDoc.body_sha256 && listedIds.has(otherDoc.id) && !plannedIds.has(otherDoc.id)) {
            outcomes.push({ id: otherDoc.id, kind: 'kept-previous', placed: new Map(), kept: new Map([[p.relPath, otherDoc]]) });
            pendingWarnings.push(`! doc ${p.doc.id} ("${shown(p.doc.title)}") failed to download and ${shown(p.relPath)} holds doc ${otherDoc.id}'s file ("${shown(otherDoc.title)}"); still tracking it as doc ${otherDoc.id} — pull again later`);
            continue;
        }
        // A pull that stopped keeps every earlier entry of a doc it has no outcome for, so it takes no tracking from that doc.
        const lost = otherDoc === undefined || stopped ? '' : ` Doc ${otherDoc.id} ("${shown(otherDoc.title)}") was tracked at ${shown(p.relPath)} before and is no longer tracked there.`;
        pendingWarnings.push(`! doc ${p.doc.id} ("${shown(p.doc.title)}") failed to download and ${shown(p.relPath)} holds a local file; not tracking it — pull again later.${lost}`);
    }

    // A rename whose replacement is NOT written (a failed media download plans a new path but
    // writes nothing) keeps its old file and its old manifest entry: deleting it would destroy
    // the only good copy. An old entry with a hash whose file is gone is not kept (I1(b)): the doc is then not
    // tracked at all, neither at the old path nor (with no hash) at a new path that may hold an untracked file. The
    // refusals in `report` guarantee no other doc in this pull claims that old path.
    for (const m of renameMoves) {
        if (m.replacementWritten) continue;
        const oldEntry = entryAt(previousManifest, m.oldRel);
        const local = localFile(destination, m.oldRel);
        if (oldEntry !== undefined && oldEntry.body_sha256 != null && !local.present) {
            outcomes.push({ id: m.id, kind: 'dropped', placed: new Map(), kept: new Map() });
            const state = absentState(destination, m.oldRel);
            pendingWarnings.push(`! doc ${m.id} ("${shown(m.title)}") failed to download and ${shown(m.oldRel)} ${state}; not tracking it — pull again later.`);
            continue;
        }
        outcomes.push({ id: m.id, kind: 'kept-previous', placed: new Map(), kept: oldEntry === undefined ? new Map() : new Map([[m.oldRel, oldEntry]]) });
        if (local.present) {
            pendingWarnings.push(`! kept ${shown(m.oldRel)} — doc ${m.id} download failed; still tracked as ${shown(m.oldRel)}`);
        } else {
            pendingWarnings.push(`! doc ${m.id} download failed; still tracked as ${shown(m.oldRel)}, which is not present locally`);
        }
    }
    return outcomes;
}

/**
 * The manifest as a pure function of the previous manifest, the outcomes and whether this pull speaks for one doc
 * (spec §1.3, rule 3). A single-doc pull, or one that stopped before it could propagate deletions, keeps every earlier
 * entry whose doc has no outcome (cli#153); an outcome's own doc never gets its earlier entries back. Bytes this run
 * placed always win: an earlier entry at a name a placed entry holds, or one equal to it under `nameKey`, is dropped, and
 * the doc that lost it gets a "no longer tracked there" line in `pendingWarnings` (a doc's own old twin loses silently).
 * The overlap is settled here, before anything is collapsed by name, so no retained entry can stand for placed bytes.
 * Entries are collected in a Map and published as a null-prototype dictionary, so every path is an own key (PM ruling 14).
 */
export function buildManifest(folderPath: string, previousManifest: DocsManifest | null, outcomes: DocOutcome[], keepUnlisted: boolean, pendingWarnings: string[]): DocsManifest {
    const placedByKey = new Map<string, { relPath: string; entry: ManifestEntry }>();
    for (const outcome of outcomes) {
        for (const [relPath, entry] of outcome.placed) placedByKey.set(nameKey(relPath), { relPath, entry });
    }
    const docs = new Map<string, ManifestEntry>();
    const warned = new Set<string>();
    const keep = (relPath: string, entry: ManifestEntry): void => {
        const winner = placedByKey.get(nameKey(relPath));
        if (winner === undefined) {
            docs.set(relPath, entry);
            return;
        }
        if (winner.entry.id !== entry.id && !warned.has(relPath)) {
            warned.add(relPath);
            pendingWarnings.push(`! ${shown(winner.relPath)} now holds the file this pull wrote for doc ${winner.entry.id} ("${shown(winner.entry.title)}"); doc ${entry.id} ("${shown(entry.title)}") was tracked at ${shown(relPath)} before and is no longer tracked there`);
        }
    };
    if (keepUnlisted && previousManifest !== null && previousManifest.folder_path === folderPath) {
        const outcomeIds = new Set(outcomes.map((outcome) => outcome.id));
        for (const [relPath, entry] of Object.entries(previousManifest.docs)) {
            if (!outcomeIds.has(entry.id)) keep(relPath, entry);
        }
    }
    for (const outcome of outcomes) {
        for (const [relPath, entry] of outcome.kept) keep(relPath, entry);
        for (const [relPath, entry] of outcome.placed) docs.set(relPath, entry);
    }
    return { folder_path: folderPath, docs: docsFrom(docs) };
}

/** The error code of a filesystem failure, for the gate's wording. */
const errnoOf = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? 'ERROR';

/**
 * INV-C as a runtime gate (spec §1.2, rule 4), checked just before the manifest is written, on the FINAL manifest: no two
 * of its paths may be one entry on some filesystem, every file this run placed must be in it with the hash this run wrote
 * (PM ruling 14: a placed file the manifest would not record refuses), and every entry with a hash must be one this run
 * can vouch for:
 *  - A file this run placed (`placedFiles`): it must be a regular file with the `dev:ino` this run renamed in, and the
 *    entry must be the hash of the bytes it wrote. The bytes are read back; only a permission failure (EACCES, or EPERM,
 *    the same failure on some platforms) on that same file (a write-only mode it kept from the file it replaced) falls
 *    back to the hash this run wrote.
 *  - An entry kept for a doc this run acted on (a kept-previous outcome, or the old twin of a placed rename): lstat must
 *    show a regular file (no link, no folder) whose bytes hash to the entry. A missing file refuses like any other lstat
 *    or read failure: `decideOutcomes` keeps no such entry.
 *  - An entry carried unchanged for a doc this run did not write (a refused doc's, or one it never listed) was not
 *    touched by this run, and is not read: a folder or an edited file at that name is the refusal's own state.
 * The three exceptions to PM ruling 13 (a refused doc's carried entry is not read; a kept entry's missing file is NOT
 * one; EPERM like EACCES for a placed file) are the manager ruling on cli#168, issuecomment-6013479498.
 * Returns the first problem, or null.
 */
export function manifestProblem(destination: string, manifest: DocsManifest, outcomes: DocOutcome[], placedFiles: Map<string, { hash: string; identity: string }>): { rel: string; reason: string } | null {
    const byKey = new Map<string, string>();
    for (const rel of Object.keys(manifest.docs)) {
        const key = nameKey(rel);
        const other = byKey.get(key);
        if (other !== undefined) return { rel, reason: `the same file as ${other} on a case-insensitive or Unicode-normalising filesystem` };
        byKey.set(key, rel);
    }
    for (const [rel, placed] of placedFiles) {
        const entry = entryAt(manifest, rel);
        if (entry === undefined) return { rel, reason: 'this pull wrote it but the manifest would not record it' };
        if (entry.body_sha256 !== placed.hash) return { rel, reason: 'its bytes are not the ones the manifest would record' };
    }
    const verified = new Set<string>();
    for (const outcome of outcomes) {
        if (outcome.kind === 'refused') continue;
        for (const rel of outcome.kept.keys()) verified.add(rel);
    }
    for (const [rel, entry] of Object.entries(manifest.docs)) {
        if (entry.body_sha256 == null) continue;
        const placed = placedFiles.get(rel);
        if (placed === undefined && !verified.has(rel)) continue;
        const abs = path.join(destination, ...rel.split('/'));
        let stat: fs.Stats;
        try {
            stat = fs.lstatSync(abs);
        } catch (error) {
            if (errnoOf(error) !== 'ENOENT') return { rel, reason: `it cannot be checked (${errnoOf(error)})` };
            return { rel, reason: placed !== undefined ? 'the file this pull wrote is not there' : 'the file it tracks is not there' };
        }
        if (!stat.isFile()) return { rel, reason: 'it is not a regular file now' };
        if (placed !== undefined && (placed.hash !== entry.body_sha256 || placed.identity !== `${stat.dev}:${stat.ino}`)) return { rel, reason: 'its bytes are not the ones the manifest would record' };
        let actual: string;
        try {
            actual = sha256Hex(fs.readFileSync(abs));
        } catch (error) {
            if (placed === undefined || (errnoOf(error) !== 'EACCES' && errnoOf(error) !== 'EPERM')) return { rel, reason: `it cannot be read back (${errnoOf(error)})` };
            actual = placed.hash;
        }
        if (actual !== entry.body_sha256) return { rel, reason: 'its bytes are not the ones the manifest would record' };
    }
    return null;
}

/**
 * The line for the error or refusal the writes stopped at, then exit 1 (spec §1.5). `tracked` says the manifest
 * recorded the files written before the stop; when it did not, the manifest's own line already said so.
 */
function reportStop(stop: WriteStop, planned: PlannedDoc[], placed: PlacedWrite[], writes: PlannedWrite[], tracked: boolean): never {
    const { relPath } = stop.write;
    const tail = tracked ? ` — ${placed.length} of ${writes.length} files were updated and are tracked` : '';
    if (stop.error instanceof LinkOnTheWayError) {
        const linked = planned.find((q) => q.relPath === relPath);
        if (linked !== undefined) refuseLink(relPath, stop.error.component, linked.doc);
    }
    if (stop.error instanceof PublicationRefusedError) {
        process.stderr.write(chalk.red(`error: ${shown(relPath)} changed after doc pull checked it${tail}${tracked ? '. Pull again, or pass --overwrite to replace it.' : ''}\n`));
    } else if (stop.error instanceof UnsupportedTargetError) {
        // Ruling 9: a folder at a target is left alone, never moved or deleted.
        process.stderr.write(chalk.red(`error: ${shown(relPath)} is a folder (doc pull writes a file there)${tail}${tracked ? '. Move it aside and pull again.' : ''}\n`));
    } else {
        process.stderr.write(chalk.red(`error: cannot write ${shown(relPath)}: ${shown((stop.error as Error).message)}${tail}${tracked ? '; pull again.' : ''}\n`));
    }
    process.exit(1);
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
    listedIds: Set<number>,
    lock: HeldLock,
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
    const seen: SeenTargets = new Map();

    // Two docs whose names are one entry on some filesystem (case, Unicode normalisation) can never both keep
    // their own bytes: refuse before anything is written (cli#168).
    const plannedByKey = new Map<string, PlannedDoc>();
    for (const p of planned) {
        if (p.isMedia && p.mediaBytes === null) continue; // a failed download writes nothing
        const key = nameKey(p.relPath);
        const other = plannedByKey.get(key);
        if (other !== undefined) {
            process.stderr.write(chalk.red(`error: ${shown(other.relPath)} (doc ${other.doc.id}) and ${shown(p.relPath)} (doc ${p.doc.id}) would be the same file on a case-insensitive or Unicode-normalising filesystem; this pull would write different docs through those names.\n`));
            process.stderr.write(chalk.red('Nothing was written. Rename one of the docs on the server and pull again.\n'));
            process.exit(1);
        }
        plannedByKey.set(key, p);
    }

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
            let currentHash: string | null = null;
            if (sourceStat !== null) {
                const entry = entryAt(previousManifest, old);
                try {
                    currentHash = sha256Hex(fs.readFileSync(absOld));
                } catch {
                    currentHash = null;
                }
                modified = currentHash === null || currentHash !== entry?.body_sha256;
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
                sourceHash: currentHash,
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

        // Rule 5 (spec §1.1) at every rename-source decision: a source already holding the bytes this pull writes for its
        // doc, or for the doc whose write lands on that file, holds no edit (an interrupted pull placed them, and the old
        // name aliases the placed file or another doc's write took it). Real edits are still refused below.
        const plannedByDocId = new Map(planned.map((p) => [p.doc.id, p]));
        for (const m of renameMoves) {
            if (!m.modified || m.sourceHash === null) continue;
            const pulledHere = [plannedByDocId.get(m.id), plannedTargetForSource(m)];
            if (pulledHere.some((q) => q !== undefined && q.bodySha256 !== null && q.bodySha256 === m.sourceHash)) m.modified = false;
        }
        // Edited sources cannot be discarded by --overwrite during a rename.
        // Report a cross-doc collision first, including an alias's actual path.
        for (const m of renameMoves) {
            if (!m.modified) continue;
            const taker = plannedTargetForSource(m);
            if (!taker) continue;
            const oldTitle = entryAt(previousManifest, m.oldRel)?.title ?? `#${m.id}`;
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
                const targetEntry = entryAt(previousManifest, m.newRel);
                if (targetEntry !== undefined && targetEntry.body_sha256 != null) continue;
                const absNew = path.join(destination, ...m.newRel.split('/'));
                let existing: Buffer | null = null;
                let unreadable = '';
                try {
                    if (!fs.statSync(absNew).isFile()) continue;
                    existing = fs.readFileSync(absNew);
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code ?? 'ERROR';
                    if (code === 'ENOENT') {
                        observe(seen, m.newRel, { kind: 'absent' });
                        continue;
                    }
                    unreadable = ` (cannot be read: ${code})`; // present but unverifiable: not owned
                }
                if (existing !== null) observe(seen, m.newRel, { kind: 'sha256', sha256: sha256Hex(existing) });
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
    checkPlannedWrites(destination, planned, previousManifest, options, renameMoves, seen);

    // Unpushed-local-changes protection: now that the server walk is known, refuse only
    // for a file whose doc still exists remotely — i.e. its relative path is part of this
    // pull's plan and would be overwritten by the writes below. A modified file whose
    // relPath is NOT in the plan is an orphan, not a conflict: it is left alone here and
    // the deletion-propagation block further down keeps it and warns (no --overwrite
    // needed). This check must run before any write — nothing may be written to disk
    // before a real conflict has had the chance to refuse.
    if (previousManifest && !options.overwrite) {
        const modified = detectLocalModifications(destination, previousManifest, seen);
        const plannedByPath = new Map(planned.map((p) => [p.relPath, p]));
        // A file already holding the bytes this pull would write is never a conflict (spec §1.3): the next pull
        // after an interrupted or failed one adopts what that one placed.
        const conflicts = modified.filter((relPath) => {
            const p = plannedByPath.get(relPath);
            if (p === undefined) return false;
            const state = seen.get(relPath);
            return !(p.bodySha256 !== null && state?.kind === 'sha256' && state.sha256 === p.bodySha256);
        });
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

    // A destination path that already exists as a directory would make the write fail mid-walk, after earlier
    // docs were written. Refuse before any write.
    for (const p of planned) {
        const targetAbs = path.join(destination, ...p.relPath.split('/'));
        if (fs.existsSync(targetAbs) && !fs.statSync(targetAbs).isFile()) {
            process.stderr.write(chalk.red(`error: "${shown(p.relPath)}" exists and is not a regular file — cannot write doc ${p.doc.id} (${shown(p.doc.title)}).\n`));
            process.exit(1);
        }
    }

    // The state each target was authorized in is the state the checks above saw (spec §1.3 step 2); the write
    // refuses a target that is no longer in it (INV-B). Nothing is read again here. A target no check saw
    // is authorized as absent, so anything found there is refused.
    const faults = faultsFromEnv();
    faults.afterChecks(destination);
    const writes: PlannedWrite[] = [];
    for (const p of planned) {
        const data = p.isMedia ? p.mediaBytes : p.doc.body;
        if (data === null) continue; // a failed media download writes nothing
        const authorized: Authorized = options.overwrite ? { kind: 'any' } : (seen.get(p.relPath) ?? { kind: 'absent' });
        writes.push({ relPath: p.relPath, dirRel: p.dirRel, data, authorized });
    }

    // Every throw below can carry a server-derived path (a title-named file): the command
    // boundary in `docPull` prints it sanitised.
    fs.mkdirSync(destination, { recursive: true });
    if (lock.destination === null) {
        // A destination made just now was planned as new, with no manifest: take its lock, then check that no other
        // pull wrote one while this one was running (spec §1.3 step 1). The plan is built on the manifest read under
        // the lock, or the pull refuses before any write.
        takeLock(destination, lock);
        if (entryExists(path.join(destination, DOCS_MANIFEST))) {
            process.stderr.write(chalk.red(`error: another doc pull wrote to ${shown(destination)} while this one was running — nothing was changed. Pull again.\n`));
            process.exit(1);
        }
    }
    const destPrefix = path.resolve(destination) + path.sep;
    const realDest = fs.realpathSync(destination);

    // Write in plan order, stopping at the first error or refusal; then record exactly what was written, once (spec §1.3).
    const { placed, stop } = writeAll(destination, writes, faults);
    faults.afterWrites(destination);
    const pendingWarnings: string[] = [];
    const outcomes = decideOutcomes(destination, planned, new Set(placed.map((write) => write.relPath)), stop !== null, previousManifest, folderPath, renameMoves, listedIds, pendingWarnings);
    const manifest = buildManifest(folderPath, previousManifest, outcomes, usedSingleDocFallback || stop !== null, pendingWarnings);
    const updated = `${placed.length} of ${writes.length} files were updated`;
    let manifestRecorded = false;
    const problem = manifestProblem(destination, manifest, outcomes, new Map(placed.map((write) => [write.relPath, { hash: sha256Hex(write.data), identity: write.identity }])));
    if (problem !== null) {
        process.stderr.write(chalk.red(`error: doc pull stopped before recording a manifest that would not match the files (${shown(problem.rel)}: ${shown(problem.reason)}) — ${updated}; the manifest was not changed.\n`));
    } else {
        try {
            faults.beforeManifestTemp();
            writeManifest(destination, manifest, faults.beforeManifestRename);
            manifestRecorded = true;
        } catch (error) {
            process.stderr.write(chalk.red(`error: cannot write ${DOCS_MANIFEST}: ${shown((error as Error).message)} — ${updated}; the manifest was not changed.\n`));
        }
    }
    // The tracking decisions describe the manifest just recorded, so they come before the error of a pull that stopped
    // (spec §1.5); a manifest that was not recorded changed no tracking, so says nothing.
    if (manifestRecorded) {
        for (const line of pendingWarnings) process.stderr.write(chalk.yellow(`${line}\n`));
    }
    if (stop !== null) reportStop(stop, planned, placed, writes, manifestRecorded);
    if (!manifestRecorded) process.exit(1);

    const files: Array<{ path: string; action: 'written' }> = placed
        .map((write) => ({ path: write.relPath, action: 'written' as const }));

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

    // Rename cleanup (PM ruling 2, cli#157), after publication only: each unmodified old twin is
    // gone now that the new file is written — but never one this pull just wrote for another
    // doc (e.g. a new markdown doc that now takes `page.md`). Edited sources were all refused
    // before any write, even with --overwrite. A twin whose replacement was not written was
    // kept above.
    for (const m of renameMoves) {
        if (!m.replacementWritten || !m.sourcePresent) continue;
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
            if (entryAt(manifest, relPath) !== undefined) continue;
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

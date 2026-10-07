/**
 * Sidecar manifest (`.solidactions-docs.json`) shared by `doc pull` and
 * `doc push` to track which local files correspond to which SA-Docs docs,
 * and to detect local/server drift via a body sha256.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import chalk from 'chalk';
import { writeFileAtomic } from './doc-pull-writes';

export const DOCS_MANIFEST = '.solidactions-docs.json';

export interface ManifestEntry {
    id: number;
    title: string;
    current_revision_id: number | null;
    media: boolean;
    /**
     * sha256 (hex) of the exact bytes written for this file at pull time
     * (markdown body string, or downloaded media bytes). `null` when a
     * media download soft-failed (no bytes to hash). Manifests written
     * before this field existed simply omit it — callers must treat a
     * missing/undefined value the same as "no hash available", never as
     * a match.
     */
    body_sha256?: string | null;
}

export interface DocsManifest {
    folder_path: string;
    /**
     * Entries by relative path. Built and parsed as a null-prototype object (`docsFrom`), so any file name, `__proto__` and
     * the other Object.prototype names included, is only ever an own key (PM ruling 14); look entries up with `entryAt`.
     */
    docs: Record<string, ManifestEntry>;
}

/** A `docs` dictionary holding `entries` in order: no prototype, so no name is inherited and none reaches a setter. */
export function docsFrom(entries: Iterable<[string, ManifestEntry]>): Record<string, ManifestEntry> {
    const docs = Object.create(null) as Record<string, ManifestEntry>;
    for (const [relPath, entry] of entries) docs[relPath] = entry;
    return docs;
}

/** The entry `manifest` records at `relPath`: an own key only, never an inherited name. */
export function entryAt(manifest: DocsManifest | null | undefined, relPath: string): ManifestEntry | undefined {
    return manifest != null && Object.hasOwn(manifest.docs, relPath) ? manifest.docs[relPath] : undefined;
}

/** sha256 hex digest of the given bytes/string, as written to disk. */
export function sha256Hex(data: string | Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Read `<dir>/.solidactions-docs.json`. Absent or unparseable → null,
 * meaning nothing under `dir` is guarded (sidecar convention).
 *
 * `doc push` warns on unparseable JSON (files silently becoming untracked would
 * re-create every doc); `doc pull` stays silent (it is about to rewrite it anyway).
 */
export function readManifest(dir: string, opts: { warnOnParseError?: boolean } = {}): DocsManifest | null {
    const manifestPath = path.join(dir, DOCS_MANIFEST);
    if (!fs.existsSync(manifestPath)) {
        return null;
    }
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as DocsManifest;
        // JSON.parse makes every key an own one; the copy keeps it so for every later lookup and insertion.
        if (manifest !== null && typeof manifest.docs === 'object' && manifest.docs !== null) manifest.docs = docsFrom(Object.entries(manifest.docs));
        return manifest;
    } catch {
        if (opts.warnOnParseError) {
            process.stderr.write(chalk.yellow(`warn: ${DOCS_MANIFEST} exists but could not be parsed — all files will be treated as untracked\n`));
        }
        return null;
    }
}

/** `beforeRename` is doc pull's test seam (spec §1.8): it runs once the temp file exists, just before the rename. */
export function writeManifest(dir: string, manifest: DocsManifest, beforeRename?: () => void): void {
    writeFileAtomic(dir, DOCS_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, beforeRename);
}

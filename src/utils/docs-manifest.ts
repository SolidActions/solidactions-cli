/**
 * Sidecar manifest (`.solidactions-docs.json`) shared by `docs pull` and
 * `docs push` to track which local files correspond to which SA-Docs docs,
 * and to detect local/server drift via a body sha256.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import chalk from 'chalk';

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
    docs: Record<string, ManifestEntry>;
}

/** sha256 hex digest of the given bytes/string, as written to disk. */
export function sha256Hex(data: string | Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Read `<dir>/.solidactions-docs.json`. Absent or unparseable → null,
 * meaning nothing under `dir` is guarded (sidecar convention).
 *
 * `docs push` warns on unparseable JSON (files silently becoming untracked would
 * re-create every doc); `docs pull` stays silent (it is about to rewrite it anyway).
 */
export function readManifest(dir: string, opts: { warnOnParseError?: boolean } = {}): DocsManifest | null {
    const manifestPath = path.join(dir, DOCS_MANIFEST);
    if (!fs.existsSync(manifestPath)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as DocsManifest;
    } catch {
        if (opts.warnOnParseError) {
            process.stderr.write(chalk.yellow(`warn: ${DOCS_MANIFEST} exists but could not be parsed — all files will be treated as untracked\n`));
        }
        return null;
    }
}

export function writeManifest(dir: string, manifest: DocsManifest): void {
    fs.writeFileSync(path.join(dir, DOCS_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

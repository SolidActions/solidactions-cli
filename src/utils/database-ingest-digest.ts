// src/utils/database-ingest-digest.ts
//
// RFC 8785 (JCS) canonicalization, restricted to the fixed, flat ingest
// identity object spec §6.4 defines — every field is a string except the
// literal integer `v: 1`, so a full JCS number-formatting implementation
// is unnecessary; lexicographic key sorting plus JSON's own string
// escaping is JCS-compliant for this shape. Laravel
// (App\Domains\Databases\Analytical\Support\CanonicalBatchDigest) computes
// the identical digest over the identical object shape server-side; this
// file and its Laravel counterpart MUST stay byte-for-byte in sync — do
// not "improve" the canonicalization here without updating both sides.

import { createHash } from 'crypto';

export type IngestFormat = 'parquet' | 'csv' | 'jsonl' | 'rows';
export type IngestMode = 'append' | 'replace';

export interface IngestIdentity {
    databaseId: string;
    table: string;
    mode: IngestMode;
    format: IngestFormat;
    contentSha256: string;
}

function canonicalizeFlatObject(fields: Record<string, string | number>): string {
    const keys = Object.keys(fields).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(fields[key])}`);
    return `{${parts.join(',')}}`;
}

/** The §6.4 canonical digest: lower-case hex sha256 of the JCS body. */
export function canonicalIngestDigest(identity: IngestIdentity): string {
    const canonical = canonicalizeFlatObject({
        v: 1,
        database_id: identity.databaseId,
        // NOTE: JS `.trim()` strips a wider whitespace set than PHP `trim()`
        // (e.g. NBSP/BOM/OGHAM SPACE MARK/U+3000) — inert here, since the
        // server PHP-trims the same table name before this digest is ever
        // computed server-side, so a character JS strips but PHP doesn't
        // fails the `^[a-z][a-z0-9_]{0,62}$` gate with a 422 first. Do not
        // "fix" this asymmetry without re-verifying byte-for-byte parity
        // with the PHP canonical digest (`CanonicalBatchDigest`).
        table: identity.table.trim().toLowerCase(),
        mode: identity.mode,
        ack: 'durable',
        format: identity.format,
        content_sha256: identity.contentSha256.toLowerCase(),
    });
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** The CLI's default batch id: the first 32 hex chars of the canonical digest. */
export function defaultIngestBatchId(identity: IngestIdentity): string {
    return canonicalIngestDigest(identity).slice(0, 32);
}

export function ingestFormatFromExtension(filePath: string): IngestFormat {
    const ext = filePath.toLowerCase().split('.').pop();
    if (ext === 'parquet') return 'parquet';
    if (ext === 'csv') return 'csv';
    if (ext === 'jsonl') return 'jsonl';
    throw new Error(`Unsupported ingest file extension ".${ext}" — use .parquet, .csv, or .jsonl.`);
}

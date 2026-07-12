/**
 * Pure cache-planning core for `skill exec --target host`.
 *
 * The executed artifact is identified by {doc_id, published, execution_revision_id}:
 * reads serve ACTIVE-SNAPSHOT content when published (head may be newer), so the
 * execution revision is active_snapshot_revision_id when published and
 * head_revision_id only for unpublished drafts. Comparing head alone would run
 * stale cached content after a publish that promotes without moving head.
 *
 * planCacheRefresh() is deliberately pure (no fs, no network) so cache
 * correctness — noop detection, per-file skip, upstream deletions, local
 * drift — is unit-testable. The fs side lives in skill-cache-fs.ts.
 */
import os from 'os';
import path from 'path';
import { URL } from 'url';
import { Config } from './config';

export interface BundleMeta {
    doc_id: number | string;
    published?: boolean;
    head_revision_id?: number | string | null;
    active_snapshot_revision_id?: number | string | null;
}

export interface ArtifactIdentity {
    docId: number;
    published: boolean;
    executionRevisionId: number | null;
}

export interface ManifestFileEntry {
    sha256: string;
    blob_sha?: string;
}

export interface CacheManifest {
    schema_version: 1;
    origin: string;
    doc_id: number;
    published: boolean;
    execution_revision_id: number | null;
    files: Record<string, ManifestFileEntry>;
}

export const CACHE_MANIFEST = '.sa-cache-manifest.json';

function toNum(v: number | string | null | undefined): number | null {
    if (v === null || v === undefined) return null;
    return typeof v === 'string' ? parseInt(v, 10) : v;
}

export function artifactIdentity(bundle: BundleMeta): ArtifactIdentity {
    const published = bundle.published !== false;
    const executionRevisionId = published
        ? (toNum(bundle.active_snapshot_revision_id) ?? toNum(bundle.head_revision_id))
        : toNum(bundle.head_revision_id);
    return { docId: toNum(bundle.doc_id) as number, published, executionRevisionId };
}

export function sanitizeSegment(s: string): string {
    return s.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Cache identity for "which server + which workspace": host authority (host:port)
 * plus the canonical workspace id. NOT the workspace slug — Config distinguishes
 * cosmetic `workspace` from canonical `workspaceId`, and custom hosts may collide
 * on ids alone.
 */
export function cacheOrigin(config: Config): string {
    const authority = new URL(config.host).host; // host[:port]
    return `${sanitizeSegment(authority)}__${sanitizeSegment(config.workspaceId ?? 'default')}`;
}

export type CacheScope = { kind: 'shared' } | { kind: 'role'; crewPath: string; role: string };

export function cacheDirFor(config: Config, scope: CacheScope, skillName: string): string {
    const base = path.join(os.homedir(), '.solidactions', 'cache', 'skills', cacheOrigin(config));
    const scopeSegs = scope.kind === 'shared'
        ? ['shared']
        : [sanitizeSegment(scope.crewPath), sanitizeSegment(scope.role)];
    return path.join(base, ...scopeSegs, sanitizeSegment(skillName));
}

export interface DesiredFile {
    kind: 'text' | 'binary';
    sha256?: string;  // text: sha256 of the new content
    blobSha?: string; // binary: server-side blob identity
}

export interface CachePlan {
    action: 'noop' | 'refresh';
    writes: string[];
    deletes: string[];
}

export function planCacheRefresh(args: {
    manifest: CacheManifest | null;
    origin: string;
    identity: ArtifactIdentity;
    desired: Record<string, DesiredFile>;
    onDisk: Record<string, string | null>;
}): CachePlan {
    const { manifest, origin, identity, desired, onDisk } = args;
    const mfiles = manifest?.files ?? {};

    const identityOk = !!manifest
        && manifest.schema_version === 1
        && manifest.origin === origin
        && manifest.doc_id === identity.docId
        && manifest.published === identity.published
        && manifest.execution_revision_id === identity.executionRevisionId;

    const writes: string[] = [];
    for (const [p, spec] of Object.entries(desired)) {
        const m = mfiles[p];
        const upstreamSame = !!m && (spec.kind === 'text' ? m.sha256 === spec.sha256 : m.blob_sha === spec.blobSha);
        const diskSame = !!m && onDisk[p] !== null && onDisk[p] !== undefined && onDisk[p] === m.sha256;
        if (!upstreamSame || !diskSame) writes.push(p);
    }

    const deletes = Object.keys(mfiles).filter((p) => !(p in desired));

    const action = !identityOk || writes.length > 0 || deletes.length > 0 ? 'refresh' : 'noop';
    return { action, writes: action === 'noop' ? [] : writes, deletes: action === 'noop' ? [] : deletes };
}

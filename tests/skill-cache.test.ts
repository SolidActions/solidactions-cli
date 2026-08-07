import * as path from 'path';
import { describe, it, expect } from 'vitest';
import {
    artifactIdentity, sanitizeSegment, cacheOrigin, cacheDirFor,
    planCacheRefresh, CacheManifest,
} from '../src/utils/skill-cache';
import { Config } from '../src/utils/config';

const config = { host: 'https://sa.test:8443', apiKey: 'k', workspaceId: 'ws-123' } as Config;

describe('artifactIdentity', () => {
    it('uses active_snapshot_revision_id when published (read serves snapshot content, head may be newer)', () => {
        const id = artifactIdentity({ doc_id: '42', published: true, head_revision_id: 9, active_snapshot_revision_id: 7 });
        expect(id).toEqual({ docId: 42, published: true, executionRevisionId: 7 });
    });

    it('uses head_revision_id for an unpublished draft', () => {
        const id = artifactIdentity({ doc_id: 42, published: false, head_revision_id: 9, active_snapshot_revision_id: null });
        expect(id).toEqual({ docId: 42, published: false, executionRevisionId: 9 });
    });

    it('treats missing published as published (skills.read only flags false explicitly)', () => {
        const id = artifactIdentity({ doc_id: 1, head_revision_id: 3, active_snapshot_revision_id: 3 });
        expect(id.published).toBe(true);
        expect(id.executionRevisionId).toBe(3);
    });
});

describe('cache paths', () => {
    it('sanitizes path segments', () => {
        expect(sanitizeSegment('acme/marketing')).toBe('acme_marketing');
        expect(sanitizeSegment('a b:c')).toBe('a_b_c');
        expect(sanitizeSegment('ok-name_1.2')).toBe('ok-name_1.2');
    });

    it('origin combines host authority and canonical workspace id, never the slug', () => {
        expect(cacheOrigin(config)).toBe('sa.test_8443__ws-123');
    });

    it('builds shared and role scope dirs under ~/.solidactions/cache/skills', () => {
        const shared = cacheDirFor(config, { kind: 'shared' }, 'q-tool');
        expect(shared).toContain(path.join('.solidactions', 'cache', 'skills', 'sa.test_8443__ws-123', 'shared', 'q-tool'));

        const role = cacheDirFor(config, { kind: 'role', crewPath: 'acme/marketing', role: 'writer' }, 'q-tool');
        expect(role).toContain(path.join('sa.test_8443__ws-123', 'acme_marketing', 'writer', 'q-tool'));
    });
});

describe('planCacheRefresh', () => {
    const identity = { docId: 42, published: true, executionRevisionId: 7 };
    const origin = 'sa.test_8443__ws-123';
    const manifest: CacheManifest = {
        schema_version: 1, origin, doc_id: 42, published: true, execution_revision_id: 7,
        files: {
            'SKILL.md': { sha256: 'aaa' },
            'scripts/q.js': { sha256: 'bbb' },
            'assets/logo.png': { sha256: 'ccc', blob_sha: 'blob1' },
        },
    };
    const desired = {
        'SKILL.md': { kind: 'text' as const, sha256: 'aaa' },
        'scripts/q.js': { kind: 'text' as const, sha256: 'bbb' },
        'assets/logo.png': { kind: 'binary' as const, blobSha: 'blob1' },
    };
    const onDiskClean = { 'SKILL.md': 'aaa', 'scripts/q.js': 'bbb', 'assets/logo.png': 'ccc' };

    it('noop when identity, upstream hashes, and disk hashes all match', () => {
        expect(planCacheRefresh({ manifest, origin, identity, desired, onDisk: onDiskClean }))
            .toEqual({ action: 'noop', writes: [], deletes: [] });
    });

    it('cold cache (no manifest): writes everything, deletes nothing', () => {
        const plan = planCacheRefresh({ manifest: null, origin, identity, desired, onDisk: {} });
        expect(plan.action).toBe('refresh');
        expect(plan.writes.sort()).toEqual(['SKILL.md', 'assets/logo.png', 'scripts/q.js']);
        expect(plan.deletes).toEqual([]);
    });

    it('revision bump: refresh, but unchanged files (incl. binaries by blob_sha) are not rewritten', () => {
        const plan = planCacheRefresh({
            manifest, origin, identity: { ...identity, executionRevisionId: 8 },
            desired: { ...desired, 'scripts/q.js': { kind: 'text', sha256: 'NEW' } },
            onDisk: onDiskClean,
        });
        expect(plan.action).toBe('refresh');
        expect(plan.writes).toEqual(['scripts/q.js']);
        expect(plan.deletes).toEqual([]);
    });

    it('upstream deletion: file in manifest but not in bundle is deleted', () => {
        const { 'assets/logo.png': _gone, ...remaining } = desired;
        const plan = planCacheRefresh({ manifest, origin, identity, desired: remaining, onDisk: onDiskClean });
        expect(plan.action).toBe('refresh');
        expect(plan.writes).toEqual([]);
        expect(plan.deletes).toEqual(['assets/logo.png']);
    });

    it('local drift: tampered managed file is rewritten even at same revision', () => {
        const plan = planCacheRefresh({ manifest, origin, identity, desired, onDisk: { ...onDiskClean, 'scripts/q.js': 'TAMPERED' } });
        expect(plan.action).toBe('refresh');
        expect(plan.writes).toEqual(['scripts/q.js']);
    });

    it('missing file on disk is rewritten', () => {
        const plan = planCacheRefresh({ manifest, origin, identity, desired, onDisk: { ...onDiskClean, 'SKILL.md': null } });
        expect(plan.writes).toEqual(['SKILL.md']);
    });

    it('origin mismatch invalidates identity (workspace switch) but still skips byte-identical files', () => {
        const plan = planCacheRefresh({ manifest: { ...manifest, origin: 'other__ws-999' }, origin, identity, desired, onDisk: onDiskClean });
        expect(plan.action).toBe('refresh'); // manifest must be rewritten with the new origin
        expect(plan.writes).toEqual([]);     // bytes match — no file writes
    });
});

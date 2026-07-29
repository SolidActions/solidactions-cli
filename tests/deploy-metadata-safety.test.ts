/**
 * collectSourceMetadata() collection is documented as "optional, best effort"
 * (see the comment above its call site in deploy()), but had no exception
 * boundary. safeCollectSourceMetadata is the extracted, independently
 * testable wrapper — following this suite's convention of testing deploy()'s
 * pure helpers rather than deploy() itself (see deploy-plan-limit.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { safeCollectSourceMetadata } from '../src/commands/deploy';
import type { SourceMetadata } from '../src/utils/source-provenance';

const metadata: SourceMetadata = {
    metadata_source: 'git',
    commit_sha: '0123456789abcdef0123456789abcdef01234567',
    short_sha: '0123456789ab',
    branch: 'main',
    tag: null,
    commit_subject: 'Subject',
    commit_author_date: '2026-07-27T10:11:12-05:00',
    remote_url: null,
    dirty: false,
};

describe('safeCollectSourceMetadata', () => {
    it('degrades to null instead of throwing when the collector throws', () => {
        const throwingCollector = (): SourceMetadata | null => {
            throw new Error('git binary not found');
        };

        expect(safeCollectSourceMetadata('/any/source', {}, throwingCollector)).toBeNull();
    });

    it('returns the collector result when it succeeds', () => {
        expect(safeCollectSourceMetadata('/any/source', {}, () => metadata)).toEqual(metadata);
    });

    it('does not call the collector when the privacy opt-out is set', () => {
        let called = false;
        const collector = (): SourceMetadata | null => {
            called = true;
            return metadata;
        };

        expect(safeCollectSourceMetadata('/any/source', { gitMetadata: false }, collector)).toBeNull();
        expect(called).toBe(false);
    });
});

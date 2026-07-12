import { describe, it, expect } from 'vitest';
import { reconstructSkillMd, normalizeBundle } from '../src/utils/skill-bundle';

describe('reconstructSkillMd', () => {
    it('drops type, leads with name/description, appends body after frontmatter', () => {
        const md = reconstructSkillMd(
            { type: 'skill', name: 'q-tool', description: 'queries things', 'storage.scope': 'crew' },
            'Body text\n',
        );
        expect(md.startsWith('---\n')).toBe(true);
        expect(md).toContain('name: q-tool\n');
        expect(md).toContain('description: queries things\n');
        expect(md).toContain('storage.scope: crew\n');
        expect(md).not.toContain('type:');
        expect(md).toMatch(/---\n\nBody text\n$/);
    });
});

describe('normalizeBundle', () => {
    const data = {
        identifier: 'q-tool',
        doc_id: 42,
        published: true,
        head_revision_id: 9,
        active_snapshot_revision_id: 7,
        properties: { name: 'q-tool', description: 'd', storage: { scope: 'crew' } },
        body: 'B',
        reference: {
            'scripts/q.js': 'console.log(1)',
            'assets/logo.png': { binary: true, mime: 'image/png', size: 3, blob_sha: 'blob1' },
            '/etc/passwd': 'evil',
            '../escape.js': 'evil',
        },
    };

    it('separates text and binary references, computes identity and storage scope, flags unsafe keys', () => {
        const b = normalizeBundle(data);
        expect(b.identifier).toBe('q-tool');
        expect(b.identity).toEqual({ docId: 42, published: true, executionRevisionId: 7 });
        expect(b.textFiles).toEqual({ 'scripts/q.js': 'console.log(1)' });
        expect(b.binaryFiles).toEqual({ 'assets/logo.png': { blobSha: 'blob1', mime: 'image/png', size: 3 } });
        expect(b.skillMd).toContain('name: q-tool');
        expect(b.storageScope).toBe('crew');
        expect(b.skippedUnsafe.sort()).toEqual(['../escape.js', '/etc/passwd']);
    });

    it('reads flat storage.scope property form too, and null when absent/invalid', () => {
        expect(normalizeBundle({ ...data, properties: { name: 'x', 'storage.scope': 'workspace' } }).storageScope).toBe('workspace');
        expect(normalizeBundle({ ...data, properties: { name: 'x' } }).storageScope).toBeNull();
        expect(normalizeBundle({ ...data, properties: { name: 'x', storage: { scope: 'bogus' } } }).storageScope).toBeNull();
    });
});

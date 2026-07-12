import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { CacheManifest, CACHE_MANIFEST } from '../src/utils/skill-cache';
import {
    sha256Hex, hashFileOrNull, readManifest, onDiskHashes,
    writeFileAtomic, applyCachePlan, withCacheLock,
} from '../src/utils/skill-cache-fs';

function tmpdir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cache-fs-'));
}

const baseManifest: CacheManifest = {
    schema_version: 1, origin: 'o', doc_id: 1, published: true, execution_revision_id: 2,
    files: { 'SKILL.md': { sha256: sha256Hex('hello') } },
};

describe('hashing + manifest io', () => {
    it('sha256Hex matches for string and buffer, hashFileOrNull null on missing', () => {
        expect(sha256Hex('abc')).toBe(sha256Hex(Buffer.from('abc')));
        expect(hashFileOrNull(path.join(tmpdir(), 'nope'))).toBeNull();
    });

    it('readManifest returns null for missing or corrupt manifests', () => {
        const dir = tmpdir();
        expect(readManifest(dir)).toBeNull();
        fs.writeFileSync(path.join(dir, CACHE_MANIFEST), 'not json');
        expect(readManifest(dir)).toBeNull();
        fs.writeFileSync(path.join(dir, CACHE_MANIFEST), JSON.stringify({ schema_version: 99 }));
        expect(readManifest(dir)).toBeNull();
    });

    it('onDiskHashes hashes present files and nulls missing ones', () => {
        const dir = tmpdir();
        fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
        const hashes = onDiskHashes(dir, ['a.txt', 'missing/b.txt']);
        expect(hashes['a.txt']).toBe(sha256Hex('hello'));
        expect(hashes['missing/b.txt']).toBeNull();
    });
});

describe('applyCachePlan', () => {
    it('writes files atomically (nested dirs), deletes removed files, writes manifest last', () => {
        const dir = tmpdir();
        fs.mkdirSync(path.join(dir, 'old'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'old/gone.js'), 'x');

        applyCachePlan(
            dir,
            { action: 'refresh', writes: ['SKILL.md', 'scripts/q.js'], deletes: ['old/gone.js'] },
            { 'SKILL.md': 'hello', 'scripts/q.js': Buffer.from('console.log(1)') },
            baseManifest,
        );

        expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toBe('hello');
        expect(fs.readFileSync(path.join(dir, 'scripts/q.js'), 'utf8')).toBe('console.log(1)');
        expect(fs.existsSync(path.join(dir, 'old/gone.js'))).toBe(false);
        expect(readManifest(dir)).toEqual(baseManifest);
        // no temp litter
        expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
    });

    it('leaves unmanaged files (node_modules, .sa-state) untouched', () => {
        const dir = tmpdir();
        fs.mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'node_modules/pkg/index.js'), 'kept');
        fs.mkdirSync(path.join(dir, '.sa-state'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.sa-state/state.json'), '{}');

        applyCachePlan(dir, { action: 'refresh', writes: ['SKILL.md'], deletes: [] }, { 'SKILL.md': 'hello' }, baseManifest);

        expect(fs.readFileSync(path.join(dir, 'node_modules/pkg/index.js'), 'utf8')).toBe('kept');
        expect(fs.readFileSync(path.join(dir, '.sa-state/state.json'), 'utf8')).toBe('{}');
    });
});

describe('withCacheLock', () => {
    it('serializes two concurrent critical sections', async () => {
        const dir = tmpdir();
        const order: string[] = [];
        await Promise.all([
            withCacheLock(dir, async () => {
                order.push('a-in');
                await new Promise((r) => setTimeout(r, 300));
                order.push('a-out');
            }),
            (async () => {
                await new Promise((r) => setTimeout(r, 50)); // let A win the lock
                await withCacheLock(dir, async () => { order.push('b-in'); });
            })(),
        ]);
        expect(order).toEqual(['a-in', 'a-out', 'b-in']);
    });

    it('takes over a stale lock', async () => {
        const dir = tmpdir();
        const lockDir = dir + '.lock';
        fs.mkdirSync(lockDir, { recursive: true });
        const past = Date.now() / 1000 - 3600;
        fs.utimesSync(lockDir, past, past);
        let ran = false;
        await withCacheLock(dir, async () => { ran = true; });
        expect(ran).toBe(true);
    });

    it('releases the lock on callback throw', async () => {
        const dir = tmpdir();
        await expect(withCacheLock(dir, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(fs.existsSync(dir + '.lock')).toBe(false);
    });
});

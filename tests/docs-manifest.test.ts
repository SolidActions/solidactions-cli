import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DOCS_MANIFEST, DocsManifest, readManifest, sha256Hex, writeManifest } from '../src/utils/docs-manifest';

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-manifest-test-'));
}

describe('docs-manifest', () => {
    it('round-trips a manifest through writeManifest and readManifest', () => {
        const dir = tmpDir();
        const manifest: DocsManifest = {
            folder_path: 'marketing/fb',
            docs: { 'hero.png': { id: 42, title: 'hero.png', current_revision_id: 7, media: true, body_sha256: 'abc' } },
        };

        writeManifest(dir, manifest);
        const read = readManifest(dir);

        expect(read).toEqual(manifest);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('a manifest keyed by Object.prototype names reads back with each of them as its own entry, an untracked one as no entry, and writes them all back (PM ruling 14)', () => {
        const dir = tmpDir();
        const entry = (id: number): string => `{"id":${id},"title":"t","current_revision_id":1,"media":true,"body_sha256":"h${id}"}`;
        fs.writeFileSync(path.join(dir, DOCS_MANIFEST), `{"folder_path":"docs","docs":{"__proto__":${entry(1)},"toString":${entry(2)}}}`);

        const read = readManifest(dir)!;

        expect(Object.keys(read.docs)).toEqual(['__proto__', 'toString']);
        expect(Object.getOwnPropertyDescriptor(read.docs, '__proto__')?.value.id).toBe(1);
        for (const untracked of ['constructor', 'hasOwnProperty', 'valueOf', 'prototype']) expect(read.docs[untracked], untracked).toBeUndefined();
        writeManifest(dir, read);
        const written = JSON.parse(fs.readFileSync(path.join(dir, DOCS_MANIFEST), 'utf8'));
        expect(Object.keys(written.docs)).toEqual(['__proto__', 'toString']);
        expect(Object.getOwnPropertyDescriptor(written.docs, '__proto__')?.value.body_sha256).toBe('h1');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('returns null when the manifest is absent', () => {
        const dir = tmpDir();
        expect(readManifest(dir)).toBeNull();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('returns null and stays silent on unparseable json by default', () => {
        const dir = tmpDir();
        fs.writeFileSync(path.join(dir, DOCS_MANIFEST), '{ not json');
        const writes: string[] = [];
        const original = process.stderr.write;
        (process.stderr as any).write = (s: string) => { writes.push(s); return true; };

        const result = readManifest(dir);

        (process.stderr as any).write = original;
        expect(result).toBeNull();
        expect(writes).toEqual([]);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('warns on unparseable json when warnOnParseError is set', () => {
        const dir = tmpDir();
        fs.writeFileSync(path.join(dir, DOCS_MANIFEST), '{ not json');
        const writes: string[] = [];
        const original = process.stderr.write;
        (process.stderr as any).write = (s: string) => { writes.push(s); return true; };

        const result = readManifest(dir, { warnOnParseError: true });

        (process.stderr as any).write = original;
        expect(result).toBeNull();
        expect(writes.join('')).toContain(DOCS_MANIFEST);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('hashes strings and buffers identically for the same bytes', () => {
        expect(sha256Hex('hello')).toBe(sha256Hex(Buffer.from('hello', 'utf8')));
    });
});

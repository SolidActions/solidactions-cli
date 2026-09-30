import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeDirAtomic, assertReplaceableDir } from '../src/utils/atomic-dir';

describe('writeDirAtomic', () => {
    it('replaces an existing folder completely, removing stale files', () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
        const dest = path.join(base, 'skill');
        fs.mkdirSync(dest);
        fs.writeFileSync(path.join(dest, 'stale.md'), 'old');
        writeDirAtomic(dest, { 'SKILL.md': 'new', 'references/a.md': 'ref' });
        expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toBe('new');
        expect(fs.readFileSync(path.join(dest, 'references/a.md'), 'utf8')).toBe('ref');
        expect(fs.existsSync(path.join(dest, 'stale.md'))).toBe(false);
        expect(fs.readdirSync(base)).toEqual(['skill']);
    });

    it('treats a dest with a trailing slash as the dest itself, leaving only it in the parent', () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
        const dest = path.join(base, 'skill');
        fs.mkdirSync(dest);
        fs.writeFileSync(path.join(dest, 'stale.md'), 'old');
        writeDirAtomic(dest + path.sep, { 'SKILL.md': 'new' });
        expect(fs.readdirSync(base)).toEqual(['skill']);
        expect(fs.readdirSync(dest)).toEqual(['SKILL.md']);
        // and for a dest that does not exist yet
        const fresh = path.join(base, 'fresh');
        writeDirAtomic(fresh + path.sep, { 'SKILL.md': 'x' });
        expect(fs.readdirSync(base).sort()).toEqual(['fresh', 'skill']);
    });

    it('leaves the old folder untouched when a path is unsafe', () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
        const dest = path.join(base, 'skill');
        fs.mkdirSync(dest);
        fs.writeFileSync(path.join(dest, 'SKILL.md'), 'old');
        expect(() => writeDirAtomic(dest, { 'SKILL.md': 'new', '../escape.md': 'x' })).toThrow(/unsafe path/);
        expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toBe('old');
        expect(fs.readdirSync(base)).toEqual(['skill']);
    });

    it('removes the staged temp dir and leaves dest untouched when moving the old dest aside fails', () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
        const dest = path.join(base, 'skill');
        fs.mkdirSync(dest);
        fs.writeFileSync(path.join(dest, 'SKILL.md'), 'old');
        // A real failure: the exact `.old-<stamp>` path is already a non-empty dir, so renaming dest onto it fails (ENOTEMPTY/EEXIST).
        const stamp = 'blocked';
        const blocker = `${dest}.old-${stamp}`;
        fs.mkdirSync(blocker);
        fs.writeFileSync(path.join(blocker, 'in-the-way.txt'), 'x');

        expect(() => writeDirAtomic(dest, { 'SKILL.md': 'new' }, { stamp })).toThrow(/ENOTEMPTY|EEXIST/);

        expect(fs.readdirSync(base).sort()).toEqual(['skill', 'skill.old-blocked']); // no .tmp-* left behind
        expect(fs.readdirSync(dest)).toEqual(['SKILL.md']);
        expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toBe('old');
        expect(fs.readFileSync(path.join(blocker, 'in-the-way.txt'), 'utf8')).toBe('x');
    });
});

describe('assertReplaceableDir', () => {
    const MARKER = '.marker.json';
    const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-')));

    it('refuses a non-empty dir without the marker and leaves it untouched', () => {
        const dest = path.join(tmp(), 'proj');
        fs.mkdirSync(dest);
        fs.writeFileSync(path.join(dest, 'important.txt'), 'keep');
        expect(() => assertReplaceableDir(dest, MARKER)).toThrow(/not a pulled skill \(no \.marker\.json\)/);
        expect(fs.readdirSync(dest)).toEqual(['important.txt']);
    });

    it('names the kind in the refusal (default skill, role when asked)', () => {
        const dest = path.join(tmp(), 'proj');
        fs.mkdirSync(dest);
        fs.writeFileSync(path.join(dest, 'important.txt'), 'keep');
        expect(() => assertReplaceableDir(dest, MARKER, undefined, 'role')).toThrow(/not a pulled role \(no \.marker\.json\)/);
    });

    it('accepts a dir that contains the marker', () => {
        const dest = path.join(tmp(), 'skill');
        fs.mkdirSync(dest);
        fs.writeFileSync(path.join(dest, MARKER), '{}');
        fs.writeFileSync(path.join(dest, 'SKILL.md'), 'old');
        expect(() => assertReplaceableDir(dest, MARKER)).not.toThrow();
    });

    it('accepts a missing dest and an empty dir', () => {
        const base = tmp();
        expect(() => assertReplaceableDir(path.join(base, 'missing'), MARKER)).not.toThrow();
        const empty = path.join(base, 'empty');
        fs.mkdirSync(empty);
        expect(() => assertReplaceableDir(empty, MARKER)).not.toThrow();
    });

    it('refuses a dest that is a file', () => {
        const file = path.join(tmp(), 'f');
        fs.writeFileSync(file, 'x');
        expect(() => assertReplaceableDir(file, MARKER)).toThrow(/not a directory/);
    });

    it('refuses the current directory and its ancestors, even when it carries the marker', () => {
        const base = tmp();
        const child = path.join(base, 'a', 'b');
        fs.mkdirSync(child, { recursive: true });
        fs.writeFileSync(path.join(child, MARKER), '{}');
        const original = process.cwd();
        process.chdir(child);
        try {
            expect(() => assertReplaceableDir('.', MARKER)).toThrow(/current directory or one of its parents/);
            expect(() => assertReplaceableDir(child, MARKER)).toThrow(/current directory or one of its parents/);
            expect(() => assertReplaceableDir(path.join(base, 'a'), MARKER)).toThrow(/current directory or one of its parents/);
            expect(() => assertReplaceableDir('..', MARKER)).toThrow(/current directory or one of its parents/);
            // a sibling is fine
            expect(() => assertReplaceableDir(path.join(base, 'a', 'sibling'), MARKER)).not.toThrow();
        } finally {
            process.chdir(original);
        }
    });

    it('refuses dest as an ancestor of a cwd whose segment is named "..foo"', () => {
        const base = tmp();
        const dest = path.join(base, 'x');
        const cwd = path.join(dest, '..foo');
        fs.mkdirSync(cwd, { recursive: true });
        fs.writeFileSync(path.join(dest, MARKER), '{}');
        expect(() => assertReplaceableDir(dest, MARKER, cwd)).toThrow(/current directory or one of its parents/);
        // a sibling of a "..foo" cwd is not an ancestor
        const sibling = path.join(base, '..foo-sibling');
        expect(() => assertReplaceableDir(sibling, MARKER, cwd)).not.toThrow();
        // and a dest that is a "..foo" dir beside a normal cwd is fine
        const dotted = path.join(base, '..foo');
        fs.mkdirSync(dotted);
        expect(() => assertReplaceableDir(dotted, MARKER, dest)).not.toThrow();
    });
});

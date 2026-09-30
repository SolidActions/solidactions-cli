import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeDirAtomic } from '../src/utils/atomic-dir';

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

    it('leaves the old folder untouched when a path is unsafe', () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
        const dest = path.join(base, 'skill');
        fs.mkdirSync(dest);
        fs.writeFileSync(path.join(dest, 'SKILL.md'), 'old');
        expect(() => writeDirAtomic(dest, { 'SKILL.md': 'new', '../escape.md': 'x' })).toThrow(/unsafe path/);
        expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toBe('old');
        expect(fs.readdirSync(base)).toEqual(['skill']);
    });
});

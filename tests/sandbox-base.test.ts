import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect, it } from 'vitest';
import { writeSandboxBase } from '../src/utils/sandbox-base';

const oldBase = { source_hash: 'a'.repeat(32), slug: 'project', restored_at: 'before' };
const newBase = { source_hash: 'b'.repeat(32), slug: 'project', restored_at: 'after' };

it('publishes the replacement base and leaves unrelated temporary files alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-base-atomic-'));
    try {
        writeSandboxBase(dir, oldBase);
        const folder = path.join(dir, '.solidactions');
        const other = path.join(folder, '.base.json.other.tmp');
        fs.writeFileSync(other, 'other');
        writeSandboxBase(dir, newBase);
        expect(JSON.parse(fs.readFileSync(path.join(folder, 'base.json'), 'utf8'))).toEqual(newBase);
        expect(fs.readFileSync(other, 'utf8')).toBe('other');
        expect(fs.readdirSync(folder).sort()).toEqual(['.base.json.other.tmp', 'base.json']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32')('preserves the old base and unrelated temp when a real write fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-base-fail-'));
    try {
        writeSandboxBase(dir, oldBase);
        const folder = path.join(dir, '.solidactions');
        const target = path.join(folder, 'base.json');
        const original = fs.readFileSync(target, 'utf8');
        fs.writeFileSync(path.join(folder, '.base.json.other.tmp'), 'other');
        const script = `process.on('SIGXFSZ', () => {}); try { require(process.argv[1]).writeSandboxBase(process.argv[2], ${JSON.stringify(newBase)}); process.exit(2); } catch (e) { console.log(e.code); }`;
        const failed = spawnSync('bash', ['-c', 'ulimit -f 0; exec "$@"', 'bash', process.execPath, '-e', script, path.resolve('dist/utils/sandbox-base.js'), dir], { encoding: 'utf8' });
        expect(failed.status).toBe(0); expect(failed.stdout.trim()).toBe('EFBIG');
        expect(fs.readFileSync(target, 'utf8')).toBe(original);
        expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(oldBase);
        expect(fs.readFileSync(path.join(folder, '.base.json.other.tmp'), 'utf8')).toBe('other');
        expect(fs.readdirSync(folder).sort()).toEqual(['.base.json.other.tmp', 'base.json']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

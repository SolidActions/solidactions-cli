/**
 * Tests for the secret-file writer.
 *
 * Real filesystem, real temp dirs — no mocks. umask is pinned so the mode
 * assertions are deterministic: under a 077 umask an unfixed writeFileSync
 * would also produce 0600 and every assertion here would be vacuous.
 */

import * as childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { secretTempPath, writeSecretFileSync, writeViaTempFileSync } from '../src/utils/secure-write';

const posixOnly = process.platform === 'win32' ? it.skip : it;

let root: string;
let previousUmask: number;

beforeEach(() => {
    previousUmask = process.umask(0o022);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-secure-write-'));
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    process.umask(previousUmask);
});

function mode(p: string): number {
    return fs.statSync(p).mode & 0o777;
}

describe('writeSecretFileSync', () => {
    posixOnly('creates a new file owner-only', () => {
        const dest = path.join(root, '.env');

        writeSecretFileSync(dest, 'SECRET=1\n');

        expect(fs.readFileSync(dest, 'utf8')).toBe('SECRET=1\n');
        expect(mode(dest)).toBe(0o600);
        expect(fs.statSync(dest).mode & 0o077).toBe(0);
    });

    posixOnly('tightens an existing group-readable file to owner-only', () => {
        const dest = path.join(root, '.env');
        fs.writeFileSync(dest, 'OLD=0\n');
        fs.chmodSync(dest, 0o644);
        expect(mode(dest)).toBe(0o644); // precondition

        writeSecretFileSync(dest, 'SECRET=1\n');

        expect(fs.readFileSync(dest, 'utf8')).toBe('SECRET=1\n');
        expect(mode(dest)).toBe(0o600);
        expect(fs.statSync(dest).mode & 0o077).toBe(0);
    });

    posixOnly('leaves no temp file behind after a successful write', () => {
        const dest = path.join(root, '.env');

        writeSecretFileSync(dest, 'SECRET=1\n');

        // readdirSync, not a glob: the temp name is a dotfile.
        expect(fs.readdirSync(root)).toEqual(['.env']);
    });

    posixOnly('writes through a symlink and leaves the link in place', () => {
        const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-secure-write-target-'));
        const target = path.join(targetDir, 'real.env');
        const link = path.join(root, '.env');
        fs.writeFileSync(target, 'OLD=0\n');
        fs.chmodSync(target, 0o644);
        fs.symlinkSync(target, link);
        expect(mode(target)).toBe(0o644); // precondition

        writeSecretFileSync(link, 'SECRET=1\n');

        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(target, 'utf8')).toBe('SECRET=1\n');
        expect(mode(target)).toBe(0o600);
        expect(fs.statSync(target).mode & 0o077).toBe(0);
        expect(fs.readdirSync(targetDir)).toEqual(['real.env']);
        fs.rmSync(targetDir, { recursive: true, force: true });
    });

    posixOnly('creates the target of a dangling symlink and keeps the link', () => {
        const target = path.join(root, 'real.env');
        const link = path.join(root, '.env');
        fs.symlinkSync(target, link);

        writeSecretFileSync(link, 'SECRET=1\n');

        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(target, 'utf8')).toBe('SECRET=1\n');
        expect(mode(target)).toBe(0o600);
        expect(fs.statSync(target).mode & 0o077).toBe(0);
    });

    posixOnly('writes a character device directly and leaves no temp file', () => {
        writeSecretFileSync('/dev/null', 'SECRET=1\n');

        // Assert by name — a before/after listing of /dev can flap.
        expect(fs.readdirSync('/dev').filter((name) => name.startsWith('.null.'))).toEqual([]);
    });

    posixOnly('rethrows and cleans up the temp file when the destination is a directory', () => {
        const dest = path.join(root, 'subdir');
        fs.mkdirSync(dest);

        expect(() => writeSecretFileSync(dest, 'SECRET=1\n')).toThrow();
        expect(fs.readdirSync(root)).toEqual(['subdir']);
    });

    posixOnly('fails ENOENT when the parent directory is missing', () => {
        expect(() => writeSecretFileSync(path.join(root, 'nope', '.env'), 'SECRET=1\n'))
            .toThrow(expect.objectContaining({ code: 'ENOENT' }));
    });

    posixOnly('fails ENOTDIR when a parent component is a regular file', () => {
        const file = path.join(root, 'afile');
        fs.writeFileSync(file, 'x');

        expect(() => writeSecretFileSync(path.join(file, '.env'), 'SECRET=1\n'))
            .toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
    });
});

describe('writeViaTempFileSync', () => {
    // The temp path is randomized inside writeSecretFileSync, so a planted
    // collision can only be staged against this seam.
    posixOnly('leaves a file it did not create at the temp path in place', () => {
        const dest = path.join(root, '.env');
        const tempPath = path.join(root, '.env.planted.tmp');
        fs.writeFileSync(tempPath, 'NOT-OURS\n');

        expect(() => writeViaTempFileSync(dest, tempPath, 'SECRET=1\n'))
            .toThrow(expect.objectContaining({ code: 'EEXIST' }));

        expect(fs.readFileSync(tempPath, 'utf8')).toBe('NOT-OURS\n');
        expect(fs.existsSync(dest)).toBe(false);
    });

    posixOnly('removes the temp file it did create when the rename fails', () => {
        const dest = path.join(root, 'subdir');
        fs.mkdirSync(dest);
        const tempPath = path.join(root, '.subdir.ours.tmp');

        expect(() => writeViaTempFileSync(dest, tempPath, 'SECRET=1\n')).toThrow();

        expect(fs.readdirSync(root)).toEqual(['subdir']);
    });
});

describe('EBUSY fallback for a bind-mounted target (cli#129)', () => {
    const busy = (): never => {
        throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
    };

    posixOnly('writes in place, owner-only, keeping the inode, and removes its temp file', () => {
        const dest = path.join(root, '.env');
        fs.writeFileSync(dest, 'OLD=1\nOLDER=2\n', { mode: 0o644 });
        fs.chmodSync(dest, 0o644);
        const inode = fs.statSync(dest).ino;
        const tempPath = path.join(root, '.env.ours.tmp');

        writeViaTempFileSync(dest, tempPath, 'SECRET=1\n', busy);

        expect(fs.readFileSync(dest, 'utf8')).toBe('SECRET=1\n');
        expect(mode(dest)).toBe(0o600);
        expect(fs.statSync(dest).ino).toBe(inode);
        expect(fs.existsSync(tempPath)).toBe(false);
    });

    posixOnly('a rename error other than EBUSY still throws and never touches the target', () => {
        const dest = path.join(root, '.env');
        fs.writeFileSync(dest, 'OLD=1\n', { mode: 0o644 });
        const tempPath = path.join(root, '.env.ours.tmp');
        const exdev = (): never => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); };

        expect(() => writeViaTempFileSync(dest, tempPath, 'SECRET=1\n', exdev))
            .toThrow(expect.objectContaining({ code: 'EXDEV' }));

        expect(fs.readFileSync(dest, 'utf8')).toBe('OLD=1\n');
        expect(fs.existsSync(tempPath)).toBe(false);
    });

    posixOnly('never writes through a symlink target (PM ruling 5)', () => {
        const real = path.join(root, 'real.env');
        fs.writeFileSync(real, 'OLD=1\n', { mode: 0o644 });
        const link = path.join(root, '.env');
        fs.symlinkSync(real, link);
        const tempPath = path.join(root, '.env.ours.tmp');

        expect(() => writeViaTempFileSync(link, tempPath, 'SECRET=1\n', busy))
            .toThrow(expect.objectContaining({ code: 'ELOOP' }));

        expect(fs.readFileSync(real, 'utf8')).toBe('OLD=1\n');
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(fs.existsSync(tempPath)).toBe(false);
    });

    it('temp names are `<basename>.<pid>.<hex>.tmp`, keeping the target basename as a prefix', () => {
        expect(path.basename(secretTempPath('/x/.env'))).toMatch(/^\.env\.\d+\.[0-9a-f]{8}\.tmp$/);
        expect(path.basename(secretTempPath('/x/secrets.env'))).toMatch(/^secrets\.env\.\d+\.[0-9a-f]{8}\.tmp$/);
        expect(path.dirname(secretTempPath('/x/.env'))).toBe('/x');
    });

    // Real file-level bind mount in a throwaway user+mount namespace: rename(2) onto the
    // mount point fails EBUSY, so only this test exercises the production fallback path.
    const canBindMount = ((): boolean => {
        if (process.platform !== 'linux') return false;
        try {
            const probe = childProcess.spawnSync('unshare', ['-rm', 'true'], { timeout: 15_000 });
            return probe.status === 0;
        } catch {
            return false;
        }
    })();

    it.skipIf(!canBindMount)('writes owner-only through a real bind mount without renaming (cli#129)', () => {
        const source = path.join(root, 'source.env');
        fs.writeFileSync(source, 'OLD=1\n', { mode: 0o644 });
        const dest = path.join(root, '.env');
        fs.writeFileSync(dest, 'anything\n');
        const modulePath = path.resolve(__dirname, '../dist/utils/secure-write.js');
        const child = childProcess.spawnSync(
            'unshare',
            ['-rm', 'sh', '-c', 'mount --bind "$SW_SOURCE" "$SW_TARGET" && node -e "$SW_SCRIPT"'],
            {
                env: {
                    ...process.env,
                    SW_SOURCE: source,
                    SW_TARGET: dest,
                    SW_SCRIPT: [
                        "const fs = require('fs');",
                        `const { writeSecretFileSync } = require(${JSON.stringify(modulePath)});`,
                        'const target = process.env.SW_TARGET;',
                        "writeSecretFileSync(target, 'SECRET=1\\n');",
                        "process.stdout.write((fs.statSync(target).mode & 0o777).toString(8) + '\\n');",
                        "process.stdout.write(fs.readFileSync(target, 'utf8'));",
                    ].join('\n'),
                },
                timeout: 30_000,
                encoding: 'utf8',
            },
        );
        expect(child.status).toBe(0);
        expect(child.stdout).toContain('600\n');
        expect(child.stdout).toContain('SECRET=1\n');
        expect(fs.readFileSync(source, 'utf8')).toBe('SECRET=1\n');
        expect(fs.readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });
});

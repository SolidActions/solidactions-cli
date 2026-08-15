/**
 * Tests for the secret-file writer.
 *
 * Real filesystem, real temp dirs — no mocks. umask is pinned so the mode
 * assertions are deterministic: under a 077 umask an unfixed writeFileSync
 * would also produce 0600 and every assertion here would be vacuous.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { writeSecretFileSync, writeViaTempFileSync } from '../src/utils/secure-write';

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

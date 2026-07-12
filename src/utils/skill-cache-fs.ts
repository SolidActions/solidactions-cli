/**
 * Filesystem side of the host skill cache: hashing, atomic writes, the
 * per-cache-key lock, and plan application. Kept separate from the pure
 * planner (skill-cache.ts) so planning stays unit-testable without fs.
 *
 * Write protocol: every managed file is written via temp-file + rename in the
 * same directory (atomic on POSIX); the manifest is written LAST, so a crash
 * mid-refresh leaves a manifest that simply mismatches on the next run and
 * triggers a clean re-refresh. Per-file renames also mean a concurrently
 * RUNNING exec keeps its already-open scripts.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { CacheManifest, CachePlan, CACHE_MANIFEST } from './skill-cache';

export function sha256Hex(data: Buffer | string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
}

export function hashFileOrNull(filePath: string): string | null {
    try {
        return sha256Hex(fs.readFileSync(filePath));
    } catch {
        return null;
    }
}

export function readManifest(cacheDir: string): CacheManifest | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(cacheDir, CACHE_MANIFEST), 'utf8'));
        if (parsed?.schema_version !== 1 || typeof parsed?.files !== 'object') return null;
        return parsed as CacheManifest;
    } catch {
        return null;
    }
}

export function onDiskHashes(cacheDir: string, paths: string[]): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const p of paths) {
        out[p] = hashFileOrNull(path.join(cacheDir, p));
    }
    return out;
}

export function writeFileAtomic(target: string, data: Buffer | string): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = path.join(path.dirname(target), `.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
}

export function applyCachePlan(
    cacheDir: string,
    plan: CachePlan,
    contents: Record<string, Buffer | string>,
    manifest: CacheManifest,
): void {
    fs.mkdirSync(cacheDir, { recursive: true });
    for (const rel of plan.writes) {
        if (!(rel in contents)) {
            throw new Error(`applyCachePlan: no content provided for planned write '${rel}'`);
        }
        writeFileAtomic(path.join(cacheDir, rel), contents[rel]);
    }
    for (const rel of plan.deletes) {
        fs.rmSync(path.join(cacheDir, rel), { force: true });
    }
    writeFileAtomic(path.join(cacheDir, CACHE_MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
}

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 20_000;
const LOCK_POLL_MS = 100;

export async function withCacheLock<T>(cacheDir: string, fn: () => Promise<T>): Promise<T> {
    const lockDir = cacheDir + '.lock';
    fs.mkdirSync(path.dirname(lockDir), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    for (;;) {
        try {
            fs.mkdirSync(lockDir);
            break;
        } catch (e: any) {
            if (e?.code !== 'EEXIST') throw e;
            let stale = false;
            try {
                stale = Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS;
            } catch {
                continue; // holder just released — retry immediately
            }
            if (stale) {
                try { fs.rmdirSync(lockDir); } catch { /* raced another taker */ }
                continue;
            }
            if (Date.now() > deadline) {
                throw new Error(`timed out waiting for skill cache lock: ${lockDir} (another exec running? delete it if stale)`);
            }
            await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
        }
    }

    try {
        return await fn();
    } finally {
        try { fs.rmdirSync(lockDir); } catch { /* best-effort */ }
    }
}

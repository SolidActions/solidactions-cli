import * as fs from 'fs';
import * as path from 'path';

/**
 * Replace `dest` with a folder holding exactly `files` (relative path -> content),
 * as a unit: the result is either the old complete folder or the new complete one,
 * never a mix, and no stale files survive. Files go into a sibling temp dir first,
 * then the temp dir is swapped in by rename.
 */
export function writeDirAtomic(dest: string, files: Record<string, string | Buffer>): void {
    for (const rel of Object.keys(files)) {
        if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error(`unsafe path: ${rel}`);
    }
    const stamp = `${process.pid}-${Date.now()}`;
    const tmp = `${dest}.tmp-${stamp}`;
    fs.mkdirSync(tmp, { recursive: true });
    try {
        for (const [rel, content] of Object.entries(files)) {
            const target = path.join(tmp, rel);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, content);
        }
    } catch (e) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw e;
    }
    const old = `${dest}.old-${stamp}`;
    const hadOld = fs.existsSync(dest);
    if (hadOld) fs.renameSync(dest, old);
    try {
        fs.renameSync(tmp, dest);
    } catch (e) {
        if (hadOld) fs.renameSync(old, dest);
        fs.rmSync(tmp, { recursive: true, force: true });
        throw e;
    }
    if (hadOld) fs.rmSync(old, { recursive: true, force: true });
}

/**
 * Guard for callers that replace a whole folder with writeDirAtomic. Throws unless
 * `dest` is safe to swap out: it must not be the current directory or one of its
 * parents, must not be a file, and if it already holds anything it must contain
 * `marker` directly (proof that a previous pull created it). A missing or empty
 * dest is fine. `cwd` exists so tests can avoid process.chdir.
 */
export function assertReplaceableDir(dest: string, marker: string, cwd: string = process.cwd()): void {
    const resolved = path.resolve(dest);
    const exists = fs.existsSync(resolved);
    const real = exists ? fs.realpathSync(resolved) : resolved;
    const rel = path.relative(real, fs.realpathSync(cwd));
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        throw new Error(`refusing to replace ${dest}: it is the current directory or one of its parents`);
    }
    if (!exists) return;
    if (!fs.statSync(resolved).isDirectory()) {
        throw new Error(`refusing to replace ${dest}: it exists and is not a directory`);
    }
    if (fs.readdirSync(resolved).length > 0 && !fs.existsSync(path.join(resolved, marker))) {
        throw new Error(`refusing to replace ${dest}: it exists and is not a pulled skill (no ${marker}); remove it or choose another destination`);
    }
}

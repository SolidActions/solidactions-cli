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

import * as fs from 'fs';
import * as path from 'path';

/**
 * Replace `dest` with a folder holding exactly `files` (relative path -> content),
 * as a unit: the result is either the old complete folder or the new complete one,
 * never a mix, and no stale files survive. Files go into a sibling temp dir first,
 * then the temp dir is swapped in by rename. If any step fails the temp dir is removed and
 * the old folder (if any) is left in place. `opts.stamp` fixes the temp/old name suffix
 * (default pid-time); it exists so tests can force a rename failure.
 */
export function writeDirAtomic(dest: string, files: Record<string, string | Buffer>, opts: { stamp?: string } = {}): void {
    dest = path.resolve(dest); // a trailing slash would otherwise put the temp dir inside dest
    for (const rel of Object.keys(files)) {
        if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error(`unsafe path: ${rel}`);
    }
    const stamp = opts.stamp ?? `${process.pid}-${Date.now()}`;
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
    let movedAside = false;
    try {
        if (hadOld) {
            fs.renameSync(dest, old);
            movedAside = true;
        }
        fs.renameSync(tmp, dest);
    } catch (e) {
        // Put the old folder back if it was already moved aside, and never leave the staged dir behind.
        if (movedAside) fs.renameSync(old, dest);
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
 * dest is fine. `cwd` exists so tests can avoid process.chdir; `kind` names the noun in the refusal.
 */
export function assertReplaceableDir(dest: string, marker: string, cwd: string = process.cwd(), kind: string = 'skill'): void {
    const resolved = path.resolve(dest);
    const exists = fs.existsSync(resolved);
    const real = exists ? fs.realpathSync(resolved) : resolved;
    const rel = path.relative(real, fs.realpathSync(cwd));
    if (rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))) {
        throw new Error(`refusing to replace ${dest}: it is the current directory or one of its parents`);
    }
    if (!exists) return;
    if (!fs.statSync(resolved).isDirectory()) {
        throw new Error(`refusing to replace ${dest}: it exists and is not a directory`);
    }
    if (fs.readdirSync(resolved).length > 0 && !fs.existsSync(path.join(resolved, marker))) {
        throw new Error(`refusing to replace ${dest}: it exists and is not a pulled ${kind} (no ${marker}); remove it or choose another destination`);
    }
}

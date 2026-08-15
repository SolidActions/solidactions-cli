import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/** The kernel's own symlink-resolution limit. */
const MAX_SYMLINK_HOPS = 40;

/**
 * Find where a path that does not currently resolve should be created,
 * following any symlink chain by hand.
 *
 * realpathSync cannot be used here: it throws ENOENT on a dangling symlink,
 * and today's writeFileSync creates the link's target instead of failing.
 */
function resolveCreationPath(filePath: string): string {
    let current = filePath;

    for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop++) {
        let stats: fs.Stats;
        try {
            stats = fs.lstatSync(current);
        } catch {
            return current; // nothing here — this is the creation point
        }

        if (!stats.isSymbolicLink()) {
            return current;
        }

        current = path.resolve(path.dirname(current), fs.readlinkSync(current));
    }

    // Defensive guard, unreachable in practice: statSync raises ELOOP first.
    const error = new Error(`Too many symbolic links resolving ${filePath}`) as NodeJS.ErrnoException;
    error.code = 'ELOOP';
    throw error;
}

/**
 * Write a secret-bearing file so the result is owner-only, whether or not the
 * destination already exists.
 *
 * writeFileSync's `mode` only applies when it creates the file, so an existing
 * world-readable file would silently keep its mode and receive fresh plaintext
 * secrets. Writing to a sibling temp file at 0600 and renaming over the
 * destination gives the final path a fresh inode carrying 0600 on both the
 * create and the overwrite path, and makes the replacement atomic — readers
 * never observe a partial file.
 *
 * The mode is masked by the process umask, which can only subtract bits, so
 * the result is always <= 0600: never group- or world-readable.
 */
export function writeSecretFileSync(filePath: string, contents: string): void {
    let stats: fs.Stats | undefined;
    try {
        // statSync follows the whole chain, including magic /proc links.
        stats = fs.statSync(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }

    // FIFOs, sockets and character devices (`-o /dev/stdout`) have no
    // persistent inode to protect, and a temp+rename beside them fails.
    // Directories deliberately stay on the temp+rename path so they keep
    // failing loudly.
    if (stats && !stats.isFile() && !stats.isDirectory()) {
        fs.writeFileSync(filePath, contents);
        return;
    }

    const target = stats ? fs.realpathSync(filePath) : resolveCreationPath(filePath);
    const tempPath = path.join(
        path.dirname(target),
        `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
    );

    writeViaTempFileSync(target, tempPath, contents);
}

/**
 * Write `contents` to `tempPath` at 0600 and rename it over `target`.
 *
 * Exported so tests can stage a collision at a known temp path; production
 * callers go through writeSecretFileSync, which randomizes that path.
 */
export function writeViaTempFileSync(target: string, tempPath: string, contents: string): void {
    let created = false;

    try {
        // 'wx' refuses to follow or clobber an existing (or planted) temp path.
        fs.writeFileSync(tempPath, contents, { flag: 'wx', mode: 0o600 });
        created = true;
        fs.renameSync(tempPath, target);
    } catch (error) {
        // Only our own temp file may be removed: a failed 'wx' means the path
        // holds someone else's file, which is not ours to delete.
        if (created) {
            try {
                fs.unlinkSync(tempPath);
            } catch {
                // Nothing to clean up.
            }
        }
        throw error;
    }
}

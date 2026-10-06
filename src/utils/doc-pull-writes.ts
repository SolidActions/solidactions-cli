import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * doc pull's write path (cli#168, cli#188, cli#182; spec §1, PM ruling 12). The pull stops at the first error and
 * records exactly what it wrote: each file is written to a sibling temp file (opened O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW)
 * and renamed into place, after the target is re-checked against the state the preflight saw; the caller then writes the
 * manifest once. A rename replaces the directory entry, so a hard link's other names keep their bytes and a link at the
 * final name is replaced, not followed. The pull never deletes, moves or restores anything it did not create in this run
 * (its own temp file, and its own lock file, are the only things it removes here), so there is nothing to roll back.
 * One O_EXCL lock file in the destination root keeps two pulls apart. Node has no openat: a directory component swapped
 * for a link, or a final component changed between its check and its rename, is a documented residual race in the
 * user's own folder (spec §1.6). No power-loss durability is claimed.
 */
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NEW_FILE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW;

/** The name prefix of writeFileAtomic's temp files; reserved with the manifest and its lock (spec §1.3 Names). */
const TEMP_PREFIX = '.sa-write-';

/** The lock file's name beside a manifest. */
export const lockNameFor = (manifestName: string): string => `${manifestName}.lock`;

/**
 * The key two names are compared by: composed (NFC) and lower-cased, so spellings one filesystem or
 * another treats as one entry get one key (spec §1.3, cli#168).
 */
export const nameKey = (name: string): string => name.normalize('NFC').toLowerCase().normalize('NFC');

/** A name doc pull keeps for itself at every level: the manifest, its lock, and the temp-file prefix (spec §1.3). */
export function isReservedName(name: string, manifestName: string): boolean {
    const key = nameKey(name);
    return key === nameKey(manifestName) || key === nameKey(lockNameFor(manifestName)) || key.startsWith(nameKey(TEMP_PREFIX));
}

export class LinkOnTheWayError extends Error {
    constructor(public readonly component: string) {
        super(`${component} is a symbolic link or not a directory`);
        this.name = 'LinkOnTheWayError';
    }
}

export class PublicationRefusedError extends Error {
    constructor(public readonly relPath: string) {
        super(`${relPath} changed after doc pull checked it`);
        this.name = 'PublicationRefusedError';
    }
}

export class WriteStepError extends Error {
    constructor(public readonly relPath: string, public readonly cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = 'WriteStepError';
    }
}

/** Ruling 9: a folder (or any entry that is neither a file nor a link) at a target is never moved or deleted. */
export class UnsupportedTargetError extends Error {
    constructor(public readonly relPath: string) {
        super(`${relPath} is a folder now`);
        this.name = 'UnsupportedTargetError';
    }
}

/** The lock file is already there: another pull may be writing to the destination, or a killed one left it (spec §1.4). */
export class LockHeldError extends Error {
    constructor(public readonly lockName: string) {
        super(`${lockName} exists`);
        this.name = 'LockHeldError';
    }
}

export type Authorized = { kind: 'absent' } | { kind: 'sha256'; sha256: string } | { kind: 'any' };

export interface PlannedWrite {
    relPath: string;
    dirRel: string;
    data: string | Buffer;
    authorized: Authorized;
}

/** Why the write loop stopped: the write it was on, and the error (a typed refusal, or a WriteStepError wrapping the cause). */
export interface WriteStop {
    write: PlannedWrite;
    error: unknown;
}

export interface Faults {
    beforeManifestTemp(): void;
    beforeManifestRename(): void;
    afterChecks(destination: string): void;
    beforeWrites(destination: string): void;
    afterWrites(destination: string): void;
    beforeRename(n: number): void;
    afterRename(n: number): void;
}

const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');
const segments = (rel: string): string[] => rel.split('/');

function ioFault(what: string): Error {
    return Object.assign(new Error(`EIO: i/o error, ${what} (test hook)`), { code: 'EIO' });
}

/**
 * Test-only injected failures (spec §1.8, sanctioned by PM ruling 7). Inert unless
 * SOLIDACTIONS_TEST_HOOKS=1. Never documented for users.
 */
export function faultsFromEnv(env: NodeJS.ProcessEnv = process.env): Faults {
    const none: Faults = {
        beforeManifestTemp: () => undefined,
        beforeManifestRename: () => undefined,
        afterChecks: () => undefined,
        beforeWrites: () => undefined,
        afterWrites: () => undefined,
        beforeRename: () => undefined,
        afterRename: () => undefined,
    };
    if (env.SOLIDACTIONS_TEST_HOOKS !== '1') return none;
    const faults: Faults = { ...none };
    // A comma-separated list combines faults, e.g. "fail-rename:2,create-before-commit:a.md".
    for (const spec of (env.SOLIDACTIONS_DOC_PULL_TEST_FAULT ?? '').split(',')) {
        const [name, arg = ''] = spec.split(/:(.*)/s);
        switch (name) {
            case 'fail-rename':
                faults.beforeRename = (n) => { if (n === Number(arg)) throw ioFault('rename'); };
                break;
            case 'fail-manifest-temp':
                faults.beforeManifestTemp = () => { throw ioFault('open manifest temp'); };
                break;
            case 'fail-manifest-rename':
                faults.beforeManifestRename = () => { throw ioFault('rename manifest'); };
                break;
            case 'kill-after-renames':
                faults.afterRename = (n) => { if (n === Number(arg)) process.kill(process.pid, 'SIGKILL'); };
                break;
            case 'create-after-checks':
                faults.afterChecks = (destination) => {
                    const abs = path.join(destination, ...segments(arg));
                    fs.mkdirSync(path.dirname(abs), { recursive: true });
                    fs.writeFileSync(abs, 'RACE');
                };
                break;
            case 'create-before-commit':
                faults.beforeWrites = (destination) => fs.writeFileSync(path.join(destination, ...segments(arg)), 'RACE');
                break;
            case 'mkdir-before-commit':
                faults.beforeWrites = (destination) => {
                    const dir = path.join(destination, ...segments(arg));
                    fs.mkdirSync(dir);
                    fs.writeFileSync(path.join(dir, 'user.txt'), 'USER');
                };
                break;
            case 'change-after-writes':
                faults.afterWrites = (destination) => fs.writeFileSync(path.join(destination, ...segments(arg)), 'CHANGED');
                break;
            case 'link-before-commit': {
                const [linkRel, linkTarget] = arg.split('>');
                faults.beforeWrites = (destination) => fs.symlinkSync(linkTarget, path.join(destination, ...segments(linkRel)));
                break;
            }
            default:
                break;
        }
    }
    return faults;
}

function lstatOrNull(abs: string): fs.Stats | null {
    try {
        return fs.lstatSync(abs);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

function stillAuthorized(targetAbs: string, authorized: Authorized): boolean {
    if (authorized.kind === 'any') return true;
    const stat = lstatOrNull(targetAbs);
    if (authorized.kind === 'absent') return stat === null;
    return stat !== null && stat.isFile() && sha256(fs.readFileSync(targetAbs)) === authorized.sha256;
}

/** Every folder of `dirRel` under `destination`, created where missing; a link or a file on the way refuses (cli#182). Returns the folder's path. */
export function ensureRealDirs(destination: string, dirRel: string): string {
    const parts = dirRel === '' ? [] : segments(dirRel);
    let current = destination;
    for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i]);
        let stat = lstatOrNull(current);
        if (stat === null) {
            fs.mkdirSync(current);
            stat = fs.lstatSync(current);
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new LinkOnTheWayError(parts.slice(0, i + 1).join('/'));
        }
    }
    return current;
}

function writeNew(abs: string, data: string | Buffer): void {
    const fd = fs.openSync(abs, NEW_FILE_FLAGS, 0o666);
    try {
        fs.writeFileSync(fd, data);
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Write every planned file in order, stopping at the first one that cannot be written or whose target is no longer in the
 * state the preflight saw (spec §1.3). Nothing is deleted or restored: the files written before the stop stay, and are
 * returned so the caller can record them.
 */
export function writeAll(destination: string, writes: PlannedWrite[], faults: Faults): { placed: PlannedWrite[]; stop: WriteStop | null } {
    faults.beforeWrites(destination);
    const placed: PlannedWrite[] = [];
    for (let i = 0; i < writes.length; i++) {
        const write = writes[i];
        const targetAbs = path.join(destination, ...segments(write.relPath));
        try {
            const dirAbs = ensureRealDirs(destination, write.dirRel);
            writeFileAtomic(dirAbs, path.basename(targetAbs), write.data, () => {
                const existing = lstatOrNull(targetAbs);
                if (existing !== null && !existing.isFile() && !existing.isSymbolicLink()) throw new UnsupportedTargetError(write.relPath);
                if (!stillAuthorized(targetAbs, write.authorized)) throw new PublicationRefusedError(write.relPath);
                faults.beforeRename(i + 1);
            });
        } catch (error) {
            const typed = error instanceof LinkOnTheWayError || error instanceof PublicationRefusedError || error instanceof UnsupportedTargetError;
            return { placed, stop: { write, error: typed ? error : new WriteStepError(write.relPath, error) } };
        }
        placed.push(write);
        faults.afterRename(i + 1);
    }
    return { placed, stop: null };
}

/**
 * Create the destination's lock file, holding this pid (spec §1.4). Any existing entry of that name refuses, a link or a
 * folder included; the file is never removed or liveness-tested except by the pull that created it (releaseLock).
 */
export function acquireLock(destination: string, manifestName: string): void {
    const lockName = lockNameFor(manifestName);
    const lockAbs = path.join(destination, lockName);
    let fd: number;
    try {
        fd = fs.openSync(lockAbs, NEW_FILE_FLAGS, 0o666);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new LockHeldError(lockName);
        throw error;
    }
    try {
        fs.writeFileSync(fd, `${process.pid}\n`);
    } catch (error) {
        fs.closeSync(fd);
        fs.unlinkSync(lockAbs); // the file this call just created
        throw error;
    }
    fs.closeSync(fd);
}

/** Remove the lock this process created: only a regular file still holding this pid, so a lock someone else made is never touched. */
export function releaseLock(destination: string, manifestName: string): void {
    const lockAbs = path.join(destination, lockNameFor(manifestName));
    try {
        if (lstatOrNull(lockAbs)?.isFile() === true && fs.readFileSync(lockAbs, 'utf8') === `${process.pid}\n`) fs.unlinkSync(lockAbs);
    } catch {
        // already gone, or not ours to inspect
    }
}

/**
 * Write `dir/name` through a sibling temp file and a rename: never half-written, never through a link at `name`.
 * `beforeRename` runs after the temp file exists and just before the rename; if it throws, the temp file is removed.
 */
export function writeFileAtomic(dir: string, name: string, data: string | Buffer, beforeRename?: () => void): void {
    const tempAbs = path.join(dir, `${TEMP_PREFIX}${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
    writeNew(tempAbs, data);
    try {
        beforeRename?.();
        const existing = lstatOrNull(path.join(dir, name));
        if (existing !== null && existing.isFile()) fs.chmodSync(tempAbs, existing.mode & 0o7777);
        fs.renameSync(tempAbs, path.join(dir, name));
    } catch (error) {
        try {
            fs.unlinkSync(tempAbs);
        } catch {
            // already gone
        }
        throw error;
    }
}

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * doc pull's commit (cli#168, cli#188, cli#182; spec §1, PM ruling 7). Every file is
 * staged in <destination>/.solidactions-pull-<pid>/, then renamed into place after its
 * target is re-checked against the state the preflight authorized; whatever it replaces
 * is kept as a backup in the staging folder, and the manifest is published last. Any
 * in-process failure restores the backups. A killed pull leaves the old manifest and its
 * staging folder, which the next pull cleans up (cleanupLeftovers). A rename replaces the
 * directory entry, so a hard link's other names keep their bytes and a link at the final
 * name is replaced, not followed. Node has no openat: a directory component swapped for a
 * link between the walk and the rename is a documented residual race (spec §1.6). No
 * power-loss durability is claimed.
 */
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NEW_FILE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW;

export const STAGING_PREFIX = '.solidactions-pull-';
const STAGING_PATTERN = /^\.solidactions-pull-(\d+)$/;

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

export class AnotherPullRunningError extends Error {
    constructor(public readonly pid: number) {
        super(`another doc pull (pid ${pid}) is running`);
        this.name = 'AnotherPullRunningError';
    }
}

export class ForeignStagingEntryError extends Error {
    constructor(public readonly entryName: string) {
        super(`${entryName} is not a folder doc pull created`);
        this.name = 'ForeignStagingEntryError';
    }
}

export class LeftoverDiffersError extends Error {
    constructor(public readonly folderName: string, public readonly differing: string[]) {
        super(`${differing.length} file(s) differ from their saved copies in ${folderName}`);
        this.name = 'LeftoverDiffersError';
    }
}

/** Ruling 9: a folder (or any entry that is neither a file nor a link) at a target is never moved or deleted. */
export class UnsupportedTargetError extends Error {
    constructor(public readonly relPath: string) {
        super(`${relPath} is a folder now`);
        this.name = 'UnsupportedTargetError';
    }
}

export type Authorized = { kind: 'absent' } | { kind: 'sha256'; sha256: string } | { kind: 'any' };

export interface PlannedWrite {
    relPath: string;
    dirRel: string;
    data: string | Buffer;
    authorized: Authorized;
}

export interface CommitItem extends PlannedWrite {
    newAbs: string;
    targetAbs: string;
    backupAbs: string | null;
    placed: boolean;
}

export interface Commit {
    destination: string;
    stagingAbs: string;
    manifestName: string;
    items: CommitItem[];
    createdDirs: string[];
}

export interface Faults {
    failManifestTemp: boolean;
    failManifestRename: boolean;
    beforeCommit(destination: string): void;
    beforeRename(n: number): void;
    afterRename(n: number): void;
    beforeRollback(destination: string): void;
    beforeRestore(n: number): void;
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
        failManifestTemp: false,
        failManifestRename: false,
        beforeCommit: () => undefined,
        beforeRename: () => undefined,
        afterRename: () => undefined,
        beforeRollback: () => undefined,
        beforeRestore: () => undefined,
    };
    if (env.SOLIDACTIONS_TEST_HOOKS !== '1') return none;
    const faults: Faults = { ...none };
    // A comma-separated list combines faults, e.g. "fail-rename:2,fail-restore:1".
    for (const spec of (env.SOLIDACTIONS_DOC_PULL_TEST_FAULT ?? '').split(',')) {
        const [name, arg = ''] = spec.split(/:(.*)/s);
        switch (name) {
            case 'fail-rename':
                faults.beforeRename = (n) => { if (n === Number(arg)) throw ioFault('rename'); };
                break;
            case 'fail-manifest-temp':
                faults.failManifestTemp = true;
                break;
            case 'fail-manifest-rename':
                faults.failManifestRename = true;
                break;
            case 'fail-restore':
                faults.beforeRestore = (n) => { if (n === Number(arg)) throw ioFault('restore'); };
                break;
            case 'kill-after-renames':
                faults.afterRename = (n) => { if (n === Number(arg)) process.kill(process.pid, 'SIGKILL'); };
                break;
            case 'create-before-commit':
                faults.beforeCommit = (destination) => fs.writeFileSync(path.join(destination, ...segments(arg)), 'RACE');
                break;
            case 'mkdir-before-commit':
                faults.beforeCommit = (destination) => {
                    const dir = path.join(destination, ...segments(arg));
                    fs.mkdirSync(dir);
                    fs.writeFileSync(path.join(dir, 'user.txt'), 'USER');
                };
                break;
            case 'swap-before-rollback': {
                const [dirRel, outside] = arg.split('>');
                faults.beforeRollback = (destination) => {
                    const dir = path.join(destination, ...segments(dirRel));
                    fs.renameSync(dir, `${dir}.swapped`);
                    fs.symlinkSync(outside, dir);
                };
                break;
            }
            case 'link-before-commit': {
                const [linkRel, linkTarget] = arg.split('>');
                faults.beforeCommit = (destination) => fs.symlinkSync(linkTarget, path.join(destination, ...segments(linkRel)));
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

/** The state the preflight authorizes for a target (spec §1.3 step 2). */
export function authorizedStateOf(targetAbs: string, overwrite: boolean): Authorized {
    if (overwrite) return { kind: 'any' };
    const stat = lstatOrNull(targetAbs);
    if (stat === null) return { kind: 'absent' };
    if (!stat.isFile()) return { kind: 'absent' }; // never matches: a non-file target is refused at commit
    return { kind: 'sha256', sha256: sha256(fs.readFileSync(targetAbs)) };
}

function stillAuthorized(targetAbs: string, authorized: Authorized): boolean {
    if (authorized.kind === 'any') return true;
    const stat = lstatOrNull(targetAbs);
    if (authorized.kind === 'absent') return stat === null;
    return stat !== null && stat.isFile() && sha256(fs.readFileSync(targetAbs)) === authorized.sha256;
}

export function ensureRealDirs(destination: string, dirRel: string, createdDirs: string[] | null): string {
    const parts = dirRel === '' ? [] : segments(dirRel);
    let current = destination;
    for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i]);
        let stat = lstatOrNull(current);
        if (stat === null) {
            if (createdDirs === null) throw Object.assign(new Error(`ENOENT: no such directory, ${current}`), { code: 'ENOENT' });
            fs.mkdirSync(current);
            createdDirs.push(current);
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

export function stageAll(destination: string, manifestName: string, writes: PlannedWrite[], manifestBytes: string, faults: Faults): Commit {
    const stagingName = `${STAGING_PREFIX}${process.pid}`;
    const stagingAbs = path.join(destination, stagingName);
    let createdStaging = false;
    try {
        fs.mkdirSync(stagingAbs, { mode: 0o700 });
        createdStaging = true;
        fs.mkdirSync(path.join(stagingAbs, 'new'));
    } catch (error) {
        // Only the folder this call created: a pre-existing entry at the name is never removed.
        if (createdStaging) fs.rmSync(stagingAbs, { recursive: true, force: true });
        throw new WriteStepError(stagingName, error);
    }
    const commit: Commit = { destination, stagingAbs, manifestName, items: [], createdDirs: [] };
    try {
        writes.forEach((write, index) => {
            const newAbs = path.join(stagingAbs, 'new', String(index));
            try {
                ensureRealDirs(destination, `${stagingName}/new`, null);
                writeNew(newAbs, write.data);
            } catch (error) {
                throw new WriteStepError(write.relPath, error);
            }
            commit.items.push({ ...write, newAbs, targetAbs: path.join(destination, ...segments(write.relPath)), backupAbs: null, placed: false });
        });
        try {
            if (faults.failManifestTemp) throw ioFault('open manifest.tmp');
            ensureRealDirs(destination, stagingName, null);
            writeNew(path.join(stagingAbs, 'manifest.tmp'), manifestBytes);
        } catch (error) {
            throw new WriteStepError(manifestName, error);
        }
    } catch (error) {
        fs.rmSync(stagingAbs, { recursive: true, force: true });
        throw error;
    }
    return commit;
}

export function commitAll(commit: Commit, faults: Faults): void {
    faults.beforeCommit(commit.destination);
    const stagingName = path.basename(commit.stagingAbs);
    for (let i = 0; i < commit.items.length; i++) {
        const item = commit.items[i];
        try {
            ensureRealDirs(commit.destination, item.dirRel, commit.createdDirs);
        } catch (error) {
            if (error instanceof LinkOnTheWayError) throw error;
            throw new WriteStepError(item.relPath, error);
        }
        const existing = lstatOrNull(item.targetAbs);
        if (existing !== null && !existing.isFile() && !existing.isSymbolicLink()) throw new UnsupportedTargetError(item.relPath);
        if (!stillAuthorized(item.targetAbs, item.authorized)) throw new PublicationRefusedError(item.relPath);
        try {
            // Ruling 8: the staging side is anchored at the destination too, so a link planted at the
            // staging folder, new/ or backup/ never redirects a move.
            ensureRealDirs(commit.destination, `${stagingName}/new`, null);
            if (existing !== null) {
                // Backed up at commit time, so a target created late under --overwrite is restorable too.
                const backupAbs = path.join(commit.stagingAbs, 'backup', ...segments(item.relPath));
                ensureRealDirs(commit.destination, `${stagingName}/backup${item.dirRel === '' ? '' : `/${item.dirRel}`}`, []);
                if (existing.isFile()) fs.chmodSync(item.newAbs, existing.mode & 0o7777);
                fs.renameSync(item.targetAbs, backupAbs);
                item.backupAbs = backupAbs;
            }
            faults.beforeRename(i + 1);
            fs.renameSync(item.newAbs, item.targetAbs);
            item.placed = true;
        } catch (error) {
            throw new WriteStepError(item.relPath, error);
        }
        faults.afterRename(i + 1);
    }
    try {
        if (faults.failManifestRename) throw ioFault('rename manifest');
        ensureRealDirs(commit.destination, stagingName, null);
        fs.renameSync(path.join(commit.stagingAbs, 'manifest.tmp'), path.join(commit.destination, commit.manifestName));
    } catch (error) {
        throw new WriteStepError(commit.manifestName, error);
    }
}

export function rollbackAll(commit: Commit, faults: Faults): { restoreFailure: { relPath: string; error: unknown } | null } {
    faults.beforeRollback(commit.destination);
    const stagingName = path.basename(commit.stagingAbs);
    let restoreFailure: { relPath: string; error: unknown } | null = null;
    let restoring = 0;
    for (const item of [...commit.items].reverse()) {
        if (item.backupAbs === null && !item.placed) continue;
        try {
            // Ruling 8: the same parent checks as the forward path, on both ends.
            ensureRealDirs(commit.destination, item.dirRel, null);
            if (item.backupAbs !== null) {
                ensureRealDirs(commit.destination, `${stagingName}/backup${item.dirRel === '' ? '' : `/${item.dirRel}`}`, null);
                restoring += 1;
                faults.beforeRestore(restoring);
                fs.renameSync(item.backupAbs, item.targetAbs); // the original inode, links included
                item.backupAbs = null;
            } else {
                fs.unlinkSync(item.targetAbs); // this pull's new file
            }
            item.placed = false;
        } catch (error) {
            restoreFailure ??= { relPath: item.relPath, error };
        }
    }
    for (const dir of [...commit.createdDirs].reverse()) {
        try {
            ensureRealDirs(commit.destination, path.relative(commit.destination, dir).split(path.sep).join('/'), null);
            fs.rmdirSync(dir);
        } catch {
            // not empty, gone, or no longer a real folder of ours: keep it
        }
    }
    if (restoreFailure === null) fs.rmSync(commit.stagingAbs, { recursive: true, force: true });
    return { restoreFailure };
}

export function finalizeCommit(commit: Commit): { error: unknown } | null {
    try {
        const stat = lstatOrNull(commit.stagingAbs);
        if (stat !== null && (stat.isSymbolicLink() || !stat.isDirectory())) throw new LinkOnTheWayError(path.basename(commit.stagingAbs));
        fs.rmSync(commit.stagingAbs, { recursive: true, force: false });
        return null;
    } catch (error) {
        return { error };
    }
}

function pidRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/** Every leaf (file or link) under `root`, as '/'-joined paths; never follows a link. */
function walkLeaves(root: string, prefix = ''): string[] {
    const stat = lstatOrNull(root);
    if (stat === null) return [];
    const out: string[] = [];
    for (const name of fs.readdirSync(root)) {
        const abs = path.join(root, name);
        const rel = prefix === '' ? name : `${prefix}/${name}`;
        const entry = fs.lstatSync(abs);
        if (entry.isDirectory() && !entry.isSymbolicLink()) out.push(...walkLeaves(abs, rel));
        else out.push(rel);
    }
    return out;
}

function sameEntry(aAbs: string, bAbs: string): boolean {
    const a = fs.lstatSync(aAbs);
    const b = fs.lstatSync(bAbs);
    if (a.isSymbolicLink() && b.isSymbolicLink()) return fs.readlinkSync(aAbs) === fs.readlinkSync(bAbs);
    if (a.isFile() && b.isFile()) return fs.readFileSync(aAbs).equals(fs.readFileSync(bAbs));
    return false;
}

/** Clean up after a killed pull (spec §1.4). Idempotent: a second run finds nothing to do. */
export function cleanupLeftovers(destination: string): { restored: string[]; cleaned: number } {
    const restored: string[] = [];
    let cleaned = 0;
    for (const name of fs.readdirSync(destination)) {
        const match = STAGING_PATTERN.exec(name);
        if (match === null) continue;
        const folderAbs = path.join(destination, name);
        const stat = fs.lstatSync(folderAbs);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ForeignStagingEntryError(name);
        const pid = Number(match[1]);
        if (pid !== process.pid && pidRunning(pid)) throw new AnotherPullRunningError(pid);

        const backupRoot = path.join(folderAbs, 'backup');
        const rootStat = lstatOrNull(backupRoot);
        if (rootStat !== null && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) throw new ForeignStagingEntryError(`${name}/backup`);
        const differing: string[] = [];
        for (const rel of walkLeaves(backupRoot)) {
            const slash = rel.lastIndexOf('/');
            const parentRel = slash === -1 ? '' : rel.slice(0, slash);
            // Ruling 8: the same parent checks as the forward path, on both ends.
            ensureRealDirs(backupRoot, parentRel, null);
            ensureRealDirs(destination, parentRel, []);
            const backupAbs = path.join(backupRoot, ...segments(rel));
            const targetAbs = path.join(destination, ...segments(rel));
            if (lstatOrNull(targetAbs) === null) {
                fs.renameSync(backupAbs, targetAbs);
                restored.push(rel);
            } else if (sameEntry(backupAbs, targetAbs)) {
                fs.unlinkSync(backupAbs);
            } else {
                differing.push(rel);
            }
        }
        if (differing.length > 0) throw new LeftoverDiffersError(name, differing);
        fs.rmSync(folderAbs, { recursive: true, force: true });
        cleaned += 1;
    }
    return { restored, cleaned };
}

/** Write `dir/name` through a sibling temp file and a rename: never half-written, never through a link at `name`. */
export function writeFileAtomic(dir: string, name: string, data: string | Buffer): void {
    const tempAbs = path.join(dir, `.sa-write-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
    writeNew(tempAbs, data);
    try {
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

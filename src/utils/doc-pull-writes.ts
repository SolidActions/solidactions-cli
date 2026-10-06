import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * doc pull's commit (cli#168, cli#188, cli#182; spec §1). A pull first claims its staging folder,
 * <destination>/.solidactions-pull-<pid>/, and refuses if another live pull's folder (or anything that is not
 * a folder doc pull created) is there. Every file is then staged in it, and renamed into place after its target
 * is re-checked against the state the preflight saw; whatever it replaces is kept as a backup in the staging
 * folder, and the manifest is published last. Any in-process failure restores the backups, but only where the
 * entry at the target is still the one this pull placed (or still vacant). A killed pull leaves the old manifest
 * and its staging folder, which the next pull cleans up (cleanupLeftovers). A rename replaces the directory
 * entry, so a hard link's other names keep their bytes and a link at the final name is replaced, not followed.
 * Node has no openat: a directory component swapped for a link, or a final component changed between its check
 * and its rename, is a documented residual race in the user's own folder (spec §1.6). No power-loss durability
 * is claimed.
 */
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NEW_FILE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW;

export const STAGING_PREFIX = '.solidactions-pull-';
const STAGING_PATTERN = /^\.solidactions-pull-(\d+)$/;

/** What a staging folder holds at its top level (spec §1.4): anything else is not a folder doc pull created. */
const STAGING_LAYOUT: Record<string, 'folder' | 'file'> = { new: 'folder', backup: 'folder', 'manifest.tmp': 'file' };

/**
 * The key two names are compared by: composed (NFC) and lower-cased, so spellings one filesystem or
 * another treats as one entry get one key (spec §1.3, cli#168).
 */
export const nameKey = (name: string): string => name.normalize('NFC').toLowerCase().normalize('NFC');

/** A name doc pull keeps for itself at every level: the manifest and anything in the staging namespace (spec §1.3). */
export function isReservedName(name: string, manifestName: string): boolean {
    const key = nameKey(name);
    return key === nameKey(manifestName) || key.startsWith(nameKey(STAGING_PREFIX));
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

export class AnotherPullRunningError extends Error {
    constructor(public readonly pid: number, public readonly folderName: string) {
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

/** The destination's own listing failed while looking for leftovers: the only failure that reads "cannot read" (spec §1.4). */
export class DestinationUnreadableError extends Error {
    constructor(cause: Error) {
        super(cause.message);
        this.name = 'DestinationUnreadableError';
    }
}

/** A rollback step found the target no longer holds what this pull left there: both sides stay as they are (spec §1.5). */
export class ChangedSincePlacedError extends Error {
    constructor(relPath: string, placed: boolean) {
        super(placed ? `${relPath} was replaced after doc pull wrote it` : `${relPath} was created after doc pull moved the previous copy aside`);
        this.name = 'ChangedSincePlacedError';
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
    /** dev:ino of the staged file as it was renamed in; rollback only touches a target that still has it (spec §1.5). */
    placedIdentity: string | null;
}

/** The staging folder this pull created first, before it looks at anything else in the destination (spec §1.3 step 1). */
export interface StagingClaim {
    name: string;
    abs: string;
}

/** What rollback could not undo: a backup it could not put back, a new file it could not remove, or a folder it could not remove. */
export interface RestoreFailure {
    relPath: string;
    error: unknown;
    kind: 'restore' | 'remove-file' | 'remove-folder';
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
    afterChecks(destination: string): void;
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
        afterChecks: () => undefined,
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
            case 'create-after-checks':
                faults.afterChecks = (destination) => {
                    const abs = path.join(destination, ...segments(arg));
                    fs.mkdirSync(path.dirname(abs), { recursive: true });
                    fs.writeFileSync(abs, 'RACE');
                };
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
            case 'replace-before-rollback':
                faults.beforeRollback = (destination) => {
                    const abs = path.join(destination, ...segments(arg));
                    if (lstatOrNull(abs) !== null) fs.renameSync(abs, `${abs}.aside`); // keeps the old inode alive, so the new file cannot reuse it
                    fs.writeFileSync(abs, 'LATER');
                };
                break;
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

/** dev:ino as exact text (a bigint stat does not round large inode numbers). */
const identityOf = (stat: fs.BigIntStats): string => `${stat.dev}:${stat.ino}`;

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

/**
 * Create this pull's staging folder, the first thing a pull does in the destination (spec §1.3 step 1).
 * Returns null when something already has that name (a leftover of an earlier process that had this pid, or
 * an entry that is not ours); the caller classifies it with the other leftovers.
 */
export function claimStaging(destination: string): StagingClaim | null {
    const name = `${STAGING_PREFIX}${process.pid}`;
    const abs = path.join(destination, name);
    try {
        fs.mkdirSync(abs, { mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
        throw error;
    }
    return { name, abs };
}

/** Remove a claimed staging folder that nothing was staged in. Only ever the folder this pull created. */
export function releaseStaging(claim: StagingClaim): void {
    removeStagingFolder(claim.abs);
}

export function stageAll(destination: string, manifestName: string, writes: PlannedWrite[], manifestBytes: string, faults: Faults, claimed?: StagingClaim): Commit {
    const stagingName = claimed?.name ?? `${STAGING_PREFIX}${process.pid}`;
    const stagingAbs = path.join(destination, stagingName);
    let createdStaging = claimed !== undefined;
    try {
        if (claimed === undefined) {
            fs.mkdirSync(stagingAbs, { mode: 0o700 });
            createdStaging = true;
        }
        fs.mkdirSync(path.join(stagingAbs, 'new'));
    } catch (error) {
        // Only the folder this call created or claimed: a pre-existing entry at the name is never removed.
        if (createdStaging) removeStagingFolder(stagingAbs);
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
            commit.items.push({ ...write, newAbs, targetAbs: path.join(destination, ...segments(write.relPath)), backupAbs: null, placed: false, placedIdentity: null });
        });
        try {
            if (faults.failManifestTemp) throw ioFault('open manifest.tmp');
            ensureRealDirs(destination, stagingName, null);
            writeNew(path.join(stagingAbs, 'manifest.tmp'), manifestBytes);
        } catch (error) {
            throw new WriteStepError(manifestName, error);
        }
    } catch (error) {
        removeStagingFolder(stagingAbs);
        throw error;
    }
    return commit;
}

/** Remove the staging folder only while it is still a real folder, as finalizeCommit does: a link now at its name is left alone. */
function removeStagingFolder(stagingAbs: string): void {
    const stat = lstatOrNull(stagingAbs);
    if (stat !== null && stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(stagingAbs, { recursive: true, force: true });
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
            item.placedIdentity = identityOf(fs.lstatSync(item.newAbs, { bigint: true }));
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

export function rollbackAll(commit: Commit, faults: Faults): { restoreFailure: RestoreFailure | null } {
    faults.beforeRollback(commit.destination);
    const stagingName = path.basename(commit.stagingAbs);
    let restoreFailure: RestoreFailure | null = null;
    let restoring = 0;
    for (const item of [...commit.items].reverse()) {
        if (item.backupAbs === null && !item.placed) continue;
        try {
            // Ruling 8: the same parent checks as the forward path, on both ends.
            ensureRealDirs(commit.destination, item.dirRel, null);
            // PM ruling 11: only undo what this pull left. A placed file must still be the inode that was renamed in;
            // a file moved aside and not placed leaves the target vacant. Anything else is someone's later work.
            const current = fs.lstatSync(item.targetAbs, { bigint: true, throwIfNoEntry: false });
            const ours = item.placed ? current !== undefined && identityOf(current) === item.placedIdentity : current === undefined;
            if (!ours) throw new ChangedSincePlacedError(item.relPath, item.placed);
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
            restoreFailure ??= { relPath: item.relPath, error, kind: item.backupAbs !== null ? 'restore' : 'remove-file' };
        }
    }
    for (const dir of [...commit.createdDirs].reverse()) {
        const rel = path.relative(commit.destination, dir).split(path.sep).join('/');
        try {
            ensureRealDirs(commit.destination, rel, null);
            fs.rmdirSync(dir);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // already gone
            restoreFailure ??= { relPath: rel, error, kind: 'remove-folder' };
        }
    }
    if (restoreFailure === null) removeStagingFolder(commit.stagingAbs);
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
    if (!Number.isInteger(pid) || pid < 1) return false; // pid 0 would signal this process's own group: never "running"
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

/** A leftover must hold only doc pull's own layout (spec §1.4); anything else, or a link in its place, is not ours to delete. */
function requireOwnLayout(name: string, folderAbs: string): void {
    for (const entry of fs.readdirSync(folderAbs)) {
        const expected = STAGING_LAYOUT[entry];
        if (expected === undefined) throw new ForeignStagingEntryError(name);
        const stat = fs.lstatSync(path.join(folderAbs, entry));
        const isExpected = expected === 'folder' ? stat.isDirectory() : stat.isFile();
        if (stat.isSymbolicLink() || !isExpected) throw new ForeignStagingEntryError(`${name}/${entry}`);
    }
}

/**
 * Look at every `.solidactions-pull-<digits>` entry in the destination root, changing nothing, and return the
 * names of the ones a killed pull left behind (spec §1.4). Throws for the first entry that is a live pull's
 * folder or not a folder doc pull created, so nothing is restored or removed while a live writer exists.
 * `ownName` is this pull's own claimed folder, which is skipped.
 */
export function classifyLeftovers(destination: string, ownName: string | null): string[] {
    let names: string[];
    try {
        names = fs.readdirSync(destination);
    } catch (error) {
        throw new DestinationUnreadableError(error as Error);
    }
    const dead: string[] = [];
    for (const name of names.sort()) {
        const match = STAGING_PATTERN.exec(name);
        if (match === null || name === ownName) continue;
        const folderAbs = path.join(destination, name);
        try {
            const stat = fs.lstatSync(folderAbs);
            if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ForeignStagingEntryError(name);
            requireOwnLayout(name, folderAbs);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // removed while we looked
            throw error;
        }
        const pid = Number(match[1]);
        if (pid !== process.pid && pidRunning(pid)) throw new AnotherPullRunningError(pid, name);
        dead.push(name);
    }
    return dead;
}

/** Clean up after a killed pull (spec §1.4). Idempotent: a second run finds nothing to do. */
export function cleanupLeftovers(destination: string, ownName: string | null = null): { restored: string[]; cleaned: number } {
    const restored: string[] = [];
    let cleaned = 0;
    for (const name of classifyLeftovers(destination, ownName)) {
        const folderAbs = path.join(destination, name);
        const backupRoot = path.join(folderAbs, 'backup');
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

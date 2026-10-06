/**
 * The staging-folder commit module behind `doc pull` (cli#168, cli#188, cli#182; spec §1).
 *
 * Every case works directly on real temp directories: files are staged, committed, rolled back
 * and cleaned up with the real module and the real filesystem. Failures are injected through the
 * module's own test-only switch (`SOLIDACTIONS_TEST_HOOKS=1` plus `SOLIDACTIONS_DOC_PULL_TEST_FAULT`),
 * handed in as an env object, never by replacing any module or filesystem call.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    AnotherPullRunningError,
    authorizedStateOf,
    type Authorized,
    cleanupLeftovers,
    commitAll,
    ensureRealDirs,
    faultsFromEnv,
    finalizeCommit,
    ForeignStagingEntryError,
    LeftoverDiffersError,
    LinkOnTheWayError,
    type PlannedWrite,
    PublicationRefusedError,
    rollbackAll,
    STAGING_PREFIX,
    stageAll,
    UnsupportedTargetError,
    WriteStepError,
    writeFileAtomic,
} from '../src/utils/doc-pull-writes';

const M = '.solidactions-docs.json';
const MANIFEST_BYTES = '{"v":2}\n';
const none = faultsFromEnv({});
const hooks = (fault: string) => faultsFromEnv({ SOLIDACTIONS_TEST_HOOKS: '1', SOLIDACTIONS_DOC_PULL_TEST_FAULT: fault });

let root: string;
let dest: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-pull-writes-'));
    dest = path.join(root, 'dest');
    fs.mkdirSync(dest);
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

function w(rel: string, data: string | Buffer, authorized: Authorized): PlannedWrite {
    const slash = rel.lastIndexOf('/');
    return { relPath: rel, dirRel: slash === -1 ? '' : rel.slice(0, slash), data, authorized };
}

function put(abs: string, data: string): void {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
}

function read(...parts: string[]): string {
    return fs.readFileSync(path.join(...parts), 'utf8');
}

function go(writes: PlannedWrite[], faults = none) {
    const commit = stageAll(dest, M, writes, MANIFEST_BYTES, faults);
    commitAll(commit, faults);
    return finalizeCommit(commit);
}

function stagingFolders(): string[] {
    return fs
        .readdirSync(dest, { recursive: true })
        .map(String)
        .filter((entry) => path.basename(entry).startsWith(STAGING_PREFIX));
}

function captureError(fn: () => void): unknown {
    try {
        fn();
    } catch (error) {
        return error;
    }
    return null;
}

/** A pid nothing is running as, so a hand-made staging folder looks like a killed pull's. */
function deadPid(): number {
    for (let pid = 900000; pid < 1000000; pid++) {
        try {
            process.kill(pid, 0);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid;
        }
    }
    throw new Error('no free pid found');
}

describe('stageAll + commitAll + finalizeCommit', () => {
    it('writes every target and the manifest, creates missing folders, and leaves no staging folder behind', () => {
        const result = go([w('a.md', 'AAA', { kind: 'absent' }), w('x/y/b.md', 'BBB', { kind: 'absent' })]);

        expect(result).toBeNull();
        expect(read(dest, 'a.md')).toBe('AAA');
        expect(read(dest, 'x', 'y', 'b.md')).toBe('BBB');
        expect(read(dest, M)).toBe(MANIFEST_BYTES);
        expect(stagingFolders()).toEqual([]);
    });

    it('stages every file and the manifest inside the staging folder without touching any target', () => {
        const writes = [w('a.md', 'AAA', { kind: 'absent' }), w('x/b.md', 'BBB', { kind: 'absent' })];

        const commit = stageAll(dest, M, writes, MANIFEST_BYTES, none);

        const staging = path.join(dest, `${STAGING_PREFIX}${process.pid}`);
        expect(commit.stagingAbs).toBe(staging);
        expect(read(staging, 'new', '0')).toBe('AAA');
        expect(read(staging, 'new', '1')).toBe('BBB');
        expect(read(staging, 'manifest.tmp')).toBe(MANIFEST_BYTES);
        expect(fs.existsSync(path.join(dest, 'a.md'))).toBe(false);
        expect(fs.existsSync(path.join(dest, 'x'))).toBe(false);
        expect(fs.existsSync(path.join(dest, M))).toBe(false);
    });

    it('replaces a tracked file whose bytes still match the authorized checksum', () => {
        put(path.join(dest, 'a.md'), 'OLD');
        const authorized = authorizedStateOf(path.join(dest, 'a.md'), false);
        expect(authorized.kind).toBe('sha256');

        const result = go([w('a.md', 'NEW', authorized)]);

        expect(result).toBeNull();
        expect(read(dest, 'a.md')).toBe('NEW');
    });

    it('refuses to walk through a symbolic link on the way to a target folder and creates nothing behind it', () => {
        const outside = path.join(root, 'outside');
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(dest, 'x'));

        const error = captureError(() => ensureRealDirs(dest, 'x/y', []));

        expect(error).toBeInstanceOf(LinkOnTheWayError);
        expect((error as LinkOnTheWayError).component).toBe('x');
        expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('refuses a file that appeared after the check (absent authorization), and rollback leaves the late file and removes the staging folder', () => {
        const commit = stageAll(dest, M, [w('n.md', 'STAGED', { kind: 'absent' })], MANIFEST_BYTES, none);
        fs.writeFileSync(path.join(dest, 'n.md'), 'LATE');

        const error = captureError(() => commitAll(commit, none));
        const rollback = rollbackAll(commit, none);

        expect(error).toBeInstanceOf(PublicationRefusedError);
        expect((error as PublicationRefusedError).relPath).toBe('n.md');
        expect(rollback.restoreFailure).toBeNull();
        expect(read(dest, 'n.md')).toBe('LATE');
        expect(stagingFolders()).toEqual([]);
    });

    it('replaces a late file when the write is authorized as any (overwrite), keeping the late file as a backup until the commit ends', () => {
        const commit = stageAll(dest, M, [w('n.md', 'STAGED', { kind: 'any' })], MANIFEST_BYTES, none);
        fs.writeFileSync(path.join(dest, 'n.md'), 'LATE');

        commitAll(commit, none);

        expect(read(dest, 'n.md')).toBe('STAGED');
        expect(read(commit.stagingAbs, 'backup', 'n.md')).toBe('LATE');
        expect(finalizeCommit(commit)).toBeNull();
    });

    it('restores a late file to its late bytes when a later rename fails after an overwrite replaced it', () => {
        const faults = hooks('fail-rename:2');
        const commit = stageAll(dest, M, [w('n.md', 'STAGED', { kind: 'any' }), w('m.md', 'MMM', { kind: 'absent' })], MANIFEST_BYTES, faults);
        fs.writeFileSync(path.join(dest, 'n.md'), 'LATE');

        const error = captureError(() => commitAll(commit, faults));
        const rollback = rollbackAll(commit, faults);

        expect(error).toBeInstanceOf(WriteStepError);
        expect((error as WriteStepError).relPath).toBe('m.md');
        expect(rollback.restoreFailure).toBeNull();
        expect(read(dest, 'n.md')).toBe('LATE');
        expect(fs.existsSync(path.join(dest, 'm.md'))).toBe(false);
        expect(stagingFolders()).toEqual([]);
    });

    it('refuses a symbolic link that appeared after the check (absent authorization) and never touches the file it points at', () => {
        fs.writeFileSync(path.join(root, 'outside.txt'), 'OUTSIDE');
        const commit = stageAll(dest, M, [w('n.md', 'STAGED', { kind: 'absent' })], MANIFEST_BYTES, none);
        fs.symlinkSync(path.join(root, 'outside.txt'), path.join(dest, 'n.md'));

        const error = captureError(() => commitAll(commit, none));
        const rollback = rollbackAll(commit, none);

        expect(error).toBeInstanceOf(PublicationRefusedError);
        expect(rollback.restoreFailure).toBeNull();
        expect(fs.lstatSync(path.join(dest, 'n.md')).isSymbolicLink()).toBe(true);
        expect(read(root, 'outside.txt')).toBe('OUTSIDE');
    });

    it('replaces a late symbolic link with a regular file under overwrite, without writing through the link', () => {
        fs.writeFileSync(path.join(root, 'outside.txt'), 'OUTSIDE');
        const commit = stageAll(dest, M, [w('n.md', 'STAGED', { kind: 'any' })], MANIFEST_BYTES, none);
        fs.symlinkSync(path.join(root, 'outside.txt'), path.join(dest, 'n.md'));

        commitAll(commit, none);
        finalizeCommit(commit);

        expect(fs.lstatSync(path.join(dest, 'n.md')).isFile()).toBe(true);
        expect(read(dest, 'n.md')).toBe('STAGED');
        expect(read(root, 'outside.txt')).toBe('OUTSIDE');
    });

    it('replaces a hard-linked tracked file by a new inode, so the other names of the old inode keep their bytes (cli#188)', () => {
        put(path.join(dest, 'a.md'), 'OLD');
        fs.linkSync(path.join(dest, 'a.md'), path.join(root, 'other.txt'));
        const authorized = authorizedStateOf(path.join(dest, 'a.md'), false);

        go([w('a.md', 'NEW', authorized)]);

        expect(read(dest, 'a.md')).toBe('NEW');
        expect(read(root, 'other.txt')).toBe('OLD');
    });

    it('rolls back to the original inodes when a later rename fails, leaving the manifest untouched and no staging folder', () => {
        put(path.join(dest, 'a.md'), 'A1');
        put(path.join(dest, 'sub', 'b.md'), 'B1');
        put(path.join(dest, M), 'OLD-MANIFEST');
        fs.linkSync(path.join(dest, 'a.md'), path.join(root, 'other.txt'));
        const faults = hooks('fail-rename:2');
        const writes = [
            w('a.md', 'A2', authorizedStateOf(path.join(dest, 'a.md'), false)),
            w('sub/b.md', 'B2', authorizedStateOf(path.join(dest, 'sub', 'b.md'), false)),
        ];
        const commit = stageAll(dest, M, writes, MANIFEST_BYTES, faults);

        const error = captureError(() => commitAll(commit, faults));
        const rollback = rollbackAll(commit, faults);

        expect(error).toBeInstanceOf(WriteStepError);
        expect((error as WriteStepError).relPath).toBe('sub/b.md');
        expect(rollback).toEqual({ restoreFailure: null });
        expect(read(dest, 'a.md')).toBe('A1');
        expect(fs.statSync(path.join(dest, 'a.md')).ino).toBe(fs.statSync(path.join(root, 'other.txt')).ino);
        expect(read(dest, 'sub', 'b.md')).toBe('B1');
        expect(read(dest, M)).toBe('OLD-MANIFEST');
        expect(stagingFolders()).toEqual([]);
    });

    it('fails staging when the manifest temp file cannot be written, removing the staging folder and changing no target', () => {
        put(path.join(dest, 'a.md'), 'A1');
        const faults = hooks('fail-manifest-temp');

        const error = captureError(() => stageAll(dest, M, [w('a.md', 'A2', { kind: 'any' })], MANIFEST_BYTES, faults));

        expect(error).toBeInstanceOf(WriteStepError);
        expect((error as WriteStepError).relPath).toBe(M);
        expect(stagingFolders()).toEqual([]);
        expect(read(dest, 'a.md')).toBe('A1');
        expect(fs.existsSync(path.join(dest, M))).toBe(false);
    });

    it('restores every doc and keeps the old manifest bytes when publishing the manifest fails after all the doc renames', () => {
        put(path.join(dest, 'a.md'), 'A1');
        put(path.join(dest, 'sub', 'b.md'), 'B1');
        put(path.join(dest, M), 'OLD-MANIFEST');
        const faults = hooks('fail-manifest-rename');
        const writes = [
            w('a.md', 'A2', authorizedStateOf(path.join(dest, 'a.md'), false)),
            w('sub/b.md', 'B2', authorizedStateOf(path.join(dest, 'sub', 'b.md'), false)),
            w('c.md', 'C2', { kind: 'absent' }),
        ];
        const commit = stageAll(dest, M, writes, MANIFEST_BYTES, faults);

        const error = captureError(() => commitAll(commit, faults));
        expect(read(dest, 'a.md')).toBe('A2');
        const rollback = rollbackAll(commit, faults);

        expect(error).toBeInstanceOf(WriteStepError);
        expect((error as WriteStepError).relPath).toBe(M);
        expect(rollback.restoreFailure).toBeNull();
        expect(read(dest, 'a.md')).toBe('A1');
        expect(read(dest, 'sub', 'b.md')).toBe('B1');
        expect(fs.existsSync(path.join(dest, 'c.md'))).toBe(false);
        expect(read(dest, M)).toBe('OLD-MANIFEST');
        expect(stagingFolders()).toEqual([]);
    });

    it('keeps the staging folder, with the backup it could not restore, when a restore fails; the next cleanup restores it', () => {
        put(path.join(dest, 'a.md'), 'A1');
        put(path.join(dest, 'sub', 'b.md'), 'B1');
        const faults = hooks('fail-rename:2,fail-restore:1');
        const writes = [
            w('a.md', 'A2', authorizedStateOf(path.join(dest, 'a.md'), false)),
            w('sub/b.md', 'B2', authorizedStateOf(path.join(dest, 'sub', 'b.md'), false)),
        ];
        const commit = stageAll(dest, M, writes, MANIFEST_BYTES, faults);

        const error = captureError(() => commitAll(commit, faults));
        const rollback = rollbackAll(commit, faults);

        expect(error).toBeInstanceOf(WriteStepError);
        expect(rollback.restoreFailure?.relPath).toBe('sub/b.md');
        expect(read(dest, 'a.md')).toBe('A1');
        expect(fs.existsSync(path.join(dest, 'sub', 'b.md'))).toBe(false);
        expect(read(commit.stagingAbs, 'backup', 'sub', 'b.md')).toBe('B1');

        const cleanup = cleanupLeftovers(dest);

        expect(cleanup).toEqual({ restored: ['sub/b.md'], cleaned: 1 });
        expect(read(dest, 'sub', 'b.md')).toBe('B1');
        expect(stagingFolders()).toEqual([]);
    });

    it('keeps the permission bits of a replaced target', () => {
        put(path.join(dest, 'a.md'), 'OLD');
        fs.chmodSync(path.join(dest, 'a.md'), 0o600);

        go([w('a.md', 'NEW', authorizedStateOf(path.join(dest, 'a.md'), false))]);

        expect(read(dest, 'a.md')).toBe('NEW');
        expect(fs.statSync(path.join(dest, 'a.md')).mode & 0o7777).toBe(0o600);
    });

    it('ignores the injected faults unless SOLIDACTIONS_TEST_HOOKS is 1', () => {
        const faults = faultsFromEnv({ SOLIDACTIONS_DOC_PULL_TEST_FAULT: 'fail-rename:1' });

        const result = go([w('a.md', 'AAA', { kind: 'absent' })], faults);

        expect(result).toBeNull();
        expect(read(dest, 'a.md')).toBe('AAA');
    });
});

describe('a folder at a target is never moved or deleted (PM ruling 9)', () => {
    it('refuses a folder that appeared at an overwrite target, keeps its contents, and rolls back a write committed before it', () => {
        const faults = hooks('mkdir-before-commit:n.md');
        const commit = stageAll(dest, M, [w('first.md', 'FIRST', { kind: 'absent' }), w('n.md', 'STAGED', { kind: 'any' })], MANIFEST_BYTES, faults);

        const error = captureError(() => commitAll(commit, faults));
        const rollback = rollbackAll(commit, faults);

        expect(error).toBeInstanceOf(UnsupportedTargetError);
        expect((error as UnsupportedTargetError).relPath).toBe('n.md');
        expect(rollback.restoreFailure).toBeNull();
        expect(read(dest, 'n.md', 'user.txt')).toBe('USER');
        expect(fs.existsSync(path.join(dest, 'first.md'))).toBe(false);
        expect(stagingFolders()).toEqual([]);
    });

    it('checks the target type before the authorization, so an absent-authorized target that became a folder is also unsupported', () => {
        const faults = hooks('mkdir-before-commit:n.md');
        const commit = stageAll(dest, M, [w('n.md', 'STAGED', { kind: 'absent' })], MANIFEST_BYTES, faults);

        const error = captureError(() => commitAll(commit, faults));
        const rollback = rollbackAll(commit, faults);

        expect(error).toBeInstanceOf(UnsupportedTargetError);
        expect(rollback.restoreFailure).toBeNull();
        expect(read(dest, 'n.md', 'user.txt')).toBe('USER');
        expect(stagingFolders()).toEqual([]);
    });
});

describe('rollback re-checks every parent folder (PM ruling 8)', () => {
    it('never restores through a parent that was swapped for a link, reports it, and keeps the staging folder with the backup', () => {
        put(path.join(dest, 'a.md'), 'A1');
        put(path.join(dest, 'sub', 'b.md'), 'B1');
        put(path.join(root, 'outside', 'b.md'), 'OUTSIDE');
        const faults = hooks(`fail-manifest-rename,swap-before-rollback:sub>${path.join(root, 'outside')}`);
        const writes = [
            w('a.md', 'A2', authorizedStateOf(path.join(dest, 'a.md'), false)),
            w('sub/b.md', 'B2', authorizedStateOf(path.join(dest, 'sub', 'b.md'), false)),
        ];
        const commit = stageAll(dest, M, writes, MANIFEST_BYTES, faults);

        const error = captureError(() => commitAll(commit, faults));
        const rollback = rollbackAll(commit, faults);

        expect(error).toBeInstanceOf(WriteStepError);
        expect(read(root, 'outside', 'b.md')).toBe('OUTSIDE');
        expect(fs.readdirSync(path.join(root, 'outside'))).toEqual(['b.md']);
        expect(read(dest, 'a.md')).toBe('A1');
        expect(rollback.restoreFailure?.relPath).toBe('sub/b.md');
        expect(rollback.restoreFailure?.error).toBeInstanceOf(LinkOnTheWayError);
        expect(read(commit.stagingAbs, 'backup', 'sub', 'b.md')).toBe('B1');
    });

    it('never removes or adds anything in the folder a created directory was swapped for', () => {
        fs.mkdirSync(path.join(root, 'outside-empty'));
        const faults = hooks(`fail-manifest-rename,swap-before-rollback:x>${path.join(root, 'outside-empty')}`);
        const commit = stageAll(dest, M, [w('x/c.md', 'CCC', { kind: 'absent' })], MANIFEST_BYTES, faults);

        const error = captureError(() => commitAll(commit, faults));
        rollbackAll(commit, faults);

        expect(error).toBeInstanceOf(WriteStepError);
        expect(fs.existsSync(path.join(root, 'outside-empty'))).toBe(true);
        expect(fs.readdirSync(path.join(root, 'outside-empty'))).toEqual([]);
    });
});

describe('the staging folder is checked from the destination on every forward and reverse step (cli#168, ruling 8)', () => {
    it('refuses to back up through a link planted at <staging>/backup, so nothing lands outside and the target keeps its bytes', () => {
        put(path.join(dest, 'a.md'), 'A1');
        put(path.join(dest, 'b.md'), 'B1');
        put(path.join(root, 'outside', 'a.md'), 'OUTSIDE');
        const writes = [
            w('a.md', 'A2', authorizedStateOf(path.join(dest, 'a.md'), false)),
            w('b.md', 'B2', authorizedStateOf(path.join(dest, 'b.md'), false)),
        ];
        const commit = stageAll(dest, M, writes, MANIFEST_BYTES, none);
        fs.symlinkSync(path.join(root, 'outside'), path.join(commit.stagingAbs, 'backup'));

        const error = captureError(() => commitAll(commit, none));
        const rollback = rollbackAll(commit, none);

        expect(error).toBeInstanceOf(WriteStepError);
        expect((error as WriteStepError).relPath).toBe('a.md');
        expect(((error as WriteStepError).cause as Error).name).toBe('LinkOnTheWayError');
        expect(rollback.restoreFailure).toBeNull();
        expect(fs.readdirSync(path.join(root, 'outside'))).toEqual(['a.md']);
        expect(read(root, 'outside', 'a.md')).toBe('OUTSIDE');
        expect(read(dest, 'a.md')).toBe('A1');
        expect(read(dest, 'b.md')).toBe('B1');
        expect(fs.existsSync(path.join(dest, M))).toBe(false);
    });

    it('never restores out of a link that replaced the staging folder, reports the failed restore, and moves nothing in the linked folder', () => {
        put(path.join(dest, 'a.md'), 'A1');
        put(path.join(root, 'outside', 'backup', 'a.md'), 'OUTSIDE');
        const faults = hooks('fail-manifest-rename');
        const commit = stageAll(dest, M, [w('a.md', 'A2', authorizedStateOf(path.join(dest, 'a.md'), false))], MANIFEST_BYTES, faults);
        const error = captureError(() => commitAll(commit, faults));
        fs.renameSync(commit.stagingAbs, `${commit.stagingAbs}.aside`);
        fs.symlinkSync(path.join(root, 'outside'), commit.stagingAbs);

        const rollback = rollbackAll(commit, faults);

        expect(error).toBeInstanceOf(WriteStepError);
        expect(rollback.restoreFailure?.relPath).toBe('a.md');
        expect(rollback.restoreFailure?.error).toBeInstanceOf(LinkOnTheWayError);
        expect(fs.readdirSync(path.join(root, 'outside'))).toEqual(['backup']);
        expect(read(root, 'outside', 'backup', 'a.md')).toBe('OUTSIDE');
        expect(read(`${commit.stagingAbs}.aside`, 'backup', 'a.md')).toBe('A1');
        expect(read(dest, 'a.md')).toBe('A2');
    });

    it('refuses to publish a doc from a link planted at <staging>/new, and moves nothing out of the linked folder', () => {
        put(path.join(dest, 'a.md'), 'A1');
        put(path.join(root, 'outside', '0'), 'OUTSIDE');
        const commit = stageAll(dest, M, [w('a.md', 'A2', authorizedStateOf(path.join(dest, 'a.md'), false))], MANIFEST_BYTES, none);
        fs.renameSync(path.join(commit.stagingAbs, 'new'), path.join(commit.stagingAbs, 'new.aside'));
        fs.symlinkSync(path.join(root, 'outside'), path.join(commit.stagingAbs, 'new'));

        const error = captureError(() => commitAll(commit, none));
        const rollback = rollbackAll(commit, none);

        expect(error).toBeInstanceOf(WriteStepError);
        expect((error as WriteStepError).relPath).toBe('a.md');
        expect(rollback.restoreFailure).toBeNull();
        expect(fs.readdirSync(path.join(root, 'outside'))).toEqual(['0']);
        expect(read(root, 'outside', '0')).toBe('OUTSIDE');
        expect(read(dest, 'a.md')).toBe('A1');
        expect(fs.existsSync(path.join(commit.stagingAbs, 'backup'))).toBe(false);
    });

    it('refuses to publish the manifest from a link that replaced the staging folder, and moves nothing out of the linked folder', () => {
        put(path.join(root, 'outside', 'manifest.tmp'), 'OUTSIDE');
        const commit = stageAll(dest, M, [], MANIFEST_BYTES, none);
        fs.renameSync(commit.stagingAbs, `${commit.stagingAbs}.aside`);
        fs.symlinkSync(path.join(root, 'outside'), commit.stagingAbs);

        const error = captureError(() => commitAll(commit, none));

        expect(error).toBeInstanceOf(WriteStepError);
        expect((error as WriteStepError).relPath).toBe(M);
        expect(fs.readdirSync(path.join(root, 'outside'))).toEqual(['manifest.tmp']);
        expect(fs.existsSync(path.join(dest, M))).toBe(false);
    });

    it('does not remove the staging path when it is no longer a real folder at finalize, and returns it as the error', () => {
        put(path.join(root, 'outside', 'keep.txt'), 'KEEP');
        const commit = stageAll(dest, M, [w('a.md', 'AAA', { kind: 'absent' })], MANIFEST_BYTES, none);
        commitAll(commit, none);
        fs.rmSync(commit.stagingAbs, { recursive: true });
        fs.symlinkSync(path.join(root, 'outside'), commit.stagingAbs);

        const result = finalizeCommit(commit);

        expect(result?.error).toBeInstanceOf(LinkOnTheWayError);
        expect(fs.lstatSync(commit.stagingAbs).isSymbolicLink()).toBe(true);
        expect(read(root, 'outside', 'keep.txt')).toBe('KEEP');
    });

    it('fails staging without removing a pre-existing entry at the staging name', () => {
        const staging = path.join(dest, `${STAGING_PREFIX}${process.pid}`);
        put(path.join(staging, 'keep.txt'), 'KEEP');

        const error = captureError(() => stageAll(dest, M, [w('a.md', 'AAA', { kind: 'absent' })], MANIFEST_BYTES, none));

        expect(error).toBeInstanceOf(WriteStepError);
        expect(read(staging, 'keep.txt')).toBe('KEEP');
        expect(fs.existsSync(path.join(dest, 'a.md'))).toBe(false);
    });
});

describe('cleanupLeftovers', () => {
    it('does nothing when there is no staging folder', () => {
        put(path.join(dest, 'a.md'), 'A1');

        expect(cleanupLeftovers(dest)).toEqual({ restored: [], cleaned: 0 });
        expect(read(dest, 'a.md')).toBe('A1');
    });

    it('restores a backup whose target is absent, removes the folder, and is safe to run twice', () => {
        const folder = path.join(dest, `${STAGING_PREFIX}${deadPid()}`);
        put(path.join(folder, 'backup', 'sub', 'b.md'), 'B1');

        const first = cleanupLeftovers(dest);
        const second = cleanupLeftovers(dest);

        expect(first).toEqual({ restored: ['sub/b.md'], cleaned: 1 });
        expect(second).toEqual({ restored: [], cleaned: 0 });
        expect(read(dest, 'sub', 'b.md')).toBe('B1');
        expect(fs.existsSync(folder)).toBe(false);
    });

    it('drops a backup whose target already holds identical bytes and removes the folder', () => {
        const folder = path.join(dest, `${STAGING_PREFIX}${deadPid()}`);
        put(path.join(folder, 'backup', 'a.md'), 'SAME');
        put(path.join(dest, 'a.md'), 'SAME');

        const result = cleanupLeftovers(dest);

        expect(result).toEqual({ restored: [], cleaned: 1 });
        expect(read(dest, 'a.md')).toBe('SAME');
        expect(fs.existsSync(folder)).toBe(false);
    });

    it('throws when a backup differs from its target, and changes neither the folder nor either file', () => {
        const folder = path.join(dest, `${STAGING_PREFIX}${deadPid()}`);
        put(path.join(folder, 'backup', 'a.md'), 'SAVED');
        put(path.join(dest, 'a.md'), 'EDITED');

        const error = captureError(() => cleanupLeftovers(dest));

        expect(error).toBeInstanceOf(LeftoverDiffersError);
        expect((error as LeftoverDiffersError).differing).toEqual(['a.md']);
        expect(read(folder, 'backup', 'a.md')).toBe('SAVED');
        expect(read(dest, 'a.md')).toBe('EDITED');
    });

    it('throws when the staging folder belongs to a pull that is still running', () => {
        const child = childProcess.spawn('sleep', ['5'], { stdio: 'ignore' });
        try {
            const pid = child.pid as number;
            fs.mkdirSync(path.join(dest, `${STAGING_PREFIX}${pid}`));

            const error = captureError(() => cleanupLeftovers(dest));

            expect(error).toBeInstanceOf(AnotherPullRunningError);
            expect((error as AnotherPullRunningError).pid).toBe(pid);
        } finally {
            child.kill('SIGKILL');
        }
    });

    it('throws when a staging-folder name is a symbolic link', () => {
        fs.mkdirSync(path.join(root, 'elsewhere'));
        fs.symlinkSync(path.join(root, 'elsewhere'), path.join(dest, `${STAGING_PREFIX}1`));

        const error = captureError(() => cleanupLeftovers(dest));

        expect(error).toBeInstanceOf(ForeignStagingEntryError);
        expect((error as ForeignStagingEntryError).entryName).toBe(`${STAGING_PREFIX}1`);
        expect(fs.readdirSync(path.join(root, 'elsewhere'))).toEqual([]);
    });

    it('throws and writes nothing outside when the target folder of a backup is now a symbolic link', () => {
        const folder = path.join(dest, `${STAGING_PREFIX}${deadPid()}`);
        put(path.join(folder, 'backup', 'sub', 'b.md'), 'B1');
        fs.mkdirSync(path.join(root, 'outside'));
        fs.symlinkSync(path.join(root, 'outside'), path.join(dest, 'sub'));

        const error = captureError(() => cleanupLeftovers(dest));

        expect(error).toBeInstanceOf(LinkOnTheWayError);
        expect(fs.readdirSync(path.join(root, 'outside'))).toEqual([]);
        expect(read(folder, 'backup', 'sub', 'b.md')).toBe('B1');
    });

    it('throws ForeignStagingEntryError and leaves the linked folder alone when the backup root is a symbolic link', () => {
        const folder = path.join(dest, `${STAGING_PREFIX}${deadPid()}`);
        fs.mkdirSync(folder);
        put(path.join(root, 'outside', 'a.md'), 'OUTSIDE');
        fs.symlinkSync(path.join(root, 'outside'), path.join(folder, 'backup'));

        const error = captureError(() => cleanupLeftovers(dest));

        expect(error).toBeInstanceOf(ForeignStagingEntryError);
        expect(read(root, 'outside', 'a.md')).toBe('OUTSIDE');
        expect(fs.readdirSync(path.join(root, 'outside'))).toEqual(['a.md']);
    });

    it('treats a backup subfolder that is a symbolic link as one leaf, never walking into it', () => {
        const folder = path.join(dest, `${STAGING_PREFIX}${deadPid()}`);
        fs.mkdirSync(path.join(folder, 'backup'), { recursive: true });
        put(path.join(root, 'outside', 'a.md'), 'OUTSIDE');
        fs.symlinkSync(path.join(root, 'outside'), path.join(folder, 'backup', 'sub'));
        put(path.join(dest, 'sub', 'real.md'), 'REAL');

        const error = captureError(() => cleanupLeftovers(dest));

        expect(error).toBeInstanceOf(LeftoverDiffersError);
        expect((error as LeftoverDiffersError).differing).toEqual(['sub']);
        expect(fs.readdirSync(path.join(root, 'outside'))).toEqual(['a.md']);
        expect(read(root, 'outside', 'a.md')).toBe('OUTSIDE');
        expect(read(dest, 'sub', 'real.md')).toBe('REAL');
    });
});

describe('writeFileAtomic', () => {
    it('writes a new file with the given bytes and leaves no temp file behind', () => {
        writeFileAtomic(dest, 'f.txt', 'HELLO');

        expect(read(dest, 'f.txt')).toBe('HELLO');
        expect(fs.readdirSync(dest)).toEqual(['f.txt']);
    });

    it('replaces a symbolic link at its name with a regular file, without following the link', () => {
        fs.writeFileSync(path.join(root, 'outside.txt'), 'OUTSIDE');
        fs.symlinkSync(path.join(root, 'outside.txt'), path.join(dest, 'f.txt'));

        writeFileAtomic(dest, 'f.txt', 'HELLO');

        expect(fs.lstatSync(path.join(dest, 'f.txt')).isFile()).toBe(true);
        expect(read(dest, 'f.txt')).toBe('HELLO');
        expect(read(root, 'outside.txt')).toBe('OUTSIDE');
    });
});

/**
 * The write module behind `doc pull` (cli#168, cli#188, cli#182; spec §1, PM ruling 12): the ordered write loop that
 * stops at the first error, the atomic file write, the directory walk, the destination lock and the reserved names.
 *
 * Every case works directly on real temp directories with the real module and the real filesystem. Failures are
 * injected through the module's own test-only switch (`SOLIDACTIONS_TEST_HOOKS=1` plus
 * `SOLIDACTIONS_DOC_PULL_TEST_FAULT`), handed in as an env object, never by replacing any module or filesystem call.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    acquireLock,
    type Authorized,
    ensureRealDirs,
    faultsFromEnv,
    isReservedName,
    LinkOnTheWayError,
    LockHeldError,
    lockNameFor,
    nameKey,
    type PlannedWrite,
    PublicationRefusedError,
    releaseLock,
    UnsupportedTargetError,
    WriteStepError,
    writeAll,
    writeFileAtomic,
} from '../src/utils/doc-pull-writes';

const M = '.solidactions-docs.json';
const LOCK = '.solidactions-docs.json.lock';
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

/** The state a check that read `targetAbs` right now would have recorded (what doc pull's preflight hands the write loop). */
function authorizedStateOf(targetAbs: string, overwrite: boolean): Authorized {
    if (overwrite) return { kind: 'any' };
    if (!fs.existsSync(targetAbs)) return { kind: 'absent' };
    return { kind: 'sha256', sha256: crypto.createHash('sha256').update(fs.readFileSync(targetAbs)).digest('hex') };
}

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

/** Every entry under `dir` (dot-entries included), '/'-joined and sorted. */
function listing(dir: string): string[] {
    return fs.readdirSync(dir, { recursive: true }).map((entry) => String(entry).split(path.sep).join('/')).sort();
}

describe('writeAll', () => {
    it('writes every target in order, creates missing folders, and leaves nothing but the targets behind', () => {
        const result = writeAll(dest, [w('a.md', 'AAA', { kind: 'absent' }), w('x/y/b.md', 'BBB', { kind: 'absent' })], none);

        expect(result.stop).toBeNull();
        expect(result.placed.map((write) => write.relPath)).toEqual(['a.md', 'x/y/b.md']);
        expect(read(dest, 'a.md')).toBe('AAA');
        expect(read(dest, 'x', 'y', 'b.md')).toBe('BBB');
        expect(listing(dest)).toEqual(['a.md', 'x', 'x/y', 'x/y/b.md']);
    });

    it('replaces a tracked file whose bytes still match the authorized checksum', () => {
        put(path.join(dest, 'a.md'), 'OLD');
        const authorized = authorizedStateOf(path.join(dest, 'a.md'), false);
        expect(authorized.kind).toBe('sha256');

        const result = writeAll(dest, [w('a.md', 'NEW', authorized)], none);

        expect(result.stop).toBeNull();
        expect(read(dest, 'a.md')).toBe('NEW');
    });

    it('stops at the first failing write: the files before it stay written, it and the later ones are not, and no temp file is left', () => {
        put(path.join(dest, 'b.md'), 'B1');
        put(path.join(dest, 'c.md'), 'C1');
        const writes = [
            w('a.md', 'A2', { kind: 'absent' }),
            w('b.md', 'B2', authorizedStateOf(path.join(dest, 'b.md'), false)),
            w('c.md', 'C2', authorizedStateOf(path.join(dest, 'c.md'), false)),
        ];

        const result = writeAll(dest, writes, hooks('fail-rename:2'));

        expect(result.placed.map((write) => write.relPath)).toEqual(['a.md']);
        expect(result.stop?.write.relPath).toBe('b.md');
        expect(result.stop?.error).toBeInstanceOf(WriteStepError);
        expect((result.stop?.error as WriteStepError).relPath).toBe('b.md');
        expect((result.stop?.error as Error).message).toMatch(/EIO: i\/o error, rename \(test hook\)/);
        expect(read(dest, 'a.md')).toBe('A2');
        expect(read(dest, 'b.md')).toBe('B1');
        expect(read(dest, 'c.md')).toBe('C1');
        expect(listing(dest)).toEqual(['a.md', 'b.md', 'c.md']);
    });

    it('refuses a file that appeared after the check (absent authorization), keeps the late file, and writes nothing after it', () => {
        const faults = hooks('create-before-commit:n.md');

        const result = writeAll(dest, [w('n.md', 'NEW', { kind: 'absent' }), w('m.md', 'MMM', { kind: 'absent' })], faults);

        expect(result.placed).toEqual([]);
        expect(result.stop?.error).toBeInstanceOf(PublicationRefusedError);
        expect((result.stop?.error as PublicationRefusedError).relPath).toBe('n.md');
        expect(read(dest, 'n.md')).toBe('RACE');
        expect(listing(dest)).toEqual(['n.md']);
    });

    it('refuses a tracked file whose bytes changed after the check, keeps the change, and does not touch the files before it', () => {
        put(path.join(dest, 'b.md'), 'B1');
        const authorized = authorizedStateOf(path.join(dest, 'b.md'), false);
        fs.writeFileSync(path.join(dest, 'b.md'), 'EDITED LATER');

        const result = writeAll(dest, [w('a.md', 'A2', { kind: 'absent' }), w('b.md', 'B2', authorized)], none);

        expect(result.placed.map((write) => write.relPath)).toEqual(['a.md']);
        expect(result.stop?.error).toBeInstanceOf(PublicationRefusedError);
        expect(read(dest, 'b.md')).toBe('EDITED LATER');
        expect(read(dest, 'a.md')).toBe('A2');
    });

    it('replaces a late file when the write is authorized as any (overwrite)', () => {
        const faults = hooks('create-before-commit:n.md');

        const result = writeAll(dest, [w('n.md', 'NEW', { kind: 'any' })], faults);

        expect(result.stop).toBeNull();
        expect(read(dest, 'n.md')).toBe('NEW');
        expect(listing(dest)).toEqual(['n.md']);
    });

    it('refuses a symbolic link that appeared after the check (absent authorization) and never touches the file it points at', () => {
        fs.writeFileSync(path.join(root, 'outside.txt'), 'OUTSIDE');
        const faults = hooks(`link-before-commit:n.md>${path.join(root, 'outside.txt')}`);

        const result = writeAll(dest, [w('n.md', 'NEW', { kind: 'absent' })], faults);

        expect(result.stop?.error).toBeInstanceOf(PublicationRefusedError);
        expect(fs.lstatSync(path.join(dest, 'n.md')).isSymbolicLink()).toBe(true);
        expect(read(root, 'outside.txt')).toBe('OUTSIDE');
    });

    it('replaces a late symbolic link with a regular file under overwrite, without writing through the link', () => {
        fs.writeFileSync(path.join(root, 'outside.txt'), 'OUTSIDE');
        const faults = hooks(`link-before-commit:n.md>${path.join(root, 'outside.txt')}`);

        const result = writeAll(dest, [w('n.md', 'NEW', { kind: 'any' })], faults);

        expect(result.stop).toBeNull();
        expect(fs.lstatSync(path.join(dest, 'n.md')).isFile()).toBe(true);
        expect(read(dest, 'n.md')).toBe('NEW');
        expect(read(root, 'outside.txt')).toBe('OUTSIDE');
    });

    it('replaces a hard-linked tracked file by a new inode, so the other names of the old inode keep their bytes (cli#188)', () => {
        put(path.join(dest, 'a.md'), 'OLD');
        fs.linkSync(path.join(dest, 'a.md'), path.join(root, 'other.txt'));
        const authorized = authorizedStateOf(path.join(dest, 'a.md'), false);
        const oldInode = fs.statSync(path.join(root, 'other.txt')).ino;

        writeAll(dest, [w('a.md', 'NEW', authorized)], none);

        expect(read(dest, 'a.md')).toBe('NEW');
        expect(fs.statSync(path.join(dest, 'a.md')).ino).not.toBe(oldInode);
        expect(read(root, 'other.txt')).toBe('OLD');
        expect(fs.statSync(path.join(root, 'other.txt')).ino).toBe(oldInode);
    });

    it('keeps the permission bits of a replaced target', () => {
        put(path.join(dest, 'a.md'), 'OLD');
        fs.chmodSync(path.join(dest, 'a.md'), 0o600);

        writeAll(dest, [w('a.md', 'NEW', authorizedStateOf(path.join(dest, 'a.md'), false))], none);

        expect(read(dest, 'a.md')).toBe('NEW');
        expect(fs.statSync(path.join(dest, 'a.md')).mode & 0o7777).toBe(0o600);
    });

    it('ignores the injected faults unless SOLIDACTIONS_TEST_HOOKS is 1', () => {
        const faults = faultsFromEnv({ SOLIDACTIONS_DOC_PULL_TEST_FAULT: 'fail-rename:1' });

        const result = writeAll(dest, [w('a.md', 'AAA', { kind: 'absent' })], faults);

        expect(result.stop).toBeNull();
        expect(read(dest, 'a.md')).toBe('AAA');
    });
});

describe('a folder at a target is never moved or deleted (PM ruling 9)', () => {
    it('stops at a folder that appeared at an overwrite target, keeps its contents, and keeps the files written before it', () => {
        const faults = hooks('mkdir-before-commit:n.md');

        const result = writeAll(dest, [w('first.md', 'FIRST', { kind: 'absent' }), w('n.md', 'NEW', { kind: 'any' })], faults);

        expect(result.placed.map((write) => write.relPath)).toEqual(['first.md']);
        expect(result.stop?.error).toBeInstanceOf(UnsupportedTargetError);
        expect((result.stop?.error as UnsupportedTargetError).relPath).toBe('n.md');
        expect(read(dest, 'n.md', 'user.txt')).toBe('USER');
        expect(read(dest, 'first.md')).toBe('FIRST');
        expect(listing(dest)).toEqual(['first.md', 'n.md', 'n.md/user.txt']);
    });

    it('checks the target type before the authorization, so an absent-authorized target that became a folder is also unsupported', () => {
        const faults = hooks('mkdir-before-commit:n.md');

        const result = writeAll(dest, [w('n.md', 'NEW', { kind: 'absent' })], faults);

        expect(result.stop?.error).toBeInstanceOf(UnsupportedTargetError);
        expect(read(dest, 'n.md', 'user.txt')).toBe('USER');
        expect(listing(dest)).toEqual(['n.md', 'n.md/user.txt']);
    });
});

describe('a link on the way to a target (cli#182)', () => {
    it('stops with the link, creates nothing behind it, and writes nothing outside', () => {
        const outside = path.join(root, 'outside');
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(dest, 'x'));

        const result = writeAll(dest, [w('a.md', 'AAA', { kind: 'absent' }), w('x/y/b.md', 'BBB', { kind: 'absent' })], none);

        expect(result.placed.map((write) => write.relPath)).toEqual(['a.md']);
        expect(result.stop?.error).toBeInstanceOf(LinkOnTheWayError);
        expect((result.stop?.error as LinkOnTheWayError).component).toBe('x');
        expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('ensureRealDirs refuses a link on the way and creates nothing behind it', () => {
        const outside = path.join(root, 'outside');
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(dest, 'x'));

        expect(() => ensureRealDirs(dest, 'x/y')).toThrow(LinkOnTheWayError);
        expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('ensureRealDirs refuses a file on the way and names it', () => {
        put(path.join(dest, 'x'), 'A FILE');

        const error = (() => {
            try {
                ensureRealDirs(dest, 'x/y');
            } catch (caught) {
                return caught;
            }
            return null;
        })();

        expect(error).toBeInstanceOf(LinkOnTheWayError);
        expect((error as LinkOnTheWayError).component).toBe('x');
    });

    it('ensureRealDirs creates the missing folders and returns the deepest one', () => {
        const deepest = ensureRealDirs(dest, 'x/y/z');

        expect(deepest).toBe(path.join(dest, 'x', 'y', 'z'));
        expect(fs.statSync(deepest).isDirectory()).toBe(true);
        expect(ensureRealDirs(dest, '')).toBe(dest);
    });
});

describe('nothing the pull did not create is ever deleted (build rule 1)', () => {
    it('leaves user entries named like the old staging folders, and any other entry, alone through a loop that stops on an error', () => {
        put(path.join(dest, '.solidactions-pull-900123', 'backup', 'a.md'), 'MY DOC');
        put(path.join(dest, '.solidactions-pull-7'), 'MY FILE');
        put(path.join(dest, 'keep.md'), 'KEEP');
        const before = listing(dest);

        writeAll(dest, [w('a.md', 'A', { kind: 'absent' }), w('b.md', 'B', { kind: 'absent' })], hooks('fail-rename:2'));

        expect(read(dest, '.solidactions-pull-900123', 'backup', 'a.md')).toBe('MY DOC');
        expect(read(dest, '.solidactions-pull-7')).toBe('MY FILE');
        expect(read(dest, 'keep.md')).toBe('KEEP');
        expect(listing(dest)).toEqual([...before, 'a.md'].sort());
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

    it('removes its temp file and leaves the target as it was when the step before the rename throws', () => {
        put(path.join(dest, 'f.txt'), 'OLD');

        expect(() => writeFileAtomic(dest, 'f.txt', 'NEW', () => { throw new Error('stop'); })).toThrow('stop');

        expect(read(dest, 'f.txt')).toBe('OLD');
        expect(fs.readdirSync(dest)).toEqual(['f.txt']);
    });

    it('runs the step before the rename after the temp file exists, under the reserved temp prefix', () => {
        let seen: string[] = [];

        writeFileAtomic(dest, 'f.txt', 'NEW', () => { seen = fs.readdirSync(dest); });

        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatch(/^\.sa-write-\d+-[0-9a-f]{12}\.tmp$/);
        expect(isReservedName(seen[0], M)).toBe(true);
    });
});

describe('the destination lock (spec §1.4)', () => {
    it('creates the lock file holding this process\'s pid', () => {
        acquireLock(dest, M);

        expect(read(dest, LOCK)).toBe(`${process.pid}\n`);
        expect(lockNameFor(M)).toBe(LOCK);
        expect(fs.readdirSync(dest)).toEqual([LOCK]);
    });

    it('refuses a second acquire with LockHeldError naming the lock, and changes nothing', () => {
        acquireLock(dest, M);

        const error = (() => {
            try {
                acquireLock(dest, M);
            } catch (caught) {
                return caught;
            }
            return null;
        })();

        expect(error).toBeInstanceOf(LockHeldError);
        expect((error as LockHeldError).lockName).toBe(LOCK);
        expect(read(dest, LOCK)).toBe(`${process.pid}\n`);
    });

    it('refuses a lock left by another process, whatever pid it names, and never removes it', () => {
        put(path.join(dest, LOCK), '4194303\n');

        expect(() => acquireLock(dest, M)).toThrow(LockHeldError);
        releaseLock(dest, M);

        expect(read(dest, LOCK)).toBe('4194303\n');
    });

    it('refuses a symbolic link at the lock name and never follows it', () => {
        fs.mkdirSync(path.join(root, 'elsewhere'));
        fs.symlinkSync(path.join(root, 'elsewhere'), path.join(dest, LOCK));

        expect(() => acquireLock(dest, M)).toThrow(LockHeldError);

        expect(fs.readdirSync(path.join(root, 'elsewhere'))).toEqual([]);
        expect(fs.lstatSync(path.join(dest, LOCK)).isSymbolicLink()).toBe(true);
    });

    it('refuses a folder at the lock name', () => {
        fs.mkdirSync(path.join(dest, LOCK));

        expect(() => acquireLock(dest, M)).toThrow(LockHeldError);
    });

    it('reports a destination it cannot create the lock in as the filesystem\'s own error, not as a held lock', () => {
        const error = (() => {
            try {
                acquireLock(path.join(root, 'missing'), M);
            } catch (caught) {
                return caught;
            }
            return null;
        })();

        expect(error).not.toBeInstanceOf(LockHeldError);
        expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
    });

    it('releases the lock it created, and is safe to call again', () => {
        acquireLock(dest, M);

        releaseLock(dest, M);
        releaseLock(dest, M);

        expect(fs.readdirSync(dest)).toEqual([]);
    });

    it('leaves a lock that no longer holds this pid, a link and a folder alone', () => {
        put(path.join(dest, LOCK), 'someone else\n');
        releaseLock(dest, M);
        expect(read(dest, LOCK)).toBe('someone else\n');
        fs.rmSync(path.join(dest, LOCK));

        fs.symlinkSync(path.join(root, 'nowhere'), path.join(dest, LOCK));
        releaseLock(dest, M);
        expect(fs.lstatSync(path.join(dest, LOCK)).isSymbolicLink()).toBe(true);
        fs.rmSync(path.join(dest, LOCK));

        fs.mkdirSync(path.join(dest, LOCK));
        releaseLock(dest, M);
        expect(fs.statSync(path.join(dest, LOCK)).isDirectory()).toBe(true);
    });
});

describe('names doc pull keeps for itself (spec §1.3)', () => {
    it.each([
        ['.solidactions-docs.json', true],
        ['.SOLIDACTIONS-DOCS.JSON', true],
        ['.solidactions-docs.json.lock', true],
        ['.Solidactions-Docs.JSON.LOCK', true],
        ['.sa-write-123-abc.tmp', true],
        ['.SA-WRITE-', true],
        ['_.solidactions-docs.json', false],
        ['.solidactions-docs-2.json', false],
        ['.solidactions-docs.json.lock.md', false],
        ['sa-write-1', false],
        ['.solidactions-pull-123', false],
        ['.solidactions-pull-123.md', false],
    ])('%s is reserved: %s', (name, reserved) => {
        expect(isReservedName(name, M)).toBe(reserved);
    });

    it('compares composed and decomposed spellings, and cases, as one name', () => {
        expect(nameKey('café')).toBe(nameKey('café'));
        expect(nameKey('Page')).toBe(nameKey('page'));
        expect(nameKey('a')).not.toBe(nameKey('b'));
    });
});

describe('the manifest write faults', () => {
    it('throw from the manifest temp and rename steps only when asked, and only with the hooks on', () => {
        expect(() => hooks('fail-manifest-temp').beforeManifestTemp()).toThrow(/open manifest temp \(test hook\)/);
        expect(() => hooks('fail-manifest-rename').beforeManifestRename()).toThrow(/rename manifest \(test hook\)/);
        expect(() => hooks('fail-manifest-rename').beforeManifestTemp()).not.toThrow();
        expect(() => faultsFromEnv({ SOLIDACTIONS_DOC_PULL_TEST_FAULT: 'fail-manifest-temp' }).beforeManifestTemp()).not.toThrow();
    });

    it('rewrites the named file after the writes when asked to', () => {
        put(path.join(dest, 'a.md'), 'WRITTEN');

        hooks('change-after-writes:a.md').afterWrites(dest);

        expect(read(dest, 'a.md')).toBe('CHANGED');
    });

    it('ignores an unknown fault name, and combines faults given as a comma-separated list', () => {
        const faults = hooks('no-such-fault:1,fail-rename:1,fail-manifest-rename');

        expect(() => faults.beforeRename(1)).toThrow(/rename \(test hook\)/);
        expect(() => faults.beforeRename(2)).not.toThrow();
        expect(() => faults.beforeManifestRename()).toThrow();
    });
});

/**
 * Final review 3: rule 5 (spec §1.1) at the moment of each rename, and the identity of every file the loop placed, which
 * the manifest gate compares against what is on disk when it runs.
 */
describe('writeAll: rule 5 at the re-check and the identity of each placed file (final review 3)', () => {
    const identityOf = (abs: string): string => {
        const stat = fs.lstatSync(abs);
        return `${stat.dev}:${stat.ino}`;
    };

    it.each([
        ['absent', 'a file that appeared after the check'],
        ['sha256', 'a tracked file that changed after the check'],
    ])('%s authorization: %s that holds exactly the bytes about to be written is not a refusal', (kind, _what) => {
        put(path.join(dest, 'a.md'), 'OLD');
        const authorized: Authorized = kind === 'absent' ? { kind: 'absent' } : authorizedStateOf(path.join(dest, 'a.md'), false);
        if (kind === 'absent') fs.rmSync(path.join(dest, 'a.md'));
        fs.writeFileSync(path.join(dest, 'a.md'), 'NEW');

        const result = writeAll(dest, [w('a.md', 'NEW', authorized)], none);

        expect(result.stop).toBeNull();
        expect(result.placed.map((write) => write.relPath)).toEqual(['a.md']);
        expect(read(dest, 'a.md')).toBe('NEW');
    });

    it.each([
        ['absent', 'a file that appeared after the check'],
        ['sha256', 'a tracked file that changed after the check'],
    ])('%s authorization: %s that holds other bytes is still a refusal and is left as it is', (kind, _what) => {
        put(path.join(dest, 'a.md'), 'OLD');
        const authorized: Authorized = kind === 'absent' ? { kind: 'absent' } : authorizedStateOf(path.join(dest, 'a.md'), false);
        fs.writeFileSync(path.join(dest, 'a.md'), 'SOMEONE ELSE');

        const result = writeAll(dest, [w('a.md', 'NEW', authorized)], none);

        expect(result.placed).toEqual([]);
        expect(result.stop?.error).toBeInstanceOf(PublicationRefusedError);
        expect(read(dest, 'a.md')).toBe('SOMEONE ELSE');
    });

    it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')('an unreadable file that appeared after the check (absent authorization) is a refusal, not a write error (needs a non-root user, who cannot read a mode-000 file; Windows has no modes)', () => {
        fs.writeFileSync(path.join(dest, 'a.md'), 'NEW');
        fs.chmodSync(path.join(dest, 'a.md'), 0o000);

        const result = writeAll(dest, [w('a.md', 'NEW', { kind: 'absent' })], none);

        expect(result.stop?.error).toBeInstanceOf(PublicationRefusedError);
        fs.chmodSync(path.join(dest, 'a.md'), 0o600);
    });

    it('every placed write carries the dev:ino of the file renamed in: the file now at its name, and not the one it replaced', () => {
        put(path.join(dest, 'a.md'), 'OLD');
        const replacedIdentity = identityOf(path.join(dest, 'a.md'));
        fs.linkSync(path.join(dest, 'a.md'), path.join(root, 'keeps-the-old-inode'));

        const result = writeAll(dest, [w('a.md', 'NEW', { kind: 'any' }), w('b.md', 'NEW', { kind: 'absent' })], none);

        expect(result.placed.map((write) => write.identity)).toEqual([identityOf(path.join(dest, 'a.md')), identityOf(path.join(dest, 'b.md'))]);
        expect(result.placed[0].identity).not.toBe(replacedIdentity);
        expect(result.placed[0].identity).not.toBe(result.placed[1].identity);
    });

    it('writeFileAtomic returns the dev:ino of the file it renamed into place', () => {
        const identity = writeFileAtomic(dest, 'f.txt', 'HELLO');

        expect(identity).toBe(identityOf(path.join(dest, 'f.txt')));
    });
});

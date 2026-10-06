/**
 * `doc pull` commits through a staging folder (cli#168, cli#188, cli#182; spec §1).
 *
 * Every case runs the built CLI (`node dist/index.js`) against a real in-process HTTP server with a
 * temp HOME and real files. A first pull writes `a.md`, `sub/b.md` and the media file `pic.png`;
 * each case then serves new bytes and pulls again, sometimes with a failure injected through the
 * module's own test-only switch (`SOLIDACTIONS_TEST_HOOKS=1` plus `SOLIDACTIONS_DOC_PULL_TEST_FAULT`).
 * "Nothing changed" means the snapshot of everything under the destination (dot-entries and the
 * manifest included, with every file's inode) equals the one taken before the failed pull.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');
const MANIFEST_FILE = '.solidactions-docs.json';
const STAGING_PATTERN = /^\.solidactions-pull-\d+$/;

interface ServedDoc {
    id: number;
    title: string;
    revision: number;
    relative?: string;
    body?: string;
    media?: Buffer;
}

let server: http.Server;
let port: number;
let served: ServedDoc[] = [];

function mcpResult(data: object, isError = false): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError, content: [{ type: 'text', text: JSON.stringify(data) }] } });
}

function mediaProps(doc: ServedDoc): Record<string, unknown> {
    return doc.media === undefined ? {} : { blob_sha: `sha-${doc.id}`, mime: 'image/png', size: 4 };
}

function answerMcp(args: Record<string, any>): string {
    if (args.action === 'list') {
        const relative = String(args.folder_path).slice('docs'.length).replace(/^\//, '');
        const prefix = relative ? `${relative}/` : '';
        const folders = new Set(served
            .map((d) => d.relative ?? '')
            .filter((dir) => dir.startsWith(prefix) && dir !== relative)
            .map((dir) => dir.slice(prefix.length).split('/')[0]));
        return mcpResult({
            folders: [...folders].map((name) => ({ name, folder_path: `docs/${prefix}${name}` })),
            docs: served.filter((d) => (d.relative ?? '') === relative).map((d) => ({ id: d.id, title: d.title, doc_type: null })),
        });
    }
    if (args.action === 'bulk_read') {
        const ids: number[] = (args.items ?? []).map((item: { id: number }) => item.id);
        return mcpResult({
            results: ids.map((id, index) => {
                const d = served.find((doc) => doc.id === id)!;
                return { index, status: 'found', id, title: d.title, current_revision_id: d.revision, properties: mediaProps(d), body: d.media === undefined ? (d.body ?? '') : '' };
            }),
        });
    }
    return mcpResult({ code: 'unexpected', message: `unexpected action ${String(args.action)}` }, true);
}

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const url = req.url ?? '';
            const mediaConfirm = url.match(/^\/api\/v1\/docs\/(\d+)\/media$/);
            if (mediaConfirm) {
                const d = served.find((doc) => doc.id === Number(mediaConfirm[1]));
                if (!d || d.media === undefined) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ code: 'media_not_found', message: 'no media' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ url: `http://127.0.0.1:${port}/blob/${d.id}`, mime: 'image/png', size: 4 }));
                return;
            }
            const blob = url.match(/^\/blob\/(\d+)$/);
            if (blob) {
                const d = served.find((doc) => doc.id === Number(blob[1]));
                if (!d || d.media === undefined) {
                    res.writeHead(503);
                    res.end();
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
                res.end(d.media);
                return;
            }
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(answerMcp(body.params.arguments));
        });
    });
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))));

interface CliResult {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
}

/** Run the built CLI with a temp HOME pointing at the server; `extraEnv` sets the test hooks on purpose. */
function runCli(root: string, args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    writeGlobal(home, { host: `http://127.0.0.1:${port}`, apiKey: 'test-api-key', workspaceId: 'ws-test-uuid' });
    return new Promise<CliResult>((resolve, reject) => {
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
        for (const key of ['SOLIDACTIONS_HOST', 'SOLIDACTIONS_API_KEY', 'SOLIDACTIONS_WORKSPACE_ID', 'DEBUG', 'NODE_DEBUG', 'FORCE_COLOR', 'SOLIDACTIONS_TEST_HOOKS', 'SOLIDACTIONS_DOC_PULL_TEST_FAULT']) {
            delete env[key];
        }
        Object.assign(env, extraEnv);
        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`CLI timed out. stdout: ${stdout} stderr: ${stderr}`));
        }, 30_000);
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, stdout, stderr });
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

const fault = (spec: string): Record<string, string> => ({ SOLIDACTIONS_TEST_HOOKS: '1', SOLIDACTIONS_DOC_PULL_TEST_FAULT: spec });

interface Snapshot {
    entries: Record<string, string>;
    inodes: Record<string, number>;
}

/** Every entry under `dir` (dot-entries included): files by bytes, links by target, folders as `D`; plus every regular file's inode. */
function snapshot(dir: string): Snapshot {
    const entries: Record<string, string> = {};
    const inodes: Record<string, number> = {};
    const walk = (abs: string, prefix: string): void => {
        for (const name of fs.readdirSync(abs).sort()) {
            const full = path.join(abs, name);
            const rel = prefix === '' ? name : `${prefix}/${name}`;
            const stat = fs.lstatSync(full);
            if (stat.isSymbolicLink()) {
                entries[rel] = `L:${fs.readlinkSync(full)}`;
            } else if (stat.isDirectory()) {
                entries[rel] = 'D';
                walk(full, rel);
            } else {
                entries[rel] = `F:${fs.readFileSync(full).toString('latin1')}`;
                inodes[rel] = stat.ino;
            }
        }
    };
    walk(dir, '');
    return { entries, inodes };
}

const stagingEntries = (out: string): string[] => fs.readdirSync(out).filter((name) => STAGING_PATTERN.test(name));

function docsV(version: 1 | 2, extra: ServedDoc[] = []): ServedDoc[] {
    return [
        ...extra,
        { id: 1, title: 'a', revision: version, body: `A${version}` },
        { id: 2, title: 'b', revision: version, relative: 'sub', body: `B${version}` },
        { id: 3, title: 'pic', revision: version, media: Buffer.from(`P${version}`) },
    ];
}

const refusal = (rel: string): RegExp => new RegExp(`error: ${rel.replace(/\./g, '\\.')} changed after doc pull checked it — nothing was changed\\. Pull again, or pass --overwrite to replace it\\.`);

describe('doc pull commits through a staging folder', { timeout: 60_000 }, () => {
    let root: string;
    let out: string;
    let before: Snapshot;

    beforeEach(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-pull-tx-'));
        out = path.join(root, 'out');
        served = docsV(1);
        const first = await runCli(root, ['doc', 'pull', 'docs', out, '-y']);
        expect(first.code).toBe(0);
        served = docsV(2);
        before = snapshot(out);
    });

    afterEach(() => {
        fs.chmodSync(out, 0o755);
        fs.rmSync(root, { recursive: true, force: true });
    });

    const expectNothingChanged = (): void => {
        const after = snapshot(out);
        expect(after.entries).toEqual(before.entries);
        expect(after.inodes).toEqual(before.inodes);
        expect(stagingEntries(out)).toEqual([]);
    };

    it.each([1, 2, 3])('restores every doc and the manifest with their original inodes when rename %i fails', async (n) => {
        const result = await runCli(root, ['doc', 'pull', 'docs', out, '-y'], fault(`fail-rename:${n}`));

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/error: cannot write (a\.md|sub\/b\.md|pic\.png): EIO: i\/o error, rename \(test hook\) — nothing was changed\./);
        expectNothingChanged();
    });

    it('names the three docs across the three rename failures, one each', async () => {
        const named = new Set<string>();
        for (const n of [1, 2, 3]) {
            const result = await runCli(root, ['doc', 'pull', 'docs', out, '-y'], fault(`fail-rename:${n}`));
            named.add(/cannot write (a\.md|sub\/b\.md|pic\.png):/.exec(result.stderr)?.[1] ?? 'none');
        }

        expect([...named].sort()).toEqual(['a.md', 'pic.png', 'sub/b.md']);
    });

    it('fails when the manifest temp file cannot be written: the line names the manifest and nothing changed', async () => {
        const result = await runCli(root, ['doc', 'pull', 'docs', out, '-y'], fault('fail-manifest-temp'));

        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`error: cannot write ${MANIFEST_FILE}: EIO: i/o error, open manifest.tmp (test hook) — nothing was changed.`);
        expectNothingChanged();
    });

    it('restores every doc when the manifest rename fails', async () => {
        const result = await runCli(root, ['doc', 'pull', 'docs', out, '-y'], fault('fail-manifest-rename'));

        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`error: cannot write ${MANIFEST_FILE}: EIO: i/o error, rename manifest (test hook) — nothing was changed.`);
        expectNothingChanged();
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('names the staging folder and changes nothing when the staging folder cannot be created (a really read-only destination)', async () => {
        fs.chmodSync(out, 0o555);

        const result = await runCli(root, ['doc', 'pull', 'docs', out, '-y']);

        fs.chmodSync(out, 0o755);
        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/error: cannot write \.solidactions-pull-\d+: EACCES[^\n]* — nothing was changed\./);
        expectNothingChanged();
    });

    describe('a target that changes after the check', () => {
        it('refuses a doc that appeared after the check, keeps the racing file and changes nothing else', async () => {
            served = docsV(2, [{ id: 9, title: 'n', revision: 1, body: 'N1' }]);

            const result = await runCli(root, ['doc', 'pull', 'docs', out, '-y'], fault('create-before-commit:n.md'));

            expect(result.code).toBe(1);
            expect(result.stderr).toMatch(refusal('n.md'));
            const after = snapshot(out);
            expect(after.entries['n.md']).toBe('F:RACE');
            delete after.entries['n.md'];
            delete after.inodes['n.md'];
            expect(after).toEqual(before);
            expect(stagingEntries(out)).toEqual([]);
        });

        it('replaces the racing file with the served bytes when --overwrite is given', async () => {
            served = docsV(2, [{ id: 9, title: 'n', revision: 1, body: 'N1' }]);

            const result = await runCli(root, ['doc', 'pull', 'docs', out, '--overwrite'], fault('create-before-commit:n.md'));

            expect(result.code).toBe(0);
            expect(fs.readFileSync(path.join(out, 'n.md'), 'utf8')).toBe('N1');
            expect(fs.readFileSync(path.join(out, 'a.md'), 'utf8')).toBe('A2');
            expect(stagingEntries(out)).toEqual([]);
        });

        it('refuses a symbolic link that appeared at a new doc, leaves the link and the file it points at alone', async () => {
            served = docsV(2, [{ id: 9, title: 'n', revision: 1, body: 'N1' }]);
            const outside = path.join(root, 'outside.txt');
            fs.writeFileSync(outside, 'OUTSIDE');

            const result = await runCli(root, ['doc', 'pull', 'docs', out, '-y'], fault(`link-before-commit:n.md>${outside}`));

            expect(result.code).toBe(1);
            expect(result.stderr).toMatch(refusal('n.md'));
            expect(fs.readFileSync(outside, 'utf8')).toBe('OUTSIDE');
            const after = snapshot(out);
            expect(after.entries['n.md']).toBe(`L:${outside}`);
            delete after.entries['n.md'];
            expect(after).toEqual(before);
        });

        it('replaces a symbolic link that appeared at a new doc with a regular file under --overwrite, without writing through it', async () => {
            served = docsV(2, [{ id: 9, title: 'n', revision: 1, body: 'N1' }]);
            const outside = path.join(root, 'outside.txt');
            fs.writeFileSync(outside, 'OUTSIDE');

            const result = await runCli(root, ['doc', 'pull', 'docs', out, '--overwrite'], fault(`link-before-commit:n.md>${outside}`));

            expect(result.code).toBe(0);
            expect(fs.lstatSync(path.join(out, 'n.md')).isFile()).toBe(true);
            expect(fs.readFileSync(path.join(out, 'n.md'), 'utf8')).toBe('N1');
            expect(fs.readFileSync(outside, 'utf8')).toBe('OUTSIDE');
        });

        it('leaves a folder that appeared at a target alone (with its contents), rolls back every other change and says so (ruling 9)', async () => {
            served = docsV(2, [{ id: 9, title: 'n', revision: 1, body: 'N1' }]);

            const result = await runCli(root, ['doc', 'pull', 'docs', out, '--overwrite'], fault('mkdir-before-commit:n.md'));

            expect(result.code).toBe(1);
            expect(result.stderr).toContain('error: n.md is a folder now (doc pull writes a file there) — nothing was changed. Move it aside and pull again.');
            expect(fs.readFileSync(path.join(out, 'n.md', 'user.txt'), 'utf8')).toBe('USER');
            const after = snapshot(out);
            for (const key of ['n.md', 'n.md/user.txt']) {
                delete after.entries[key];
                delete after.inodes[key];
            }
            expect(after).toEqual(before);
            expect(stagingEntries(out)).toEqual([]);
        });
    });

    describe('an interrupted pull', () => {
        it('keeps the staging folder when a restore fails; the next hook-free pull cleans up and completes', async () => {
            const failed = await runCli(root, ['doc', 'pull', 'docs', out, '-y'], fault('fail-rename:3,fail-restore:1'));

            expect(failed.code).toBe(1);
            expect(failed.stderr).toMatch(/error: cannot write (a\.md|sub\/b\.md|pic\.png): EIO: i\/o error, rename \(test hook\) — could not restore \1 \(EIO: i\/o error, restore \(test hook\)\); its previous copy is in \.solidactions-pull-\d+\/backup\/\1\./);
            expect(stagingEntries(out)).toHaveLength(1);

            const next = await runCli(root, ['doc', 'pull', 'docs', out, '-y']);

            expect(next.code).toBe(0);
            expect(next.stderr).toContain(`! cleaned up after an interrupted doc pull in ${out} (restored 1 file(s))`);
            expect(fs.readFileSync(path.join(out, 'a.md'), 'utf8')).toBe('A2');
            expect(fs.readFileSync(path.join(out, 'sub', 'b.md'), 'utf8')).toBe('B2');
            expect(fs.readFileSync(path.join(out, 'pic.png'), 'utf8')).toBe('P2');
            expect(stagingEntries(out)).toEqual([]);
        });

        it('a killed pull leaves the old manifest and its staging folder; the next pull refuses to guess, and it completes once the folder is removed with --overwrite', async () => {
            const killed = await runCli(root, ['doc', 'pull', 'docs', out, '-y'], fault('kill-after-renames:1'));

            expect(killed.signal).toBe('SIGKILL');
            expect(fs.readFileSync(path.join(out, MANIFEST_FILE), 'utf8')).toBe(before.entries[MANIFEST_FILE].slice(2));
            const [folder] = stagingEntries(out);
            expect(folder).toBeDefined();
            expect(fs.readFileSync(path.join(out, folder, 'backup', 'a.md'), 'utf8')).toBe('A1');

            const second = await runCli(root, ['doc', 'pull', 'docs', out, '-y']);

            expect(second.code).toBe(1);
            expect(second.stderr).toContain(`error: an interrupted doc pull left saved copies in ${path.join(out, folder)}; 1 file(s) differ from their saved copies (first: a.md), so neither was changed. Keep the versions you want, delete that folder, and pull again.`);
            expect(fs.readFileSync(path.join(out, 'a.md'), 'utf8')).toBe('A2');
            expect(fs.readFileSync(path.join(out, folder, 'backup', 'a.md'), 'utf8')).toBe('A1');

            fs.rmSync(path.join(out, folder), { recursive: true });
            const third = await runCli(root, ['doc', 'pull', 'docs', out, '--overwrite']);

            expect(third.code).toBe(0);
            expect(fs.readFileSync(path.join(out, 'sub', 'b.md'), 'utf8')).toBe('B2');
        });

        it('a pull killed after publishing only a new file is cleaned up by the next pull, which adopts that file and completes', async () => {
            served = docsV(2, [{ id: 9, title: 'n', revision: 1, body: 'N1' }]);

            const killed = await runCli(root, ['doc', 'pull', 'docs', out, '-y'], fault('kill-after-renames:1'));

            expect(killed.signal).toBe('SIGKILL');
            expect(fs.readFileSync(path.join(out, 'n.md'), 'utf8')).toBe('N1');
            expect(stagingEntries(out)).toHaveLength(1);

            const second = await runCli(root, ['doc', 'pull', 'docs', out, '-y']);

            expect(second.code).toBe(0);
            expect(second.stderr).toContain(`! cleaned up after an interrupted doc pull in ${out} (restored 0 file(s))`);
            expect(fs.readFileSync(path.join(out, 'n.md'), 'utf8')).toBe('N1');
            expect(fs.readFileSync(path.join(out, 'a.md'), 'utf8')).toBe('A2');
            expect(JSON.parse(fs.readFileSync(path.join(out, MANIFEST_FILE), 'utf8')).docs['n.md'].id).toBe(9);
            expect(stagingEntries(out)).toEqual([]);
        });

        it('a link refusal after earlier files were placed still says which saved copy could not be restored, and keeps it', async () => {
            served = docsV(2, [{ id: 9, title: 'n', revision: 1, relative: 'newdir', body: 'N1' }]);
            const outside = path.join(root, 'outside');
            fs.mkdirSync(outside);
            fs.writeFileSync(path.join(outside, 'keep.txt'), 'KEEP');

            const result = await runCli(root, ['doc', 'pull', 'docs', out, '-y'], fault(`link-before-commit:newdir>${outside},fail-restore:1`));

            expect(result.code).toBe(1);
            expect(result.stderr).toMatch(/error: newdir\/n\.md is a symbolic link \(or sits under one: newdir\); this pull would write doc 9/);
            const unrestored = /error: could not restore (a\.md|sub\/b\.md|pic\.png) \(EIO: i\/o error, restore \(test hook\)\); its previous copy is in (\.solidactions-pull-\d+)\/backup\/\1\./.exec(result.stderr);
            expect(unrestored).not.toBeNull();
            const [, rel, staging] = unrestored!;
            expect(stagingEntries(out)).toEqual([staging]);
            expect(fs.readFileSync(path.join(out, staging, 'backup', rel), 'utf8')).toBe(before.entries[rel].slice(2));
            expect(fs.readdirSync(outside)).toEqual(['keep.txt']);
        });

        it('refuses while another pull is running and changes nothing', async () => {
            const child = childProcess.spawn('sleep', ['5'], { stdio: 'ignore' });
            try {
                fs.mkdirSync(path.join(out, `.solidactions-pull-${child.pid}`));
                before = snapshot(out);

                const result = await runCli(root, ['doc', 'pull', 'docs', out, '-y']);

                expect(result.code).toBe(1);
                expect(result.stderr).toContain(`error: another doc pull (pid ${child.pid}) is writing to ${out}; wait for it to finish.`);
                expect(snapshot(out)).toEqual(before);
            } finally {
                child.kill('SIGKILL');
            }
        });

        it('refuses a staging-folder name that is a symbolic link and never follows it', async () => {
            const elsewhere = path.join(root, 'elsewhere');
            fs.mkdirSync(elsewhere);
            fs.symlinkSync(elsewhere, path.join(out, '.solidactions-pull-1'));
            before = snapshot(out);

            const result = await runCli(root, ['doc', 'pull', 'docs', out, '-y']);

            expect(result.code).toBe(1);
            expect(result.stderr).toContain(`error: ${path.join(out, '.solidactions-pull-1')} is not a folder doc pull created; remove it and pull again.`);
            expect(snapshot(out)).toEqual(before);
            expect(fs.readdirSync(elsewhere)).toEqual([]);
        });
    });

    describe('what a rename replaces', () => {
        it('replaces a hard-linked tracked file by a new inode, so the other name keeps the old bytes (cli#188)', async () => {
            const other = path.join(root, 'outside.md');
            fs.linkSync(path.join(out, 'a.md'), other);

            const result = await runCli(root, ['doc', 'pull', 'docs', out, '-y']);

            expect(result.code).toBe(0);
            expect(fs.readFileSync(path.join(out, 'a.md'), 'utf8')).toBe('A2');
            expect(fs.readFileSync(other, 'utf8')).toBe('A1');
        });

        it('keeps the permission bits of a replaced file', async () => {
            fs.chmodSync(path.join(out, 'a.md'), 0o600);

            const result = await runCli(root, ['doc', 'pull', 'docs', out, '-y']);

            expect(result.code).toBe(0);
            expect(fs.readFileSync(path.join(out, 'a.md'), 'utf8')).toBe('A2');
            expect(fs.statSync(path.join(out, 'a.md')).mode & 0o7777).toBe(0o600);
        });
    });
});

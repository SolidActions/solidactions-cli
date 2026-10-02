import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { liveConfig, LIVE } from './live-env';
import { callDocsTool } from '../../src/utils/mcp';
import { createCleanup } from './cleanup';

const CLI = path.resolve(__dirname, '../../dist/index.js');

// A valid 1x1 PNG, written to disk by the test.
const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

describe.skipIf(!LIVE)('doc push / pull / upload (live, real CLI)', () => {
    const config = liveConfig()!;
    const stamp = Date.now();
    const root = `cli-docs-live-${stamp}`;
    const tmpDirs: string[] = [];
    const cleanup = createCleanup(config);

    const mkTmp = () => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-docs-live-'));
        tmpDirs.push(d);
        return d;
    };

    /** Run the built CLI against the live stack; env-only config, throwaway HOME so no config files are written. */
    const runCli = (args: string[]) => {
        const res = spawnSync('node', [CLI, ...args], {
            encoding: 'utf8',
            env: {
                PATH: process.env.PATH,
                HOME: mkTmp(),
                SOLIDACTIONS_HOST: config.host,
                SOLIDACTIONS_API_KEY: config.apiKey,
                SOLIDACTIONS_WORKSPACE_ID: config.workspaceId,
            },
        });
        return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
    };

    const json = (r: { stdout: string; stderr: string }) => JSON.parse(r.stdout.trim());

    /** What the server lists in a folder: doc titles and sub-folder names. */
    const listFolder = async (folderPath: string) => {
        const r = await callDocsTool(config, { action: 'list', folder_path: folderPath });
        expect(r.ok, JSON.stringify(r.data)).toBe(true);
        return {
            docs: (r.data.docs ?? []).map((d: any) => d.title as string).sort(),
            folders: (r.data.folders ?? []).map((f: any) => f.name as string).sort(),
        };
    };

    const read = (...p: string[]) => fs.readFileSync(path.join(...p));

    // Multibyte UTF-8: em dash, emoji (4-byte), CJK.
    const bodyA = '# Alpha\n\nem dash — here, emoji 🚀🎉, CJK 你好世界, accents café.\n';
    const bodyB = '# Bravo\n\nnested doc — 📚 日本語のテスト\n';
    let srcDir: string;
    let pulledDir: string;
    let editedA: string;

    beforeAll(() => {
        expect(fs.existsSync(CLI), 'run `npm run build` first').toBe(true);
        // Registered before anything is created, so a half-finished test still cleans up.
        cleanup.docFolder(root);
        srcDir = mkTmp();
        fs.mkdirSync(path.join(srcDir, 'sub'));
        fs.writeFileSync(path.join(srcDir, 'a.md'), bodyA, 'utf8');
        fs.writeFileSync(path.join(srcDir, 'sub', 'b.md'), bodyB, 'utf8');
    });

    afterAll(async () => {
        await cleanup.run();
        for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    });

    it('doc push creates the docs under --folder, mirroring sub-folders', async () => {
        const push = runCli(['doc', 'push', srcDir, '--folder', root, '--json']);
        expect(push.status, push.stdout + push.stderr).toBe(0);
        const out = json(push);
        expect(out.summary.created).toBe(2);
        expect(out.summary.errors ?? 0).toBe(0);
        expect(out.results.map((r: any) => r.file).sort()).toEqual(['a.md', path.join('sub', 'b.md')]);

        expect(await listFolder(root)).toEqual({ docs: ['a'], folders: ['sub'] });
        expect(await listFolder(`${root}/sub`)).toEqual({ docs: ['b'], folders: [] });
    });

    it('doc pull round-trips the folder: every pulled file is byte-identical to the source', () => {
        pulledDir = path.join(mkTmp(), 'out');
        const pull = runCli(['doc', 'pull', root, pulledDir, '--json']);
        expect(pull.status, pull.stdout + pull.stderr).toBe(0);
        const out = json(pull);
        expect(out.files.map((f: any) => f.path).sort()).toEqual(['a.md', 'sub/b.md']);
        expect(out.manifest.folder_path).toBe(root);

        expect(Buffer.compare(read(pulledDir, 'a.md'), read(srcDir, 'a.md'))).toBe(0);
        expect(Buffer.compare(read(pulledDir, 'sub', 'b.md'), read(srcDir, 'sub', 'b.md'))).toBe(0);
        // Re-read as text to make sure the multibyte characters survived, not just the bytes.
        expect(read(pulledDir, 'a.md').toString('utf8')).toBe(bodyA);
    });

    it('tracked re-push goes through the write path: only the edited file is written, and a fresh pull has its bytes', () => {
        editedA = `${bodyA}\nedited locally — ✍️ 改めました\n`;
        fs.writeFileSync(path.join(pulledDir, 'a.md'), editedA, 'utf8');

        const push = runCli(['doc', 'push', pulledDir, '--json']);
        expect(push.status, push.stdout + push.stderr).toBe(0);
        const out = json(push);
        expect(out.tracked.written.map((w: any) => w.file)).toEqual(['a.md']);
        expect(out.tracked.written[0].current_revision_id).not.toBeNull();
        expect(out.tracked.unchanged.map((u: any) => u.file)).toEqual(['sub/b.md']);
        expect(out.tracked.drifted).toEqual([]);
        // Tracked docs are written in place, never re-created through bulk_create.
        expect(out.results).toEqual([]);
        expect(out.summary).toEqual({});

        const fresh = path.join(mkTmp(), 'out');
        const pull = runCli(['doc', 'pull', root, fresh]);
        expect(pull.status, pull.stdout + pull.stderr).toBe(0);
        expect(read(fresh, 'a.md').toString('utf8')).toBe(editedA);
        expect(Buffer.compare(read(fresh, 'sub', 'b.md'), read(srcDir, 'sub', 'b.md'))).toBe(0);

        // The human-readable report names the same thing.
        fs.writeFileSync(path.join(pulledDir, 'sub', 'b.md'), `${bodyB}\nsecond edit\n`, 'utf8');
        const human = runCli(['doc', 'push', pulledDir]);
        expect(human.status, human.stdout + human.stderr).toBe(0);
        expect(human.stdout).toMatch(/tracked: 1 written, 0 drifted, 1 unchanged/);
        expect(human.stdout).toContain('sub/b.md');
    });

    it('a tracked push sends base_revision: a stale copy is reported as drift (exit 1), and --force overwrites it', () => {
        // Two copies of the same revision; the first one pushes, which moves the server ahead of the second.
        const a = path.join(mkTmp(), 'out');
        const b = path.join(mkTmp(), 'out');
        expect(runCli(['doc', 'pull', root, a]).status).toBe(0);
        expect(runCli(['doc', 'pull', root, b]).status).toBe(0);

        fs.writeFileSync(path.join(a, 'a.md'), 'from copy A\n', 'utf8');
        const first = runCli(['doc', 'push', a, '--json']);
        expect(first.status, first.stdout + first.stderr).toBe(0);

        fs.writeFileSync(path.join(b, 'a.md'), 'from copy B\n', 'utf8');
        const stale = runCli(['doc', 'push', b, '--json']);
        expect(stale.status, stale.stdout + stale.stderr).toBe(1);
        const drift = json(stale).tracked;
        expect(drift.written).toEqual([]);
        expect(drift.drifted.map((d: any) => d.file)).toEqual(['a.md']);

        const check = path.join(mkTmp(), 'out');
        expect(runCli(['doc', 'pull', root, check]).status).toBe(0);
        expect(read(check, 'a.md').toString('utf8')).toBe('from copy A\n');

        const forced = runCli(['doc', 'push', b, '--force', '--json']);
        expect(forced.status, forced.stdout + forced.stderr).toBe(0);
        expect(json(forced).tracked.written.map((w: any) => w.file)).toEqual(['a.md']);
        const after = path.join(mkTmp(), 'out');
        expect(runCli(['doc', 'pull', root, after]).status).toBe(0);
        expect(read(after, 'a.md').toString('utf8')).toBe('from copy B\n');
    });

    it('doc push creates visual docs and canvases; --replace swaps a body with a kind check', async () => {
        const dir = mkTmp();
        const pageFile = path.join(dir, 'page.html');
        const boardFile = path.join(dir, 'board.canvas.json');
        const pageV1 = '<!doctype html><html><body><h1>cli-trust</h1></body></html>';
        const boardBody = '{"nodes":[{"id":"n1","type":"text","text":"hello","x":0,"y":0,"width":200,"height":80}],"edges":[]}';
        fs.writeFileSync(pageFile, pageV1, 'utf8');
        fs.writeFileSync(boardFile, boardBody, 'utf8');

        const push = runCli(['doc', 'push', dir, '--folder', `${root}/visual`, '--json']);
        expect(push.status, push.stdout + push.stderr).toBe(0);
        const created = json(push).results.filter((r: any) => r.status === 'created');
        expect(created.length).toBe(2);

        const readPage = await callDocsTool(config, { action: 'read_doc', path: { folder_path: `${root}/visual`, title: 'page' } });
        expect(readPage.ok, JSON.stringify(readPage.data)).toBe(true);
        expect(readPage.data.body).toBe(pageV1);
        expect(readPage.data.doc_type.slug).toBe('visual');
        const readBoard = await callDocsTool(config, { action: 'read_doc', path: { folder_path: `${root}/visual`, title: 'board' } });
        expect(readBoard.ok, JSON.stringify(readBoard.data)).toBe(true);
        expect(readBoard.data.doc_type.slug).toBe('canvas');
        const pageId = readPage.data.id;

        const pageV2 = '<!doctype html><html><body><h1>cli-trust v2</h1></body></html>';
        fs.writeFileSync(pageFile, pageV2, 'utf8');
        const replaced = runCli(['doc', 'push', pageFile, '--replace', String(pageId), '--json']);
        expect(replaced.status, replaced.stdout + replaced.stderr).toBe(0);
        expect(json(replaced).replaced.current_revision_id).toBeDefined();
        const reread = await callDocsTool(config, { action: 'read_doc', path: { folder_path: `${root}/visual`, title: 'page' } });
        expect(reread.ok, JSON.stringify(reread.data)).toBe(true);
        expect(reread.data.body).toBe(pageV2);

        const notesFile = path.join(mkTmp(), 'notes.md');
        fs.writeFileSync(notesFile, '# not a page\n', 'utf8');
        const mismatch = runCli(['doc', 'push', notesFile, '--replace', String(pageId)]);
        expect(mismatch.status).toBe(1);
        const still = await callDocsTool(config, { action: 'read_doc', path: { folder_path: `${root}/visual`, title: 'page' } });
        expect(still.ok, JSON.stringify(still.data)).toBe(true);
        expect(still.data.body).toBe(pageV2);

        const again = runCli(['doc', 'push', dir, '--folder', `${root}/visual`]);
        expect(again.status, again.stdout + again.stderr).toBe(0);
        expect(again.stderr).toContain('page.html: skipped');
        console.log(`skip hint form: ${/--replace \d+/.test(again.stderr) ? 'id from the server row' : '<doc-id> fallback'}`);
        expect(/--replace (\d+|<doc-id>)/.test(again.stderr)).toBe(true);
    });

    it('doc pull <folder>/<doc> reads a single doc (read_doc by folder_path + title)', () => {
        const dest = path.join(mkTmp(), 'single');
        const pull = runCli(['doc', 'pull', `${root}/a`, dest, '--json']);
        expect(pull.status, pull.stdout + pull.stderr).toBe(0);
        const out = json(pull);
        expect(out.files.map((f: any) => f.path)).toEqual(['a.md']);
        expect(out.manifest.folder_path).toBe(root);
        expect(read(dest, 'a.md').toString('utf8')).toBe('from copy B\n');

        // A doc that lives in a sub-folder resolves the same way.
        const dest2 = path.join(mkTmp(), 'single-nested');
        const nested = runCli(['doc', 'pull', `${root}/sub/b`, dest2]);
        expect(nested.status, nested.stdout + nested.stderr).toBe(0);
        expect(read(dest2, 'b.md').toString('utf8')).toBe(`${bodyB}\nsecond edit\n`);
        expect(JSON.parse(fs.readFileSync(path.join(dest2, '.solidactions-docs.json'), 'utf8')).folder_path).toBe(`${root}/sub`);

        // A path that is neither a folder nor a doc fails cleanly.
        const missing = runCli(['doc', 'pull', `${root}/no-such-doc`, path.join(mkTmp(), 'none')]);
        expect(missing.status).toBe(1);
        expect(missing.stderr).not.toMatch(/\n\s+at /);
    });

    it('doc upload creates a media doc in --folder, and doc pull downloads the same bytes', async () => {
        const name = `pic-${stamp}.png`;
        const file = path.join(mkTmp(), name);
        fs.writeFileSync(file, PNG_BYTES);

        const up = runCli(['doc', 'upload', file, '--folder', root]);
        expect(up.status, up.stdout + up.stderr).toBe(0);
        expect(up.stdout).toContain(`${name} → ${root} (doc `);

        const listed = await listFolder(root);
        expect(listed.docs).toContain(name);

        const dest = path.join(mkTmp(), 'with-media');
        const pull = runCli(['doc', 'pull', root, dest]);
        expect(pull.status, pull.stdout + pull.stderr).toBe(0);
        expect(Buffer.compare(read(dest, name), PNG_BYTES)).toBe(0);
    });
});

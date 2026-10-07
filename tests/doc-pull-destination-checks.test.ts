/**
 * `doc pull` destination checks (cli#191, cli#176).
 *
 * An unreadable destination fails with one `error: cannot read <destination>: <fs message>`
 * line instead of a raw scandir stack. A non-empty destination with no terminal to answer the
 * prompt fails with one line and exit 1 instead of printing "Cancelled." and exiting 0. Every
 * case runs the built CLI (`node dist/index.js`) against a real in-process HTTP server with a
 * temp HOME and real files; the "no" answer goes through a real pseudo-terminal (util-linux
 * `script`).
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
const NOTE_BODY = '# note from the server';
const NO_TERMINAL_LINE = (dest: string): string =>
    `error: ${dest} is not empty and there is no terminal to confirm the pull; pass -y to pull into it.`;

const isRoot = process.getuid?.() === 0; // root reads mode-000 directories, so nothing is unreadable to it
const canChmod = process.platform !== 'win32' && !isRoot;
const hasScript = process.platform !== 'win32' && fs.existsSync('/usr/bin/script');

function mcpResult(data: object): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: false, content: [{ type: 'text', text: JSON.stringify(data) }] } });
}

function answerMcp(args: Record<string, any>): string {
    if (args.action === 'list') {
        return mcpResult({ folders: [], docs: [{ id: 1, title: 'Note', doc_type: null }] });
    }
    if (args.action === 'bulk_read') {
        return mcpResult({
            results: (args.items ?? []).map((item: { id: number }, index: number) => (
                { index, status: 'found', id: item.id, title: 'Note', current_revision_id: 10, properties: {}, body: NOTE_BODY }
            )),
        });
    }
    return mcpResult({ code: 'unexpected', message: `unexpected action ${String(args.action)}` });
}

let server: http.Server;
let port: number;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
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
    stdout: string;
    stderr: string;
}

let root: string;
let dest: string;

beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-docpull-dest-')));
    dest = path.join(root, 'out');
    writeGlobal(path.join(root, 'home'), { host: `http://127.0.0.1:${port}`, apiKey: 'test-api-key', workspaceId: 'ws-test-uuid' });
});

afterEach(() => {
    try {
        fs.chmodSync(dest, 0o700);
    } catch {
        // dest was never created, or is already readable
    }
    fs.rmSync(root, { recursive: true, force: true });
});

function childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(root, 'home') };
    for (const key of ['SOLIDACTIONS_HOST', 'SOLIDACTIONS_API_KEY', 'SOLIDACTIONS_WORKSPACE_ID', 'DEBUG', 'NODE_DEBUG', 'FORCE_COLOR', 'SOLIDACTIONS_TEST_HOOKS', 'SOLIDACTIONS_DOC_PULL_TEST_FAULT']) {
        delete env[key];
    }
    // The product's own opt-out: a background update check could otherwise print an `AGENT NOTE` line on stderr.
    env.SOLIDACTIONS_NO_AGENT_NUDGES = '1';
    return env;
}

/** `doc pull docs <dest> …extra` through the built CLI; the child's stdin is a closed pipe, never a terminal. */
function runPull(extra: string[] = []): Promise<CliResult> {
    return new Promise<CliResult>((resolve, reject) => {
        const child = childProcess.spawn(process.execPath, [CLI_BINARY, 'doc', 'pull', 'docs', dest, ...extra], { cwd: root, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdin.end(); // a pipe at end-of-input: nobody can answer a prompt
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`CLI timed out. stdout: ${stdout} stderr: ${stderr}`));
        }, 30_000);
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

/** The same pull under util-linux `script`, so the CLI sees a real terminal; answers the prompt with `answer`. */
function runPullInTerminal(answer: string): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve, reject) => {
        const command = `${process.execPath} ${CLI_BINARY} doc pull docs ${dest}`;
        const child = childProcess.spawn('script', ['-qec', command, '/dev/null'], { cwd: root, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '';
        let answered = false;
        child.stdout.on('data', (chunk) => {
            output += chunk;
            if (!answered && output.includes('Continue?')) {
                answered = true;
                child.stdin.write(answer);
            }
        });
        child.stderr.on('data', (chunk) => { output += chunk; });
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`CLI timed out. output: ${output}`));
        }, 30_000);
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, output });
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

/** A pull that succeeded: exit 0, its summary on stdout, nothing on stderr. */
function expectPulledNote(result: CliResult): void {
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`pulled 1 doc → ${dest}\n  Note.md\n`);
    expect(result.stderr).toBe('');
    expect(fs.readFileSync(path.join(dest, 'Note.md'), 'utf8')).toBe(NOTE_BODY);
}

function seedDestination(): void {
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'x.txt'), 'local file');
}

describe('doc pull destination checks (cli#191, cli#176)', () => {
    it.skipIf(!canChmod)('an unreadable destination fails with one "cannot read" line and no stack (needs a non-root user, who cannot read a mode-000 folder; Windows has no modes)', async () => {
        seedDestination();
        fs.chmodSync(dest, 0o000);

        const result = await runPull();
        fs.chmodSync(dest, 0o700);

        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(new RegExp(`^error: cannot read ${dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: EACCES[^\n]*\n$`));
        expect(result.stderr).not.toContain('    at ');
        expect(fs.readdirSync(dest)).toEqual(['x.txt']);
    });

    it('a non-empty destination with no terminal and no -y fails with the no-terminal line and writes nothing', async () => {
        seedDestination();

        const result = await runPull();

        expect(result.code).toBe(1);
        expect(result.stderr).toBe(`${NO_TERMINAL_LINE(dest)}\n`);
        expect(result.stdout).toBe('');
        expect(fs.readdirSync(dest)).toEqual(['x.txt']);
        expect(fs.existsSync(path.join(dest, MANIFEST_FILE))).toBe(false);
    });

    it('a non-empty destination with no terminal and -y pulls', async () => {
        seedDestination();

        const result = await runPull(['-y']);

        expectPulledNote(result);
    });

    it('a non-empty destination with no terminal and --overwrite pulls', async () => {
        seedDestination();

        const result = await runPull(['--overwrite']);

        expectPulledNote(result);
    });

    it('an empty destination with no terminal and no -y pulls', async () => {
        fs.mkdirSync(dest);

        const result = await runPull();

        expectPulledNote(result);
    });

    it.skipIf(!hasScript)('a real terminal gets the prompt, and answering "no" cancels with exit 0 and writes nothing (needs util-linux script for a PTY)', async () => {
        seedDestination();

        const { code, output } = await runPullInTerminal('n\n');

        // eslint-disable-next-line no-control-regex
        const text = output.replace(/\u001b\[[0-9;]*m/g, '');
        expect(code).toBe(0);
        expect(text).toContain(`Destination "${dest}" is not empty (1 items).`);
        expect(text).toContain("Pulling overwrites tracked files; local files the folder doesn't track are refused unless --overwrite.");
        expect(text).toContain('Continue?');
        expect(text).toContain('Cancelled.');
        expect(fs.readdirSync(dest)).toEqual(['x.txt']);
        expect(fs.existsSync(path.join(dest, MANIFEST_FILE))).toBe(false);
    });
});

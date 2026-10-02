/**
 * Project-name tests for `solidactions init` (cli#102): the scaffolded
 * package takes the canonical slug, not the folder's spelling.
 *
 * A real in-process HTTP server stands in for raw GitHub (via
 * SOLIDACTIONS_RAW_CONTENT_BASE_URL); the real built CLI scaffolds into a
 * real temp directory. No mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

let server: http.Server;
let port: number;

beforeAll(async () => {
    server = http.createServer((request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        if ((request.url ?? '').endsWith('templates/minimal/package.json')) {
            response.end('{"name": "__PROJECT_NAME__", "version": "0.0.0"}');
        } else {
            response.end('name: __PROJECT_NAME__\n');
        }
    });

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => {
    return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
});

interface CliResult {
    stdout: string;
    stderr: string;
    status: number | null;
}

function runCli(args: string[], cwd: string): Promise<CliResult> {
    return new Promise((resolve, reject) => {
        const childEnv: NodeJS.ProcessEnv = {
            ...process.env,
            SOLIDACTIONS_RAW_CONTENT_BASE_URL: `http://127.0.0.1:${port}`,
        };
        delete childEnv.SOLIDACTIONS_HOST;
        delete childEnv.SOLIDACTIONS_API_KEY;
        delete childEnv.SOLIDACTIONS_WORKSPACE_ID;

        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], {
            cwd,
            env: childEnv,
        });
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });

        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`CLI timed out. stdout: ${stdout} stderr: ${stderr}`));
        }, 20_000);

        child.on('close', (status) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, status });
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

describe('init project name (cli#102)', () => {
    let root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-init-name-'));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('names the package by the canonical slug and prints the slug in the next steps', async () => {
        const result = await runCli(['init', 'Issue970Cleanroom', '--no-skills'], root);

        expect(result.status).toBe(0);
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'Issue970Cleanroom', 'package.json'), 'utf-8'));
        expect(pkg.name).toBe('issue970cleanroom');
        expect(result.stdout).toContain('solidactions project deploy issue970cleanroom -e production');
    });

    it('falls back to solidactions-project when nothing slugifiable remains', async () => {
        const result = await runCli(['init', '你好', '--no-skills'], root);

        expect(result.status).toBe(0);
        const pkg = JSON.parse(fs.readFileSync(path.join(root, '你好', 'package.json'), 'utf-8'));
        expect(pkg.name).toBe('solidactions-project');
    });
});

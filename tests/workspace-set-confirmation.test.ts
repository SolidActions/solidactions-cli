/**
 * Confirmation-copy tests for `solidactions workspace set` (cli#112): the
 * confirmation names org and slug, a miss suggests instead of picking, and a
 * failed set writes nothing.
 *
 * Same pattern as tests/connection-list.test.ts: a real in-process HTTP
 * server, a real temp HOME, the real built CLI. No mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

let server: http.Server;
let port: number;

const WORKSPACES_PAYLOAD = {
    workspaces: {
        t1: [{ id: '019f-a', slug: 'acme-north-ws', name: 'Main', tenant_name: 'Acme' }],
        t2: [{ id: '019f-b', slug: 'acme-south-ws', name: 'Main', tenant_name: 'Acme' }],
    },
};

beforeAll(async () => {
    server = http.createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(WORKSPACES_PAYLOAD));
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

function runCli(args: string[], home: string, cwd: string): Promise<CliResult> {
    return new Promise((resolve, reject) => {
        const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home };
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
        }, 15_000);

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

describe('workspace set confirmation (cli#112)', () => {
    let root: string;
    let home: string;
    let cwd: string;
    let globalFile: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-workspace-set-'));
        home = path.join(root, 'home');
        cwd = path.join(root, 'work');
        fs.mkdirSync(home, { recursive: true });
        fs.mkdirSync(cwd, { recursive: true });
        globalFile = writeGlobal(home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
        });
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('confirms with org and slug so same-named workspaces never confirm identically', async () => {
        const result = await runCli(['workspace', 'set', 'acme-south-ws', '--global'], home, cwd);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Workspace set to: Main — organization Acme, slug acme-south-ws (019f-b)');
    });

    it('refuses a name shared by two workspaces instead of picking one', async () => {
        const result = await runCli(['workspace', 'set', 'Main', '--global'], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('is ambiguous');
        expect(result.stderr).toContain('acme-north-ws');
        expect(result.stderr).toContain('acme-south-ws');
    });

    it('suggests on a miss and writes nothing', async () => {
        const result = await runCli(['workspace', 'set', 'acme-south', '--global'], home, cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Did you mean: acme-south-ws (Acme)?');
        const written = JSON.parse(fs.readFileSync(globalFile, 'utf-8'));
        expect(written).not.toHaveProperty('workspaceId');
    });
});

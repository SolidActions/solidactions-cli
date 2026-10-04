/**
 * Device login whose workspace discovery answers 401 (cli#181 audit).
 *
 * The approved credential is already saved when discovery runs, so the 401
 * message keeps its saved-credential explanation, but it must also name the
 * host that refused (userinfo stripped, as every printed host is). Runs the
 * built CLI (`node dist/index.js login --device`) against a real in-process
 * HTTP server with a temp HOME and asserts stdout, stderr, the exit status
 * and the saved file.
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
let requested: string[] = [];

beforeAll(async () => {
    server = http.createServer((req, res) => {
        requested.push(`${req.method} ${req.url}`);
        if (req.method === 'POST' && req.url === '/oauth/device/code') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                device_code: 'device-code',
                user_code: 'ABCD-EFGH',
                verification_uri: `http://127.0.0.1:${port}/device`,
                expires_in: 60,
                interval: 0.001,
            }));
            return;
        }
        if (req.method === 'POST' && req.url === '/oauth/token') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ access_token: 'approved-token', expires_in: 3600 }));
            return;
        }
        if (req.method === 'GET' && req.url === '/api/v1/workspaces') {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'Unauthenticated.' }));
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));

interface CliResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

function runDeviceLogin(root: string, host: string): Promise<CliResult> {
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    return new Promise<CliResult>((resolve, reject) => {
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
        delete env.SOLIDACTIONS_HOST;
        delete env.SOLIDACTIONS_API_KEY;
        delete env.SOLIDACTIONS_WORKSPACE_ID;
        const child = childProcess.spawn(process.execPath, [CLI_BINARY, 'login', '--device', '--global', '--host', host], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

describe('device login when workspace discovery answers 401', () => {
    let root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-device-401-'));
        requested = [];
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('names the refusing host, keeps the saved-credential explanation, and exits 1', async () => {
        const savedPath = path.join(root, 'home', '.solidactions', 'config.json');

        const result = await runDeviceLogin(root, `http://127.0.0.1:${port}`);

        expect(result.code).toBe(1);
        expect(requested).toEqual(['POST /oauth/device/code', 'POST /oauth/token', 'GET /api/v1/workspaces']);
        expect(result.stderr).toContain(`Authentication was saved to ${savedPath}, but http://127.0.0.1:${port} rejected it during workspace discovery.`);
        expect(fs.existsSync(savedPath)).toBe(true);
    });
});

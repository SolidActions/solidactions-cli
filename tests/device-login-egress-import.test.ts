import axios, { AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requestDeviceCode } from '../src/commands/device-login';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');
const EXPECTED_MESSAGE = 'Sandbox network egress appears to be blocking app.solidactions.com. '
    + "Allow-list app.solidactions.com in your provider's network settings, "
    + 'start a new agent session if required, then retry. '
    + 'See https://www.solidactions.com/docs/troubleshooting/#sandbox-egress';

let proxy: http.Server;
let proxyPort: number;

beforeAll(async () => {
    proxy = http.createServer((_req, res) => {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('host not permitted by hosted sandbox');
    });
    await new Promise<void>((resolve) => {
        proxy.listen(0, '127.0.0.1', () => {
            proxyPort = (proxy.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => new Promise<void>((resolve, reject) => {
    proxy.close((error) => error ? reject(error) : resolve());
}));

function runCli(home: string): Promise<{ stdout: string; stderr: string; status: number | null }> {
    return new Promise((resolve, reject) => {
        const proxyUrl = `http://127.0.0.1:${proxyPort}`;
        const child = childProcess.spawn(process.execPath, [
            CLI_BINARY,
            'login',
            '--device',
            '--global',
            '--host',
            'http://app.solidactions.com',
        ], {
            env: {
                ...process.env,
                HOME: home,
                HTTP_PROXY: proxyUrl,
                http_proxy: proxyUrl,
                NO_PROXY: '',
                no_proxy: '',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`CLI timed out. stdout: ${stdout} stderr: ${stderr}`));
        }, 15_000);
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', (status) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, status });
        });
    });
}

describe('device-login entry registers the shared Axios error interceptor', () => {
    it('augments a request when this test imports only the device-login entry path', async () => {
        const originalAdapter = axios.defaults.adapter;
        axios.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
            const response = {
                status: 403,
                statusText: 'Forbidden',
                headers: {},
                config,
                data: 'host not permitted by hosted sandbox',
            };
            throw new AxiosError(
                'Request failed with status code 403',
                'ERR_BAD_REQUEST',
                config,
                null,
                response,
            );
        };

        try {
            await expect(requestDeviceCode('https://app.solidactions.com'))
                .rejects.toMatchObject({ message: EXPECTED_MESSAGE });
        } finally {
            axios.defaults.adapter = originalAdapter;
        }
    });

    it('prints the diagnosis through the compiled binary top-level catch path', async () => {
        expect(fs.existsSync(CLI_BINARY)).toBe(true);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-egress-spawn-'));
        const home = path.join(root, 'home');
        fs.mkdirSync(home);

        try {
            const result = await runCli(home);
            expect(result.status).toBe(1);
            expect(result.stdout).toContain('Requesting device authorization');
            expect(result.stderr.trim()).toBe(EXPECTED_MESSAGE);
            expect(`${result.stdout}\n${result.stderr}`).not.toContain('Claude');
            expect(`${result.stdout}\n${result.stderr}`).not.toContain('Organization settings');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

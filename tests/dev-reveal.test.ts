import http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';
import { describe, it, expect, afterEach } from 'vitest';
import { buildSaApiClient, runDev, type PlatformVar } from '../src/commands/dev';
import { Config } from '../src/utils/config';

const ECHO_FIXTURE = path.resolve(__dirname, '../fixtures/echo.ts');

let server: http.Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function startServer(handler: http.RequestListener): Promise<string> {
    return new Promise((resolve) => {
        server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server!.address() as AddressInfo;
            resolve(`http://127.0.0.1:${port}`);
        });
    });
}

function cfg(host: string): Config {
    return { host, apiKey: 'test-api-key', workspaceId: 'ws-123' } as Config;
}

describe('buildSaApiClient reveal behavior', () => {
    it('requests reveal=true and returns secret values when permitted', async () => {
        const seen: string[] = [];
        const host = await startServer((req, res) => {
            seen.push(req.url!);
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify([
                { env_name: 'SECRET_VAR', is_secret: true, source_type: 'local', resolved_value: 's3cret' },
            ]));
        });

        const client = buildSaApiClient(cfg(host), 'my-proj');
        const vars = await client.fetchVarsAndConnections('dev');

        expect(seen[0]).toContain('reveal=true');
        expect(vars[0].resolved_value).toBe('s3cret');
    });

    it('falls back without reveal on 403 token_missing_ability', async () => {
        const seen: string[] = [];
        const host = await startServer((req, res) => {
            seen.push(req.url!);
            res.setHeader('content-type', 'application/json');
            if (req.url!.includes('reveal=true')) {
                res.statusCode = 403;
                res.end(JSON.stringify({ code: 'token_missing_ability', required_ability: 'env:reveal' }));
                return;
            }
            res.end(JSON.stringify([
                { env_name: 'SECRET_VAR', is_secret: true, source_type: 'local', resolved_value: null },
            ]));
        });

        const client = buildSaApiClient(cfg(host), 'my-proj');
        const vars = await client.fetchVarsAndConnections('dev');

        expect(seen).toHaveLength(2);
        expect(seen[1]).not.toContain('reveal=true');
        expect(vars[0].resolved_value).toBeNull();
        expect(client.revealDenied).toBe(true);
    });

    it('rethrows non-ability 403s', async () => {
        const host = await startServer((_req, res) => {
            res.statusCode = 403;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ code: 'workspace_forbidden' }));
        });

        const client = buildSaApiClient(cfg(host), 'my-proj');
        await expect(client.fetchVarsAndConnections('dev')).rejects.toThrow();
    });
});

describe('runDev', () => {
    it('reports secrets withheld for lacking env:reveal distinctly from a genuinely unset secret', async () => {
        const out = await runDev({
            entry: ECHO_FIXTURE,
            input: '{"n":1}',
            env: 'staging',
            api: {
                projectSlug: 'test-project-staging',
                revealDenied: true,
                async fetchVarsAndConnections(): Promise<PlatformVar[]> {
                    return [
                        { env_name: 'SECRET_VAR', resolved_value: null, is_secret: true, source_type: 'plain' },
                    ];
                },
            },
        });

        expect(out.stdout).toMatch(/1 secret var unavailable: your API key lacks the 'env:reveal' ability/);
        expect(out.stdout).not.toMatch(/not available to local dev/);
    }, 20_000);
});

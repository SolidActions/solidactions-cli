/**
 * Issue #1127 spec §4B item 2 — `pushYamlDeclarations` (shared by both the
 * normal deploy path and the `--config-only` path) must:
 *   1. carry a `database:` declaration through as `yaml_default_database_name`
 *   2. still POST `declarations: []` when the parsed YAML has no env
 *      declarations at all — the endpoint prunes stale mappings on an
 *      explicit empty array, and the CLI used to skip the request entirely
 *      on an empty parsed list, so removing the last YAML database
 *      declaration never reached the endpoint's prune (round-7 spec fix).
 *   3. (PM round #1127 finding 14) throw on a failed sync instead of
 *      swallowing the error internally — deploy() call sites must be able
 *      to see the failure and report it, rather than the request silently
 *      failing while the CLI reports success.
 *
 * Test-double policy: a real in-process HTTP server (Node's http.createServer)
 * captures the POST body. No mock/spy/stub libraries — matches the pattern
 * used in dev.test.ts / proxy-contract.test.ts.
 */
import * as http from 'http';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { pushYamlDeclarations } from '../src/commands/deploy';
import { SolidActionsConfig } from '../src/utils/env';

let server: http.Server;
let port: number;
let lastRequest: { path: string; body: any } | null = null;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            lastRequest = { path: req.url ?? '', body: raw ? JSON.parse(raw) : null };
            if (req.url?.includes('/projects/fail-project/')) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Sync target unreachable.' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'YAML declarations synced.' }));
        });
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
        server.close((err) => (err ? reject(err) : resolve()));
    });
});

beforeEach(() => {
    lastRequest = null;
});

const config = () => ({ host: `http://127.0.0.1:${port}`, apiKey: 'test-key', workspaceId: 'ws-1' });

describe('pushYamlDeclarations: database declarations carried through', () => {
    it('POSTs yaml_default_database_name for a `database:` YAML declaration', async () => {
        const yamlConfig: SolidActionsConfig = {
            workflows: [],
            env: [{ MYDB: { database: 'analytics' } }],
        };

        await pushYamlDeclarations(config(), 'my-project', yamlConfig);

        expect(lastRequest?.path).toBe('/api/v1/projects/my-project/variable-mappings/sync-yaml');
        expect(lastRequest?.body).toEqual({
            declarations: [
                {
                    env_name: 'MYDB',
                    yaml_default_global_key: null,
                    yaml_default_oauth_name: null,
                    yaml_default_database_name: 'analytics',
                    source: 'yaml',
                },
            ],
        });
    });
});

describe('pushYamlDeclarations: empty declaration list still POSTs [] (round-7 spec fix)', () => {
    it('POSTs declarations: [] when the yaml env list is empty', async () => {
        const yamlConfig: SolidActionsConfig = { workflows: [], env: [] };

        await pushYamlDeclarations(config(), 'my-project', yamlConfig);

        expect(lastRequest).not.toBeNull();
        expect(lastRequest?.body).toEqual({ declarations: [] });
    });

    it('POSTs declarations: [] when the yaml has no env key at all (last database declaration removed)', async () => {
        const yamlConfig: SolidActionsConfig = { workflows: [] };

        await pushYamlDeclarations(config(), 'my-project', yamlConfig);

        expect(lastRequest).not.toBeNull();
        expect(lastRequest?.body).toEqual({ declarations: [] });
    });
});

describe('pushYamlDeclarations: a failed sync throws instead of being swallowed (PM round #1127 finding 14)', () => {
    it('rejects when the server responds with a non-2xx status, instead of resolving silently', async () => {
        const yamlConfig: SolidActionsConfig = { workflows: [], env: [] };

        await expect(pushYamlDeclarations(config(), 'fail-project', yamlConfig)).rejects.toThrow();
    });
});

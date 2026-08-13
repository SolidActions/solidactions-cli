import http from 'http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { workspacesList } from '../src/commands/workspaces';
import { makeTmpEnv, writeGlobal } from './helpers';

class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

/**
 * Payload as GET /api/v1/workspaces returns it after app#1214: groups are keyed
 * by tenant id, every row carries tenant_id/tenant_name/tenant_slug. Two of the
 * three orgs are both called "Acme" — the consultant-with-a-client case from
 * cli#111 — and three of the four workspaces are called "Main".
 */
const UUID_KEYED_TWO_ACMES = {
    workspaces: {
        '019ff32d-5d08-7068-ac46-494abcfa9041': [
            {
                id: '019ff32d-5d15-71ee-87e5-db9e1e0772b0',
                name: 'Main',
                slug: 'acme-north-ws',
                role: 'owner',
                tenant_id: '019ff32d-5d08-7068-ac46-494abcfa9041',
                tenant_name: 'Acme',
                tenant_slug: 'acme-north',
            },
        ],
        '019ff32d-5d26-7056-adca-8c5c1c302e0f': [
            {
                id: '019ff32d-5d28-72e9-b9b8-8ab606eb04e6',
                name: 'Main',
                slug: 'acme-south-ws',
                role: 'owner',
                tenant_id: '019ff32d-5d26-7056-adca-8c5c1c302e0f',
                tenant_name: 'Acme',
                tenant_slug: 'acme-south',
            },
        ],
        '019ff323-e255-73e7-b477-57f008c15026': [
            {
                id: '019ff323-e25c-7170-97e6-9a44cfa799f0',
                name: 'Test Workspace',
                slug: 'test-workspace',
                role: 'admin',
                tenant_id: '019ff323-e255-73e7-b477-57f008c15026',
                tenant_name: 'Globex',
                tenant_slug: 'globex',
            },
        ],
        '019ff32d-5d30-731a-ace7-a1876d9c7ec0': [
            {
                id: '019ff32d-5d33-72c0-8f2c-7945860b80d3',
                name: 'Main',
                slug: 'initech-ws',
                role: 'owner',
                tenant_id: '019ff32d-5d30-731a-ace7-a1876d9c7ec0',
                tenant_name: 'Initech',
                tenant_slug: 'initech',
            },
        ],
    },
    scope: null,
};

/** Same-named orgs whose tenants have no slug — the disambiguator falls back to the tenant id. */
const UUID_KEYED_TWO_ACMES_WITHOUT_TENANT_SLUGS = {
    workspaces: {
        '019ff32d-5d08-7068-ac46-494abcfa9041': [
            {
                id: 'ws-north',
                name: 'Main',
                slug: 'acme-north-ws',
                role: 'owner',
                tenant_id: '019ff32d-5d08-7068-ac46-494abcfa9041',
                tenant_name: 'Acme',
            },
        ],
        '019ff32d-5d26-7056-adca-8c5c1c302e0f': [
            {
                id: 'ws-south',
                name: 'Main',
                slug: 'acme-south-ws',
                role: 'owner',
                tenant_id: '019ff32d-5d26-7056-adca-8c5c1c302e0f',
                tenant_name: 'Acme',
            },
        ],
    },
    scope: null,
};

/** Pre-app#1214 payload: groups keyed by the tenant display name. */
const NAME_KEYED_LEGACY = {
    workspaces: {
        'Acme': [
            {
                id: 'ws-1',
                name: 'Main',
                slug: 'acme-ws',
                role: 'owner',
                tenant_id: '019ff32d-5d08-7068-ac46-494abcfa9041',
                tenant_name: 'Acme',
                tenant_slug: 'acme',
            },
        ],
    },
    scope: null,
};

/** Oldest payload shape: name-keyed groups whose rows carry no tenant_* fields at all. */
const NAME_KEYED_WITHOUT_TENANT_FIELDS = {
    workspaces: {
        'Acme': [
            { id: 'ws-1', name: 'Main', slug: 'acme-ws', role: 'owner' },
        ],
    },
};

const EMPTY = { workspaces: {}, scope: null };

describe('workspace list — org headers and workspace slugs (cli#111)', () => {
    let server: http.Server;
    let port: number;
    let responseBody: unknown;
    let env: ReturnType<typeof makeTmpEnv>;
    let originalExit: typeof process.exit;
    let originalLog: typeof console.log;
    let logLines: string[];

    beforeAll(async () => {
        server = http.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responseBody));
        });
        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', () => {
                port = (server.address() as { port: number }).port;
                resolve();
            });
        });
    });

    afterAll(() => new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    }));

    beforeEach(() => {
        env = makeTmpEnv();
        originalExit = process.exit;
        (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };
        originalLog = console.log;
        logLines = [];
        console.log = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };
        responseBody = EMPTY;
    });

    afterEach(() => {
        (process as any).exit = originalExit;
        console.log = originalLog;
        env.cleanup();
    });

    function login(workspaceId?: string) {
        writeGlobal(env.home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'test-token',
            ...(workspaceId ? { workspaceId } : {}),
        });
    }

    it('renders the org display name as the header, never the raw UUID grouping key', async () => {
        responseBody = UUID_KEYED_TWO_ACMES;
        login();

        await workspacesList();

        const headers = logLines.filter((line) => /^ {2}\S/.test(line));
        expect(headers.some((line) => line.includes('Globex'))).toBe(true);
        expect(headers.some((line) => line.includes('Initech'))).toBe(true);
        expect(headers.every((line) => !/^ {2}[0-9a-f-]{36}\s*$/.test(line))).toBe(true);
    });

    it('disambiguates two same-named orgs with their tenant slug', async () => {
        responseBody = UUID_KEYED_TWO_ACMES;
        login();

        await workspacesList();

        const acmeHeaders = logLines.filter((line) => line.trim().startsWith('Acme'));
        expect(acmeHeaders).toHaveLength(2);
        expect(acmeHeaders[0].trim()).toBe('Acme (acme-north)');
        expect(acmeHeaders[1].trim()).toBe('Acme (acme-south)');
    });

    it('leaves a uniquely-named org unqualified', async () => {
        responseBody = UUID_KEYED_TWO_ACMES;
        login();

        await workspacesList();

        expect(logLines.some((line) => line.trim() === 'Globex')).toBe(true);
        expect(logLines.some((line) => line.trim() === 'Initech')).toBe(true);
    });

    it('falls back to the tenant id when same-named orgs have no tenant slug', async () => {
        responseBody = UUID_KEYED_TWO_ACMES_WITHOUT_TENANT_SLUGS;
        login();

        await workspacesList();

        const acmeHeaders = logLines.filter((line) => line.trim().startsWith('Acme'));
        expect(acmeHeaders).toHaveLength(2);
        expect(acmeHeaders[0].trim()).toBe('Acme (019ff32d-5d08-7068-ac46-494abcfa9041)');
        expect(acmeHeaders[1].trim()).toBe('Acme (019ff32d-5d26-7056-adca-8c5c1c302e0f)');
    });

    it('prints each workspace slug, the only field distinguishing three workspaces named Main', async () => {
        responseBody = UUID_KEYED_TWO_ACMES;
        login();

        await workspacesList();

        const mainRows = logLines.filter((line) => line.includes('Main') && line.includes('(owner)'));
        expect(mainRows).toHaveLength(3);
        expect(mainRows.map((line) => line.trim())).toEqual([
            'Main (owner)  acme-north-ws',
            'Main (owner)  acme-south-ws',
            'Main (owner)  initech-ws',
        ]);
    });

    it('keeps marking the pinned workspace as current', async () => {
        responseBody = UUID_KEYED_TWO_ACMES;
        login('019ff32d-5d28-72e9-b9b8-8ab606eb04e6');

        await workspacesList();

        const current = logLines.filter((line) => line.includes('← current'));
        expect(current).toHaveLength(1);
        expect(current[0]).toContain('acme-south-ws');
    });

    it('still prints each workspace id', async () => {
        responseBody = UUID_KEYED_TWO_ACMES;
        login();

        await workspacesList();

        expect(logLines.some((line) => line.trim() === 'ID: 019ff32d-5d15-71ee-87e5-db9e1e0772b0')).toBe(true);
        expect(logLines.some((line) => line.trim() === 'ID: 019ff323-e25c-7170-97e6-9a44cfa799f0')).toBe(true);
    });

    it('renders a pre-app#1214 name-keyed payload identically', async () => {
        responseBody = NAME_KEYED_LEGACY;
        login();

        await workspacesList();

        expect(logLines.some((line) => line.trim() === 'Acme')).toBe(true);
        expect(logLines.some((line) => line.trim() === 'Main (owner)  acme-ws')).toBe(true);
    });

    it('falls back to the grouping key when rows carry no tenant fields', async () => {
        responseBody = NAME_KEYED_WITHOUT_TENANT_FIELDS;
        login();

        await workspacesList();

        expect(logLines.some((line) => line.trim() === 'Acme')).toBe(true);
    });

    it('reports an empty workspace list', async () => {
        responseBody = EMPTY;
        login();

        await workspacesList();

        expect(logLines.some((line) => line.includes('No workspaces found.'))).toBe(true);
    });
});

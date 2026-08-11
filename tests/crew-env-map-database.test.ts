import * as http from 'http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    crewEnvMapDatabase,
    matchWorkspaceDatabase,
} from '../src/commands/crew-env-map-database';
import { makeTmpEnv, writeGlobal } from './helpers';

interface CapturedRequest {
    method: string | undefined;
    path: string | undefined;
    headers: http.IncomingHttpHeaders;
    body: any;
}

interface QueuedResponse {
    status: number;
    body: any;
}

let server: http.Server;
let port: number;
let captures: CapturedRequest[] = [];
let responses: QueuedResponse[] = [];

function queue(status: number, body: any): void {
    responses.push({ status, body });
}

beforeAll(async () => {
    server = http.createServer((request, response) => {
        let rawBody = '';
        request.on('data', (chunk) => { rawBody += chunk; });
        request.on('end', () => {
            captures.push({
                method: request.method,
                path: request.url,
                headers: request.headers,
                body: rawBody ? JSON.parse(rawBody) : null,
            });
            const queued = responses.shift() ?? { status: 500, body: { message: 'No response queued.' } };
            response.writeHead(queued.status, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(queued.body));
        });
    });

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
}));

beforeEach(() => {
    captures = [];
    responses = [];
});

function setupConfig(): () => void {
    const { cleanup } = makeTmpEnv();
    writeGlobal(process.env.HOME!, {
        host: `http://127.0.0.1:${port}`,
        apiKey: 'test-api-key',
        workspaceId: 'workspace-id',
    });

    return cleanup;
}

function captureConsole(): { logs: string[]; restore: () => void } {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: any[]) => { logs.push(args.map(String).join(' ')); };

    return { logs, restore: () => { console.log = original; } };
}

describe('matchWorkspaceDatabase', () => {
    const databases = [
        { id: 'db-1', name: 'Analytics', status: 'ready', deleted_at: null },
        { id: 'db-2', name: 'Archive', status: 'ready', deleted_at: null },
    ];

    it('matches a database by exact id or case-insensitive name', () => {
        expect(matchWorkspaceDatabase('db-1', databases)).toEqual(databases[0]);
        expect(matchWorkspaceDatabase('analytics', databases)).toEqual(databases[0]);
    });

    it('does not select a deleted database', () => {
        expect(matchWorkspaceDatabase('db-1', [{ ...databases[0], deleted_at: '2026-08-11T00:00:00Z' }]))
            .toBeNull();
    });
});

describe('crewEnvMapDatabase', () => {
    it('resolves crew and database names, then PUTs only mapping metadata and prints the exact scope warning', async () => {
        const cleanup = setupConfig();
        const { logs, restore } = captureConsole();
        try {
            queue(200, { data: [{ id: 7, name: 'Ops' }] });
            queue(200, {
                databases: [{
                    id: '019ff-db-id', name: 'Analytics', status: 'ready', deleted_at: null,
                    purge_at: null, size_bytes: 0,
                }],
                quota: { used: 1, limit: 5 },
            });
            queue(201, {
                env_name: 'ANALYTICS_DB', source_type: 'workspace_database',
                workspace_database_id: '019ff-db-id', workspace_database_name: 'Analytics',
                is_secret: true,
            });

            await crewEnvMapDatabase('Ops', 'ANALYTICS_DB', 'analytics');

            expect(captures).toHaveLength(3);
            expect(captures[1]).toMatchObject({
                method: 'POST',
                path: '/api/v1/databases',
                body: { operation: 'list' },
            });
            expect(captures[2]).toMatchObject({
                method: 'PUT',
                path: '/api/v1/crews/7/variables/ANALYTICS_DB',
                body: {
                    source_type: 'workspace_database',
                    workspace_database_id: '019ff-db-id',
                },
            });
            expect(captures[2].headers['authorization']).toBe('Bearer test-api-key');
            expect(logs.join('\n')).toContain('Applies to production, staging, and dev crew sandboxes');
            expect(logs.join('\n')).not.toContain('token');
        } finally {
            restore();
            cleanup();
        }
    });

    it('accepts numeric crew id and database UUID without name lookups beyond the database list', async () => {
        const cleanup = setupConfig();
        const { restore } = captureConsole();
        try {
            queue(200, {
                databases: [{
                    id: '019ff-db-id', name: 'Analytics', status: 'ready', deleted_at: null,
                    purge_at: null, size_bytes: 0,
                }],
                quota: { used: 1, limit: 5 },
            });
            queue(200, {});

            await crewEnvMapDatabase('42', 'ANALYTICS_DB', '019ff-db-id');

            expect(captures).toHaveLength(2);
            expect(captures[0].path).toBe('/api/v1/databases');
            expect(captures[1].path).toBe('/api/v1/crews/42/variables/ANALYTICS_DB');
        } finally {
            restore();
            cleanup();
        }
    });
});

import http from 'http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fetchWorkspaces, matchWorkspace, WorkspaceLookupRecord } from '../src/utils/workspace-lookup';

const workspaces: WorkspaceLookupRecord[] = [
    { id: 'uuid-1', slug: 'mercer', name: 'Mercer Workspace' },
    { id: 'uuid-2', slug: 'second', name: 'Second Workspace' },
    { id: 'uuid-3', name: 'No Slug' },
];

describe('matchWorkspace', () => {
    it('matches by id', () => {
        expect(matchWorkspace('uuid-2', workspaces)?.slug).toBe('second');
    });
    it('matches by slug', () => {
        expect(matchWorkspace('mercer', workspaces)?.id).toBe('uuid-1');
    });
    it('matches by name', () => {
        expect(matchWorkspace('Second Workspace', workspaces)?.id).toBe('uuid-2');
    });
    it('returns undefined when no field matches', () => {
        expect(matchWorkspace('nope', workspaces)).toBeUndefined();
    });
    it('matches a workspace with no slug by name', () => {
        expect(matchWorkspace('No Slug', workspaces)?.id).toBe('uuid-3');
    });
});

describe('fetchWorkspaces', () => {
    let server: http.Server;
    let port: number;
    let responseBody: unknown;

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

    let config: { host: string; apiKey: string };

    beforeEach(() => {
        config = { host: `http://127.0.0.1:${port}`, apiKey: 'test-token' };
    });

    afterEach(() => {
        responseBody = undefined;
    });

    it('annotates each record with org_name and role from a multi-org grouped payload', async () => {
        responseBody = {
            workspaces: {
                'Acme Org': [
                    { id: 'ws-1', name: 'First', slug: 'first', role: 'admin', tenant_id: 't-1', tenant_name: 'Acme Org', tenant_slug: 'acme' },
                ],
                'Globex': [
                    { id: 'ws-2', name: 'Second', slug: 'second', role: 'member', tenant_id: 't-2', tenant_name: 'Globex', tenant_slug: 'globex' },
                ],
            },
            scope: null,
        };

        const result = await fetchWorkspaces(config);

        expect(result.workspaces).toEqual([
            { id: 'ws-1', name: 'First', slug: 'first', role: 'admin', tenant_id: 't-1', tenant_name: 'Acme Org', tenant_slug: 'acme', org_name: 'Acme Org' },
            { id: 'ws-2', name: 'Second', slug: 'second', role: 'member', tenant_id: 't-2', tenant_name: 'Globex', tenant_slug: 'globex', org_name: 'Globex' },
        ]);
    });

    it('falls back to the grouping key for org_name when a record lacks tenant_name', async () => {
        responseBody = {
            workspaces: {
                'Acme Org': [
                    { id: 'ws-1', name: 'First', slug: 'first', role: 'admin' },
                ],
            },
            scope: null,
        };

        const result = await fetchWorkspaces(config);

        expect(result.workspaces).toEqual([
            { id: 'ws-1', name: 'First', slug: 'first', role: 'admin', org_name: 'Acme Org' },
        ]);
    });

    it('passes array-shaped payloads through unchanged', async () => {
        responseBody = {
            workspaces: [
                { id: 'ws-1', name: 'First', slug: 'first' },
                { id: 'ws-2', name: 'Second', slug: 'second', org_name: 'Preset Org', role: 'owner' },
            ],
            scope: null,
        };

        const result = await fetchWorkspaces(config);

        expect(result.workspaces).toEqual([
            { id: 'ws-1', name: 'First', slug: 'first' },
            { id: 'ws-2', name: 'Second', slug: 'second', org_name: 'Preset Org', role: 'owner' },
        ]);
    });
});

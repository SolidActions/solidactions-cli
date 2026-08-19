import http from 'http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    classifyWorkspaceInput,
    describeWorkspaceMatchFailure,
    fetchWorkspaces,
    WorkspaceLookupRecord,
} from '../src/utils/workspace-lookup';

const workspaces: WorkspaceLookupRecord[] = [
    { id: 'uuid-1', slug: 'mercer', name: 'Mercer Workspace' },
    { id: 'uuid-2', slug: 'second', name: 'Second Workspace' },
    { id: 'uuid-3', name: 'No Slug' },
];

describe('classifyWorkspaceInput', () => {
    it('matches by id with no ambiguity check, even when the id string collides with a name elsewhere', () => {
        const collidingWorkspaces: WorkspaceLookupRecord[] = [
            { id: 'uuid-1', slug: 'mercer', name: 'Mercer Workspace' },
            { id: 'uuid-2', slug: 'second', name: 'uuid-1' },
        ];
        const result = classifyWorkspaceInput('uuid-1', collidingWorkspaces);
        expect(result).toEqual({ kind: 'match', workspace: collidingWorkspaces[0] });
    });

    it('matches by slug', () => {
        const result = classifyWorkspaceInput('mercer', workspaces);
        expect(result).toEqual({ kind: 'match', workspace: workspaces[0] });
    });

    it('returns not-found when no field matches', () => {
        const result = classifyWorkspaceInput('nope', workspaces);
        expect(result).toEqual({ kind: 'not-found', input: 'nope' });
    });

    it('matches a workspace with no slug by name', () => {
        const result = classifyWorkspaceInput('No Slug', workspaces);
        expect(result).toEqual({ kind: 'match', workspace: workspaces[2] });
    });

    it('two workspaces sharing a slug are ambiguous', () => {
        const dupSlug: WorkspaceLookupRecord[] = [
            { id: 'uuid-1', slug: 'dup', name: 'First' },
            { id: 'uuid-2', slug: 'dup', name: 'Second' },
        ];
        const result = classifyWorkspaceInput('dup', dupSlug);
        expect(result.kind).toBe('ambiguous');
        if (result.kind === 'ambiguous') {
            expect(result.candidates).toEqual(dupSlug);
        }
    });

    it('#1196(1): an org name equal to one of its workspace names, which also owns a second workspace, is ambiguous with both candidates in payload order', () => {
        const orgWorkspaces: WorkspaceLookupRecord[] = [
            { id: 'ws-1', slug: '10tc', name: '10TC', org_name: '10TC', role: 'admin', tenant_id: 't-10tc' },
            { id: 'ws-2', slug: '10tc-sales', name: '10TC Sales', org_name: '10TC', role: 'member', tenant_id: 't-10tc' },
        ];

        const result = classifyWorkspaceInput('10TC', orgWorkspaces);

        expect(result.kind).toBe('ambiguous');
        if (result.kind === 'ambiguous') {
            expect(result.candidates).toEqual(orgWorkspaces);
        }

        const message = describeWorkspaceMatchFailure(result);
        expect(message).toContain('is both an organization name and a workspace name');
        expect(message).toContain('10TC Sales');
        expect(message).toMatch(/slug or ID|slug|ID/i);
        // The org-collision headline must not claim "matches more than one
        // workspace" — only ws-1 is actually NAMED 10TC.
        expect(message).not.toContain('matches more than one workspace');
    });

    it('#1196(1) regression: org-collision candidates preserve payload order even when the name match is NOT listed first', () => {
        const outOfOrderWorkspaces: WorkspaceLookupRecord[] = [
            { id: 'ws-b', slug: 'widgets', name: 'Widgets', org_name: 'Acme', role: 'member', tenant_id: 't-acme' },
            { id: 'ws-a', slug: 'acme-ws', name: 'Acme', org_name: 'Acme', role: 'admin', tenant_id: 't-acme' },
        ];

        const result = classifyWorkspaceInput('Acme', outOfOrderWorkspaces);

        expect(result.kind).toBe('ambiguous');
        if (result.kind === 'ambiguous') {
            expect(result.candidates.map((w) => w.id)).toEqual(['ws-b', 'ws-a']);
        }
    });

    it('a same-named org that owns ONLY the matched workspace still resolves to match', () => {
        const soleOrgWorkspace: WorkspaceLookupRecord[] = [
            { id: 'ws-1', slug: 'acme', name: 'Acme', org_name: 'Acme', role: 'admin', tenant_id: 't-acme' },
        ];

        const result = classifyWorkspaceInput('Acme', soleOrgWorkspace);

        expect(result).toEqual({ kind: 'match', workspace: soleOrgWorkspace[0] });
    });

    it('#1196(2): an org name matching no workspace name is org-only, listing that org\'s workspaces', () => {
        const testOrgWorkspaces: WorkspaceLookupRecord[] = [
            { id: 'ws-1', slug: 'ops', name: 'Operations', org_name: 'Test Org', role: 'admin', tenant_id: 't-test' },
            { id: 'ws-2', slug: 'eng', name: 'Engineering', org_name: 'Test Org', role: 'member', tenant_id: 't-test' },
        ];

        const result = classifyWorkspaceInput('Test Org', testOrgWorkspaces);

        expect(result).toEqual({ kind: 'org-only', input: 'Test Org', orgWorkspaces: testOrgWorkspaces });

        const message = describeWorkspaceMatchFailure(result);
        expect(message).toContain('"Test Org" is an organization, not a workspace.');
        expect(message).toContain('Operations');
        expect(message).toContain('Engineering');
    });

    it('#1196(3): one workspace name present in two different orgs is ambiguous with both candidates and their org names', () => {
        const crossOrgWorkspaces: WorkspaceLookupRecord[] = [
            { id: 'ws-1', slug: 'acme-shared', name: 'Shared Name', org_name: 'Acme Org', role: 'admin', tenant_id: 't-acme' },
            { id: 'ws-2', slug: 'globex-shared', name: 'Shared Name', org_name: 'Globex Org', role: 'member', tenant_id: 't-globex' },
        ];

        const result = classifyWorkspaceInput('Shared Name', crossOrgWorkspaces);

        expect(result.kind).toBe('ambiguous');
        if (result.kind === 'ambiguous') {
            expect(result.candidates).toEqual(crossOrgWorkspaces);
        }

        const message = describeWorkspaceMatchFailure(result);
        expect(message).toContain('is ambiguous — it matches more than one workspace');
        expect(message).toContain('Acme Org');
        expect(message).toContain('Globex Org');
        // Neither org's name equals the shared workspace name, so this must
        // NOT get the org-collision wording.
        expect(message).not.toContain('is both an organization name and a workspace name');
    });

    it('falls back to tenant_name for org matching when org_name is absent', () => {
        const tenantNameOnly: WorkspaceLookupRecord[] = [
            { id: 'ws-1', slug: 'ops', name: 'Operations', tenant_name: 'Test Org', role: 'admin' },
        ];

        const result = classifyWorkspaceInput('Test Org', tenantNameOnly);

        expect(result).toEqual({ kind: 'org-only', input: 'Test Org', orgWorkspaces: tenantNameOnly });
    });
});

describe('describeWorkspaceMatchFailure', () => {
    it('returns the existing not-found message for a not-found result', () => {
        const message = describeWorkspaceMatchFailure({ kind: 'not-found', input: 'nope' });
        expect(message).toBe(
            'Workspace "nope" not found. Run `solidactions workspace list` to list available workspaces.',
        );
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

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { selectWorkspaceInteractively } from '../src/commands/login';

const workspaces = [
    { id: 'ws-1', name: 'First Workspace', slug: 'first-workspace' },
    { id: 'ws-2', name: 'Second Workspace', slug: 'second-workspace' },
];

describe('interactive login workspace selection', () => {
    it('re-prompts after invalid input and returns a later valid selection', async () => {
        const answers = ['not-a-number', '3', '2'];
        const selected = await selectWorkspaceInteractively(workspaces, {
            question: async () => answers.shift(),
        });

        expect(selected?.id).toBe('ws-2');
    });

    it('treats EOF as cancellation without selecting a workspace', async () => {
        const selected = await selectWorkspaceInteractively(workspaces, {
            question: async () => undefined,
        });

        expect(selected).toBeUndefined();
    });
});

describe('interactive login workspace selection: org grouping', () => {
    let originalLog: typeof console.log;
    let logLines: string[];

    beforeEach(() => {
        originalLog = console.log;
        logLines = [];
        console.log = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };
    });

    afterEach(() => {
        console.log = originalLog;
    });

    const multiOrgWorkspaces = [
        { id: 'ws-1', name: 'First Workspace', slug: 'first-workspace', org_name: 'Acme Org', role: 'admin' },
        { id: 'ws-2', name: 'Second Workspace', slug: 'second-workspace', org_name: 'Acme Org', role: 'member' },
        { id: 'ws-3', name: 'Third Workspace', slug: 'third-workspace', org_name: 'Globex', role: 'owner' },
        { id: 'ws-4', name: 'Fourth Workspace', slug: 'fourth-workspace', org_name: 'Globex', role: 'member' },
    ];

    it('prints one header per org and numbers continuously across groups, selecting from the second group by number', async () => {
        const selected = await selectWorkspaceInteractively(multiOrgWorkspaces, {
            question: async () => '4',
        });

        expect(selected?.id).toBe('ws-4');
        expect(logLines.some((line) => line.includes('Acme Org'))).toBe(true);
        expect(logLines.some((line) => line.includes('Globex'))).toBe(true);
        expect(logLines.some((line) => line.includes('1.') && line.includes('First Workspace'))).toBe(true);
        expect(logLines.some((line) => line.includes('2.') && line.includes('Second Workspace'))).toBe(true);
        expect(logLines.some((line) => line.includes('3.') && line.includes('Third Workspace'))).toBe(true);
        expect(logLines.some((line) => line.includes('4.') && line.includes('Fourth Workspace'))).toBe(true);
    });

    it('renders each row as "name (role)"', async () => {
        await selectWorkspaceInteractively(multiOrgWorkspaces, {
            question: async () => '1',
        });

        expect(logLines.some((line) => line.includes('First Workspace (admin)'))).toBe(true);
        expect(logLines.some((line) => line.includes('Fourth Workspace (member)'))).toBe(true);
    });

    it('falls back to a flat numbered list with no headers when no workspace has an org_name', async () => {
        const orglessWorkspaces = [
            { id: 'ws-1', name: 'First Workspace', slug: 'first-workspace' },
            { id: 'ws-2', name: 'Second Workspace', slug: 'second-workspace' },
        ];

        const selected = await selectWorkspaceInteractively(orglessWorkspaces, {
            question: async () => '2',
        });

        expect(selected?.id).toBe('ws-2');
        expect(logLines.some((line) => line.includes('1.') && line.includes('First Workspace'))).toBe(true);
        expect(logLines.some((line) => line.includes('2.') && line.includes('Second Workspace'))).toBe(true);
    });

    it('renders a single header when every workspace shares one org', async () => {
        const singleOrgWorkspaces = [
            { id: 'ws-1', name: 'First Workspace', slug: 'first-workspace', org_name: 'Acme Org', role: 'admin' },
            { id: 'ws-2', name: 'Second Workspace', slug: 'second-workspace', org_name: 'Acme Org', role: 'member' },
        ];

        await selectWorkspaceInteractively(singleOrgWorkspaces, {
            question: async () => '1',
        });

        const headerCount = logLines.filter((line) => line.trim() === 'Acme Org').length;
        expect(headerCount).toBe(1);
        expect(logLines.some((line) => line.includes('1.') && line.includes('First Workspace (admin)'))).toBe(true);
        expect(logLines.some((line) => line.includes('2.') && line.includes('Second Workspace (member)'))).toBe(true);
    });

    it('prints a line naming the grouping level as organization when grouped', async () => {
        await selectWorkspaceInteractively(multiOrgWorkspaces, {
            question: async () => '1',
        });

        expect(logLines.some((line) => line.toLowerCase().includes('grouped by organization'))).toBe(true);
    });

    it('does not print the organization grouping line for a flat org-less list', async () => {
        const orglessWorkspaces = [
            { id: 'ws-1', name: 'First Workspace', slug: 'first-workspace' },
            { id: 'ws-2', name: 'Second Workspace', slug: 'second-workspace' },
        ];

        await selectWorkspaceInteractively(orglessWorkspaces, {
            question: async () => '1',
        });

        expect(logLines.some((line) => line.toLowerCase().includes('organization'))).toBe(false);
    });

    it('echoes the resolved selection with its org name after a valid pick', async () => {
        const selected = await selectWorkspaceInteractively(multiOrgWorkspaces, {
            question: async () => '4',
        });

        expect(selected?.id).toBe('ws-4');
        expect(logLines.some((line) => line.includes('Selected: Fourth Workspace') && line.includes('Globex'))).toBe(true);
    });

    it('echoes the resolved selection without an org clause when the list has no orgs', async () => {
        const orglessWorkspaces = [
            { id: 'ws-1', name: 'First Workspace', slug: 'first-workspace' },
            { id: 'ws-2', name: 'Second Workspace', slug: 'second-workspace' },
        ];

        await selectWorkspaceInteractively(orglessWorkspaces, {
            question: async () => '2',
        });

        expect(logLines.some((line) => line.includes('Selected: Second Workspace') && !line.includes('organization'))).toBe(true);
    });

    it('disambiguates two workspaces sharing the same name across different orgs via org headers and qualified rows', async () => {
        const sameNameAcrossOrgs = [
            { id: 'ws-1', name: 'Production', slug: 'production-acme', org_name: 'Acme Org', role: 'admin' },
            { id: 'ws-2', name: 'Production', slug: 'production-globex', org_name: 'Globex', role: 'member' },
        ];

        const selected = await selectWorkspaceInteractively(sameNameAcrossOrgs, {
            question: async () => '2',
        });

        expect(selected?.id).toBe('ws-2');
        expect(logLines.some((line) => line.trim() === 'Acme Org')).toBe(true);
        expect(logLines.some((line) => line.trim() === 'Globex')).toBe(true);
        expect(logLines.some((line) => line.includes('Selected: Production') && line.includes('Globex'))).toBe(true);
    });

    it('names the org in the auto-selected single-workspace confirmation when known', async () => {
        const singleWorkspaceWithOrg = [
            { id: 'ws-1', name: 'Only Workspace', slug: 'only-workspace', org_name: 'Acme Org', role: 'owner' },
        ];

        const selected = await selectWorkspaceInteractively(singleWorkspaceWithOrg);

        expect(selected?.id).toBe('ws-1');
        expect(logLines.some((line) => line.includes('Auto-selected workspace: Only Workspace') && line.includes('Acme Org'))).toBe(true);
    });
});

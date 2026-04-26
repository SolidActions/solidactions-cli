import { describe, expect, it } from 'vitest';
import { matchWorkspace, WorkspaceLookupRecord } from '../src/utils/workspace-lookup';

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

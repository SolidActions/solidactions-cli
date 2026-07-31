import { describe, expect, it } from 'vitest';
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

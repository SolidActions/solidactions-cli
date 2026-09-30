import { Config } from '../../src/utils/config';
import { callCrewsTool } from '../../src/utils/mcp';

/**
 * Leak-proof cleanup for live tests. Register each thing BEFORE the call that creates it
 * (so a create that half-succeeds is still cleaned up), then `await cleanup.run()` in afterAll.
 * Items are deleted in reverse registration order (skill, role, crew), each in its own
 * try/catch; a delete that throws or answers ok:false is logged, never silently swallowed.
 * "Not found" is expected for anything the test already deleted or never got to create.
 */
export function createCleanup(config: Config) {
    const items: Array<{ label: string; tool: string; args: Record<string, unknown> }> = [];
    const add = (label: string, tool: string, args: Record<string, unknown>) => { items.push({ label, tool, args }); };

    return {
        crew: (name: string) => add(`crew ${name}`, 'crews_delete', { action: 'delete_crew', name }),
        role: (name: string, inCrew?: string) =>
            add(`role ${name}`, 'crews_delete', { action: 'delete_role', name, ...(inCrew ? { in_crew: inCrew } : {}) }),
        sharedSkill: (identifier: string) => add(`shared skill ${identifier}`, 'crews_delete', { action: 'delete_skill', identifier }),

        async run(): Promise<void> {
            for (const item of items.slice().reverse()) {
                try {
                    const r = await callCrewsTool(config, item.tool, item.args);
                    if (!r.ok && !/not[_ ]found/i.test(JSON.stringify(r.data))) {
                        console.warn(`live cleanup: ${item.label} returned ok:false: ${JSON.stringify(r.data)}`);
                    }
                } catch (e: any) {
                    console.warn(`live cleanup: ${item.label} threw: ${e?.message ?? e}`);
                }
            }
        },
    };
}

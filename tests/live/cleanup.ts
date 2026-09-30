import { Config } from '../../src/utils/config';
import { callCrewsTool, callDocsTool, McpToolResult } from '../../src/utils/mcp';

/**
 * Leak-proof cleanup for live tests. Register each thing BEFORE the call that creates it
 * (so a create that half-succeeds is still cleaned up), then `await cleanup.run()` in afterAll.
 * Items are deleted in reverse registration order (skill, role, crew), each in its own
 * try/catch; a delete that throws or answers ok:false is logged, never silently swallowed.
 * "Not found" is expected for anything the test already deleted or never got to create.
 */
export function createCleanup(config: Config) {
    const items: Array<{ label: string; call: () => Promise<McpToolResult> }> = [];
    const add = (label: string, tool: string, args: Record<string, unknown>) => {
        items.push({ label, call: () => callCrewsTool(config, tool, args) });
    };

    return {
        crew: (name: string) => add(`crew ${name}`, 'crews_delete', { action: 'delete_crew', name }),
        role: (name: string, inCrew?: string) =>
            add(`role ${name}`, 'crews_delete', { action: 'delete_role', name, ...(inCrew ? { in_crew: inCrew } : {}) }),
        sharedSkill: (identifier: string) => add(`shared skill ${identifier}`, 'crews_delete', { action: 'delete_skill', identifier }),
        /**
         * A top-level docs folder, deleted (with everything in it) by name. The id is looked up at
         * run() time, because the folder does not exist yet when this is registered. A folder that
         * is not in the docs root is fine: the test never created it, or already removed it.
         */
        docFolder: (name: string) => {
            items.push({
                label: `docs folder ${name}`,
                call: async () => {
                    const listed = await callDocsTool(config, { action: 'list' });
                    if (!listed.ok) return listed;
                    const folder = (listed.data?.folders ?? []).find((f: any) => f.name === name);
                    if (!folder) return { ok: false, data: { code: 'not_found', message: `docs folder ${name} not found` } } as McpToolResult;
                    return callCrewsTool(config, 'docs_delete', { action: 'delete_folder', id: folder.id });
                },
            });
        },

        async run(): Promise<void> {
            for (const item of items.slice().reverse()) {
                try {
                    const r = await item.call();
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

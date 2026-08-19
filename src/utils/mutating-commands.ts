/**
 * Read-vs-write classification for every leaf CLI command.
 *
 * Used to decide whether an implicitly-resolved workspace (inferred from
 * CWD) needs a confirmation prompt before a command runs: reads are safe to
 * run against the wrong workspace, writes are not.
 *
 * Classified by reading each command's implementation under src/commands/
 * and checking which HTTP verb it sends. Most commands call axios directly
 * (GET = read, POST/PUT/PATCH/DELETE = write). The crews/roles MCP commands
 * (skill push/publish/pull/list/view/delete, role push) are transported as a
 * single JSON-RPC `tools/call` POST regardless of semantics (see
 * `postMcpTool` in src/utils/mcp.ts) — for those, the classification follows
 * the MCP tool's `action` argument instead of the outer HTTP verb
 * ('list'/'read' = read, 'create'/'edit'/'delete'/'take_snapshot'/
 * 'sandbox_exec' = write).
 */

/** Space-joined command paths that mutate SERVER state, e.g. 'project deploy'. */
export const MUTATING_COMMANDS: ReadonlySet<string> = new Set([
    'database create',
    'database delete',
    'database undelete',
    'database exec',
    'database import',
    'database push',
    'project create',
    'project deploy',
    'project enable',
    'project disable',
    'workflow enable',
    'workflow disable',
    'run start',
    'env set',
    'env delete',
    'env reset',
    'env map',
    'env push',
    'crew env set',
    'crew env map-database',
    'crew env delete',
    'crew env push',
    'schedule set',
    'schedule enable',
    'schedule disable',
    'schedule reset',
    'schedule delete',
    'skill push',
    'skill publish',
    'skill delete',
    // --target sandbox executes the stored skill via the crews MCP
    // 'sandbox_exec' action, which runs real code with side effects on the
    // server-managed sandbox — the same class of action as `run start`.
    'skill exec',
    'role push',
    'doc push',
    'doc upload',
]);

/** Space-joined command paths that do not mutate server state. */
export const READONLY_COMMANDS: ReadonlySet<string> = new Set([
    'login',
    'init',
    'logout',
    'whoami',
    // Runs locally; does not touch server state for any workspace.
    'dev',
    'database list',
    'database schema',
    'database query',
    // Downloads a dump and writes it to a local file only, like the `pull`
    // family below — the data-plane request happens to be a POST, but no
    // server state changes.
    'database dump',
    // project/env/database/doc/skill pull all write LOCAL files from a GET —
    // they cannot corrupt the wrong workspace's server state.
    'database pull',
    'project view',
    'project pull',
    'project logs',
    'project list',
    'workflow view',
    'run list',
    'run view',
    'env list',
    'env pull',
    'crew env list',
    'schedule list',
    'webhook list',
    'webhook secret',
    'workspace list',
    // Excluded from the workspace-mismatch guard entirely elsewhere; still
    // classified explicitly here because it writes local config only.
    'workspace set',
    'oauth-action search',
    'oauth-action list',
    'oauth-action view',
    'oauth-action platforms',
    'connection list',
    'ai init',
    'ai examples',
    'skill pull',
    'skill list',
    'skill view',
    // Fetches crew variables (read) and runs the working copy locally, like
    // `dev` — never writes server state.
    'skill dev',
    'doc pull',
]);

/**
 * True when the given commander path is a server-mutating command.
 *
 * A path not present in either MUTATING_COMMANDS or READONLY_COMMANDS
 * returns true (fail safe): an unclassified command is treated as a write,
 * so a newly-added command can never silently skip the workspace-mismatch
 * guard.
 */
export function isMutatingCommand(path: readonly string[]): boolean {
    const key = path.join(' ');
    if (MUTATING_COMMANDS.has(key)) {
        return true;
    }
    if (READONLY_COMMANDS.has(key)) {
        return false;
    }
    return true;
}

let activeCommandPath: readonly string[] | undefined = undefined;

/**
 * Set the command path from the commander `preAction` hook.
 * Module-level state — set once at CLI startup before the command runs.
 * Pass `undefined` to clear (used in tests).
 */
export function setActiveCommandPath(path: readonly string[] | undefined): void {
    activeCommandPath = path;
}

/** The path recorded by setActiveCommandPath, or undefined. */
export function getActiveCommandPath(): readonly string[] | undefined {
    return activeCommandPath;
}

/** True when the recorded active command is mutating. False when nothing was recorded. */
export function activeCommandIsMutating(): boolean {
    if (activeCommandPath === undefined) {
        return false;
    }
    return isMutatingCommand(activeCommandPath);
}

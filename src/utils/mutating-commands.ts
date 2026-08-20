/**
 * Read-vs-write classification for every leaf CLI command.
 *
 * Used to decide whether an implicitly-resolved workspace (inferred from
 * CWD) needs a confirmation prompt before a command runs: reads are safe to
 * run against the wrong workspace, writes are not.
 *
 * Classified by reading each command's implementation under src/commands/
 * and checking which HTTP verb it sends. Most commands call axios directly
 * (GET = read, POST/PUT/PATCH/DELETE = write). The MCP-backed commands
 * (crews/roles tools: skill push/publish/pull/list/view/delete, role push;
 * docs_vault tool: doc push/pull) are transported as a single JSON-RPC
 * `tools/call` POST regardless of semantics (see `postMcpTool` in
 * src/utils/mcp.ts) — for those, the classification follows the MCP tool's
 * `action` argument instead of the outer HTTP verb ('list'/'read' = read,
 * 'create'/'edit'/'delete'/'take_snapshot'/'sandbox_exec' = write).
 *
 * Classification is per command PATH only — it does not see flags. A
 * command that can write under some flag combination but not others (e.g.
 * `database pull --writable`) must still be classified MUTATING wholesale;
 * there is no flag-aware variant of this lookup. Over-inclusion is the
 * intended bias: the workspace-mismatch guard this file feeds only prompts
 * when the resolved workspace ALSO changed and was CWD-inferred, so
 * classifying a mostly-read command as MUTATING costs at most one extra
 * confirmation, whereas the reverse can silently write to the wrong
 * workspace.
 */

/** Space-joined command paths that mutate SERVER state, e.g. 'project deploy'. */
export const MUTATING_COMMANDS: ReadonlySet<string> = new Set([
    'database create',
    'database delete',
    'database undelete',
    'database exec',
    'database import',
    'database push',
    // Plain `database pull` is read-only (GET, writes a local file only —
    // same family as project/env/doc/skill pull). But `--writable`
    // (databaseWritablePullWithConfig, src/commands/database.ts:1320) mints
    // a WRITE-mode credential and opens a live interactive SQL REPL that
    // executes real statements (client.execute/executeMultiple, ~lines
    // 1540-1560) against the server-backed replica. Classification can't see
    // flags, so the whole leaf must be MUTATING to keep the workspace guard
    // from silently letting --writable writes through against the wrong
    // CWD-inferred workspace.
    'database pull',
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
    // Hidden deprecated alias of `skill dev` (same skillDev() function, removed
    // in v2.0.0) — omitted from this list originally; without it the fail-safe
    // default classified it MUTATING, which broke the alias's identical-output
    // contract by making it print the mutating-command workspace banner (#1437).
    'skill run',
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

let assumeYes = false;

/**
 * Set from the preAction hook, reflecting the active command's own --yes/-y flag.
 * Module-level state — set once at CLI startup before the command runs.
 */
export function setAssumeYes(value: boolean): void {
    assumeYes = value;
}

/** The value recorded by setAssumeYes. */
export function getAssumeYes(): boolean {
    return assumeYes;
}

let supportsAssumeYes = true;

/**
 * Set from the preAction hook, reflecting whether the active command itself declares a
 * --yes/-y option (most mutating commands don't — see MUTATING_COMMANDS' doc comment).
 * Module-level state — set once at CLI startup before the command runs.
 */
export function setSupportsAssumeYes(value: boolean): void {
    supportsAssumeYes = value;
}

/** The value recorded by setSupportsAssumeYes. */
export function getSupportsAssumeYes(): boolean {
    return supportsAssumeYes;
}

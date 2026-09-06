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
 * Classification is per command PATH only, by default — it does not see
 * flags. Over-inclusion is the intended bias for anything not explicitly
 * refined below: the workspace-mismatch guard this file feeds only prompts
 * when the resolved workspace ALSO changed and was CWD-inferred, so
 * classifying a mostly-read command as MUTATING costs at most one extra
 * confirmation, whereas the reverse can silently write to the wrong
 * workspace.
 *
 * FLAG_SENSITIVE_COMMANDS below is a narrow, deliberate refinement layer on
 * top of that path-only answer: a handful of leaves genuinely change from
 * read to write depending on a flag (e.g. `database pull --writable`, which
 * opens a live write REPL instead of just writing a local file). Those
 * leaves stay listed in MUTATING_COMMANDS — the conservative, path-only
 * fail-safe — and isMutatingCommand() only consults the flag predicate when
 * it is given actual options to check; called with no options, or for a
 * path that has no entry in the table, it falls straight through to the
 * path-only answer above.
 */

/** Space-joined command paths that mutate SERVER state, e.g. 'project deploy'. */
export const MUTATING_COMMANDS: ReadonlySet<string> = new Set([
    'database create',
    'database delete',
    'database undelete',
    'database exec',
    'database import',
    'database push',
    'database ingest',
    // Export creates durable operation rows and temporary R2 objects and may
    // wake billed compute, even though authorization is read-capability based.
    'database export',
    'database drop-table',
    // `optimize` dispatches a real server-side operation that rewrites the
    // database's stored files (`StartOptimizeOperation` — a job, not just a
    // read of existing state), the same class of deliberate write action as
    // `run start`/`skill exec`.
    'database optimize',
    // Plain `database pull` is read-only (GET, writes a local file only —
    // same family as project/env/doc/skill pull). But `--writable`
    // (databaseWritablePullWithConfig, src/commands/database.ts:1320) mints
    // a WRITE-mode credential and opens a live interactive SQL REPL that
    // executes real statements (client.execute/executeMultiple, ~lines
    // 1540-1560) against the server-backed replica. This is the path-only
    // fail-safe answer (kept for callers that don't pass options, and for
    // completeness/disjointness); FLAG_SENSITIVE_COMMANDS below refines it
    // to the exact `--writable` boundary when options are available.
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
    'database show',
    'database schema',
    'database query',
    // `connect` never calls the server's admission gate — it is a pure,
    // synchronous read of the database row (no side effects at all).
    'database connect',
    // `wake` is the same admission-only call `query` already makes
    // incidentally (both can dispatch the async wake job, never touching
    // application data) — its whole purpose is that read-intent pre-warm,
    // spec §4.2.
    'database wake',
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
    // Never reaches the guard at all: `workspace set` resolves through
    // requireConfig()/requireResolvedConfig(), not requireConfigWithWorkspace(), so
    // applyWorkspaceGuard never runs for it. Listed anyway to keep the classification
    // complete — it writes local config, never server state.
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
 * Command paths whose read/write nature depends on a flag rather than being
 * fixed by path alone. Each predicate takes the leaf command's own parsed
 * options and returns true when that flag combination makes the command a
 * SERVER WRITE. This table is a deliberate hole in the path-only fail-safe
 * above — keep it tiny, and keep the corresponding leaf in MUTATING_COMMANDS
 * so any caller that can't supply options still gets the conservative
 * answer.
 */
export const FLAG_SENSITIVE_COMMANDS: ReadonlyMap<string, (options: Record<string, unknown>) => boolean> = new Map([
    ['database pull', (options) => options.writable === true],
]);

/**
 * True when the given commander path is a server-mutating command.
 *
 * When `options` is supplied and the path has an entry in
 * FLAG_SENSITIVE_COMMANDS, that entry's predicate decides the answer
 * exactly — this is the only way a `database pull` without `--writable` is
 * classified as read-only. Without options (the caller didn't observe any
 * flags, or the path isn't flag-sensitive), classification falls through to
 * the path-only tables: a path not present in either MUTATING_COMMANDS or
 * READONLY_COMMANDS returns true (fail safe) — an unclassified command is
 * treated as a write, so a newly-added command can never silently skip the
 * workspace-mismatch guard, and an unobserved-flags lookup never guesses
 * read from absence.
 */
export function isMutatingCommand(path: readonly string[], options?: Record<string, unknown>): boolean {
    const key = path.join(' ');
    if (options !== undefined) {
        const predicate = FLAG_SENSITIVE_COMMANDS.get(key);
        if (predicate) {
            return predicate(options);
        }
    }
    if (MUTATING_COMMANDS.has(key)) {
        return true;
    }
    if (READONLY_COMMANDS.has(key)) {
        return false;
    }
    return true;
}

let activeCommandPath: readonly string[] | undefined = undefined;
let activeCommandOptions: Record<string, unknown> | undefined = undefined;

/**
 * Set the command path (and its own parsed options) from the commander
 * `preAction` hook. Module-level state — set once at CLI startup before the
 * command runs. Pass `undefined` for both to clear (used in tests).
 */
export function setActiveCommandPath(path: readonly string[] | undefined, options?: Record<string, unknown>): void {
    activeCommandPath = path;
    activeCommandOptions = path === undefined ? undefined : options;
}

/** The path recorded by setActiveCommandPath, or undefined. */
export function getActiveCommandPath(): readonly string[] | undefined {
    return activeCommandPath;
}

/** The options recorded by setActiveCommandPath, or undefined. */
export function getActiveCommandOptions(): Record<string, unknown> | undefined {
    return activeCommandOptions;
}

/** True when the recorded active command is mutating. False when nothing was recorded. */
export function activeCommandIsMutating(): boolean {
    if (activeCommandPath === undefined) {
        return false;
    }
    return isMutatingCommand(activeCommandPath, activeCommandOptions);
}

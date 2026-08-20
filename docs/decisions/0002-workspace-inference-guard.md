# 2. Workspace-inference guard

- **Status:** Accepted
- **Date:** 2026-08-19
- **Issue:** [SolidActions/solidactions-cli#118](https://github.com/SolidActions/solidactions-cli/issues/118)

## Context

`host`, `apiKey`, and `workspaceId` resolve independently, and `workspaceId` can come from a
`./.solidactions/config.json` discovered by walking up from the current working directory (see
README "Resolution order", layer 2). That is convenient for the common case — `cd` into a
project once, and every command in that folder targets the right workspace — but it also means
the active workspace can change silently just because a command was run from a different
directory than usual. In production use this was reported as a real incident: a CWD-inferred
workspace differed from the one the operator intended, and a write (`project deploy`) landed
against the wrong workspace with no warning.

## Decision

The guard keys on **change**, not on inference alone: it only acts when the resolved
workspace was CWD-inferred (per `isCwdInferredWorkspace` in `src/utils/workspace-guard.ts`)
**and** differs from the workspace the CLI last *wrote* to (recorded in
`~/.solidactions/state.json` — only mutating commands update it; a read-only command must
never consume the change that gates a write confirmation). If the CWD-inferred workspace is
the same one last written to, nothing happens — the normal same-project workflow stays
prompt-free.

An early build recorded `state.json` unconditionally, including for read-only commands. That
let a harmless read (e.g. `project list`) silently disarm the following write's confirmation:
the read would record the newly-inferred workspace as last-used, so the very next write in
that directory saw "last used == resolved" and skipped the guard entirely. Found by live smoke
against the dev stack, not by the test suite. Fixed by gating the `state.json` write on
`options.mutating`.

When the workspace has changed:
- Read-only commands print a `warn:` line naming both workspaces and the config file the new
  one came from, and proceed.
- Server-mutating commands (`isMutatingCommand` in `src/utils/mutating-commands.ts`) instead
  ask for confirmation before proceeding. `-w <id-or-slug-or-name>` and `--yes` both skip the
  prompt; a non-interactive shell with neither is refused.

Every mutating command additionally prints its resolved workspace, organization-qualified, as
its first line of output — independent of whether the guard fired — so the target workspace is
always visible for a write, not just on the first run after a change.

## Alternatives considered

- **Always confirm CWD-inferred writes**, regardless of whether the workspace changed. Rejected:
  the intended workflow is `cd` into a project once and run many commands from there; confirming
  every single one adds friction to the case that isn't dangerous, training operators to
  reflexively answer "yes" and defeating the guard's purpose.
- **Require `-w` on every mutating command.** Rejected: breaks every existing script and
  interactive habit that relies on directory-scoped config; the whole point of local config
  files is to not have to pass `-w` every time.

## Consequences

- A new file, `~/.solidactions/state.json`, is written after every **mutating** command that
  resolves a workspace — read-only commands never write it. It holds only a workspace UUID, an
  optional display label, and a timestamp — no secret — and is advisory: deleting it just means
  the next command has nothing to compare against.
- Command classification (`src/utils/mutating-commands.ts`) fails safe: a command path not
  explicitly listed as read-only or mutating is treated as **mutating** by default, so a newly
  added command can never silently skip the confirmation prompt.

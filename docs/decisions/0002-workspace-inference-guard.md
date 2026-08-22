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
  ask for confirmation before proceeding. Consent to a workspace is exactly two things:
  stating it explicitly (`-w <id-or-slug-or-name>` or `SOLIDACTIONS_WORKSPACE_ID`, both of
  which make the workspace non-inferred and skip the guard outright), or answering the prompt.
  A command's **own** `--yes` is deliberately NOT consent: it acknowledges that command's own
  destructive act — `database push` declares `-y` as a *required* option, `database pull --yes`
  means "overwrite the local file" — and conflating the two made the confirmation structurally
  unreachable on the CLI's highest-blast-radius command. A non-interactive shell is therefore
  refused, period, with a hint naming `-w` only.

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
- **Breaking for existing non-interactive automation.** Any script, cron job, or CI step that
  performs a CWD-inferred write without `-w`/`SOLIDACTIONS_WORKSPACE_ID` now exits 1 once
  `state.json` records a different workspace as the last one written to. This is not limited to
  a first run: on a persistent runner, every run after that box wrote to some other workspace
  refuses, because the comparison is against the last workspace written to globally, not a
  per-directory memory. The migration is to pass `-w <id>` (or export
  `SOLIDACTIONS_WORKSPACE_ID`) in the automation — which is exactly what the refusal prints.
  Accepted deliberately: the failure mode this guard exists to stop is a script writing to the
  wrong workspace silently, and an unattended caller has no one to ask.
- **With no `state.json` at all, the next CWD-inferred write is unguarded — not merely
  uncompared.** The first-run case returns `'none'` rather than prompting, so a fresh machine
  (or a deleted state file) gets exactly one free CWD-inferred write before the guard has a
  baseline to compare against. Accepted: prompting on a first run, before the CLI has ever
  observed a workspace change, is friction with no signal behind it.
  **Superseded by the amendment below (app#1481).**
- The workspace shown in the banner, warning, and prompt is printed **without** its display
  name whenever that name was not resolved from the same config layer as the workspace id
  (e.g. `SOLIDACTIONS_WORKSPACE_ID` set on its own over a config file naming a different
  workspace) — an id alone is less useful than a name, but a name that belongs to another
  workspace is worse than useless on a line whose whole job is saying where a write is going.

## Amendment (2026-08-22, app#1481)

The Consequences bullet above — "with no `state.json` at all, the next CWD-inferred write is
unguarded" — was accepted as a deliberate gap at the time, but it left the very first write on a
fresh install or a fresh CI container with *no signal at all*, not even a warning. That gap is
the accepted residual tracked by [SolidActions/solidactions-app#1481](https://github.com/SolidActions/solidactions-app/issues/1481).

`decideWorkspaceGuard` now returns a new action, `'warn-no-baseline'`, when the resolved
workspace is CWD-inferred, the command is mutating, and there is no recorded last-used
workspace to compare against (no `state.json`, or one that fails to parse). It emits a distinct
`warn:` line — it cannot claim the workspace "changed" or name a "last used" workspace, because
there is nothing to compare against — and then the command proceeds exactly as it would have
before: it prints its usual `Workspace: …` banner and records `state.json`, so the warning fires
once, on write #1, and never again for that same workspace.

Read-only commands are **not** extended by this amendment and still return `'none'` in the
no-baseline case: a read never writes `state.json`, so warning there would nag on every single
read forever rather than exactly once.

`'warn-no-baseline'` deliberately only warns — it does **not** confirm and does **not** refuse in
a non-interactive shell. This was a conscious choice, not an oversight: ADR 0002's own
"Alternatives considered" section already rejected "always confirm CWD-inferred writes" as
training operators to reflexively answer "yes"; extending that to the very first write on a
machine would do the same. More concretely, a refusal here would break every fresh CI runner
that infers its workspace from CWD on its very first run — exactly the case a fresh container
hits every time, not just once.

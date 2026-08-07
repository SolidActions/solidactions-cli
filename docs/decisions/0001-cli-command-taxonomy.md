# 1. CLI command taxonomy for the multi-surface platform

- **Status:** Accepted
- **Date:** 2026-05-23
- **Issue:** [SolidActions/solidactions-cli#34](https://github.com/SolidActions/solidactions-cli/issues/34) — full principles, target tree, and conformer tracking live here.

## Context

`solidactions` began as a workflow-automation deploy tool and is repositioning into a four-pillar "tools to run AI in your business" platform — **Context** (docs), **Tasks** (pegs), **SOPs** (skills/crews/roles), **Automation** (workflows) — with a likely **Compute** layer (sandboxes, edge functions) later. Each surface already has a rich MCP. The CLI is a **local-filesystem bridge first** (push/pull/ingest); full CRUD comes later only if users ask, so names must be forward-compatible.

## Decision

1. **Noun-then-verb**; depth follows *real* parent-child, not MCP nesting (depth 3 only for true containers — the `wrangler kv key` test).
2. **Singular nouns** — `crew`, not `crews` (matches `project`/`run`/`env`).
3. **`push`/`pull` are the bridge verbs; `add` collapses into `push`.** CRUD (`create`/`edit`/`delete`) is a later, orthogonal axis: `push`/`pull` = "I have files," `create`/`edit`/`delete` = "I don't."
4. **Flatten the SOP surface** to three peer top-level nouns — `skill` / `crew` / `role`, **no umbrella**. Role-scoping is a `--role <name>` flag. (`crews skill add <dir>` → `skill push <dir>`.)
5. **Pillars are `--help` section headers + mental model only — never typed path segments** (the `gh` model; needs a Commander `configureHelp` customization).
6. **Verb canon = `view`** for "show one"; migrate `oauth-actions show` → `view`. *(Executed in #84 — see the conformance table below.)*
7. **Hot-path promotion** to bare top-level is limited to unambiguous actions (`deploy`, `dev`); `push`/`pull`/`list` stay noun-scoped.
8. **Verbs come in families; each noun declares its family** — file-sync (`push`/`pull`), content-CRUD (`create`/`edit`/`delete`/`list`/`view`), execution-lifecycle (`start`/`invoke`/…), KV-upsert (`set`, e.g. `env`). "Full CRUD" is not "bolt create/edit/delete onto everything."
9. **Activation-lifecycle uses `enable` / `disable`.** These verbs gate whether
   an executable resource admits new work without deleting its configuration.
   They are distinct from content CRUD and from execution-lifecycle verbs that
   start or invoke one individual run.
10. **The `workflow` noun also declares the single-resource `view` verb.** It
    exposes the stored activation gates and their effective precedence for one
    deployed workflow. This is an inspection operation in the canonical
    "show one" family, not an activation-lifecycle mutation.

### Deferred

- Name for the renamed docs saved-query resource (was "view", collides with the `view` verb): `query` / `lens` / `saved-view`.
- Whether `folder` / `type` become commands at all (depth gate).
- Sandbox framing (5th pillar vs substrate) — cosmetic for the CLI.

## Consequences

- Bridge-era names degrade gracefully into CRUD: flat peer nouns absorb new verbs with no restructuring.
- Three landmines must hold or CRUD forces a later rename: `add`→`push`; rename the docs `view` resource off the `view` verb; treat CRUD as per-noun verb-families.
- Each surface gets a **conformer issue** that follows this north-star (see #34). The branch `feat/crews-skill-add` is the **first conformer** — unblocked by decisions (2) `crew` and (3)/(4) `skill push`.

### Per-noun conformance to (2) singular nouns

| Noun | Status | Notes |
| --- | --- | --- |
| `project` / `run` / `env` / `schedule` / `webhook` / `skill` / `role` / `crew` / `workspace` | Conformant | Singular from the start |
| `doc` | Conformant since #63 | Shipped plural as `docs`; renamed `docs` → `doc` (BREAKING, no deprecation alias) per decision (2). Old `docs push` / `docs pull` / `docs upload` are gone — Commander emits an "unknown command" error with a `Did you mean doc?` hint. The `"docs"` OAuth ability, the `SA-Docs` product name, the `/mcp/docs` + `docs_*` API surface, and the `.solidactions-docs.json` sidecar are **not** part of this rename and stay as-is |
| `oauth-action` | Conformant since #84 | Shipped plural as `oauth-actions`; renamed `oauth-actions` → `oauth-action` (BREAKING, no deprecation alias) per decision (2), and the `show` subcommand migrated to `view` per decision (6) — both in one pass, as the #63 deferral anticipated. Old `oauth-actions <anything>` and `oauth-action show` are gone; Commander emits an "unknown command" error. The `/api/v1/oauth-actions` REST paths, the `oauth_actions` JSON response key, and the `solidactions-oauth-actions` bundled skill filename are **not** part of this rename and stay as-is |

Both known plurals are now reconciled: `doc` (#63) and `oauth-action` (#84). No
top-level noun is currently non-conformant to decision (2), and decision (6) has
no remaining pending migration.

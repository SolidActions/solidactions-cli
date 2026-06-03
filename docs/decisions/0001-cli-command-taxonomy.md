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
6. **Verb canon = `view`** for "show one"; migrate `oauth-actions show` → `view`.
7. **Hot-path promotion** to bare top-level is limited to unambiguous actions (`deploy`, `dev`); `push`/`pull`/`list` stay noun-scoped.
8. **Verbs come in families; each noun declares its family** — file-sync (`push`/`pull`), content-CRUD (`create`/`edit`/`delete`/`list`/`view`), execution-lifecycle (`start`/`invoke`/…), KV-upsert (`set`, e.g. `env`). "Full CRUD" is not "bolt create/edit/delete onto everything."

### Deferred

- Name for the renamed docs saved-query resource (was "view", collides with the `view` verb): `query` / `lens` / `saved-view`.
- Whether `folder` / `type` become commands at all (depth gate).
- Sandbox framing (5th pillar vs substrate) — cosmetic for the CLI.

## Consequences

- Bridge-era names degrade gracefully into CRUD: flat peer nouns absorb new verbs with no restructuring.
- Three landmines must hold or CRUD forces a later rename: `add`→`push`; rename the docs `view` resource off the `view` verb; treat CRUD as per-noun verb-families.
- Each surface gets a **conformer issue** that follows this north-star (see #34). The branch `feat/crews-skill-add` is the **first conformer** — unblocked by decisions (2) `crew` and (3)/(4) `skill push`.

# Slim `ai init` Output and Retire the Legacy Full CLAUDE.md

## Summary

Retire the 1190-line legacy `CLAUDE.md` (and its `AGENTS.md` twin) that `solidactions ai init` currently injects into projects. Replace with a ~50-line slim file that lists hard rules inline and points at the auto-activating skill files. Always install skills; remove the `--no-skills` escape hatch. Target `.claude/skills/` for Claude Code and `.agents/skills/` for Codex/Cursor/Gemini (both are real auto-discovery paths). Add onboarding nudges so AI agents reliably run `ai init` after `init` and reach the skills path instead of falling back to legacy content.

## Motivation

**Today's failure mode:** An AI agent runs `solidactions init`, sees no nudge toward `ai init`, and either skips it or runs it in non-interactive mode — at which point `prompts` returns undefined, the code treats it as "user cancelled," skills silently don't install, and `fetchClaudeMdContent(false)` falls back to the 1190-line legacy `CLAUDE.md`. The AI then has an enormous unstructured reference file instead of the three focused skills that were supposed to load.

**Why slim:** The legacy file duplicates everything `.solidactions/sdk-reference.md` already provides, plus content now owned by the three skills (`solidactions-getting-started`, `solidactions-workflow-coding`, `solidactions-deploy-and-config`). Keeping it is maintenance cost with no upside — skills are the right container for domain-scoped guidance, and the SDK reference is the right container for API truth.

**Why hard rules inline:** If an AI enters a project and never loads the skills (bug, misconfiguration, or tool that doesn't auto-activate), it should still get the handful of rules whose violation causes the worst bugs (determinism, step discipline). Those rules live in the root file AND scoped at the top of each relevant skill — belt + suspenders for the highest-cost mistakes.

## Current State

**`solidactions-examples` repo** (`../solidactions-examples/`):
- `CLAUDE.md` — 1190 lines, full legacy reference
- `AGENTS.md` — 1190 lines, legacy (same content as CLAUDE.md)
- `CLAUDE-skills-pointer.md` — 9 lines, points at skills + SDK reference
- `skills/solidactions-getting-started.md` — scaffolding/bootstrap
- `skills/solidactions-workflow-coding.md` — TS workflow editing
- `skills/solidactions-deploy-and-config.md` — deploy/env/triggers

**`solidactions-cli` repo** (`src/commands/ai-init.ts`):
- Branches on whether skills are being installed; fetches `CLAUDE-skills-pointer.md` (slim) if yes, legacy `CLAUDE.md` if no.
- Upserts two marker sections: `SolidActions` (main) and `SolidActions SDK Reference` (redundant — the slim file already covers the SDK reference pointer).
- Skills install only when target is `CLAUDE.md`; `AGENTS.md` target never installs skills, always fetches legacy full file.
- `--no-skills` flag forces legacy fetch even for `CLAUDE.md` target.
- If `.claude/` doesn't exist, prompts interactively; non-interactive mode effectively cancels.

**`src/commands/init.ts`** prints a "Quick start" block at lines 170–173 listing `project deploy`, `run start`, `run list`. No mention of `ai init`.

## New Design

### 1. Content changes in `solidactions-examples`

**New slim `CLAUDE.md`** (~50 lines):

```markdown
SolidActions workflow project. AI skills are installed in `.claude/skills/`:
- solidactions-getting-started — new-project scaffolding and bootstrap discipline
- solidactions-workflow-coding — editing TS workflow code (SDK rules, determinism, recipes)
- solidactions-deploy-and-config — deploying, env vars, triggers, debugging runs

Full SDK reference: .solidactions/sdk-reference.md. Read before using any SDK function you do not know cold.

## Hard Rules — NEVER violate

### Determinism
1. Workflows must be deterministic — same inputs produce the same step calls in the same order.
2. Non-deterministic ops (`fetch`, `fs`, `Math.random`, external APIs) must run inside `SolidActions.runStep()` — never directly in workflow functions.
3. Use `SolidActions.now()` instead of `Date.now()` / `new Date()`.
4. Use `SolidActions.randomUUID()` instead of `crypto.randomUUID()` / `Math.random()`.
5. Prefer `Promise.allSettled()` over `Promise.all()` for parallel steps unless fail-fast is genuinely what you want — `Promise.all` rejects on first failure and leaves sibling step promises unresolved, which corrupts workflow state.

### Step & workflow discipline
6. Do NOT call context methods (`send`, `recv`, `sleep`, `setEvent`, `getEvent`, `startWorkflow`, `respond`) inside a step. They belong in the workflow function.
7. Do NOT start workflows from inside a step.
8. Steps should not mutate shared in-memory state (module-level variables, globals). External side effects (API calls, DB writes, file I/O) are the whole point of steps — it's in-memory mutation that breaks replay.
9. Internal workflows do NOT call `SolidActions.run()`. Only export the registered workflow.
10. Scheduling is YAML-only — configure cron in `solidactions.yaml`, not in code.
11. Workflow inputs and outputs must be JSON-serializable.

### Messaging
12. `send()` / `recv()` without a topic are in a separate channel from calls with a topic. Don't mix them expecting one to receive the other.

Workflow examples: https://github.com/SolidActions/solidactions-examples
```

**New slim `AGENTS.md`** — same content as `CLAUDE.md` except the opening line points at `.agents/skills/` instead of `.claude/skills/`.

**Rule #5 caveat:** The legacy file states `Promise.allSettled` as absolute; reworded to "prefer unless fail-fast is what you want" because `Promise.all` with explicit fail-fast intent is sometimes correct. Verify against SDK docs before publishing; if the SDK genuinely requires `allSettled` always, revert to the absolute wording.

### 2. Skill edits

Approach: each skill's top-level "Hard Rules" section covers the rules relevant to its scope. Skills can include additional scoped rules beyond the root list (e.g., `solidactions-workflow-coding` already carries "step names must be stable" and "step return values must be small" — scoped API discipline, kept).

- **`solidactions-workflow-coding.md`** — merge root rules 1–9, 11, 12 into the existing Hard Rules section, deduplicated against its current content. Reword rule 8 to match the new "shared in-memory state" phrasing.
- **`solidactions-deploy-and-config.md`** — add rule 10 (scheduling is YAML-only) to Hard Rules if not already present at top.
- **`solidactions-getting-started.md`** — no changes. Its existing rules (production-first, run `init` + `ai-init`) are bootstrap-scoped and stay.

### 3. CLI changes in `solidactions-cli`

**`src/utils/skills.ts`:**
- `detectSkillTargets(cwd, targetFile)` — takes the target file. Returns `.claude/skills/` for `CLAUDE.md`, `.agents/skills/` for `AGENTS.md`. Codex auto-discovers `.agents/skills/` per its documented convention (https://developers.openai.com/codex/skills).
- Replace `fetchClaudeMdContent(skillsInstalled)` with `fetchAiHelperContent(targetFile)` — single slim file per target, no branching.
- Update the stale v1 comment about Codex being user-global-only (no longer accurate).

**`src/commands/ai-init.ts`:**
- Remove `--no-skills` option and the `installSkillsEnabled` branch.
- Always install skills. Skills directory is derived from the target file.
- Remove the interactive prompt at lines 58–73 that asks whether to create `.claude/`. Just create it unconditionally — a user who ran `ai init --claude` has already consented to AI tooling setup. Same for `.agents/` when target is `AGENTS.md`.
- Remove the separate `SolidActions SDK Reference` marker section write at lines 102–106 — content is redundant with the slim file. Existing users' CLAUDE.md files will retain that marker block as stale content after the upgrade. Implementation decision deferred: either (a) accept the stale block and document manual cleanup, or (b) extend `markers.ts` with a `removeMarkerSection(file, name)` helper and call it once during `ai init` for graceful migration. Pick whichever is smaller once the implementer reads `markers.ts`.

**`src/commands/init.ts`:**
- Update Quick start output to lead with `ai init` as the next step (not hardcoded to `--claude` or `--agents`):
  ```
  Next step — install AI helper docs and skills:
    solidactions ai init          (picks CLAUDE.md or AGENTS.md interactively)

  Quick start:
    solidactions project deploy <name>    Deploy current directory
    solidactions run start <proj> <wf>    Run a workflow
    solidactions run list                 List recent runs
  ```

**`src/index.ts`:**
- Remove `--no-skills` option from the `ai init` command definition (currently line 352).
- Rewrite the `ai init` description: `"Install SolidActions AI skills and SDK reference for AI-assisted development"`. Leading with "skills" makes it obvious to an AI skimming `--help`.

### 4. README nudge

Update `solidactions-cli/README.md` so the Quick Start section shows `ai init` as step 2 immediately after `init`. The README is where an AI agent lands first when orienting to a new CLI; a missed mention here means the agent may never see the success-output nudge from `init`.

## Rollout

Filename collision: the new slim `CLAUDE.md` and the legacy full `CLAUDE.md` occupy the same path in the examples repo. We can't hold both simultaneously. Since older published CLI versions will still fetch from that path, overwriting is a breaking-content change for them. The slim file is still usable for older CLIs (it has the hard rules and skill pointers) — degraded but not broken.

Order:

1. **Examples repo:** replace content at `CLAUDE.md` and `AGENTS.md` with the new slim content. Also overwrite `CLAUDE-skills-pointer.md` with the same slim content so older CLIs on the skills branch still find something sensible. Update the three skill files per Section 2.
2. **CLI repo:** ship the new `ai-init.ts` / `skills.ts` / `init.ts` / `index.ts` changes together. Version bump.
3. **Cleanup (optional, later):** delete `CLAUDE-skills-pointer.md` once telemetry or time confirms no CLI versions still fetch it.

## Out of Scope / Deferred

- Folding `ai init` into `init`. Considered and rejected — `init` can run without a project directory (global config); `ai init` requires one. Keep distinct.
- Embedding the slim file into the CLI binary instead of fetching from GitHub. Today the fetch model lets us update content without a CLI release. Keep fetching for now; revisit if network failures during `ai init` become a real issue.
- Detecting additional per-tool skill conventions beyond `.claude/skills/` and `.agents/skills/` (e.g., `.cursor/`, `.windsurf/`). Cursor/Windsurf/Gemini are all AGENTS.md consumers and — per current convention — read from `.agents/skills/`. Add specific paths only if a tool diverges.
- Cleaning up orphaned `SolidActions SDK Reference` marker sections in users' existing CLAUDE.md files beyond the one-time empty-write pass. Users with older content can delete manually.

## Open Questions Flagged for Implementation

- **Verify rule #5 against the SDK.** Reword absolute-vs-preferred before publishing based on what the SDK actually guarantees.
- **Confirm Codex's discovery behavior** matches the docs for our specific skill format (YAML frontmatter, `---` delimiters, `name:`/`description:` fields). If Codex expects a different frontmatter schema, we may need a format shim or two copies per skill.

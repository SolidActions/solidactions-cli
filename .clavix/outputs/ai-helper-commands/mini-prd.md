# Requirements: AI Helper Commands

*Generated from conversation on 2026-02-23*

## Objective
Add CLI commands to the SolidActions CLI that help AI coding assistants (Claude Code, Cursor, etc.) write SolidActions workflows more effectively by installing documentation, SDK references, and example workflows directly into the user's project.

## Core Requirements

### Must Have (High Priority)

- [HIGH] **`solidactions ai:init` command** - Installs AI helper documentation into the project
  - Asks user to choose CLAUDE.md or AGENTS.md (interactive prompt)
  - Supports `--claude` and `--agents` flags for non-interactive use (AI-friendly)
  - Fetches AI helper content from `github.com/SolidActions/solidactions-examples` CLAUDE.md
  - Fetches SDK reference from `github.com/SolidActions/solidactions-ts-sdk/docs/sdk-reference.md` into `.solidactions/sdk-reference.md`
  - If target file doesn't exist: creates it fresh, content wrapped in `<!-- SolidActions -->` / `<!-- /SolidActions -->` markers
  - If target file exists: appends or replaces only the content within `<!-- SolidActions -->` markers, preserving all user content outside markers
  - Adds `<!-- SolidActions SDK Reference -->` / `<!-- /SolidActions SDK Reference -->` section with a note pointing to `.solidactions/sdk-reference.md`
  - Running again replaces content inside markers with latest from repo (update behavior)

- [HIGH] **`solidactions ai:examples` command** - Clones example workflows into the project
  - No args: opens interactive multi-selector showing available examples
  - With names: `solidactions ai:examples name1 name2` grabs specific ones
  - `--all` flag: pulls all available examples
  - Reads folder structure from the GitHub repo to discover available examples (no manifest file)
  - Clones selected examples into `.solidactions/examples/`
  - Adds reference note in a separate `<!-- SolidActions Examples -->` / `<!-- /SolidActions Examples -->` section in the CLAUDE.md/AGENTS.md, explaining where the examples are and how AI should use them for reference
  - If example already exists locally: warns the user
  - `--overwrite` flag to bypass the warning and replace with latest

- [HIGH] **Three independent marker sections** in CLAUDE.md/AGENTS.md that update independently:
  - `<!-- SolidActions -->` ... `<!-- /SolidActions -->` - Main AI helper content (CLI docs, SDK gotchas, workflow patterns)
  - `<!-- SolidActions Examples -->` ... `<!-- /SolidActions Examples -->` - Reference note about `.solidactions/examples/`
  - `<!-- SolidActions SDK Reference -->` ... `<!-- /SolidActions SDK Reference -->` - Reference note pointing to `.solidactions/sdk-reference.md`

### Should Have (Medium Priority)

- [MEDIUM] **Update examples repo CLAUDE.md with critical SDK gotchas** (separate task, pushed to solidactions-examples repo):
  - Determinism rules: no `fetch`, no file system access, no `Math.random()` in workflow functions (only in steps)
  - `Promise.all` vs `Promise.allSettled`: use `allSettled` for parallel steps, `all` can leave orphaned promises
  - `now()` instead of `Date.now()` for deterministic timestamps
  - `randomUUID()` instead of `crypto.randomUUID()` for deterministic UUIDs
  - Step retry config details (`intervalSeconds`, `backoffRate`, `maxAttempts`)
  - `send()`/`recv()` topic behavior: messages without topics are separate from messages with topics
  - Error classes: `SolidActionsMaxStepRetriesError` has `.errors` array

### Could Have (Low Priority / Inferred)

- [LOW] Cleanup of `sdk-reference.md` in the SDK repo (e.g., remove references to queues which no longer exist in the SDK)

## Technical Constraints
- **Framework/Stack:** TypeScript, oclif CLI framework (existing CLI patterns)
- **Command naming:** Follows existing `namespace:command` convention (e.g., `env:pull`, `env:push`)
- **Sources:**
  - AI helper content: `https://github.com/SolidActions/solidactions-examples` (CLAUDE.md)
  - SDK reference: `https://github.com/SolidActions/solidactions-ts-sdk/docs/sdk-reference.md`
  - Examples: `https://github.com/SolidActions/solidactions-examples` (folder structure)
- **GitHub access:** Needs to fetch raw file content and read repo folder structure from GitHub

## Architecture & Design
- **`.solidactions/` folder** is the home for all AI reference material:
  - `.solidactions/sdk-reference.md` - Full SDK API reference
  - `.solidactions/examples/` - Cloned example workflows
- **Marker-based sections** in CLAUDE.md/AGENTS.md allow independent updates without data loss
- **No manifest file** - example discovery is done by reading the repo's folder structure

## User Context
**Target Users:** Developers using AI coding assistants (Claude Code, Cursor, etc.) to write SolidActions workflows
**Primary Use Case:** AI assistant lacks context about SolidActions SDK, CLI, and patterns - these commands provide that context directly in the project
**User Flow:**
1. Developer runs `solidactions ai:init --claude` (or `--agents`)
2. CLI fetches docs, creates/merges CLAUDE.md, drops SDK reference into `.solidactions/`
3. Developer optionally runs `solidactions ai:examples` to get example workflows
4. AI coding assistant now has full context: CLI docs, SDK gotchas, API reference, and example patterns

## Edge Cases & Considerations
- What if the GitHub repo is unreachable? (network error handling needed)
- What if the user manually edits content inside the markers? (gets overwritten on next `ai:init` - this is expected behavior)
- What if `.solidactions/` folder doesn't exist yet? (create it)
- AGENTS.md and CLAUDE.md contain the same content, just different filenames for different tools

## Implicit Requirements
*Inferred from conversation context - please verify:*
- [Inferred] The CLI should handle GitHub rate limiting gracefully
- [Inferred] `.solidactions/` and `.solidactions/examples/` should probably be added to `.gitignore` suggestions (or not - user may want to commit them for team sharing)

## Success Criteria
How we know this is complete and working:
- `solidactions ai:init --claude` creates/merges a CLAUDE.md with SolidActions content in markers
- `solidactions ai:init --agents` does the same for AGENTS.md
- Running `ai:init` again updates only the marked sections
- `.solidactions/sdk-reference.md` is fetched and saved
- `solidactions ai:examples` shows a selector and clones chosen examples to `.solidactions/examples/`
- `solidactions ai:examples name1 name2` clones specific examples
- `solidactions ai:examples --all` clones everything
- Existing examples trigger a warning; `--overwrite` bypasses it
- All three marker sections in CLAUDE.md/AGENTS.md are independent and don't interfere with each other
- An AI coding assistant, given the installed files, can write correct SolidActions workflows

## Next Steps
1. Review this PRD for accuracy and completeness
2. If anything is missing or unclear, continue the conversation
3. When ready, use `/clavix:plan` to generate implementation tasks

---
*This PRD was generated by Clavix from conversational requirements gathering.*

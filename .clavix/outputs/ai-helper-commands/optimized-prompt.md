# Optimized Prompt (Clavix Enhanced)

## Objective

Add two CLI commands (`ai:init` and `ai:examples`) to the SolidActions CLI that provide AI coding assistants with the documentation, SDK references, and example workflows needed to write correct SolidActions workflows.

## Command 1: `solidactions ai:init`

Install AI helper documentation and SDK reference into the project.

**File selection:**
- Interactive: prompts user to choose CLAUDE.md or AGENTS.md
- Non-interactive: `--claude` or `--agents` flags (required for AI tool compatibility)

**Actions performed:**
1. Fetch CLAUDE.md content from `github.com/SolidActions/solidactions-examples`
2. Fetch `docs/sdk-reference.md` from `github.com/SolidActions/solidactions-ts-sdk` and save to `.solidactions/sdk-reference.md`
3. Create or merge the chosen AI file (CLAUDE.md or AGENTS.md) with two marker sections:
   - `<!-- SolidActions -->` / `<!-- /SolidActions -->` — main helper content (CLI docs, SDK gotchas, workflow patterns)
   - `<!-- SolidActions SDK Reference -->` / `<!-- /SolidActions SDK Reference -->` — note pointing to `.solidactions/sdk-reference.md`

**Merge behavior:**
- New file: create with content wrapped in markers
- Existing file: find markers and replace only the content within them; if markers don't exist, append at bottom
- Re-running updates marker content with latest from repo; user content outside markers is never touched

## Command 2: `solidactions ai:examples`

Clone example workflow projects for AI reference.

**Invocation modes:**
- `solidactions ai:examples` — interactive multi-selector (lists available examples from repo)
- `solidactions ai:examples name1 name2 name3` — clone specific examples by name
- `solidactions ai:examples --all` — clone all available examples

**Discovery:** Read folder structure from the solidactions-examples GitHub repo (no manifest file).

**Output location:** `.solidactions/examples/`

**AI file integration:** Add a `<!-- SolidActions Examples -->` / `<!-- /SolidActions Examples -->` section to the CLAUDE.md/AGENTS.md explaining where examples live and instructing the AI to use them as reference patterns.

**Conflict handling:**
- If example folder already exists locally: warn the user
- `--overwrite` flag bypasses the warning and replaces with latest

## Marker Section Independence

Three marker sections in CLAUDE.md/AGENTS.md, each updated independently:

| Section | Updated by | Content |
|---------|-----------|---------|
| `<!-- SolidActions -->` | `ai:init` | Main docs (CLI, SDK gotchas, patterns) |
| `<!-- SolidActions SDK Reference -->` | `ai:init` | Pointer to `.solidactions/sdk-reference.md` |
| `<!-- SolidActions Examples -->` | `ai:examples` | Pointer to `.solidactions/examples/` with usage guidance |

## Prerequisite Task: Update Examples Repo CLAUDE.md

Before implementation, add these critical SDK gotchas to the solidactions-examples repo's CLAUDE.md (so `ai:init` pulls them automatically):

- **Determinism rules:** No `fetch`, file system access, or `Math.random()` in workflow functions (only inside steps)
- **Parallel execution:** Use `Promise.allSettled()` not `Promise.all()` for parallel steps (`all` can leave orphaned promises)
- **Deterministic timestamps:** Use `now()` instead of `Date.now()`
- **Deterministic UUIDs:** Use `randomUUID()` instead of `crypto.randomUUID()`
- **Step retry config:** `intervalSeconds`, `backoffRate`, `maxAttempts` parameters
- **Messaging topics:** `send()`/`recv()` messages without topics are separate from messages with topics
- **Error handling:** `SolidActionsMaxStepRetriesError` exposes `.errors` array for per-attempt errors

## Technical Context

- CLI framework: oclif (TypeScript), command naming follows `namespace:command` pattern
- GitHub sources: raw content fetch for files, GitHub API for folder structure listing
- `.solidactions/` folder is the home for all AI reference material

## Success Criteria

- `ai:init --claude` creates/merges CLAUDE.md with correct markers and fetches SDK reference
- `ai:init --agents` does the same for AGENTS.md
- Re-running `ai:init` updates only marked sections, preserving user content
- `ai:examples` selector works, clones to correct location, warns on existing
- All three marker sections are independent and don't interfere
- An AI assistant with the installed files can write correct SolidActions workflows

---

## Optimization Improvements Applied

1. **[STRUCTURED]** - Reorganized from narrative paragraphs into command-by-command specification with tables and clear sections
2. **[CLARIFIED]** - Made merge behavior explicit: new file vs existing file vs re-run scenarios
3. **[COMPLETENESS]** - Added marker section independence table showing which command updates which section
4. **[ACTIONABILITY]** - Separated the prerequisite task (updating examples repo) from the CLI implementation
5. **[EFFICIENCY]** - Removed conversational language, each requirement is a concrete specification

---
*Optimized by Clavix on 2026-02-23. This version is ready for implementation.*

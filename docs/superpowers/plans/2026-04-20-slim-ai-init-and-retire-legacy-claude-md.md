# Slim `ai init` and Retire Legacy CLAUDE.md — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the 1190-line legacy `CLAUDE.md` fallback, slim the `ai init` output to a ~50-line pointer + hard rules, always install skills, and add onboarding nudges so AI agents reliably reach the skills path.

**Architecture:** Two-repo change. `solidactions-examples` (content) ships new slim `CLAUDE.md`/`AGENTS.md` plus updated skill files; `solidactions-cli` removes the `--no-skills` branch, always installs skills (to `.claude/skills/` for Claude Code, `.agents/skills/` for Codex/Cursor/Gemini), and nudges users toward `ai init` from the `init` success output.

**Tech Stack:** TypeScript, Node 18+, commander.js, prompts, fs-extra. No test framework in this project — verification is `npm run build` plus manual smoke tests in a throwaway directory.

**Two working repos:**
- CLI: `/home/mercer/projects/solid/solidactions-cli/` (this repo)
- Examples: `/home/mercer/projects/solid/solidactions-examples/` (sibling)

---

## Task 1: Author new slim CLAUDE.md in examples repo

**Files:**
- Modify: `../solidactions-examples/CLAUDE.md` (currently 1190 lines — will be replaced entirely)

- [ ] **Step 1: Overwrite the file with the new slim content**

Replace the full contents of `/home/mercer/projects/solid/solidactions-examples/CLAUDE.md` with:

```markdown
SolidActions workflow project. AI skills are installed in `.claude/skills/` and auto-activate when relevant:

- `solidactions-getting-started` — new-project scaffolding and bootstrap discipline
- `solidactions-workflow-coding` — editing TS workflow code (SDK rules, determinism, recipes)
- `solidactions-deploy-and-config` — deploying, env vars, triggers, debugging runs

Full SDK reference: `.solidactions/sdk-reference.md`. Read before using any SDK function you do not know cold.

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

- [ ] **Step 2: Verify file looks correct**

Run from the CLI repo:

```bash
wc -l ../solidactions-examples/CLAUDE.md
```

Expected: around 30–40 lines (down from 1190).

- [ ] **Step 3: No commit yet** — bundle with Tasks 2 and 3 into one examples-repo commit at Task 4.

---

## Task 2: Author new slim AGENTS.md in examples repo

**Files:**
- Modify: `../solidactions-examples/AGENTS.md` (currently 1190 lines of legacy content — will be replaced entirely)

- [ ] **Step 1: Overwrite the file with the AGENTS variant**

Replace the full contents of `/home/mercer/projects/solid/solidactions-examples/AGENTS.md` with the same content as the new `CLAUDE.md`, with just one difference: the opening line references `.agents/skills/` instead of `.claude/skills/`. Full content:

```markdown
SolidActions workflow project. AI skills are installed in `.agents/skills/` and auto-activate when relevant (Codex auto-discovers from this path; see https://developers.openai.com/codex/skills):

- `solidactions-getting-started` — new-project scaffolding and bootstrap discipline
- `solidactions-workflow-coding` — editing TS workflow code (SDK rules, determinism, recipes)
- `solidactions-deploy-and-config` — deploying, env vars, triggers, debugging runs

Full SDK reference: `.solidactions/sdk-reference.md`. Read before using any SDK function you do not know cold.

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

- [ ] **Step 2: Verify file looks correct**

Run from the CLI repo:

```bash
wc -l ../solidactions-examples/AGENTS.md
```

Expected: around 30–40 lines.

---

## Task 3: Overwrite `CLAUDE-skills-pointer.md` for backwards compat

Older published CLI versions fetch `CLAUDE-skills-pointer.md` when skills install. We want those CLIs to fetch something sensible during the transition, so copy the same slim content there.

**Files:**
- Modify: `../solidactions-examples/CLAUDE-skills-pointer.md`

- [ ] **Step 1: Overwrite with the new slim CLAUDE.md content**

Replace the full contents of `/home/mercer/projects/solid/solidactions-examples/CLAUDE-skills-pointer.md` with the exact same content as the new `CLAUDE.md` from Task 1 (the `.claude/skills/` variant, since this file was only ever served to CLIs that install skills to `.claude/skills/`).

- [ ] **Step 2: Verify**

```bash
diff ../solidactions-examples/CLAUDE.md ../solidactions-examples/CLAUDE-skills-pointer.md
```

Expected: no output (files identical).

---

## Task 4: Update `solidactions-workflow-coding.md` skill with merged hard rules

Merge root-list rules not currently covered. The skill's Hard Rules section currently numbers 1–6; add new rules 7–13 for the missing ones. Preserve existing numbering to minimize churn.

**Note on `solidactions-deploy-and-config.md`:** The design spec flags this skill as a potential target for adding rule 10 (scheduling is YAML-only), conditional on whether it's "already present at top." It IS already present — see `../solidactions-examples/skills/solidactions-deploy-and-config.md:26` ("For schedules, set the cron string in `solidactions.yaml`, not in code"). Therefore this plan does NOT modify `solidactions-deploy-and-config.md`. If you verify that rule has been removed or softened since the plan was written, add it back to the top of that skill's Hard Rules before proceeding.

**Files:**
- Modify: `../solidactions-examples/skills/solidactions-workflow-coding.md:8-37` (the "Hard Rules" block)

- [ ] **Step 1: Replace the Hard Rules block**

Open `/home/mercer/projects/solid/solidactions-examples/skills/solidactions-workflow-coding.md`. Find the `## Hard Rules` header (currently line 8) and replace the entire section through the end of rule 6 (currently line 37) with the block below. Leave everything below that section (the recipes) unchanged.

```markdown
## Hard Rules

1. **Determinism: use SDK durable primitives first; fall back to `SolidActions.runStep()` only when no SDK primitive exists.**
   - Replace `Date.now()` with `SolidActions.now()` — the SDK's durable timestamp primitive.
   - Replace `crypto.randomUUID()` and `Math.random()` with `SolidActions.randomUUID()` — the SDK's durable UUID primitive.
   - If you need a non-deterministic operation with no SDK primitive (e.g., calling an external API, generating a non-UUID random string), wrap it inside a `SolidActions.runStep(...)` body so its output is captured for replay.
   - *Why: workflows replay on resume; non-deterministic values outside steps cause divergence and broken state.*

2. **Webhooks that do work after responding: use `SolidActions.respond()` for the early response.**
   - The pattern is: call `await SolidActions.respond({ ... })` early, then continue with steps that send emails, call APIs, etc.
   - *Why: webhook callers (Stripe, GitHub, etc.) time out fast. Responding early then doing durable work in steps is the correct pattern.*

3. **Trigger choice: default to `instant`. Use `wait` only with explicit user intent.**
   - `instant` triggers fire as soon as the event arrives — correct for ~80% of cases (form submissions, webhooks, scheduled events).
   - `wait` is for workflows that block until an external signal arrives mid-execution.
   - *Why: AIs over-pick `wait` because the name sounds "safer." It's wrong for most cases and adds latency.*

4. **Step names must be stable across runs.**
   - The `name` option passed to `SolidActions.runStep(fn, { name: '...' })` is used as the cache key. Renaming a step across deploys breaks in-flight runs.
   - *Why: step caching uses the name as the lookup key; rename = cache miss = re-execution of already-completed work.*

5. **Secrets: never hardcode. Reference via `process.env.X` and document in `.env.example`.**
   - Setting the actual value happens via `solidactions env set` (covered by the deploy-and-config skill).
   - *Why: secrets in source = checked into git = leaked.*

6. **Step return values must be small. Pass references between steps, not large payloads.**
   - The value returned from a `SolidActions.runStep()` body is serialized into the workflow's persistent state for replay. Returning large objects (file bytes, base64-encoded media, multi-MB JSON, raw HTTP bodies) bloats the run's storage and can exceed practical durability limits.
   - When a step produces something large (a downloaded file, a generated PDF, a video frame, a large API response): write it to durable external storage inside the step (S3/R2/blob storage, a tmp file path the next step can re-read, a database row), and return a **reference** — a URL, storage key, file path, or row ID. Re-fetch or re-open the bytes inside the next step that needs them.
   - Rule of thumb: if a step return value would be larger than ~100KB serialized, you're probably doing it wrong. Pass a reference instead.
   - *Why: durable workflow state is meant for small coordination data (IDs, status flags, references) — not for piping large payloads through the orchestration layer. Bloated state slows resumes, hits storage limits, and complicates debugging.*

7. **Prefer `Promise.allSettled()` over `Promise.all()` for parallel steps.**
   - `Promise.all` rejects on first failure and leaves sibling step promises unresolved, which corrupts workflow state. `Promise.allSettled` lets every parallel step finish (or fail) independently, and you handle the results.
   - Only use `Promise.all` if you genuinely want fail-fast and no other steps may continue.
   - *Why: a partially-resolved `Promise.all` leaves dangling step state that poisons replay.*

8. **Do NOT call SDK context methods inside a step.**
   - `SolidActions.send`, `SolidActions.recv`, `SolidActions.sleep`, `SolidActions.setEvent`, `SolidActions.getEvent`, `SolidActions.startWorkflow`, and `SolidActions.respond` belong in the workflow function, not inside a `runStep()` body.
   - *Why: these methods coordinate durable state. Calling them inside a step (which itself is a replay-cached unit) creates double-booking of durable operations on replay.*

9. **Do NOT start workflows from inside a step.**
   - Use `SolidActions.startWorkflow(...)` at the workflow-function level.
   - *Why: same replay-determinism reason as rule 8 — child-workflow identity must be stable across replays.*

10. **Steps should not mutate shared in-memory state.**
    - Module-level variables, globals, shared caches — reading is fine, mutating is not.
    - External side effects (API calls, DB writes, file I/O) are the whole point of steps. This rule is about in-process memory that replay will see stale on resume.
    - *Why: replay re-runs the workflow function from scratch but pulls cached step results. Mutated in-memory state from a previous execution won't exist on replay, producing different code paths.*

11. **Internal workflows do NOT call `SolidActions.run()`.**
    - Only export the registered workflow; the top-level entry workflow for the project is the one that calls `SolidActions.run()`.
    - *Why: `SolidActions.run()` wires the project's single entrypoint. Calling it inside a workflow file meant to be imported by another workflow creates multiple entrypoints and breaks routing.*

12. **Workflow inputs and outputs must be JSON-serializable.**
    - No classes, functions, `Date` objects (use ISO strings), `Map`/`Set`, `BigInt`, or symbols at the boundaries.
    - *Why: the runner serializes inputs/outputs across the network and into durable storage. Non-JSON values silently lose fidelity.*

13. **`send()` / `recv()` without a topic are on a separate channel from calls with a topic.**
    - If one side calls `send(msg, 'orders')` and the other calls `recv()` with no topic, the message is never received.
    - *Why: topics are first-class channel keys, not optional tags. Default (no-topic) is its own channel.*
```

- [ ] **Step 2: Verify the file still parses as valid markdown**

```bash
head -80 ../solidactions-examples/skills/solidactions-workflow-coding.md
```

Confirm visually that the Hard Rules section ends cleanly and is followed by the `## Recipe — Webhook with Early Response + Background Work` section untouched.

---

## Task 5: Commit all examples repo changes

- [ ] **Step 1: Change to the examples repo**

```bash
cd ../solidactions-examples
```

- [ ] **Step 2: Check status**

```bash
git status
```

Expected to show modifications to: `CLAUDE.md`, `AGENTS.md`, `CLAUDE-skills-pointer.md`, `skills/solidactions-workflow-coding.md`.

- [ ] **Step 3: Stage and commit**

```bash
git add CLAUDE.md AGENTS.md CLAUDE-skills-pointer.md skills/solidactions-workflow-coding.md
git commit -m "$(cat <<'EOF'
docs: slim CLAUDE.md and AGENTS.md to skills pointer + hard rules

Retires the 1190-line legacy full reference in favor of a ~40-line
pointer that lists auto-activating skills and inlines the 12
highest-cost hard rules. Merges the rules not already covered by the
workflow-coding skill (Promise.allSettled, context-method discipline,
JSON-serializable I/O, messaging-topic channel separation) into that
skill's Hard Rules section. CLAUDE-skills-pointer.md is overwritten
with the same slim content so older published CLIs still fetch
something sensible during the transition.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Return to the CLI repo**

```bash
cd ../solidactions-cli
```

- [ ] **Step 5: Do NOT push to origin yet.** Push happens only after the CLI code changes are verified to work against the new content — done at Task 12 so rollback is simple if something goes wrong.

---

## Task 6: Refactor `src/utils/skills.ts` — per-target skill directories

**Files:**
- Modify: `src/utils/skills.ts`

- [ ] **Step 1: Replace the entire file contents**

Open `/home/mercer/projects/solid/solidactions-cli/src/utils/skills.ts` and replace the entire file with:

```typescript
import fs from 'fs';
import path from 'path';
import fsExtra from 'fs-extra';
import { fetchRawFile } from './github';

const SKILL_NAMES = [
    'solidactions-getting-started',
    'solidactions-workflow-coding',
    'solidactions-deploy-and-config',
] as const;

const EXAMPLES_OWNER = 'SolidActions';
const EXAMPLES_REPO = 'solidactions-examples';
const SKILLS_PATH_PREFIX = 'skills';

export type AiHelperTarget = 'CLAUDE.md' | 'AGENTS.md';

/**
 * Resolve the skills directory for an AI helper target.
 *
 * - `CLAUDE.md` → `<cwd>/.claude/skills/` (Claude Code convention)
 * - `AGENTS.md` → `<cwd>/.agents/skills/` (Codex auto-discovers this path;
 *   Cursor/Gemini read via AGENTS.md pointers)
 *
 * The directory does not need to exist — the caller creates it.
 */
export function skillTargetDir(targetFile: AiHelperTarget, cwd: string = process.cwd()): string {
    if (targetFile === 'CLAUDE.md') {
        return path.join(cwd, '.claude', 'skills');
    }
    return path.join(cwd, '.agents', 'skills');
}

/**
 * Fetch all SolidActions skill files from the examples repo and write
 * them into the target directory. Overwrites existing files (skills
 * are versioned upstream).
 */
export async function installSkills(targetDir: string): Promise<{ written: string[] }> {
    const written: string[] = [];

    fsExtra.ensureDirSync(targetDir);

    for (const skillName of SKILL_NAMES) {
        const remotePath = `${SKILLS_PATH_PREFIX}/${skillName}.md`;
        const content = await fetchRawFile(EXAMPLES_OWNER, EXAMPLES_REPO, remotePath);

        const filePath = path.join(targetDir, `${skillName}.md`);
        fs.writeFileSync(filePath, content, 'utf8');
        written.push(filePath);
    }

    return { written };
}

/**
 * Fetch the slim AI-helper content for the target file from the examples
 * repo. Single source per target — no legacy fallback.
 */
export async function fetchAiHelperContent(targetFile: AiHelperTarget): Promise<string> {
    return fetchRawFile(EXAMPLES_OWNER, EXAMPLES_REPO, targetFile);
}
```

- [ ] **Step 2: TypeScript compile check**

```bash
npm run build
```

Expected: PASS (the build will fail on references to removed exports from other files, but that's fine for now — we fix those at Task 7. If the build fails at this step _only_ on `ai-init.ts` importing `detectSkillTargets` or `fetchClaudeMdContent`, that's expected. If it fails elsewhere in `skills.ts` itself, fix before proceeding.)

---

## Task 7: Refactor `src/commands/ai-init.ts` — always install skills, no prompt, slim content only

**Files:**
- Modify: `src/commands/ai-init.ts` (full rewrite — small file)

- [ ] **Step 1: Replace the entire file contents**

Open `/home/mercer/projects/solid/solidactions-cli/src/commands/ai-init.ts` and replace the full contents with:

```typescript
import fs from 'fs';
import chalk from 'chalk';
import prompts from 'prompts';
import fsExtra from 'fs-extra';
import path from 'path';
import { fetchRawFile } from '../utils/github';
import { upsertMarkerSection } from '../utils/markers';
import { AiHelperTarget, skillTargetDir, installSkills, fetchAiHelperContent } from '../utils/skills';

interface AiInitOptions {
    claude?: boolean;
    agents?: boolean;
}

export async function aiInit(options: AiInitOptions = {}) {
    try {
        // Determine target file.
        let targetFile: AiHelperTarget;

        if (options.claude && options.agents) {
            console.error(chalk.red('Please specify only one of --claude or --agents'));
            process.exit(1);
        }

        if (options.claude) {
            targetFile = 'CLAUDE.md';
        } else if (options.agents) {
            targetFile = 'AGENTS.md';
        } else {
            const response = await prompts({
                type: 'select',
                name: 'file',
                message: 'Which AI helper file?',
                choices: [
                    { title: 'CLAUDE.md (Claude Code)', value: 'CLAUDE.md' },
                    { title: 'AGENTS.md (Codex, Cursor, Gemini, etc.)', value: 'AGENTS.md' },
                ],
            });

            if (!response.file) {
                console.log(chalk.yellow('Cancelled.'));
                process.exit(0);
            }

            targetFile = response.file as AiHelperTarget;
        }

        console.log(chalk.blue('Fetching AI helper content...'));

        // Fetch slim helper content for the chosen target.
        const aiContent = await fetchAiHelperContent(targetFile);

        // Fetch SDK reference (always).
        const sdkContent = await fetchRawFile('SolidActions', 'solidactions-ts-sdk', 'docs/sdk-reference.md');

        // Save SDK reference to .solidactions/sdk-reference.md.
        fsExtra.ensureDirSync('.solidactions');
        fs.writeFileSync('.solidactions/sdk-reference.md', sdkContent, 'utf8');
        console.log(chalk.green('✓ SDK reference saved to .solidactions/sdk-reference.md'));

        // Always install skills — no prompt. The user chose `ai init <target>`,
        // so they want AI tooling set up.
        const targetDir = skillTargetDir(targetFile);
        console.log(chalk.blue(`Installing SolidActions skills to ${path.relative(process.cwd(), targetDir)}/ ...`));
        const { written } = await installSkills(targetDir);
        for (const f of written) {
            console.log(chalk.green(`✓ ${path.relative(process.cwd(), f)}`));
        }

        // Upsert the AI helper marker section.
        upsertMarkerSection(targetFile, 'SolidActions', aiContent);

        console.log(chalk.green(`✓ AI helper installed to ${targetFile}`));
        console.log(
            chalk.gray(
                '  Existing files may still contain a separate "SolidActions SDK Reference" marker block from older CLI versions. That content is now redundant and can be deleted manually.',
            ),
        );
    } catch (error: any) {
        if (error.message?.includes('rate limit')) {
            console.error(chalk.red(error.message));
        } else if (error.message?.includes('not found')) {
            console.error(chalk.red(error.message));
        } else if (error.message?.includes('Failed to fetch')) {
            console.error(chalk.red('Network error: Could not reach GitHub. Check your internet connection.'));
        } else {
            console.error(chalk.red('Error:'), error.message);
        }
        process.exit(1);
    }
}
```

Key changes from the previous version:
- `AiInitOptions` no longer has a `skills` field (no `--no-skills`).
- No `detectSkillTargets()` call, no `.claude/` prompt — skills dir is derived from target file and always created.
- Single `fetchAiHelperContent(targetFile)` call — no branching on whether skills are installed.
- The separate `SolidActions SDK Reference` `upsertMarkerSection` call is removed; the slim content already covers it. A one-line tip is printed so users know the stale block (if any) can be manually deleted.

- [ ] **Step 2: TypeScript compile check**

```bash
npm run build
```

Expected: the build will fail at `src/index.ts` because it still passes `skills: false` to `aiInit` (from the `--no-skills` flag). We fix that at Task 8. If the build fails in `ai-init.ts` itself or in `skills.ts`, fix before proceeding.

---

## Task 8: Update `src/index.ts` — remove `--no-skills`, rewrite description

**Files:**
- Modify: `src/index.ts:347-353` (the `ai init` command definition)

- [ ] **Step 1: Find the current command definition**

Open `src/index.ts` and locate the block starting at line 347:

```typescript
ai
    .command('init')
    .description('Install AI helper documentation (CLAUDE.md or AGENTS.md) for AI-assisted workflow development')
    .option('--claude', 'Use CLAUDE.md (for Claude Code)')
    .option('--agents', 'Use AGENTS.md (for Cursor, Windsurf, etc.)')
    .option('--no-skills', 'Skip installing SolidActions skill files (uses legacy full CLAUDE.md injection)')
    .action((options) => { aiInit(options); });
```

- [ ] **Step 2: Replace with the new definition**

Replace that block with:

```typescript
ai
    .command('init')
    .description('Install SolidActions AI skills and SDK reference for AI-assisted development')
    .option('--claude', 'Use CLAUDE.md (for Claude Code)')
    .option('--agents', 'Use AGENTS.md (for Codex, Cursor, Gemini, Windsurf, etc.)')
    .action((options) => { aiInit(options); });
```

Changes: removed the `--no-skills` option, rewrote description to lead with "skills," broadened the `--agents` description to name the full set of consumers.

- [ ] **Step 3: TypeScript compile check**

```bash
npm run build
```

Expected: PASS. The CLI entrypoint should now compile cleanly against the new `ai-init.ts`.

---

## Task 9: Add `ai init` nudge to `init.ts` success output

**Files:**
- Modify: `src/commands/init.ts:168-173`

- [ ] **Step 1: Find the current Quick start block**

Open `src/commands/init.ts` and locate lines 168–173:

```typescript
    console.log('');
    console.log(chalk.blue('Quick start:'));
    console.log(chalk.gray('  solidactions project deploy <name>    Deploy current directory'));
    console.log(chalk.gray('  solidactions run start <proj> <wf>    Run a workflow'));
    console.log(chalk.gray('  solidactions run list                 List recent runs'));
}
```

- [ ] **Step 2: Replace with the nudge-first version**

Replace the block (keeping the closing `}` for the `init` function in place) with:

```typescript
    console.log('');
    console.log(chalk.blue('Next step — install AI helper docs and skills:'));
    console.log(chalk.gray('  solidactions ai init                  Picks CLAUDE.md or AGENTS.md interactively'));
    console.log('');
    console.log(chalk.blue('Quick start:'));
    console.log(chalk.gray('  solidactions project deploy <name>    Deploy current directory'));
    console.log(chalk.gray('  solidactions run start <proj> <wf>    Run a workflow'));
    console.log(chalk.gray('  solidactions run list                 List recent runs'));
}
```

- [ ] **Step 3: TypeScript compile check**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 4: Commit all CLI code changes so far**

```bash
git add src/utils/skills.ts src/commands/ai-init.ts src/commands/init.ts src/index.ts
git commit -m "$(cat <<'EOF'
feat(ai-init): always install skills, slim content, nudge from init

Removes the `--no-skills` flag and the interactive `.claude/` creation
prompt. `ai init` now unconditionally installs the three skills into
`.claude/skills/` (for CLAUDE.md target) or `.agents/skills/` (for
AGENTS.md target — Codex auto-discovers this path), fetches a single
slim content variant per target, and stops writing the redundant
`SolidActions SDK Reference` marker section. `init`'s success output
now surfaces `solidactions ai init` as the next step so AI agents
reliably reach the skills path instead of skipping it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Update README.md to surface `ai init` and drop `--no-skills`

Three concrete README edits: add `ai init` to the Quick Start code block, update the `ai` command table, and rewrite the paragraph that advertises `--no-skills` as an escape hatch.

**Files:**
- Modify: `README.md:13-19` (Quick Start code block)
- Modify: `README.md:130` (ai command table row)
- Modify: `README.md:133-139` (explanation paragraph)

- [ ] **Step 1: Update Quick Start code block**

The current Quick Start at `README.md:13-19` is:

```bash
solidactions init <api-key>                          # Initialize (prompts for workspace)
solidactions init <api-key> --workspace <name>       # Initialize with workspace
solidactions project deploy <project> <path>         # Deploy a project
solidactions run start <project> <workflow>           # Trigger a workflow
solidactions run view <run-id>                        # Inspect a run
```

Replace the block contents (keep the surrounding triple-backticks) with:

```bash
solidactions init <api-key>                          # Initialize (prompts for workspace)
solidactions ai init                                  # Install AI skills and SDK reference (required for AI-assisted dev)
solidactions project deploy <project> <path>         # Deploy a project
solidactions run start <project> <workflow>           # Trigger a workflow
solidactions run view <run-id>                        # Inspect a run
```

Rationale: `ai init` becomes step 2 — immediately after `init`, before the first `project deploy`. The `--workspace` variant is dropped from Quick Start (still documented under flags) to keep the essential path readable.

- [ ] **Step 2: Update the `ai` command table at `README.md:130`**

Current row:

```markdown
| `ai init` | `--claude`, `--agents`, `--no-skills` | Install AI helper docs |
```

Replace with:

```markdown
| `ai init` | `--claude`, `--agents` | Install AI skills and SDK reference |
```

- [ ] **Step 3: Rewrite the explanation paragraph at `README.md:133-139`**

Current text:

```markdown
By default, `ai init` also installs three lazy-loaded SolidActions skills
into `.claude/skills/`. These activate automatically when you scaffold a
project, write workflow code, or deploy. The CLAUDE.md injection becomes
a slim pointer to keep always-loaded context light.

Pass `--no-skills` to skip the skill install and get the legacy full
CLAUDE.md content instead.
```

Replace with:

```markdown
`ai init` installs three auto-activating SolidActions skills and a
full SDK reference into your project:

- Skills go to `.claude/skills/` (for `--claude` / Claude Code) or
  `.agents/skills/` (for `--agents` / Codex, Cursor, Gemini, Windsurf).
  Codex auto-discovers the `.agents/skills/` path — see
  https://developers.openai.com/codex/skills.
- The SDK reference is saved to `.solidactions/sdk-reference.md`.
- A slim pointer section is injected into `CLAUDE.md` or `AGENTS.md`
  listing the skills and inlining the highest-cost hard rules
  (determinism, step discipline, messaging) as a safety net.
```

- [ ] **Step 4: Sanity check the README**

```bash
grep -n "ai init\|--no-skills" README.md
```

Expected: multiple `ai init` matches in Quick Start, command table, and explanation. **Zero** `--no-skills` matches.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs(readme): surface `ai init` in Quick Start, drop `--no-skills`

AI agents orienting to the CLI read the README first; without a
prominent mention there, they skip `ai init` and never install the
skills that make them productive. Also drops the `--no-skills` flag
documentation (the flag was removed from the CLI).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Smoke-test the full `ai init` path end-to-end

We have no automated tests. Manual verification in a throwaway directory confirms the full path works against the new examples-repo content.

**Prerequisite:** Task 5's examples-repo commit must be pushed to `origin/main` for the CLI's `fetchRawFile` to see the new content. If Task 5 hasn't been pushed yet, push it now:

```bash
cd ../solidactions-examples
git push origin main
cd ../solidactions-cli
```

(This is the point-of-no-return for the examples repo. Verify one more time with `git log -1` in that repo that the commit is correct before pushing.)

- [ ] **Step 1: Build the CLI**

```bash
npm run build
```

Expected: PASS with no errors.

- [ ] **Step 2: Create a scratch directory for smoke testing**

```bash
mkdir -p /tmp/sacli-smoke && cd /tmp/sacli-smoke && rm -rf .claude .agents .solidactions CLAUDE.md AGENTS.md
```

- [ ] **Step 3: Run `ai init --claude` non-interactively**

```bash
node /home/mercer/projects/solid/solidactions-cli/dist/index.js ai init --claude
```

Expected output:
- "Fetching AI helper content..."
- "✓ SDK reference saved to .solidactions/sdk-reference.md"
- "Installing SolidActions skills to .claude/skills/ ..."
- Three green check lines for each installed skill
- "✓ AI helper installed to CLAUDE.md"
- Gray tip about stale marker block

- [ ] **Step 4: Verify CLAUDE.md contents**

```bash
cat CLAUDE.md
```

Expected: wrapped in `<!-- SolidActions -->` / `<!-- /SolidActions -->` tags, containing the ~40 lines of slim content (skill names, hard rules, pointers). NO 1190-line legacy content. NO separate `SolidActions SDK Reference` marker section.

- [ ] **Step 5: Verify skills were installed**

```bash
ls .claude/skills/
```

Expected:
```
solidactions-deploy-and-config.md
solidactions-getting-started.md
solidactions-workflow-coding.md
```

- [ ] **Step 6: Verify workflow-coding skill has the merged hard rules**

```bash
grep -c "Prefer \`Promise.allSettled" .claude/skills/solidactions-workflow-coding.md
```

Expected: `1` (rule 7 from Task 4 is present).

- [ ] **Step 7: Verify SDK reference was fetched**

```bash
ls -la .solidactions/sdk-reference.md && wc -l .solidactions/sdk-reference.md
```

Expected: file exists, non-trivial line count (hundreds of lines).

- [ ] **Step 8: Re-run `ai init --claude` — confirm idempotent**

```bash
node /home/mercer/projects/solid/solidactions-cli/dist/index.js ai init --claude
```

Expected: same output as Step 3, no errors, no duplicated CLAUDE.md content.

```bash
grep -c "<!-- SolidActions -->" CLAUDE.md
```

Expected: `1`.

- [ ] **Step 9: Test the AGENTS.md path**

```bash
cd /tmp && rm -rf sacli-smoke-agents && mkdir sacli-smoke-agents && cd sacli-smoke-agents
node /home/mercer/projects/solid/solidactions-cli/dist/index.js ai init --agents
```

Expected: analogous output, skills installed to `.agents/skills/` not `.claude/skills/`, AGENTS.md created.

```bash
ls .agents/skills/ && head -3 AGENTS.md
```

Expected: three skill files in `.agents/skills/`, AGENTS.md opens with "SolidActions workflow project. AI skills are installed in `.agents/skills/`..."

- [ ] **Step 10: Test that `ai init` with no flag works interactively**

Skip this step if running in a non-TTY environment. Otherwise:

```bash
cd /tmp && rm -rf sacli-smoke-noflag && mkdir sacli-smoke-noflag && cd sacli-smoke-noflag
node /home/mercer/projects/solid/solidactions-cli/dist/index.js ai init
```

Expected: interactive prompt asking which file (CLAUDE.md or AGENTS.md). Select CLAUDE.md. Rest of the flow matches Step 3.

- [ ] **Step 11: Clean up smoke test directories**

```bash
cd /home/mercer/projects/solid/solidactions-cli && rm -rf /tmp/sacli-smoke /tmp/sacli-smoke-agents /tmp/sacli-smoke-noflag
```

- [ ] **Step 12: No commit needed** — smoke tests don't produce artifacts.

---

## Task 12: Push the examples repo (point of no return) and bump CLI version

**Files:**
- Modify: `package.json` (version bump)

- [ ] **Step 1: Decide the CLI version bump**

Current version is `1.5.0`. This change:
- Removes the `--no-skills` flag (breaking surface change in the CLI, minor breakage)
- Changes default behavior of `ai init` (always installs, always slim)

Per semver-for-tooling conventions, a minor bump (to `1.6.0`) is appropriate. A major bump (to `2.0.0`) is reasonable if the team wants to signal the `--no-skills` removal loudly — confirm with the user before the version bump commit if unsure.

Default choice for this plan: **`1.6.0`**.

- [ ] **Step 2: Update `package.json`**

Edit `/home/mercer/projects/solid/solidactions-cli/package.json` line 3:

```json
    "version": "1.5.0",
```

to:

```json
    "version": "1.6.0",
```

- [ ] **Step 3: Build one more time to regenerate `dist/`**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 4: Commit the version bump**

```bash
git add package.json
git commit -m "chore: bump version to 1.6.0"
```

- [ ] **Step 5: Confirm examples repo is pushed**

If Task 11 Step 1 didn't push yet (e.g., it was skipped because already pushed), verify now:

```bash
cd ../solidactions-examples && git log origin/main..HEAD --oneline && cd ../solidactions-cli
```

Expected: no output (local is not ahead of origin/main — i.e., the slim-content commit is already on origin). If there ARE unpushed commits, push them:

```bash
cd ../solidactions-examples && git push origin main && cd ../solidactions-cli
```

- [ ] **Step 6: Do NOT push CLI or publish to npm here.** This plan stops at a local, committed, version-bumped state. Pushing to origin and `npm publish` are left to the user per their release workflow (and typically happen via a PR + tag).

---

## Final Sanity Checklist

Before declaring the plan complete, confirm:

- [ ] `../solidactions-examples` has one new commit slimming `CLAUDE.md`, `AGENTS.md`, `CLAUDE-skills-pointer.md`, and `skills/solidactions-workflow-coding.md`. **Pushed to origin/main.**
- [ ] `solidactions-cli` has two new commits locally: (a) the `ai-init` / `init` / `index` / `skills` code change, and (b) the README update. Plus a third chore commit for the version bump.
- [ ] `npm run build` passes cleanly in the CLI repo.
- [ ] Smoke tests in Task 11 all passed.
- [ ] No stray files in working directory outside the commits listed above.

---

## Rollback Notes

If something breaks after Task 12 Step 5 (examples repo already pushed):

- **If the CLI hasn't been released yet:** revert the examples-repo commit. The slim-content files are overwrites of a single path — `git revert` restores the legacy 1190-line file.
- **If the CLI has been released:** don't revert. Users of the new CLI depend on the slim content. Fix forward.

---

## Open Questions Carried From the Spec

These two items were flagged in the design doc as "verify at implementation time." The plan currently takes the safer option for each; flip to the alternative only if verification shows a problem.

1. **Rule 5 absoluteness (`Promise.allSettled` vs `Promise.all`).** The legacy file treated this as absolute. This plan softens to "prefer...unless fail-fast is genuinely what you want" in both the slim `CLAUDE.md`/`AGENTS.md` (Task 1 / Task 2) and the workflow-coding skill Hard Rule 7 (Task 4). If you read the SDK source or docs and discover `Promise.all` genuinely breaks workflow state in ALL cases (not just when a sibling step has mid-flight effects), revert to the absolute phrasing: *"Use `Promise.allSettled()` — not `Promise.all()` — for parallel steps. Always."* — in all three files before Task 5 commits.

2. **Codex frontmatter compatibility.** The installed skill files use Claude Code's frontmatter format (`name:`, `description:`). Codex's documented discovery behavior (https://developers.openai.com/codex/skills) does not confirm that this exact schema is parsed correctly. During Task 11 Step 9 (AGENTS.md smoke test), if Codex or another AGENTS.md-consuming tool fails to pick up the skills from `.agents/skills/`, check their docs for the expected frontmatter schema. If it differs, the fix is to either (a) author a separate format for AGENTS.md-target skills, or (b) add both sets of fields to the shared skill files. This plan assumes the shared format works; confirm during smoke testing.

# Implementation Plan

**Project**: ai-helper-commands
**Generated**: 2026-02-23T00:00:00Z

## Technical Context & Standards
*Detected Stack & Patterns*
- **Architecture**: Flat command files in `src/commands/`, registered in `src/index.ts`
- **Framework**: Commander.js - commands use `program.command('namespace:name')`
- **HTTP**: axios for API calls
- **Interactive prompts**: `prompts` package (already a dependency)
- **Output**: chalk for colored console output
- **File ops**: fs + fs-extra (both available)
- **Conventions**: One exported async function per command file, options interface at top of file, error handling with try/catch + chalk.red + process.exit(1)

**Rate Limiting Note**: GitHub contents API allows 60 unauthenticated requests/hour. Use `raw.githubusercontent.com` for file content (no rate limit) and the API only for directory listing to minimize API calls.

---

## Phase 1: External Repo Updates (solidactions-examples)

- [x] **Add SDK gotchas to examples repo CLAUDE.md** (ref: Update examples repo CLAUDE.md)
  Task ID: phase-1-examples-repo-01
  > **Implementation**: Edit `CLAUDE.md` in the `solidactions-examples` repository (separate repo: `../solidactions-examples`).
  > **Details**: Add a new section (e.g., `## Critical SDK Rules & Gotchas`) with:
  > 1. **Determinism rules**: "Never use `fetch()`, file system access (`fs`), or `Math.random()` directly in workflow functions. These are non-deterministic. All side effects must happen inside `SolidActions.runStep()` callbacks."
  > 2. **Parallel execution**: "Use `Promise.allSettled()` instead of `Promise.all()` for parallel steps. `Promise.all` rejects immediately on first failure, leaving other step promises unresolved."
  > 3. **Deterministic timestamps**: "Use `SolidActions.now()` instead of `Date.now()` or `new Date()`. Workflow replay requires deterministic timestamps."
  > 4. **Deterministic UUIDs**: "Use `SolidActions.randomUUID()` instead of `crypto.randomUUID()`. Same reason - replay determinism."
  > 5. **Step retry config**: "Steps support retry configuration: `{ retries: { intervalSeconds: 1, backoffRate: 2, maxAttempts: 3 } }`. Configure based on the step's idempotency and expected failure modes."
  > 6. **Messaging topics**: "`send()` and `recv()` messages without a topic are in a separate channel from messages with topics. Don't mix them expecting they'll be received on the same channel."
  > 7. **Error handling**: "`SolidActionsMaxStepRetriesError` has an `.errors` array containing the error from each retry attempt. Access it for debugging which attempts failed and why."
  >
  > **Why first**: `ai:init` fetches this file, so the gotchas need to be in place before users run the command.

---

## Phase 2: Shared Utilities

- [x] **Create GitHub fetch utility** (ref: Technical Constraints)
  Task ID: phase-2-utils-01
  > **Implementation**: Create `src/utils/github.ts`.
  > **Details**: Export two functions:
  > 1. `fetchRawFile(owner: string, repo: string, path: string, branch?: string): Promise<string>` - Fetches raw file content from `https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}`. Uses axios. Returns the file content as a string. Throws with a friendly message on 404 or network error. Uses raw.githubusercontent.com (not API) to avoid rate limits.
  > 2. `listRepoContents(owner: string, repo: string, path?: string, branch?: string): Promise<{name: string, type: string, download_url: string | null}[]>` - Uses the GitHub API `https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={branch}` to list directory contents. Returns array of all items (files and dirs) with `{name, type, download_url}`. No auth token needed (public repos). Handle rate-limiting (403) with a user-friendly message: `'GitHub API rate limit reached (60 requests/hour for unauthenticated access). Please wait a few minutes and try again.'`
  > Default branch to `'main'` in both functions.

- [x] **Create marker-section utility** (ref: Three independent marker sections)
  Task ID: phase-2-utils-02
  > **Implementation**: Create `src/utils/markers.ts`.
  > **Details**: Export three functions:
  > 1. `upsertMarkerSection(filePath: string, markerName: string, content: string): void` - Reads the file at `filePath` (or treats as empty string if file doesn't exist). Looks for `<!-- {markerName} -->` and `<!-- /{markerName} -->`. If found, replaces everything between them (inclusive of markers). If not found, appends a blank line + the full marker block at the end. Writes the result back. The marker block format:
  >    ```
  >    <!-- {markerName} -->
  >    {content}
  >    <!-- /{markerName} -->
  >    ```
  > 2. `hasMarkerSection(filePath: string, markerName: string): boolean` - Returns true if the file exists and contains both the opening and closing marker.
  > 3. `findAiHelperFile(): string | null` - Checks project root for a file with the `<!-- SolidActions -->` marker. Checks `CLAUDE.md` first, then `AGENTS.md`. Returns the filename if found, `null` otherwise. This is used by `ai:examples` to detect which file `ai:init` created.
  > Use `fs` for read/write. Create parent directories with `fs-extra.ensureDirSync` if needed.

---

## Phase 3: `ai:init` Command

- [x] **Create ai-init command file** (ref: ai:init command)
  Task ID: phase-3-ai-init-01
  > **Implementation**: Create `src/commands/ai-init.ts`.
  > **Details**: Export `async function aiInit(options: AiInitOptions)`. Define interface:
  > ```
  > interface AiInitOptions {
  >     claude?: boolean;
  >     agents?: boolean;
  > }
  > ```
  > **Logic flow:**
  > 1. Determine target file:
  >    - If `options.claude` → `'CLAUDE.md'`
  >    - If `options.agents` → `'AGENTS.md'`
  >    - If neither flag → use `prompts` package to ask: `{ type: 'select', name: 'file', message: 'Which AI helper file?', choices: [{ title: 'CLAUDE.md', value: 'CLAUDE.md' }, { title: 'AGENTS.md', value: 'AGENTS.md' }] }`
  >    - If both flags → error: "Please specify only one of --claude or --agents"
  > 2. Fetch AI helper content: call `fetchRawFile('SolidActions', 'solidactions-examples', 'CLAUDE.md')`. Store as `aiContent`.
  > 3. Fetch SDK reference: call `fetchRawFile('SolidActions', 'solidactions-ts-sdk', 'docs/sdk-reference.md')`. Store as `sdkContent`.
  > 4. Save SDK reference to `.solidactions/sdk-reference.md`: use `fs-extra.ensureDirSync('.solidactions')` then `fs.writeFileSync`. Log with chalk.green.
  > 5. Upsert main AI helper section: call `upsertMarkerSection(targetFile, 'SolidActions', aiContent)`.
  > 6. Upsert SDK reference pointer section: call `upsertMarkerSection(targetFile, 'SolidActions SDK Reference', sdkReferenceNote)` where `sdkReferenceNote` is a short markdown note:
  >    ```
  >    ## SolidActions SDK Reference
  >
  >    The full SDK API reference is available at `.solidactions/sdk-reference.md`. Refer to it for detailed function signatures, error classes, retry configuration, and advanced patterns like forking, streaming, and signal URLs.
  >    ```
  > 7. Log success: `chalk.green('✓ AI helper installed to {targetFile}')` and `chalk.green('✓ SDK reference saved to .solidactions/sdk-reference.md')`.
  > 8. Wrap everything in try/catch. On axios errors, print friendly messages (network error, 404, rate limit).

- [x] **Register ai:init in index.ts** (ref: Command naming)
  Task ID: phase-3-ai-init-02
  > **Implementation**: Edit `src/index.ts`.
  > **Details**:
  > 1. Add import: `import { aiInit } from './commands/ai-init';`
  > 2. Add a new section comment `// AI Helper` after the Webhooks section.
  > 3. Register command:
  >    ```
  >    program
  >        .command('ai:init')
  >        .description('Install AI helper documentation (CLAUDE.md or AGENTS.md) for AI-assisted workflow development')
  >        .option('--claude', 'Use CLAUDE.md (for Claude Code)')
  >        .option('--agents', 'Use AGENTS.md (for Cursor, Windsurf, etc.)')
  >        .action((options) => { aiInit(options); });
  >    ```

---

## Phase 4: `ai:examples` Command

- [x] **Create ai-examples command file** (ref: ai:examples command)
  Task ID: phase-4-ai-examples-01
  > **Implementation**: Create `src/commands/ai-examples.ts`.
  > **Details**: Export `async function aiExamples(names: string[], options: AiExamplesOptions)`. Define interface:
  > ```
  > interface AiExamplesOptions {
  >     all?: boolean;
  >     overwrite?: boolean;
  > }
  > ```
  > **Logic flow:**
  > 1. **Discover available examples**: Call `listRepoContents('SolidActions', 'solidactions-examples')`. Filter to `type === 'dir'` and exclude dotfile directories (names starting with `.`). Store as `availableExamples`.
  > 2. **Determine which to clone**:
  >    - If `options.all` → select all `availableExamples`
  >    - If `names.length > 0` → validate each name exists in `availableExamples`. If any name not found, error: `chalk.red('Example "{name}" not found. Available: {list}')` and exit.
  >    - If no names and no `--all` → use `prompts` package with `{ type: 'multiselect', name: 'selected', message: 'Select examples to install', choices: availableExamples.map(e => ({ title: e.name, value: e.name })) }`. If user cancels/selects none, exit gracefully.
  > 3. **Clone each selected example**:
  >    - For each example name, check if `.solidactions/examples/{name}/` already exists.
  >    - If exists and no `--overwrite`: print `chalk.yellow('Example "{name}" already exists. Use --overwrite to replace.')` and skip.
  >    - If exists and `--overwrite`: delete the directory first (`fs-extra.removeSync`).
  >    - Fetch the example recursively: create a helper `async function downloadDirectory(owner, repo, remotePath, localPath)` that:
  >      a. Calls `listRepoContents(owner, repo, remotePath)` to get directory listing (1 API call)
  >      b. For each file (`type === 'file'`): calls `fetchRawFile` to get content via raw.githubusercontent.com (no API call), writes to `localPath/{name}`
  >      c. For each subdir (`type === 'dir'`): creates the local subdir, recurses
  >    - This minimizes API calls: only 1 per directory level, file content uses raw URLs.
  >    - Log each: `chalk.green('✓ Installed example: {name}')`
  > 4. **Detect AI helper file**: Use `findAiHelperFile()` from `src/utils/markers.ts` to find the file with the `<!-- SolidActions -->` marker. If not found, print `chalk.yellow('No AI helper file found. Run "solidactions ai:init" first to create one.')` and skip the marker step.
  > 5. **Upsert examples reference section**: Call `upsertMarkerSection(detectedFile, 'SolidActions Examples', examplesNote)` where `examplesNote` lists installed examples and usage guidance:
  >    ```
  >    ## SolidActions Examples
  >
  >    Example workflows are available in `.solidactions/examples/`. Use these as reference patterns when writing SolidActions workflows.
  >
  >    Installed examples:
  >    - {name1}
  >    - {name2}
  >    ...
  >
  >    When writing workflows, check these examples for patterns covering steps, sleep, signals, child workflows, retries, events, messaging, parallel execution, scheduling, OAuth, streaming, and webhooks.
  >    ```
  >    The installed examples list should include ALL examples present in `.solidactions/examples/` (read existing dirs plus newly installed ones), not just the ones installed in this run.
  > 6. Log summary: `chalk.green('✓ Installed {N} example(s) to .solidactions/examples/')`.

- [x] **Register ai:examples in index.ts** (ref: Command naming)
  Task ID: phase-4-ai-examples-02
  > **Implementation**: Edit `src/index.ts`.
  > **Details**:
  > 1. Add import: `import { aiExamples } from './commands/ai-examples';`
  > 2. Register command under the `// AI Helper` section:
  >    ```
  >    program
  >        .command('ai:examples')
  >        .description('Install example workflows for AI reference')
  >        .argument('[names...]', 'Example names to install (omit for interactive selector)')
  >        .option('--all', 'Install all available examples')
  >        .option('--overwrite', 'Overwrite existing examples without warning')
  >        .action((names, options) => { aiExamples(names, options); });
  >    ```

---

*Generated by Clavix /clavix:plan*

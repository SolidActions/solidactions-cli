# Per-folder CLI Configuration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users scope the CLI's `host`, `apiKey`, and `workspaceId` to a folder via a three-layer resolver (env > nearest local > global), so concurrent AI agents in different project folders don't stomp each other's configuration.

**Architecture:** New `src/utils/config.ts` module owns all config I/O and resolution. Commands go through it via existing `requireConfig()` / `saveConfig()` shims so unrelated callers don't need changes. `init` gains `--local`/`--global` flags and an interactive chooser. Env vars `SOLIDACTIONS_HOST` / `SOLIDACTIONS_API_KEY` / `SOLIDACTIONS_WORKSPACE_ID` act as a per-field override layer.

**Tech Stack:** TypeScript, Node.js built-ins (`fs`, `os`, `path`, `readline`), commander (already in place).

**Spec:** `docs/superpowers/specs/2026-04-14-per-folder-config-design.md`

**Verification approach:** The CLI repo has no test framework today. Each task is verified by running `solidactions` commands in a clean scratch directory and inspecting output + filesystem state. A final task captures test notes for coverage that should be added later if/when the CLI repo introduces a test framework.

---

## File Structure

- **Create** `src/utils/config.ts` — resolver, walk-up, atomic write, path helpers.
- **Modify** `src/commands/init.ts` — `init`, `logout`, `whoami` delegate to new module; `init` gains flags + prompt + `.gitignore` handling; `logout` gains flags; `whoami` prints per-field sources.
- **Modify** `src/utils/api.ts` — `requireConfig` / `ensureWorkspaceSelected` use resolver and active path; `ensureWorkspaceSelected` skips save when workspace came from env.
- **Modify** `src/commands/workspaces.ts` — `workspaceSet` writes to active path; errors on env var conflict.
- **Modify** `src/index.ts` — register new flags; add `SOLIDACTIONS_DEBUG` preAction hook.
- **Modify** `README.md` — document new flags, env vars, resolution order.
- **Create** `docs/test-todo.md` — test notes for deferred coverage.

---

## Task 1: Create `src/utils/config.ts` skeleton (types + path helpers)

**Files:**
- Create: `src/utils/config.ts`

- [x] **Step 1: Write the skeleton file**

```ts
// src/utils/config.ts
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface Config {
    host: string;
    apiKey: string;
    workspaceId?: string;
}

export type ConfigSource = 'env' | string | null;

export interface ResolvedConfig {
    config: Config;
    sources: {
        host: ConfigSource;
        apiKey: ConfigSource;
        workspaceId: ConfigSource;
    };
    activePath: string; // path write-mutating commands should target
}

const GLOBAL_DIR = path.join(os.homedir(), '.solidactions');
const GLOBAL_FILE = path.join(GLOBAL_DIR, 'config.json');
const LOCAL_DIR_NAME = '.solidactions';
const LOCAL_FILE_NAME = 'config.json';

export function getGlobalConfigPath(): string {
    return GLOBAL_FILE;
}

export function getLocalConfigPath(cwd: string = process.cwd()): string {
    return path.join(cwd, LOCAL_DIR_NAME, LOCAL_FILE_NAME);
}
```

- [x] **Step 2: Build to confirm it compiles**

```bash
cd /home/mercer/projects/solid/solidactions-cli && npm run build
```

Expected: exits 0 with no errors. `dist/utils/config.js` exists.

- [x] **Step 3: Commit**

```bash
git add src/utils/config.ts
git commit -m "feat(config): scaffold config module with types and path helpers (#13)"
```

---

## Task 2: Add walk-up finder and atomic file read/write to `config.ts`

**Files:**
- Modify: `src/utils/config.ts`

- [x] **Step 1: Append walk-up and file helpers**

Append to `src/utils/config.ts`:

```ts
/**
 * Walk up from startDir looking for `.solidactions/config.json`.
 * Stops at filesystem root. **Skips `$HOME` itself** so the global config
 * at `~/.solidactions/config.json` is never matched as a local hit.
 * Returns the absolute path of the nearest local config, or null.
 */
export function findLocalConfigPath(startDir: string = process.cwd()): string | null {
    const home = os.homedir();
    let dir = path.resolve(startDir);
    while (true) {
        if (dir !== home) {
            const candidate = path.join(dir, LOCAL_DIR_NAME, LOCAL_FILE_NAME);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return null;
        }
        dir = parent;
    }
}

/**
 * Read a config file. Normalizes the legacy `token` field into `apiKey`.
 * Returns null if the file does not exist or cannot be parsed.
 */
export function readConfigFile(filePath: string): Config | null {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (raw.token && !raw.apiKey) {
            raw.apiKey = raw.token;
        }
        return raw as Config;
    } catch {
        return null;
    }
}

/**
 * Atomic write: writes to `<filePath>.tmp` and renames into place.
 * Creates parent directory with mode 0o700 if missing.
 * File is written with mode 0o600.
 */
export function writeConfigFile(filePath: string, config: Config): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
}

export function removeConfigFile(filePath: string): boolean {
    if (!fs.existsSync(filePath)) {
        return false;
    }
    fs.unlinkSync(filePath);
    return true;
}
```

- [x] **Step 2: Build**

```bash
cd /home/mercer/projects/solid/solidactions-cli && npm run build
```

Expected: exits 0.

- [x] **Step 3: Manually exercise walk-up via a tinker-style one-liner**

```bash
cd /home/mercer/projects/solid/solidactions-cli && node -e "
const { findLocalConfigPath, getLocalConfigPath, getGlobalConfigPath } = require('./dist/utils/config');
console.log('global:', getGlobalConfigPath());
console.log('local cwd:', getLocalConfigPath());
console.log('walk-up from /tmp:', findLocalConfigPath('/tmp'));
console.log('walk-up from \$HOME:', findLocalConfigPath(process.env.HOME));
"
```

Expected: prints paths; `walk-up from $HOME` prints `null` (because we skip `$HOME` itself and no parent above it has `.solidactions/config.json`).

- [x] **Step 4: Commit**

```bash
git add src/utils/config.ts
git commit -m "feat(config): add walk-up finder and atomic file I/O (#13)"
```

---

## Task 3: Add `resolveConfig()` with env + file layers

**Files:**
- Modify: `src/utils/config.ts`

- [x] **Step 1: Append resolver**

Append to `src/utils/config.ts`:

```ts
function readEnvOverrides(): Partial<Config> {
    const env: Partial<Config> = {};
    if (process.env.SOLIDACTIONS_HOST) env.host = process.env.SOLIDACTIONS_HOST;
    if (process.env.SOLIDACTIONS_API_KEY) env.apiKey = process.env.SOLIDACTIONS_API_KEY;
    if (process.env.SOLIDACTIONS_WORKSPACE_ID) env.workspaceId = process.env.SOLIDACTIONS_WORKSPACE_ID;
    return env;
}

/**
 * Resolve config by merging three layers field-by-field (env > local > global).
 * Returns null only when no source contributes an apiKey AND host (i.e. nothing usable).
 * `activePath` is the file a write-mutating command should target: nearest local if present, else global.
 */
export function resolveConfig(cwd: string = process.cwd()): ResolvedConfig | null {
    const env = readEnvOverrides();
    const localPath = findLocalConfigPath(cwd);
    const local = localPath ? readConfigFile(localPath) : null;
    const global = readConfigFile(getGlobalConfigPath());

    const pick = <K extends keyof Config>(key: K): { value: Config[K] | undefined; source: ConfigSource } => {
        if (env[key] !== undefined) return { value: env[key] as Config[K], source: 'env' };
        if (local && local[key] !== undefined) return { value: local[key], source: localPath! };
        if (global && global[key] !== undefined) return { value: global[key], source: getGlobalConfigPath() };
        return { value: undefined, source: null };
    };

    const host = pick('host');
    const apiKey = pick('apiKey');
    const workspaceId = pick('workspaceId');

    if (!host.value && !apiKey.value) {
        return null;
    }

    return {
        config: {
            host: (host.value ?? '') as string,
            apiKey: (apiKey.value ?? '') as string,
            workspaceId: workspaceId.value as string | undefined,
        },
        sources: {
            host: host.source,
            apiKey: apiKey.source,
            workspaceId: workspaceId.source,
        },
        activePath: localPath ?? getGlobalConfigPath(),
    };
}
```

- [x] **Step 2: Build**

```bash
cd /home/mercer/projects/solid/solidactions-cli && npm run build
```

Expected: exits 0.

- [x] **Step 3: Manually exercise `resolveConfig` against the existing global config**

```bash
cd /home/mercer/projects/solid/solidactions-cli && node -e "
const { resolveConfig } = require('./dist/utils/config');
console.log(JSON.stringify(resolveConfig(), null, 2));
"
```

Expected: prints `{ config: { host, apiKey, workspaceId? }, sources: { host: '<abs path to ~/.solidactions/config.json>', ... }, activePath: '<abs path>' }`. If no global config exists yet, prints `null`.

- [x] **Step 4: Exercise env override**

```bash
cd /home/mercer/projects/solid/solidactions-cli && SOLIDACTIONS_HOST=https://override.test SOLIDACTIONS_WORKSPACE_ID=ws-from-env node -e "
const { resolveConfig } = require('./dist/utils/config');
const r = resolveConfig();
console.log('host:', r && r.config.host, 'source:', r && r.sources.host);
console.log('workspaceId:', r && r.config.workspaceId, 'source:', r && r.sources.workspaceId);
"
```

Expected:
- `host: https://override.test  source: env`
- `workspaceId: ws-from-env  source: env`

- [x] **Step 5: Commit**

```bash
git add src/utils/config.ts
git commit -m "feat(config): add resolveConfig with env/local/global layers (#13)"
```

---

## Task 4: Migrate `src/commands/init.ts` to delegate to `config.ts`

Routes existing `getConfig` / `saveConfig` / `clearConfig` through the new module so all callers transparently gain resolution without changing their code. This task keeps today's behavior — later tasks will add the new flags.

**Files:**
- Modify: `src/commands/init.ts:1-44` (the config I/O section)

- [ ] **Step 1: Replace the file I/O block**

Replace lines 1–44 of `src/commands/init.ts` (from `import fs` through the end of `clearConfig()`) with:

```ts
import chalk from 'chalk';
import { ensureWorkspaceSelected } from '../utils/api';
import { workspaceSet } from './workspaces';
import {
    Config,
    resolveConfig,
    readConfigFile,
    writeConfigFile,
    removeConfigFile,
    getGlobalConfigPath,
} from '../utils/config';

export type { Config };

export function getConfig(): Config | null {
    const resolved = resolveConfig();
    return resolved ? resolved.config : null;
}

export function saveConfig(config: Config): void {
    const resolved = resolveConfig();
    const targetPath = resolved ? resolved.activePath : getGlobalConfigPath();
    writeConfigFile(targetPath, config);
}

export function clearConfig(): void {
    removeConfigFile(getGlobalConfigPath());
}
```

Leave the rest of the file (`init`, `logout`, `whoami`) unchanged for now. Their bodies already call these functions and will continue to work.

No change needed in `src/utils/api.ts` for this task. `Config` now lives in `config.ts` but is re-exported from `init.ts` via `export type { Config }`, so the existing `import { getConfig, saveConfig, Config } from '../commands/init';` continues to compile. Task 5 rewrites `api.ts` to use the resolver directly.

- [ ] **Step 2: Build**

```bash
cd /home/mercer/projects/solid/solidactions-cli && npm run build
```

Expected: exits 0 with no errors.

- [ ] **Step 3: Verify existing CLI still works (back-compat)**

```bash
cd /home/mercer/projects/solid/solidactions-cli && node dist/index.js whoami
```

Expected: same output as before this change — prints host + truncated API key from `~/.solidactions/config.json` (or "Not initialized" if none). No change in behavior.

- [ ] **Step 4: Commit**

```bash
git add src/commands/init.ts
git commit -m "refactor(config): route init.ts through new config module (#13)"
```

---

## Task 5: Update `requireConfig` / `ensureWorkspaceSelected` to use the resolver's active path

Today `ensureWorkspaceSelected` saves the workspace selection via `saveConfig()`, which now writes to the active path — so no change there. But the env-conflict skip-save and returned source info need to come from `resolveConfig()`. We'll keep the exposed shape of `requireConfig()` (returns `Config`) and add a new `requireResolvedConfig()` for callers that need sources/activePath.

**Files:**
- Modify: `src/utils/api.ts`

- [ ] **Step 1: Update `src/utils/api.ts`**

Replace the body of `src/utils/api.ts` with:

```ts
import axios from 'axios';
import chalk from 'chalk';
import readline from 'readline';
import { saveConfig } from '../commands/init';
import { Config, ResolvedConfig, resolveConfig } from './config';

export function getApiHeaders(config: Config, contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {
        'Authorization': `Bearer ${config.apiKey}`,
        'Accept': 'application/json',
    };
    if (contentType) headers['Content-Type'] = contentType;
    if (config.workspaceId) headers['X-Workspace-Id'] = config.workspaceId;
    return headers;
}

/**
 * Get the full resolution (config + sources + activePath). Exits if nothing resolvable.
 */
export function requireResolvedConfig(): ResolvedConfig {
    const resolved = resolveConfig();
    if (!resolved || !resolved.config.apiKey) {
        console.error(chalk.red('Not initialized. Run `solidactions init <api-key>` first.'));
        process.exit(1);
    }
    return resolved;
}

export function requireConfig(): Config {
    return requireResolvedConfig().config;
}

export async function ensureWorkspaceSelected(config: Config): Promise<Config> {
    if (config.workspaceId) {
        return config;
    }

    // Re-resolve so we know whether a save would be redundant (env-provided) or meaningful (file-backed).
    const resolved = resolveConfig();
    const workspaceSource = resolved?.sources.workspaceId ?? null;

    let workspaces: Array<{ id: string; name: string; org_name: string; role: string }>;
    try {
        const response = await axios.get(`${config.host}/api/v1/workspaces`, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
            },
        });
        const grouped = response.data.workspaces || response.data.teams || response.data.data || response.data;
        if (typeof grouped === 'object' && !Array.isArray(grouped)) {
            workspaces = [];
            for (const orgName of Object.keys(grouped)) {
                for (const ws of grouped[orgName]) {
                    workspaces.push({
                        id: ws.id,
                        name: ws.name,
                        org_name: ws.tenant_name || orgName,
                        role: ws.role,
                    });
                }
            }
        } else {
            workspaces = Array.isArray(grouped) ? grouped : [];
        }
    } catch (error: any) {
        if (error.response?.status === 401) {
            console.error(chalk.red('Authentication failed. Run `solidactions init <api-key>` to reconfigure.'));
        } else {
            console.error(chalk.red('Failed to fetch workspaces:'), error.response?.data?.message || error.message);
        }
        process.exit(1);
    }

    if (workspaces.length === 0) {
        console.error(chalk.red('No workspaces found. Create a workspace at your SolidActions dashboard first.'));
        process.exit(1);
    }

    let selected: typeof workspaces[0];

    if (workspaces.length === 1) {
        selected = workspaces[0];
        console.log(chalk.gray(`Auto-selected workspace: ${selected.name}`));
    } else {
        console.log(chalk.blue('\nSelect a workspace:\n'));
        workspaces.forEach((ws, i) => {
            console.log(`  ${chalk.white(`${i + 1}.`)} ${ws.name} ${chalk.gray(`(${ws.org_name}, ${ws.role})`)}`);
        });
        console.log('');

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
            rl.question(chalk.blue('Enter number: '), resolve);
        });
        rl.close();

        const index = parseInt(answer, 10) - 1;
        if (isNaN(index) || index < 0 || index >= workspaces.length) {
            console.error(chalk.red('Invalid selection.'));
            process.exit(1);
        }
        selected = workspaces[index];
    }

    config.workspaceId = selected.id;

    if (workspaceSource !== 'env') {
        saveConfig(config);
    }
    console.log(chalk.green(`Workspace set: ${selected.name}`));

    return config;
}

export async function requireConfigWithWorkspace(): Promise<Config> {
    const config = requireConfig();
    return ensureWorkspaceSelected(config);
}
```

- [ ] **Step 2: Build**

```bash
cd /home/mercer/projects/solid/solidactions-cli && npm run build
```

Expected: exits 0.

- [ ] **Step 3: Verify back-compat**

```bash
cd /home/mercer/projects/solid/solidactions-cli && node dist/index.js whoami
```

Expected: same output as before.

- [ ] **Step 4: Commit**

```bash
git add src/utils/api.ts
git commit -m "refactor(config): add requireResolvedConfig and skip workspace save on env override (#13)"
```

---

## Task 6: Add `--local` / `--global` flags + interactive prompt + non-TTY guard to `init`

**Files:**
- Modify: `src/index.ts` (commander `init` command, lines 40–49)
- Modify: `src/commands/init.ts` (`init` function)

- [ ] **Step 1: Update the `init` command registration in `src/index.ts`**

Replace lines 40–49 in `src/index.ts` with:

```ts
program
    .command('init')
    .description('Initialize the CLI with your API key')
    .argument('<api-key>', 'Your SolidActions API key')
    .option('--dev', 'Use local development server (http://localhost:8000)')
    .option('--host <url>', 'Custom API host URL')
    .option('--workspace <name-or-id>', 'Set workspace by name, slug, or ID (skips interactive prompt)')
    .option('--local', 'Save config to ./.solidactions/config.json in the current folder')
    .option('--global', 'Save config to ~/.solidactions/config.json (default if prompted)')
    .option('--gitignore', 'With --local, add .solidactions/ to .gitignore without prompting')
    .action((apiKey, options) => {
        init(apiKey, options);
    });
```

- [ ] **Step 2: Update the `init` function in `src/commands/init.ts`**

Replace the current `init` function body with this. Add imports at the top: `import readline from 'readline';` `import path from 'path';` `import { getLocalConfigPath } from '../utils/config';`

```ts
async function promptLocation(): Promise<'local' | 'global'> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
        rl.question(chalk.blue('Save config locally (./.solidactions) or globally (~/.solidactions)? [global] '), resolve);
    });
    rl.close();
    const normalized = answer.trim().toLowerCase();
    if (normalized === 'local' || normalized === 'l') return 'local';
    return 'global';
}

export async function init(
    apiKey: string,
    options: { dev?: boolean; host?: string; workspace?: string; local?: boolean; global?: boolean; gitignore?: boolean },
) {
    let host: string;
    if (options.host) {
        host = options.host;
    } else if (options.dev) {
        host = 'http://localhost:8000';
    } else {
        host = 'https://app.solidactions.com';
    }

    if (!apiKey || apiKey.trim().length === 0) {
        console.error(chalk.red('Error: API key is required.'));
        console.log(chalk.gray('Generate an API key at: ') + chalk.blue(`${host}/settings/api-keys`));
        process.exit(1);
    }

    // Determine target location.
    let target: 'local' | 'global';
    if (options.local && options.global) {
        console.error(chalk.red('Error: --local and --global are mutually exclusive.'));
        process.exit(1);
    } else if (options.local) {
        target = 'local';
    } else if (options.global) {
        target = 'global';
    } else if (process.stdin.isTTY) {
        target = await promptLocation();
    } else {
        console.error(chalk.red('Refusing to init non-interactively. Pass --local or --global.'));
        process.exit(1);
    }

    const targetPath = target === 'local' ? getLocalConfigPath() : getGlobalConfigPath();

    console.log(chalk.blue(`Initializing SolidActions CLI...`));
    console.log(chalk.gray(`Host: ${host}`));

    if (readConfigFile(targetPath)) {
        console.log(chalk.yellow(`Existing config at ${targetPath} will be overwritten.`));
    }

    const config: Config = {
        host,
        apiKey: apiKey.trim(),
    };
    writeConfigFile(targetPath, config);

    console.log(chalk.green('CLI initialized successfully!'));
    console.log(chalk.gray(`Configuration saved to ${targetPath}`));
    console.log('');

    // Workspace selection — always uses resolveConfig so it targets the right file.
    try {
        if (options.workspace) {
            await workspaceSet(options.workspace);
        } else {
            await ensureWorkspaceSelected(config);
        }
    } catch {
        console.log(chalk.yellow('Could not set workspace. Run `solidactions workspace set` later.'));
    }

    console.log('');
    console.log(chalk.blue('Quick start:'));
    console.log(chalk.gray('  solidactions project deploy <name>    Deploy current directory'));
    console.log(chalk.gray('  solidactions run start <proj> <wf>    Run a workflow'));
    console.log(chalk.gray('  solidactions run list                 List recent runs'));
}
```

You'll also need to add these imports at the top of `src/commands/init.ts`:

```ts
import readline from 'readline';
import {
    Config,
    resolveConfig,
    readConfigFile,
    writeConfigFile,
    removeConfigFile,
    getGlobalConfigPath,
    getLocalConfigPath,
} from '../utils/config';
```

Remove the now-unused imports (`ensureWorkspaceSelected` remains; the old `fs`/`os`/`path` imports are gone unless used elsewhere in the file).

- [ ] **Step 3: Build**

```bash
cd /home/mercer/projects/solid/solidactions-cli && npm run build
```

Expected: exits 0.

- [ ] **Step 4: Verify `--global` (existing behavior)**

```bash
mkdir -p /tmp/solidactions-init-test && cd /tmp/solidactions-init-test && node /home/mercer/projects/solid/solidactions-cli/dist/index.js init dummy-key --global --host https://example.test --workspace nonexistent 2>&1 | head -10
cat ~/.solidactions/config.json
```

Expected: config file updated with `host: https://example.test`, `apiKey: dummy-key`. (Workspace step will fail, which is fine for this test — the write already happened.)

**Restore your real config after this test.** Back it up first:

```bash
cp ~/.solidactions/config.json ~/.solidactions/config.json.backup
# run test
cp ~/.solidactions/config.json.backup ~/.solidactions/config.json
```

- [ ] **Step 5: Verify `--local`**

```bash
rm -rf /tmp/solidactions-init-local-test && mkdir -p /tmp/solidactions-init-local-test && cd /tmp/solidactions-init-local-test && node /home/mercer/projects/solid/solidactions-cli/dist/index.js init dummy-key --local --host https://example.test 2>&1 | head -20
ls -la .solidactions/
cat .solidactions/config.json
```

Expected: `./.solidactions/config.json` exists, contains `host`/`apiKey`. File mode `-rw-------` (0o600). Directory mode `drwx------` (0o700).

- [ ] **Step 6: Verify non-TTY guard**

```bash
cd /tmp && echo "" | node /home/mercer/projects/solid/solidactions-cli/dist/index.js init dummy-key --host https://example.test </dev/null 2>&1 | head -5
```

Expected: prints `Refusing to init non-interactively. Pass --local or --global.` and exits non-zero.

- [ ] **Step 7: Verify both-flags guard**

```bash
cd /tmp && node /home/mercer/projects/solid/solidactions-cli/dist/index.js init dummy-key --local --global --host https://example.test 2>&1 | head -5
```

Expected: prints `Error: --local and --global are mutually exclusive.`

- [ ] **Step 8: Commit**

```bash
cd /home/mercer/projects/solid/solidactions-cli && git add src/index.ts src/commands/init.ts
git commit -m "feat(init): add --local, --global, interactive prompt, non-TTY guard (#13)"
```

---

## Task 7: Add `.gitignore` handling for `init --local`

**Files:**
- Modify: `src/commands/init.ts`

- [ ] **Step 1: Add the helper**

Add this function just above `init()` in `src/commands/init.ts`:

```ts
async function ensureGitignoreCovers(targetDir: string, auto: boolean): Promise<void> {
    const gitignorePath = path.join(targetDir, '.gitignore');
    const patternToAdd = '.solidactions/';

    let existing = '';
    if (fs.existsSync(gitignorePath)) {
        existing = fs.readFileSync(gitignorePath, 'utf-8');
        const lines = existing.split('\n').map((l) => l.trim());
        if (lines.includes('.solidactions/') || lines.includes('.solidactions') || lines.includes('/.solidactions/')) {
            return; // already covered
        }
    }

    let shouldAdd = auto;
    if (!shouldAdd && process.stdin.isTTY) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
            rl.question(
                chalk.yellow(`Local config contains an API key. Add \`.solidactions/\` to ${gitignorePath}? [Y/n] `),
                resolve,
            );
        });
        rl.close();
        shouldAdd = !(answer.trim().toLowerCase().startsWith('n'));
    }

    if (!shouldAdd) {
        console.log(chalk.yellow(`Skipping .gitignore update. Remember: ${path.join(targetDir, '.solidactions', 'config.json')} contains your API key.`));
        return;
    }

    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(gitignorePath, `${existing}${prefix}${patternToAdd}\n`);
    console.log(chalk.green(`Added \`${patternToAdd}\` to ${gitignorePath}.`));
}
```

Add imports if not already present: `import fs from 'fs'; import path from 'path';`.

- [ ] **Step 2: Call it from `init` when target is local**

In `init()`, after `writeConfigFile(targetPath, config);` and before the "CLI initialized successfully!" log, add:

```ts
    if (target === 'local') {
        await ensureGitignoreCovers(process.cwd(), !!options.gitignore);
    }
```

- [ ] **Step 3: Build**

```bash
cd /home/mercer/projects/solid/solidactions-cli && npm run build
```

Expected: exits 0.

- [ ] **Step 4: Verify fresh folder prompts (interactive)**

```bash
rm -rf /tmp/solidactions-gi-test && mkdir -p /tmp/solidactions-gi-test && cd /tmp/solidactions-gi-test && node /home/mercer/projects/solid/solidactions-cli/dist/index.js init dummy --local --host https://example.test
# Answer "y" at the .gitignore prompt; ^C at the workspace step.
cat .gitignore
```

Expected: `.gitignore` contains `.solidactions/`.

- [ ] **Step 5: Verify `--gitignore` skips prompt**

```bash
rm -rf /tmp/solidactions-gi-auto-test && mkdir -p /tmp/solidactions-gi-auto-test && cd /tmp/solidactions-gi-auto-test && node /home/mercer/projects/solid/solidactions-cli/dist/index.js init dummy --local --gitignore --host https://example.test </dev/null 2>&1 | head -15
cat .gitignore
```

Expected: no prompt in output; `.gitignore` contains `.solidactions/`. (Workspace step will fail in non-TTY; that's fine.)

- [ ] **Step 6: Verify already-covered case is a no-op**

```bash
rm -rf /tmp/solidactions-gi-skip-test && mkdir -p /tmp/solidactions-gi-skip-test && cd /tmp/solidactions-gi-skip-test && echo ".solidactions/" > .gitignore && node /home/mercer/projects/solid/solidactions-cli/dist/index.js init dummy --local --gitignore --host https://example.test </dev/null 2>&1 | head -15
cat .gitignore
```

Expected: `.gitignore` still contains one line `.solidactions/`, not duplicated.

- [ ] **Step 7: Commit**

```bash
cd /home/mercer/projects/solid/solidactions-cli && git add src/commands/init.ts
git commit -m "feat(init): prompt to add .solidactions/ to .gitignore on --local (#13)"
```

---

## Task 8: Upgrade `whoami` to show per-field sources

**Files:**
- Modify: `src/commands/init.ts` (`whoami` function)

- [ ] **Step 1: Replace `whoami`**

Replace the existing `whoami()` in `src/commands/init.ts` with:

```ts
export async function whoami() {
    const resolved = resolveConfig();
    if (!resolved || !resolved.config.apiKey) {
        console.log(chalk.yellow('Not initialized.'));
        console.log(chalk.gray('Run "solidactions init <api-key>" to configure.'));
        process.exit(1);
    }

    const { config, sources } = resolved;
    const maskedKey = config.apiKey.length > 12
        ? `${config.apiKey.substring(0, 8)}...${config.apiKey.slice(-4)}`
        : config.apiKey;

    const fmt = (src: ConfigSource): string => {
        if (src === 'env') return chalk.gray('(from $SOLIDACTIONS_* env var)');
        if (src === null) return chalk.gray('(unset)');
        return chalk.gray(`(from ${src})`);
    };

    console.log(chalk.blue('Current configuration:'));
    console.log(`  Host:        ${config.host.padEnd(40)} ${fmt(sources.host)}`);
    console.log(`  API Key:     ${maskedKey.padEnd(40)} ${fmt(sources.apiKey)}`);
    console.log(`  Workspace:   ${(config.workspaceId ?? '').padEnd(40)} ${fmt(sources.workspaceId)}`);
}
```

Update the import line in `src/commands/init.ts` to include `ConfigSource`:

```ts
import {
    Config,
    ConfigSource,
    resolveConfig,
    // ...
} from '../utils/config';
```

- [ ] **Step 2: Build**

```bash
cd /home/mercer/projects/solid/solidactions-cli && npm run build
```

Expected: exits 0.

- [ ] **Step 3: Verify against global config**

```bash
cd /tmp && node /home/mercer/projects/solid/solidactions-cli/dist/index.js whoami
```

Expected: prints `Host`, `API Key`, `Workspace` each annotated with `(from /home/mercer/.solidactions/config.json)`.

- [ ] **Step 4: Verify mixed sources**

```bash
cd /tmp/solidactions-init-local-test && SOLIDACTIONS_WORKSPACE_ID=env-ws-123 node /home/mercer/projects/solid/solidactions-cli/dist/index.js whoami
```

Expected:
- `Host` and `API Key` show `(from /tmp/solidactions-init-local-test/.solidactions/config.json)`
- `Workspace` shows `env-ws-123` with `(from $SOLIDACTIONS_* env var)`

- [ ] **Step 5: Commit**

```bash
cd /home/mercer/projects/solid/solidactions-cli && git add src/commands/init.ts
git commit -m "feat(whoami): show per-field config sources (#13)"
```

---

## Task 9: Update `workspace set` — write to active path; error on env conflict

**Files:**
- Modify: `src/commands/workspaces.ts`

- [ ] **Step 1: Update `workspaceSet`**

Replace the entire `workspaceSet` function in `src/commands/workspaces.ts` with:

```ts
export async function workspaceSet(workspaceId: string) {
    if (process.env.SOLIDACTIONS_WORKSPACE_ID) {
        console.error(chalk.red(
            'SOLIDACTIONS_WORKSPACE_ID is set in the environment; the change would not take effect. ' +
            'Unset the env var or edit the config file directly.',
        ));
        process.exit(1);
    }

    const resolved = requireResolvedConfig();
    const config = resolved.config;

    try {
        const response = await axios.get(`${config.host}/api/v1/workspaces`, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
            },
        });

        const grouped = response.data.workspaces || response.data.data || response.data;
        let allWorkspaces: any[] = [];
        if (typeof grouped === 'object' && !Array.isArray(grouped)) {
            for (const orgWorkspaces of Object.values(grouped)) {
                allWorkspaces.push(...(orgWorkspaces as any[]));
            }
        } else if (Array.isArray(grouped)) {
            allWorkspaces = grouped;
        }
        const workspace = allWorkspaces.find(
            (w: any) => w.id === workspaceId || w.slug === workspaceId || w.name === workspaceId,
        );

        if (!workspace) {
            console.error(chalk.red(`Workspace "${workspaceId}" not found. Run \`solidactions workspace list\` to list available workspaces.`));
            process.exit(1);
        }

        const updated: Config = { ...config, workspaceId: workspace.id };
        writeConfigFile(resolved.activePath, updated);
        console.log(chalk.green(`Workspace set to: ${workspace.name} (${workspace.id})`));
        console.log(chalk.gray(`Saved to ${resolved.activePath}`));
    } catch (error: any) {
        console.error(chalk.red('Failed to set workspace:'), error.response?.data?.message || error.message);
        process.exit(1);
    }
}
```

Update imports at the top of the file:

```ts
import axios from 'axios';
import chalk from 'chalk';
import { requireConfig, requireResolvedConfig } from '../utils/api';
import { Config, writeConfigFile } from '../utils/config';
```

Remove the now-unused `saveConfig` and `getApiHeaders` imports. `requireConfig` is still needed by `workspacesList` elsewhere in this file.

- [ ] **Step 2: Build**

```bash
cd /home/mercer/projects/solid/solidactions-cli && npm run build
```

Expected: exits 0.

- [ ] **Step 3: Verify env conflict error**

```bash
SOLIDACTIONS_WORKSPACE_ID=pinned cd /tmp && SOLIDACTIONS_WORKSPACE_ID=pinned node /home/mercer/projects/solid/solidactions-cli/dist/index.js workspace set some-workspace 2>&1 | head -5
```

Expected: prints the env-conflict error and exits non-zero.

- [ ] **Step 4: Verify it writes to active path (local)**

Precondition: `/tmp/solidactions-init-local-test/.solidactions/config.json` exists from Task 6.

```bash
cd /tmp/solidactions-init-local-test && node /home/mercer/projects/solid/solidactions-cli/dist/index.js workspace set does-not-exist 2>&1 | head -5
```

Expected: error about "Workspace 'does-not-exist' not found." (Because the API will fail first — but that's expected; the point of this step is that we *would* have written to the local path, which we can't fully verify without a real workspace. See step 5.)

- [ ] **Step 5: Verify path annotation on success (requires real workspace)**

If you have a real API key and workspace in local config:

```bash
cd /tmp/solidactions-init-local-test && node /home/mercer/projects/solid/solidactions-cli/dist/index.js workspace set <real-workspace-name>
cat .solidactions/config.json
```

Expected: prints `Saved to /tmp/solidactions-init-local-test/.solidactions/config.json`. Local config's `workspaceId` updated.

If no real workspace available, skip this step and verify logic via code review.

- [ ] **Step 6: Commit**

```bash
cd /home/mercer/projects/solid/solidactions-cli && git add src/commands/workspaces.ts
git commit -m "feat(workspace): write to active config path; error on env conflict (#13)"
```

---

## Task 10: Update `logout` — flags + default walk-up behavior

**Files:**
- Modify: `src/index.ts` (logout registration, lines 51–56)
- Modify: `src/commands/init.ts` (`logout` function)

- [ ] **Step 1: Update the `logout` command registration**

Replace lines 51–56 in `src/index.ts` with:

```ts
program
    .command('logout')
    .description('Remove saved credentials')
    .option('--local', 'Remove only the nearest local ./.solidactions/config.json')
    .option('--global', 'Remove only ~/.solidactions/config.json')
    .action((options) => {
        logout(options);
    });
```

- [ ] **Step 2: Replace the `logout` function**

Replace the existing `logout()` in `src/commands/init.ts` with:

```ts
export async function logout(options: { local?: boolean; global?: boolean } = {}) {
    if (options.local && options.global) {
        console.error(chalk.red('Error: --local and --global are mutually exclusive.'));
        process.exit(1);
    }

    const globalPath = getGlobalConfigPath();
    const localPath = findLocalConfigPath(process.cwd());

    let targetPath: string | null;
    if (options.local) {
        targetPath = localPath;
        if (!targetPath) {
            console.error(chalk.red(`No local config found in ${process.cwd()} or any parent directory.`));
            process.exit(1);
        }
    } else if (options.global) {
        targetPath = globalPath;
    } else {
        targetPath = localPath ?? globalPath;
    }

    const removed = removeConfigFile(targetPath);
    if (removed) {
        console.log(chalk.green(`Logged out. Removed ${targetPath}`));
    } else {
        console.log(chalk.gray(`Not logged in (no config at ${targetPath}).`));
    }
}
```

Add `findLocalConfigPath` to the imports from `../utils/config`:

```ts
import {
    Config,
    ConfigSource,
    resolveConfig,
    readConfigFile,
    writeConfigFile,
    removeConfigFile,
    findLocalConfigPath,
    getGlobalConfigPath,
    getLocalConfigPath,
} from '../utils/config';
```

- [ ] **Step 3: Build**

```bash
cd /home/mercer/projects/solid/solidactions-cli && npm run build
```

Expected: exits 0.

- [ ] **Step 4: Verify `logout --local`**

```bash
rm -rf /tmp/solidactions-logout-test && mkdir -p /tmp/solidactions-logout-test && cd /tmp/solidactions-logout-test && mkdir .solidactions && echo '{"host":"h","apiKey":"k"}' > .solidactions/config.json
node /home/mercer/projects/solid/solidactions-cli/dist/index.js logout --local
ls .solidactions/ 2>&1
```

Expected: prints `Logged out. Removed /tmp/solidactions-logout-test/.solidactions/config.json`. The config file is gone.

- [ ] **Step 5: Verify bare `logout` with only global**

```bash
# Back up real global, then run logout
cp ~/.solidactions/config.json ~/.solidactions/config.json.logout-backup
cd /tmp && node /home/mercer/projects/solid/solidactions-cli/dist/index.js logout
cp ~/.solidactions/config.json.logout-backup ~/.solidactions/config.json  # restore
```

Expected: prints `Logged out. Removed /home/mercer/.solidactions/config.json`.

- [ ] **Step 6: Verify `logout --local` errors when no local config is walk-up-findable**

```bash
cd /tmp && node /home/mercer/projects/solid/solidactions-cli/dist/index.js logout --local 2>&1 | head -3
```

Expected: prints `No local config found in /tmp or any parent directory.`

- [ ] **Step 7: Commit**

```bash
cd /home/mercer/projects/solid/solidactions-cli && git add src/index.ts src/commands/init.ts
git commit -m "feat(logout): add --local/--global flags; default to walk-up removal (#13)"
```

---

## Task 11: Add `SOLIDACTIONS_DEBUG=1` resolution dump

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add the debug hook**

In `src/index.ts`, insert this block immediately after `const program = new Command();` (line 29):

```ts
if (process.env.SOLIDACTIONS_DEBUG === '1') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveConfig } = require('./utils/config');
    const resolved = resolveConfig();
    if (resolved) {
        const fmt = (src: any) => {
            if (src === 'env') return '(from $SOLIDACTIONS_* env var)';
            if (src === null) return '(unset)';
            return `(from ${src})`;
        };
        process.stderr.write('[SOLIDACTIONS_DEBUG] resolved configuration:\n');
        process.stderr.write(`  host:        ${resolved.config.host} ${fmt(resolved.sources.host)}\n`);
        process.stderr.write(`  apiKey:      <redacted> ${fmt(resolved.sources.apiKey)}\n`);
        process.stderr.write(`  workspaceId: ${resolved.config.workspaceId ?? ''} ${fmt(resolved.sources.workspaceId)}\n`);
        process.stderr.write(`  activePath:  ${resolved.activePath}\n`);
    } else {
        process.stderr.write('[SOLIDACTIONS_DEBUG] no config resolvable\n');
    }
}
```

- [ ] **Step 2: Build**

```bash
cd /home/mercer/projects/solid/solidactions-cli && npm run build
```

Expected: exits 0.

- [ ] **Step 3: Verify the dump appears on stderr**

```bash
cd /tmp && SOLIDACTIONS_DEBUG=1 node /home/mercer/projects/solid/solidactions-cli/dist/index.js whoami 2>/tmp/solidactions-debug-stderr
cat /tmp/solidactions-debug-stderr
```

Expected: file contains the `[SOLIDACTIONS_DEBUG]` block with resolved sources.

- [ ] **Step 4: Verify it's silent when the env var is not set**

```bash
cd /tmp && node /home/mercer/projects/solid/solidactions-cli/dist/index.js whoami 2>/tmp/solidactions-nodbg-stderr
wc -l /tmp/solidactions-nodbg-stderr
```

Expected: `0 /tmp/solidactions-nodbg-stderr`.

- [ ] **Step 5: Commit**

```bash
cd /home/mercer/projects/solid/solidactions-cli && git add src/index.ts
git commit -m "feat(debug): add SOLIDACTIONS_DEBUG=1 resolution dump (#13)"
```

---

## Task 12: Update README.md with new flags, env vars, resolution order

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Configuration" section**

Locate the existing `init` documentation in `README.md` and add a new top-level `## Configuration` section near it (or replace the current init notes if they're minimal). The section should include the following content verbatim:

````markdown
## Configuration

The CLI stores `host`, `apiKey`, and `workspaceId` in a JSON config file. Two locations are supported:

- **Global** — `~/.solidactions/config.json`. Used by default, shared across all folders for a single user.
- **Local** — `./.solidactions/config.json`. Scoped to a project folder; takes precedence over the global file when running commands from inside that folder (or any subdirectory — the CLI walks up looking for it).

### Resolution order

For each field (`host`, `apiKey`, `workspaceId`), the CLI resolves independently in this order:

1. Environment variables: `SOLIDACTIONS_HOST`, `SOLIDACTIONS_API_KEY`, `SOLIDACTIONS_WORKSPACE_ID`
2. Nearest local `./.solidactions/config.json` (walking up from cwd)
3. Global `~/.solidactions/config.json`

You can mix: e.g., set only `SOLIDACTIONS_WORKSPACE_ID` in the environment while letting `host` and `apiKey` come from a file.

### `solidactions init` flags

- `--local` — write config to `./.solidactions/config.json` in the current folder.
- `--global` — write config to `~/.solidactions/config.json` (today's default).
- `--gitignore` — with `--local`, auto-add `.solidactions/` to `.gitignore` without prompting.

In interactive shells, `init` without `--local`/`--global` prompts for a location. In non-interactive contexts, one of the flags is required.

### `solidactions logout` flags

- `--local` — remove only the nearest local config (walks up from cwd).
- `--global` — remove only the global config.
- Bare `logout` — removes the nearest local if present, otherwise removes global.

### Debugging resolution

Set `SOLIDACTIONS_DEBUG=1` on any command to print the resolved configuration and per-field sources to stderr before the command runs. `solidactions whoami` also shows this information.

### Use case: multiple AI agents in parallel

If you run multiple AI coding agents in different project folders simultaneously, either:

- Run `solidactions init <key> --local` in each folder so each has its own config, or
- Set `SOLIDACTIONS_API_KEY` / `SOLIDACTIONS_WORKSPACE_ID` in the environment each agent uses (no files to share or stomp).
````

- [ ] **Step 2: Commit**

```bash
cd /home/mercer/projects/solid/solidactions-cli && git add README.md
git commit -m "docs: document per-folder config, resolution order, new flags (#13)"
```

---

## Task 13: Capture test notes for deferred coverage

The CLI repo has no test framework today. This task records what should be tested when one is added. Skip if a test framework is introduced as a separate initiative that will pick up these cases.

**Files:**
- Create: `docs/test-todo.md`

- [ ] **Step 1: Write the test notes**

Create `docs/test-todo.md` with this content:

```markdown
# Test TODO — CLI

When a test framework is introduced, cover the following for per-folder config (#13):

## `src/utils/config.ts` unit tests

- `findLocalConfigPath` returns null when no `.solidactions/config.json` exists anywhere up the tree.
- `findLocalConfigPath` skips `$HOME` — never reports `~/.solidactions/config.json` as a local hit.
- `findLocalConfigPath` stops at filesystem root without throwing.
- `findLocalConfigPath` returns the deepest match when multiple ancestors have `.solidactions/` directories.
- `readConfigFile` returns null for missing / malformed files (no throw).
- `readConfigFile` normalizes `{ token }` into `{ apiKey }` (legacy shim).
- `writeConfigFile` is atomic (tmp-file exists only briefly; readers never see a torn file).
- `writeConfigFile` creates the parent directory at mode 0o700, file at mode 0o600.
- `resolveConfig` merges field-by-field: env > local > global.
- `resolveConfig` preserves `activePath = nearest-local-if-present, else-global`.
- `resolveConfig` returns null when no layer contributes `apiKey` and `host`.
- `resolveConfig` reads env overrides lazily from `process.env` (tests can mutate env between calls).

## `init` integration tests

- `--local` writes to `./.solidactions/config.json` and leaves `~/.solidactions/config.json` untouched.
- `--global` writes to `~/.solidactions/config.json`.
- `--local --global` errors.
- Non-TTY without either flag errors.
- `--gitignore` auto-adds `.solidactions/` to `.gitignore`.
- `--gitignore` is a no-op when the pattern is already present.
- Existing target path is overwritten silently with a warning line.

## `logout` integration tests

- `--local` removes the walk-up match; errors if no local config found.
- `--global` removes global only.
- Bare `logout` removes local if present, else global.

## `whoami` integration tests

- Shows correct source annotation for each of: env override, local file, global file, unset.

## `workspace set` integration tests

- Errors if `SOLIDACTIONS_WORKSPACE_ID` is set in the environment.
- Writes to `resolved.activePath` (local takes precedence over global).
- Prints the absolute path of the file it wrote.

## `SOLIDACTIONS_DEBUG=1`

- Prints resolution table to stderr on any command; absent when unset.
- Does not leak the API key (prints `<redacted>`).
```

- [ ] **Step 2: Commit**

```bash
cd /home/mercer/projects/solid/solidactions-cli && git add docs/test-todo.md
git commit -m "docs: record test TODO for per-folder config feature (#13)"
```

---

## Task 14: End-to-end verification

Final pass to confirm nothing regressed and all user-facing flows behave as specified.

- [ ] **Step 1: Back up your real global config**

```bash
cp ~/.solidactions/config.json ~/.solidactions/config.json.e2e-backup
```

- [ ] **Step 2: Scenario — global-only (existing user, no changes)**

```bash
cd /tmp && node /home/mercer/projects/solid/solidactions-cli/dist/index.js whoami
```

Expected: prints host / API key / workspace, all sourced from `~/.solidactions/config.json`. Same as pre-change behavior.

- [ ] **Step 3: Scenario — local takes precedence over global**

```bash
rm -rf /tmp/sa-e2e-local && mkdir -p /tmp/sa-e2e-local/.solidactions && echo '{"host":"https://local.test","apiKey":"local-key","workspaceId":"local-ws"}' > /tmp/sa-e2e-local/.solidactions/config.json
cd /tmp/sa-e2e-local && node /home/mercer/projects/solid/solidactions-cli/dist/index.js whoami
```

Expected: all three fields sourced from `/tmp/sa-e2e-local/.solidactions/config.json`.

- [ ] **Step 4: Scenario — local from subdirectory (walk-up)**

```bash
mkdir -p /tmp/sa-e2e-local/deep/nested/subdir && cd /tmp/sa-e2e-local/deep/nested/subdir && node /home/mercer/projects/solid/solidactions-cli/dist/index.js whoami
```

Expected: same output as Step 3 (walks up to `/tmp/sa-e2e-local`).

- [ ] **Step 5: Scenario — env override for one field only**

```bash
cd /tmp/sa-e2e-local && SOLIDACTIONS_WORKSPACE_ID=env-override-ws node /home/mercer/projects/solid/solidactions-cli/dist/index.js whoami
```

Expected: `Workspace: env-override-ws` with `(from $SOLIDACTIONS_* env var)`; `host` and `apiKey` still from local file.

- [ ] **Step 6: Scenario — walk-up does NOT match `~/.solidactions/config.json`**

```bash
cd ~ && node /home/mercer/projects/solid/solidactions-cli/dist/index.js whoami
```

Expected: sources for `host`/`apiKey`/`workspaceId` show `(from /home/mercer/.solidactions/config.json)` — meaning they were resolved via the global layer, not mistakenly matched as a local hit during walk-up. The key assertion: the source path output is the global path, reached through the "global layer" not through the walk-up logic.

- [ ] **Step 7: Scenario — `workspace set` errors with env var**

```bash
cd /tmp && SOLIDACTIONS_WORKSPACE_ID=pinned node /home/mercer/projects/solid/solidactions-cli/dist/index.js workspace set anything 2>&1 | head -3
```

Expected: error about env var being set.

- [ ] **Step 8: Scenario — `SOLIDACTIONS_DEBUG` dumps resolution**

```bash
cd /tmp/sa-e2e-local && SOLIDACTIONS_DEBUG=1 node /home/mercer/projects/solid/solidactions-cli/dist/index.js whoami 2>&1 >/dev/null | head -10
```

Expected: `[SOLIDACTIONS_DEBUG]` block appears on stderr with per-field sources.

- [ ] **Step 9: Restore real global config**

```bash
cp ~/.solidactions/config.json.e2e-backup ~/.solidactions/config.json
rm ~/.solidactions/config.json.e2e-backup
```

- [ ] **Step 10: Clean up scratch dirs**

```bash
rm -rf /tmp/sa-e2e-local /tmp/solidactions-init-test /tmp/solidactions-init-local-test /tmp/solidactions-gi-test /tmp/solidactions-gi-auto-test /tmp/solidactions-gi-skip-test /tmp/solidactions-logout-test /tmp/solidactions-debug-stderr /tmp/solidactions-nodbg-stderr
```

- [ ] **Step 11: Final sanity — real command against real server (if you have a dev workspace)**

```bash
cd /tmp && node /home/mercer/projects/solid/solidactions-cli/dist/index.js project list
```

Expected: lists projects as before — full round-trip against the API still works.

- [ ] **Step 12: Open PR**

At this point, the branch `feat/issue-13-per-folder-config` is ready. Ask the user before pushing or opening the PR.

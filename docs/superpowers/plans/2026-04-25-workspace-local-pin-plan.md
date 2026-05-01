# Per-folder Workspace Pin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-directory workspace pinning to the SolidActions CLI: `workspace set <slug> --local` writes a partial config to `./.solidactions/config.json`, and a layered precedence chain (`-w` flag → env → local → global) decides the active workspace per command. Plus a backend-error hint and the four spec tests.

**Architecture:** Extend the existing layered-config resolver. Local file gains optional `workspace` (slug, canonical for humans) alongside `workspaceId` (UUID, truth for API). New top-level `-w` commander option flows into a module-level setter consumed by `resolveConfig`. A single axios response interceptor augments the new "Project not found in your active workspace" 404 with a remediation hint.

**Tech Stack:** TypeScript 5, Node ≥18, axios, commander 11, fs-extra, **vitest** (new — added in this plan).

**Spec:** `docs/superpowers/specs/2026-04-25-workspace-local-pin-design.md`

**Key constraints:**
- `solidactions-app` PR #128 must merge + deploy to `e2e.formup.cc` before manual staging smoke (everything else in this plan is unblocked).
- Per project memory: superpowers tooling, never Clavix; CI runs unit before e2e.
- Hard cut for `workspace set` flag handling — no deprecation warning.

---

## Task 1: Set up vitest

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1.1: Install vitest as devDependency**

Run from worktree root:

```bash
npm install --save-dev vitest
```

Expected: `package.json` updated with `vitest` under `devDependencies`. `package-lock.json` updated. No errors.

- [ ] **Step 1.2: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        testTimeout: 10_000,
    },
});
```

- [ ] **Step 1.3: Add npm scripts**

Modify `package.json`'s `scripts` block to add `test` and `test:watch` while preserving existing scripts. Resulting block:

```json
"scripts": {
    "build": "tsc",
    "prepublishOnly": "npm run build",
    "test": "vitest run",
    "test:watch": "vitest"
}
```

- [ ] **Step 1.4: Verify tooling — empty test run exits 0**

Create a placeholder file `tests/.gitkeep` (so the directory exists) and run:

```bash
npm test
```

Expected: vitest reports `No test files found, exiting with code 0`. (Or `No test suites found` — the exact wording varies by vitest version. The exit code must be 0.)

If exit code is non-zero, investigate before continuing.

- [ ] **Step 1.5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts tests/.gitkeep
git commit -m "$(cat <<'EOF'
chore: add vitest as the test framework

No tests yet — scaffolding only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `workspace` slug to Config + extract pure `mergeConfigs`

**Files:**
- Modify: `src/utils/config.ts`
- Create: `tests/config-merge.test.ts`

This is **spec test #1**: unit test for the merge function (key-by-key merge, missing-key fallthrough).

- [ ] **Step 2.1: Write the failing test**

Create `tests/config-merge.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mergeConfigs } from '../src/utils/config';

const LOCAL_PATH = '/tmp/local/.solidactions/config.json';
const GLOBAL_PATH = '/home/u/.solidactions/config.json';

describe('mergeConfigs', () => {
    it('returns null when no source contributes host or apiKey', () => {
        const result = mergeConfigs({}, null, null, null, GLOBAL_PATH);
        expect(result).toBeNull();
    });

    it('env wins per-key over local and global', () => {
        const env = { host: 'https://env-host', apiKey: 'env-key' };
        const local = { host: 'https://local-host', apiKey: 'local-key', workspace: 'local-ws', workspaceId: 'local-uuid' };
        const global = { host: 'https://global-host', apiKey: 'global-key', workspace: 'global-ws', workspaceId: 'global-uuid' };
        const result = mergeConfigs(env, local, LOCAL_PATH, global, GLOBAL_PATH);
        expect(result).not.toBeNull();
        expect(result!.config.host).toBe('https://env-host');
        expect(result!.config.apiKey).toBe('env-key');
        expect(result!.sources.host).toBe('env');
        expect(result!.sources.apiKey).toBe('env');
    });

    it('local wins over global per-key when env is silent', () => {
        const local = { workspace: 'mercer', workspaceId: 'local-uuid' };
        const global = { host: 'https://h', apiKey: 'k', workspace: 'global-ws', workspaceId: 'global-uuid' };
        const result = mergeConfigs({}, local, LOCAL_PATH, global, GLOBAL_PATH);
        expect(result).not.toBeNull();
        expect(result!.config.workspace).toBe('mercer');
        expect(result!.config.workspaceId).toBe('local-uuid');
        expect(result!.sources.workspace).toBe(LOCAL_PATH);
        expect(result!.sources.workspaceId).toBe(LOCAL_PATH);
        expect(result!.config.host).toBe('https://h');
        expect(result!.sources.host).toBe(GLOBAL_PATH);
    });

    it('falls through missing keys to the next layer', () => {
        const local = { workspace: 'mercer' };
        const global = { host: 'https://h', apiKey: 'k', workspaceId: 'global-uuid' };
        const result = mergeConfigs({}, local, LOCAL_PATH, global, GLOBAL_PATH);
        expect(result).not.toBeNull();
        expect(result!.config.workspace).toBe('mercer');
        expect(result!.sources.workspace).toBe(LOCAL_PATH);
        expect(result!.config.workspaceId).toBe('global-uuid');
        expect(result!.sources.workspaceId).toBe(GLOBAL_PATH);
    });

    it('reports null source for keys absent from every layer', () => {
        const result = mergeConfigs({}, null, null, { host: 'https://h', apiKey: 'k' }, GLOBAL_PATH);
        expect(result).not.toBeNull();
        expect(result!.config.workspace).toBeUndefined();
        expect(result!.sources.workspace).toBeNull();
        expect(result!.config.workspaceId).toBeUndefined();
        expect(result!.sources.workspaceId).toBeNull();
    });
});
```

- [ ] **Step 2.2: Run test — expect failure**

```bash
npm test -- tests/config-merge.test.ts
```

Expected: the test fails to import `mergeConfigs` from `../src/utils/config` (it doesn't exist yet).

- [ ] **Step 2.3: Add `workspace` to `Config` and extract `mergeConfigs`**

Modify `src/utils/config.ts`. Replace the `Config` interface and the body of `resolveConfig` with:

```ts
export interface Config {
    host: string;
    apiKey: string;
    workspace?: string;     // human-readable slug; cosmetic
    workspaceId?: string;   // canonical UUID used in API calls
}

export type ConfigSource = 'env' | string | null;

export interface ResolvedConfig {
    config: Config;
    sources: {
        host: ConfigSource;
        apiKey: ConfigSource;
        workspace: ConfigSource;
        workspaceId: ConfigSource;
    };
    activePath: string;
}

// ... keep getGlobalConfigPath, getLocalConfigPath, findLocalConfigPath, readConfigFile,
//     writeConfigFile, removeConfigFile, readEnvOverrides exactly as they are ...

export function mergeConfigs(
    env: Partial<Config>,
    local: Partial<Config> | null,
    localPath: string | null,
    global: Partial<Config> | null,
    globalPath: string,
): { config: Config; sources: ResolvedConfig['sources'] } | null {
    const pick = <K extends keyof Config>(
        key: K,
    ): { value: Config[K] | undefined; source: ConfigSource } => {
        if (env[key] !== undefined) return { value: env[key] as Config[K], source: 'env' };
        if (local && local[key] !== undefined) return { value: local[key], source: localPath! };
        if (global && global[key] !== undefined) return { value: global[key], source: globalPath };
        return { value: undefined, source: null };
    };

    const host = pick('host');
    const apiKey = pick('apiKey');
    const workspace = pick('workspace');
    const workspaceId = pick('workspaceId');

    if (!host.value && !apiKey.value) {
        return null;
    }

    return {
        config: {
            host: (host.value ?? '') as string,
            apiKey: (apiKey.value ?? '') as string,
            workspace: workspace.value as string | undefined,
            workspaceId: workspaceId.value as string | undefined,
        },
        sources: {
            host: host.source,
            apiKey: apiKey.source,
            workspace: workspace.source,
            workspaceId: workspaceId.source,
        },
    };
}

export function resolveConfig(cwd: string = process.cwd()): ResolvedConfig | null {
    const env = readEnvOverrides();
    const localPath = findLocalConfigPath(cwd);
    const local = localPath ? readConfigFile(localPath) : null;
    const global = readConfigFile(getGlobalConfigPath());

    const merged = mergeConfigs(env, local, localPath, global, getGlobalConfigPath());
    if (!merged) return null;

    return {
        config: merged.config,
        sources: merged.sources,
        activePath: localPath ?? getGlobalConfigPath(),
    };
}
```

Also update `readEnvOverrides` to leave `workspace` undefined (env never carries the slug per spec):

```ts
function readEnvOverrides(): Partial<Config> {
    const env: Partial<Config> = {};
    if (process.env.SOLIDACTIONS_HOST) env.host = process.env.SOLIDACTIONS_HOST;
    if (process.env.SOLIDACTIONS_API_KEY) env.apiKey = process.env.SOLIDACTIONS_API_KEY;
    if (process.env.SOLIDACTIONS_WORKSPACE_ID) env.workspaceId = process.env.SOLIDACTIONS_WORKSPACE_ID;
    return env;
}
```

(`SOLIDACTIONS_WORKSPACE_ID` continues to populate `env.workspaceId`. We do NOT add a `SOLIDACTIONS_WORKSPACE` env var per the spec decision.)

- [ ] **Step 2.4: Run test — expect pass**

```bash
npm test -- tests/config-merge.test.ts
```

Expected: 5 passed.

- [ ] **Step 2.5: Verify `tsc` build is clean**

```bash
npm run build
```

Expected: exit code 0. No type errors.

- [ ] **Step 2.6: Commit**

```bash
git add src/utils/config.ts tests/config-merge.test.ts
git commit -m "$(cat <<'EOF'
feat(config): add workspace slug field, extract pure mergeConfigs

Adds optional workspace (slug) alongside workspaceId on the Config type
and refactors resolveConfig to delegate to a pure mergeConfigs() so the
merge logic is unit-testable. Test #1 from the spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: CLI workspace override + precedence-chain test

**Files:**
- Modify: `src/utils/config.ts`
- Create: `tests/helpers.ts`
- Create: `tests/precedence-chain.test.ts`

This is **spec test #3**: the lookup precedence chain.

- [ ] **Step 3.1: Create the test helpers module**

`tests/helpers.ts`:

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach } from 'vitest';

const ENV_KEYS_TO_RESTORE = [
    'HOME',
    'SOLIDACTIONS_HOST',
    'SOLIDACTIONS_API_KEY',
    'SOLIDACTIONS_WORKSPACE_ID',
];

export function makeTmpEnv(): { home: string; cwd: string; cleanup: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-test-'));
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'work');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });

    const saved: Record<string, string | undefined> = {};
    for (const key of ENV_KEYS_TO_RESTORE) {
        saved[key] = process.env[key];
    }
    process.env.HOME = home;
    delete process.env.SOLIDACTIONS_HOST;
    delete process.env.SOLIDACTIONS_API_KEY;
    delete process.env.SOLIDACTIONS_WORKSPACE_ID;

    const cleanup = () => {
        for (const key of ENV_KEYS_TO_RESTORE) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
        fs.rmSync(root, { recursive: true, force: true });
    };

    return { home, cwd, cleanup };
}

export function writeGlobal(home: string, body: object): string {
    const dir = path.join(home, '.solidactions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify(body, null, 2));
    return file;
}

export function writeLocal(cwd: string, body: object): string {
    const dir = path.join(cwd, '.solidactions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify(body, null, 2));
    return file;
}

export function withEachCleanup(state: { cleanup: (() => void) | null }) {
    afterEach(() => {
        state.cleanup?.();
        state.cleanup = null;
    });
}
```

- [ ] **Step 3.2: Write the failing precedence test**

`tests/precedence-chain.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    resolveConfig,
    setCliWorkspaceOverride,
} from '../src/utils/config';
import { makeTmpEnv, writeGlobal, writeLocal } from './helpers';

describe('resolveConfig precedence chain', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();
    });
    afterEach(() => {
        setCliWorkspaceOverride(undefined);
        env.cleanup();
    });

    it('returns null when no layer is set', () => {
        const result = resolveConfig(env.cwd);
        expect(result).toBeNull();
    });

    it('global only — global workspace wins', () => {
        writeGlobal(env.home, {
            host: 'https://app.solidactions.com',
            apiKey: 'sk_g',
            workspace: 'global-ws',
            workspaceId: 'global-uuid',
        });
        const result = resolveConfig(env.cwd);
        expect(result?.config.workspaceId).toBe('global-uuid');
        expect(result?.config.workspace).toBe('global-ws');
    });

    it('local overrides global per key', () => {
        writeGlobal(env.home, { host: 'https://h', apiKey: 'k', workspace: 'g', workspaceId: 'g-uuid' });
        writeLocal(env.cwd, { workspace: 'mercer', workspaceId: 'local-uuid' });
        const result = resolveConfig(env.cwd);
        expect(result?.config.workspaceId).toBe('local-uuid');
        expect(result?.config.workspace).toBe('mercer');
        expect(result?.config.host).toBe('https://h');
        expect(result?.config.apiKey).toBe('k');
    });

    it('SOLIDACTIONS_WORKSPACE_ID env var beats local + global', () => {
        writeGlobal(env.home, { host: 'https://h', apiKey: 'k', workspaceId: 'g-uuid' });
        writeLocal(env.cwd, { workspaceId: 'local-uuid' });
        process.env.SOLIDACTIONS_WORKSPACE_ID = 'env-uuid';
        const result = resolveConfig(env.cwd);
        expect(result?.config.workspaceId).toBe('env-uuid');
        expect(result?.sources.workspaceId).toBe('env');
    });

    it('-w (CLI override) beats env, local, and global', () => {
        writeGlobal(env.home, { host: 'https://h', apiKey: 'k', workspaceId: 'g-uuid' });
        writeLocal(env.cwd, { workspaceId: 'local-uuid' });
        process.env.SOLIDACTIONS_WORKSPACE_ID = 'env-uuid';
        setCliWorkspaceOverride('cli-input');
        const result = resolveConfig(env.cwd);
        expect(result?.config.workspace).toBe('cli-input');
        expect(result?.config.workspaceId).toBeUndefined();
        expect(result?.sources.workspace).toBe('cli');
        expect(result?.sources.workspaceId).toBe('cli');
    });

    it('clearing the override returns to the underlying chain', () => {
        writeGlobal(env.home, { host: 'https://h', apiKey: 'k', workspaceId: 'g-uuid' });
        setCliWorkspaceOverride('cli-input');
        setCliWorkspaceOverride(undefined);
        const result = resolveConfig(env.cwd);
        expect(result?.config.workspaceId).toBe('g-uuid');
    });
});
```

- [ ] **Step 3.3: Run test — expect failure**

```bash
npm test -- tests/precedence-chain.test.ts
```

Expected: import error for `setCliWorkspaceOverride` (doesn't exist yet).

- [ ] **Step 3.4: Add CLI override to `src/utils/config.ts`**

Add at module scope (after the constants near the top of the file, before `getGlobalConfigPath`):

```ts
let cliWorkspaceOverride: string | undefined = undefined;

/**
 * Set the workspace override from the top-level `-w/--workspace` CLI flag.
 * Module-level state — set once at CLI startup before any subcommand runs.
 * Pass `undefined` to clear (used in tests).
 */
export function setCliWorkspaceOverride(value: string | undefined): void {
    cliWorkspaceOverride = value;
}
```

Update `resolveConfig` to apply the override after merging:

```ts
export function resolveConfig(cwd: string = process.cwd()): ResolvedConfig | null {
    const env = readEnvOverrides();
    const localPath = findLocalConfigPath(cwd);
    const local = localPath ? readConfigFile(localPath) : null;
    const global = readConfigFile(getGlobalConfigPath());

    const merged = mergeConfigs(env, local, localPath, global, getGlobalConfigPath());
    if (!merged) return null;

    if (cliWorkspaceOverride !== undefined) {
        merged.config.workspace = cliWorkspaceOverride;
        merged.config.workspaceId = undefined;
        merged.sources.workspace = 'cli';
        merged.sources.workspaceId = 'cli';
    }

    return {
        config: merged.config,
        sources: merged.sources,
        activePath: localPath ?? getGlobalConfigPath(),
    };
}
```

Note: `'cli'` is a literal string, not the existing `'env' | string | null` discriminator. Since `ConfigSource` is `'env' | string | null`, `'cli'` is a valid `string` and `whoami` will print it as `(from cli)` — see Task 9.

- [ ] **Step 3.5: Run test — expect pass**

```bash
npm test -- tests/precedence-chain.test.ts
```

Expected: 6 passed.

- [ ] **Step 3.6: Run all tests + build**

```bash
npm test && npm run build
```

Expected: 11 passed (5 from Task 2, 6 from Task 3). Build succeeds.

- [ ] **Step 3.7: Commit**

```bash
git add src/utils/config.ts tests/helpers.ts tests/precedence-chain.test.ts
git commit -m "$(cat <<'EOF'
feat(config): add -w/--workspace CLI override at top of precedence chain

setCliWorkspaceOverride() is wired in resolveConfig and beats env, local,
and global. Spec test #3 covers the full precedence chain.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Extract config-write-target helper from `login.ts`

**Files:**
- Create: `src/utils/config-write-target.ts`
- Modify: `src/commands/login.ts`

`workspace set --local` will reuse `login`'s prompt + gitignore logic. Extract the helpers first; pure refactor — no test changes (existing login flow is the test until Task 5 adds the workspace-set test).

- [ ] **Step 4.1: Create the extracted helper**

`src/utils/config-write-target.ts`:

```ts
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import chalk from 'chalk';
import { getGlobalConfigPath, getLocalConfigPath } from './config';

export type WriteTarget = 'local' | 'global';

/**
 * Decide whether a write should target the local or global config file,
 * mirroring the contract used by `login`:
 *  - --local / --global mutually exclusive (caller validated already).
 *  - If exactly one is set, use it.
 *  - Else if TTY, prompt.
 *  - Else error and exit.
 */
export async function decideWriteTarget(
    options: { local?: boolean; global?: boolean },
    promptLabel = 'Save config locally (./.solidactions) or globally (~/.solidactions)? [global] ',
): Promise<WriteTarget> {
    if (options.local && options.global) {
        console.error(chalk.red('Error: --local and --global are mutually exclusive.'));
        process.exit(1);
    }
    if (options.local) return 'local';
    if (options.global) return 'global';

    if (process.stdin.isTTY) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
            while (true) {
                const answer = await new Promise<string>((resolve) => rl.question(chalk.blue(promptLabel), resolve));
                const normalized = answer.trim().toLowerCase();
                if (normalized === '' || normalized === 'global' || normalized === 'g') return 'global';
                if (normalized === 'local' || normalized === 'l') return 'local';
                console.log(chalk.yellow("Please answer 'local' or 'global' (or press Enter for global)."));
            }
        } finally {
            rl.close();
        }
    }
    console.error(chalk.red('Refusing to write config non-interactively. Pass --local or --global.'));
    process.exit(1);
}

export function pathForTarget(target: WriteTarget, cwd: string = process.cwd()): string {
    return target === 'local' ? getLocalConfigPath(cwd) : getGlobalConfigPath();
}

/**
 * Ensure `.solidactions/` is in the target directory's `.gitignore`.
 * Idempotent. Skips silently if pattern is already covered.
 */
export async function ensureGitignoreCovers(targetDir: string, auto: boolean): Promise<void> {
    const gitignorePath = path.join(targetDir, '.gitignore');
    const patternToAdd = '.solidactions/';

    let existing = '';
    if (fs.existsSync(gitignorePath)) {
        existing = fs.readFileSync(gitignorePath, 'utf-8');
        const lines = existing.split('\n').map((l) => l.trim());
        const isCovered = lines.some((line) => {
            const normalized = line
                .replace(/^\*\*\//, '')
                .replace(/^\//, '')
                .replace(/\/(\*\*|\*)?$/, '');
            return normalized === '.solidactions';
        });
        if (isCovered) return;
    }

    let shouldAdd = auto;
    if (!shouldAdd && process.stdin.isTTY) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
            rl.question(
                chalk.yellow(`Local config directory may contain secrets. Add \`.solidactions/\` to ${gitignorePath}? [Y/n] `),
                resolve,
            );
        });
        rl.close();
        shouldAdd = !(answer.trim().toLowerCase().startsWith('n'));
    }

    if (!shouldAdd) {
        console.log(chalk.yellow(`Skipping .gitignore update. Remember: ${path.join(targetDir, '.solidactions', 'config.json')} may contain your API key.`));
        return;
    }

    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    try {
        fs.writeFileSync(gitignorePath, `${existing}${prefix}${patternToAdd}\n`);
        console.log(chalk.green(`Added \`${patternToAdd}\` to ${gitignorePath}.`));
    } catch (err: any) {
        console.log(chalk.yellow(`Could not update ${gitignorePath}: ${err.message}. Add \`.solidactions/\` to it manually.`));
    }
}
```

- [ ] **Step 4.2: Refactor `login` to use the extracted helper**

In `src/commands/login.ts`, delete the local `promptLocation` and `ensureGitignoreCovers` definitions. Replace the location-decision block in `login()` with:

```ts
import { decideWriteTarget, pathForTarget, ensureGitignoreCovers } from '../utils/config-write-target';

// ... inside login() ...

const target = await decideWriteTarget(
    { local: options.local, global: options.global },
);
const targetPath = pathForTarget(target);
```

(Keep the rest of `login()` — write the config, the `target === 'local'` branch that calls `ensureGitignoreCovers(process.cwd(), !!options.gitignore)`, the workspace-selection follow-up, and the next-steps printing — exactly as it is.)

- [ ] **Step 4.3: Manually verify login still works (smoke)**

```bash
npm run build
node dist/index.js whoami
```

Expected: same output as before this task — either "Not initialized" (if no config) or the existing whoami print.

```bash
node dist/index.js login --help
```

Expected: option list still includes `--local` and `--global`.

- [ ] **Step 4.4: Run all tests + build**

```bash
npm test && npm run build
```

Expected: 11 passed; build clean.

- [ ] **Step 4.5: Commit**

```bash
git add src/utils/config-write-target.ts src/commands/login.ts
git commit -m "$(cat <<'EOF'
refactor(login): extract write-target decision and gitignore helpers

Pulls promptLocation, the --local/--global decision tree, and the
.gitignore prompt out of login.ts so workspace set can reuse them. No
behavior change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `workspace set --local` partial-write helper + test

**Files:**
- Modify: `src/utils/config.ts`
- Create: `tests/workspace-set-local.test.ts`

This is **spec test #2**: integration test for `workspace set --local` writing only the workspace key.

The full `workspaceSet` command (with network call) lands in Task 6; this task introduces the testable file-write primitive that Task 6 will call.

- [ ] **Step 5.1: Write the failing test**

`tests/workspace-set-local.test.ts`:

```ts
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeWorkspaceToFile, getGlobalConfigPath, getLocalConfigPath, readConfigFile } from '../src/utils/config';
import { makeTmpEnv, writeGlobal } from './helpers';

describe('writeWorkspaceToFile', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => { env = makeTmpEnv(); });
    afterEach(() => env.cleanup());

    it('local: creates .solidactions/config.json with only workspace + workspaceId', () => {
        writeGlobal(env.home, { host: 'https://h', apiKey: 'sk_g', workspaceId: 'old' });

        const localPath = getLocalConfigPath(env.cwd);
        writeWorkspaceToFile(localPath, 'mercer', 'new-uuid');

        expect(fs.existsSync(localPath)).toBe(true);
        const local = readConfigFile(localPath);
        expect(local).toEqual({ workspace: 'mercer', workspaceId: 'new-uuid' });
        expect(local).not.toHaveProperty('host');
        expect(local).not.toHaveProperty('apiKey');

        // Global is untouched.
        const globalPath = getGlobalConfigPath();
        const global = readConfigFile(globalPath);
        expect(global).toEqual({ host: 'https://h', apiKey: 'sk_g', workspaceId: 'old' });
    });

    it('local: shallow-merges over an existing local file (preserves prior keys)', () => {
        const localPath = getLocalConfigPath(env.cwd);
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        fs.writeFileSync(localPath, JSON.stringify({ host: 'https://manual', apiKey: 'sk_l', workspace: 'old', workspaceId: 'old-uuid' }));

        writeWorkspaceToFile(localPath, 'mercer', 'new-uuid');

        const local = readConfigFile(localPath);
        expect(local).toEqual({ host: 'https://manual', apiKey: 'sk_l', workspace: 'mercer', workspaceId: 'new-uuid' });
    });

    it('global: shallow-merges into an existing global file (preserves host/apiKey)', () => {
        writeGlobal(env.home, { host: 'https://h', apiKey: 'sk_g', workspaceId: 'old' });
        const globalPath = getGlobalConfigPath();

        writeWorkspaceToFile(globalPath, 'mercer', 'new-uuid');

        const global = readConfigFile(globalPath);
        expect(global).toEqual({ host: 'https://h', apiKey: 'sk_g', workspace: 'mercer', workspaceId: 'new-uuid' });
    });

    it('writes the file with mode 0o600', () => {
        const localPath = getLocalConfigPath(env.cwd);
        writeWorkspaceToFile(localPath, 'mercer', 'uuid');
        const stat = fs.statSync(localPath);
        // file mode is the last 9 bits
        expect(stat.mode & 0o777).toBe(0o600);
    });
});
```

- [ ] **Step 5.2: Run test — expect failure**

```bash
npm test -- tests/workspace-set-local.test.ts
```

Expected: import error for `writeWorkspaceToFile`.

- [ ] **Step 5.3: Add `writeWorkspaceToFile` to `src/utils/config.ts`**

Append (after `writeConfigFile`):

```ts
/**
 * Write a workspace pin to the given config file path. Shallow-merges over
 * any existing keys (preserves host/apiKey if already present). Re-uses
 * writeConfigFile's atomic-write + 0o600 mode contract.
 */
export function writeWorkspaceToFile(filePath: string, workspace: string, workspaceId: string): void {
    const existing = readConfigFile(filePath) ?? ({} as Config);
    const updated: Config = {
        ...existing,
        workspace,
        workspaceId,
    } as Config;
    writeConfigFile(filePath, updated);
}
```

Note: `writeConfigFile` already uses atomic `.tmp` + rename and writes mode `0o600`. We deliberately reuse it.

- [ ] **Step 5.4: Run test — expect pass**

```bash
npm test -- tests/workspace-set-local.test.ts
```

Expected: 4 passed.

- [ ] **Step 5.5: Run all tests + build**

```bash
npm test && npm run build
```

Expected: 15 passed; build clean.

- [ ] **Step 5.6: Commit**

```bash
git add src/utils/config.ts tests/workspace-set-local.test.ts
git commit -m "$(cat <<'EOF'
feat(config): add writeWorkspaceToFile partial-write helper

Powers the upcoming `workspace set --local` flag — writes only the
workspace + workspaceId keys, shallow-merging over any existing host /
apiKey. Spec test #2 covers correctness + 0o600 mode.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `workspace set <slug> --local|--global` flag handling

**Files:**
- Modify: `src/commands/workspaces.ts`
- Modify: `src/index.ts`

Hard cut: `workspace set` now requires explicit flag (or TTY prompt). No deprecation period.

- [ ] **Step 6.1: Update `workspaceSet` signature and logic**

In `src/commands/workspaces.ts`, replace the existing `workspaceSet` with:

```ts
import axios from 'axios';
import chalk from 'chalk';
import { requireConfig, requireResolvedConfig } from '../utils/api';
import { writeWorkspaceToFile, getGlobalConfigPath, getLocalConfigPath } from '../utils/config';
import { decideWriteTarget, ensureGitignoreCovers } from '../utils/config-write-target';

// ... keep workspacesList unchanged ...

interface WorkspaceSetOptions {
    local?: boolean;
    global?: boolean;
    gitignore?: boolean;
}

export async function workspaceSet(input: string, options: WorkspaceSetOptions = {}) {
    if (process.env.SOLIDACTIONS_WORKSPACE_ID) {
        console.error(chalk.red(
            'SOLIDACTIONS_WORKSPACE_ID is set in the environment; the change would not take effect. ' +
            'Unset the env var or edit the config file directly.',
        ));
        process.exit(1);
    }

    const config = requireResolvedConfig().config;

    let allWorkspaces: any[] = [];
    try {
        const response = await axios.get(`${config.host}/api/v1/workspaces`, {
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Accept': 'application/json',
            },
        });
        const grouped = response.data.workspaces || response.data.data || response.data;
        if (typeof grouped === 'object' && !Array.isArray(grouped)) {
            for (const orgWorkspaces of Object.values(grouped)) {
                allWorkspaces.push(...(orgWorkspaces as any[]));
            }
        } else if (Array.isArray(grouped)) {
            allWorkspaces = grouped;
        }
    } catch (error: any) {
        console.error(chalk.red('Failed to list workspaces:'), error.response?.data?.message || error.message);
        process.exit(1);
    }

    const workspace = allWorkspaces.find(
        (w: any) => w.id === input || w.slug === input || w.name === input,
    );
    if (!workspace) {
        console.error(chalk.red(`Workspace "${input}" not found. Run \`solidactions workspace list\` to list available workspaces.`));
        process.exit(1);
    }

    const target = await decideWriteTarget({ local: options.local, global: options.global });
    const targetPath = target === 'local' ? getLocalConfigPath() : getGlobalConfigPath();

    writeWorkspaceToFile(targetPath, workspace.slug ?? workspace.name, workspace.id);

    if (target === 'local') {
        await ensureGitignoreCovers(process.cwd(), !!options.gitignore);
    }

    console.log(chalk.green(`Workspace set to: ${workspace.name} (${workspace.id})`));
    console.log(chalk.gray(`Saved to ${targetPath}`));
}
```

Key changes from the old function:
- Now requires `--local` or `--global` (or TTY prompt) via `decideWriteTarget`.
- Writes both `workspace` (slug) and `workspaceId` (UUID) — partial write via `writeWorkspaceToFile`.
- `--local` triggers the gitignore-prompt path.
- The `workspace.slug ?? workspace.name` fallback handles APIs that don't return `slug` (we'd rather keep something readable than nothing). Most workspaces have a slug.

- [ ] **Step 6.2: Wire commander flags in `src/index.ts`**

Find the `workspace set` command registration. Add `--local`, `--global`, and (re-using login's pattern) `--gitignore` to the option chain. Example fragment (your existing structure may differ slightly; preserve it):

```ts
workspace
    .command('set <id-or-slug-or-name>')
    .description('Set the active workspace and pin it')
    .option('--local', 'pin to ./.solidactions/config.json')
    .option('--global', 'pin to ~/.solidactions/config.json')
    .option('--gitignore', 'auto-add .solidactions/ to local .gitignore (skip prompt)')
    .action(async (input, opts) => {
        await workspaceSet(input, opts);
    });
```

If the existing registration uses a different shape, port these options into it without changing the command name or path.

- [ ] **Step 6.3: Verify build and that existing tests still pass**

```bash
npm test && npm run build
```

Expected: 15 passed; build clean.

- [ ] **Step 6.4: Manual smoke (TTY non-interactive — should error)**

```bash
node dist/index.js workspace set whatever < /dev/null
```

Expected: `Refusing to write config non-interactively. Pass --local or --global.` Exit code 1.

(`< /dev/null` forces stdin to be non-TTY, triggering the error path. We can't realistically smoke a TTY prompt or a real workspace here without a logged-in session — the manual full smoke happens in Task 9 after login is verified.)

- [ ] **Step 6.5: Commit**

```bash
git add src/commands/workspaces.ts src/index.ts
git commit -m "$(cat <<'EOF'
feat(workspaces): add --local and --global flags to workspace set

Hard cut on the old flagless behavior: workspace set now requires an
explicit --local/--global or a TTY prompt, mirroring login. Local writes
go through writeWorkspaceToFile (workspace + workspaceId only) and
trigger the .gitignore prompt. Resolves issue #22 spec section 2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Top-level `-w/--workspace` flag + warn-and-ignore on `set`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 7.1: Add the global option and pre-action hook**

In `src/index.ts`, near the top of the program setup (after `program = new Command()` and `program.name(...).description(...).version(...)`), add:

```ts
import { setCliWorkspaceOverride } from './utils/config';

program.option('-w, --workspace <id-or-slug-or-name>', 'override active workspace for this command');

program.hook('preAction', (thisCommand, actionCommand) => {
    const opts = thisCommand.opts();
    const wsOverride: string | undefined = opts.workspace;
    if (wsOverride) {
        // workspace set is a write — -w is for read-paths only.
        const fullName = actionCommand.name();
        const parentName = actionCommand.parent?.name?.();
        const isWorkspaceSet = fullName === 'set' && parentName === 'workspace';
        if (isWorkspaceSet) {
            console.error(
                '\x1b[33mwarn:\x1b[0m -w/--workspace is ignored on `workspace set`; the positional argument is the new workspace.',
            );
            return; // do not set the override
        }
        setCliWorkspaceOverride(wsOverride);
    }
});
```

(The `\x1b[33m` is yellow ANSI; this avoids importing `chalk` in `index.ts` if it isn't already, and avoids a yellow-on-yellow conflict.)

- [ ] **Step 7.2: Verify build**

```bash
npm run build
```

Expected: clean.

- [ ] **Step 7.3: Verify the precedence-chain test still passes**

```bash
npm test -- tests/precedence-chain.test.ts
```

Expected: 6 passed. (The test exercises `setCliWorkspaceOverride` directly; the commander hook only sits between `-w` parsing and that function.)

- [ ] **Step 7.4: Manual smoke — `-w` with whoami**

```bash
node dist/index.js -w some-input whoami 2>&1 | head -20
```

Expected (assuming a logged-in user): `Workspace: some-input (cli)` line, regardless of the underlying file's workspaceId. (Or "Not initialized" if no global config exists — that's fine, the override is overlaid on top of the resolved chain.)

- [ ] **Step 7.5: Manual smoke — `-w` with `workspace set` warns and ignores**

```bash
node dist/index.js -w foo workspace set bar < /dev/null 2>&1
```

Expected first line: `warn: -w/--workspace is ignored on \`workspace set\`; the positional argument is the new workspace.` (Followed by the non-interactive flag error from Task 6.)

- [ ] **Step 7.6: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat(cli): add top-level -w/--workspace override flag

Wires commander's preAction hook to setCliWorkspaceOverride, putting -w
at the top of the resolution chain. Emits a stderr warning when used
together with `workspace set` (the override applies to read paths; set
is a write).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Axios response interceptor + hint

**Files:**
- Modify: `src/utils/api.ts`
- Create: `tests/api-error-hint.test.ts`

This is **spec test #4**: the new error display.

- [ ] **Step 8.1: Write the failing test**

`tests/api-error-hint.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { augmentNotFoundMessage } from '../src/utils/api';

function makeAxiosError(status: number, message: string): any {
    const err: any = new Error(message);
    err.isAxiosError = true;
    err.response = { status, data: { message } };
    return err;
}

describe('augmentNotFoundMessage (axios response interceptor)', () => {
    it('appends the workspace-switch hint to a 404 "not found in your active workspace" error', () => {
        const err = makeAxiosError(404, "Project 'foo' not found in your active workspace 'mercer'.");
        const result = augmentNotFoundMessage(err);
        expect(result.response.data.message).toContain("Project 'foo' not found in your active workspace 'mercer'.");
        expect(result.response.data.message).toContain('Did you mean to switch workspaces?');
        expect(result.response.data.message).toContain("solidactions workspace set <name> --local");
    });

    it('does NOT append the hint to a 422 unique-violation message', () => {
        const err = makeAxiosError(422, "A project named 'foo' already exists in workspace 'mercer'.");
        const result = augmentNotFoundMessage(err);
        expect(result.response.data.message).toBe("A project named 'foo' already exists in workspace 'mercer'.");
        expect(result.response.data.message).not.toContain('Did you mean to switch workspaces?');
    });

    it('does NOT append the hint to a generic 500', () => {
        const err = makeAxiosError(500, 'Internal server error');
        const result = augmentNotFoundMessage(err);
        expect(result.response.data.message).toBe('Internal server error');
    });

    it('returns the error unchanged when there is no response body', () => {
        const err: any = new Error('Network error');
        err.isAxiosError = true;
        const result = augmentNotFoundMessage(err);
        expect(result).toBe(err);
    });
});
```

- [ ] **Step 8.2: Run test — expect failure**

```bash
npm test -- tests/api-error-hint.test.ts
```

Expected: import error for `augmentNotFoundMessage`.

- [ ] **Step 8.3: Add the interceptor + helper to `src/utils/api.ts`**

Add to the top of the file (after the existing imports), or wherever fits the file's existing structure:

```ts
const NOT_FOUND_IN_WORKSPACE = /Project .+ not found in your active workspace/;

/**
 * Inspect an axios error and, if its response message matches the new
 * workspace-not-found 404, append a remediation hint. Exported for unit
 * testing; the live interceptor below calls it.
 */
export function augmentNotFoundMessage(error: any): any {
    const msg = error?.response?.data?.message;
    if (typeof msg === 'string' && NOT_FOUND_IN_WORKSPACE.test(msg)) {
        const hint = "Did you mean to switch workspaces? Run 'solidactions workspace set <name> --local' to pin this directory.";
        error.response.data.message = `${msg}\n\n${hint}`;
    }
    return error;
}

axios.interceptors.response.use(
    (response) => response,
    (error) => Promise.reject(augmentNotFoundMessage(error)),
);
```

(`axios` is already imported at the top of `api.ts`.)

- [ ] **Step 8.4: Run test — expect pass**

```bash
npm test -- tests/api-error-hint.test.ts
```

Expected: 4 passed.

- [ ] **Step 8.5: Run all tests + build**

```bash
npm test && npm run build
```

Expected: 19 passed; build clean.

- [ ] **Step 8.6: Commit**

```bash
git add src/utils/api.ts tests/api-error-hint.test.ts
git commit -m "$(cat <<'EOF'
feat(api): augment 'project not found in workspace' 404 with switch hint

A single axios response interceptor pattern-matches the new error from
solidactions-app PR #128 and appends a 'Did you mean to switch
workspaces?' hint with the exact CLI command. Spec test #4.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Update `whoami` to show slug + UUID

**Files:**
- Modify: `src/commands/login.ts` (the `whoami` function)

- [ ] **Step 9.1: Update `whoami` printing**

In `src/commands/login.ts`, replace the body of `whoami` with:

```ts
export function whoami() {
    const resolved = resolveConfig();
    if (!resolved || !resolved.config.apiKey) {
        console.log(chalk.yellow('Not initialized.'));
        console.log(chalk.gray('Run "solidactions login <api-key>" to configure.'));
        process.exit(1);
    }

    const { config, sources } = resolved;
    const maskedKey = config.apiKey.length > 12
        ? `${config.apiKey.substring(0, 8)}...${config.apiKey.slice(-4)}`
        : config.apiKey;

    const fmt = (src: ConfigSource): string => {
        if (src === 'env') return chalk.gray('(from $SOLIDACTIONS_* env var)');
        if (src === 'cli') return chalk.gray('(from -w flag)');
        if (src === null) return chalk.gray('(unset)');
        return chalk.gray(`(from ${src})`);
    };

    const workspaceLabel = config.workspace
        ? `${config.workspace}${config.workspaceId ? ` (${config.workspaceId})` : ''}`
        : config.workspaceId
            ? `${config.workspaceId} (slug unknown — run 'workspace set <slug>' to populate)`
            : '';

    console.log(chalk.blue('Current configuration:'));
    console.log(`  Host:        ${config.host.padEnd(50)} ${fmt(sources.host)}`);
    console.log(`  API Key:     ${maskedKey.padEnd(50)} ${fmt(sources.apiKey)}`);
    console.log(`  Workspace:   ${workspaceLabel.padEnd(50)} ${fmt(sources.workspaceId)}`);
}
```

(`ConfigSource` is already imported alongside `resolveConfig`.)

- [ ] **Step 9.2: Build and manual smoke**

```bash
npm run build
```

If the worktree's environment has a logged-in user (a `~/.solidactions/config.json` exists), run:

```bash
node dist/index.js whoami
```

Expected: a Workspace line in one of the three forms above (slug + uuid / uuid only / `cli` source if `-w` was given). If no global config exists in this environment, `whoami` correctly prints "Not initialized" — that's a pass.

- [ ] **Step 9.3: Run all tests + build**

```bash
npm test && npm run build
```

Expected: 19 passed; build clean.

- [ ] **Step 9.4: Commit**

```bash
git add src/commands/login.ts
git commit -m "$(cat <<'EOF'
feat(whoami): show workspace slug + uuid + source provenance

Surfaces the new -w / cli source label and falls back gracefully when
the slug isn't yet populated on a legacy global config.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Notes-to-test-todo + final verification

**Files:**
- Create or modify: `docs/superpowers/notes/sol-r0b-test-todo.md`

- [ ] **Step 10.1: Append a test-todo note**

Create or append to `docs/superpowers/notes/sol-r0b-test-todo.md`:

```markdown
# sol-r0b — test todos

Items uncovered during implementation that aren't blocking the PR but
should be revisited:

- **Cross-tenant slug ambiguity in `workspace set <slug>` lookup.**
  The flat search in `workspaceSet` matches the first workspace whose
  `id`/`slug`/`name` equals the input. A user with access to multiple
  tenants where each tenant has a workspace slugged `acme` would get the
  first match silently. Considered out of scope for this issue; revisit
  when (if) the API gains a tenant filter on `/api/v1/workspaces`.

- **End-to-end smoke against staging for the deploy-error hint.**
  After `solidactions-app` PR #128 is merged + deployed to
  `e2e.formup.cc`, manually:
    1. `solidactions login --local` against `e2e.formup.cc`
    2. `solidactions workspace set <some-other-workspace> --local`
    3. `solidactions deploy nonexistent-project ./`
  Expect: the new "Project 'X' not found in your active workspace 'Y'."
  error WITH the hint appended.
```

- [ ] **Step 10.2: Final pass — all tests, build, and lint-equivalent**

```bash
npm test && npm run build
```

Expected: 19 passed (5 + 6 + 4 + 4); build clean.

```bash
git status
```

Expected: nothing else uncommitted (everything has been committed at the end of each task).

```bash
git log --oneline origin/main..HEAD
```

Expected: 9 commits (one per task that committed code: 1, 2, 3, 4, 5, 6, 7, 8, 9). Task 10 commits the test-todo note as a 10th.

- [ ] **Step 10.3: Commit the test-todo note**

```bash
git add docs/superpowers/notes/sol-r0b-test-todo.md
git commit -m "$(cat <<'EOF'
docs(sol-r0b): record follow-up test todos

Cross-tenant slug ambiguity (out of scope) and the staging e2e smoke
that's blocked on solidactions-app#128 merge/deploy.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## After Task 10

Push branch + open a **draft** PR (the lifecycle's step 8). The bead's BLOCKER section requires the PR to stay draft until app#128 is merged + deployed to staging. Then the manual staging smoke (Task 10's note) becomes unblocked, and the PR can be moved out of draft.

The order of operations after this plan completes is owned by the Dev lifecycle, not by this plan — the plan ends with the local branch in a green state at the end of Task 10.

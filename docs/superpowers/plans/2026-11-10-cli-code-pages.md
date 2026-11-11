# CLI code pages: bundle tsx pages with esbuild before deploy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sa-subagent-driven-development to implement this plan task-by-task (the wave's build step). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `solidactions deploy` bundles every `tsx` code page (entry, relative imports, `lib/` files, npm packages and their CSS) with a pinned esbuild into one compiled module and one stylesheet, and sends them with the page's source files in the pages sync request.

**Architecture:**
- `src/utils/page-bundle.ts` (Task 1) is the one bundler: `bundlePage(entryPath, projectDir)`. It mirrors the server's page compiler (`runner/src/query/page-compile-worker.ts` in the app repo, shipped in app v0.278.0) option for option, so the compiled text has the shape the visual frame expects.
- `src/utils/pages-sync.ts` and `src/commands/deploy.ts` (Task 2) bundle all `tsx` pages right after the page bodies are read, before the first network call of the pages/functions sync, collect every page's failure naming its slug, and exit 1 without uploading anything if any page fails. The payload gains the new fields.
- The new fields are additive: today's app main ignores unknown keys, and the existing fields (`kind`, `body`, `sources` as the data-source list) stay as they are, so this CLI release deploys against current main (PM ruling B). The server half is app#2653.
- Task 3 proves it end to end: a real `deploy` against a local fake server.

**Tech Stack:** TypeScript (Node 20+, CommonJS), esbuild 0.28.2 (new runtime dependency, exact pin), axios, vitest 4 (`unit` project). Tests run only in CI (`check.yml`, GitHub-hosted runners). `npm run build` runs `tsc`; the repo has no formatter or linter script, so static checks are `npx tsc --noEmit`.

**Spec:** `/home/mercer/crewops2/workspaces/solidactions/desk/proposals/2026-11-07-one-page-kind.md` section 6.1 and plan `.../2026-11-07-one-page-kind-plan.md` "Wave 4: Task 1". The app epic is SolidActions/solidactions-app#2566. Every value used here is copied below.

**Issues:** cli#236. Approved by Peter 2026-11-10 18:02Z (ask task-approvewavecode-ce21), recorded on the issue: "Peter approved this wave (ask task-approvewavecode-ce21, 2026-11-10 18:02Z): "Approve". Size: normal."

## The issue, verbatim (cli#236 body, the binding scope)

> **Ask:** the CLI bundles `tsx` pages before sending.
> - Pin esbuild. New `src/utils/page-bundle.ts`: `bundlePage(entryPath, projectDir) -> {compiled, compiledCss, sources, compilerVersion}`; platform modules external, everything else (lib/ files, npm packages) bundled into one module and one stylesheet.
> - `src/utils/pages-sync.ts` sends `language`, `sources`, `compiled`, `compiled_css`, `compiler_version` for `tsx` pages; deploy uses it.
> - Tests: an entry with `lib/` and one npm package bundles to one module + one stylesheet; a bare `react/jsx-runtime` import is mapped or refused naming the specifier; output over 2 MiB fails before upload naming the slug; `sources` holds every file the bundle read (at most 50 files, 1 MiB).
>
> The server half (accepting and verifying these fields in pages sync) is an app wave after sandbox apps W1 (#2593) merges, since both touch pages sync. Until then the server ignores the extra fields, so this CLI release is safe to ship first; the wave must confirm that against current main.

## Rulings (binding for every task)

- **R1 — wire name of the file map (PM chief, mail b8c948fb, 2026-11-11, recorded on cli#236).** "(A) the bundle's file map goes on the wire as source_files (path -> text); sources stays the data-source list. (B) Yes: this CLI release must stay deployable against current app main: a tsx page syncs as today and the new fields (language, source_files, compiled, compiled_css, compiler_version) are ignored until the server wave. Add a test that the request body still validates against today's rules for a tsx page (or a pinned copy of them). (C) The server half is filed as app#2653 with exactly these names."
  Why: current app main `PagesSyncRequest` validates `pages.*.sources` as a list of data-source objects (`sources.*.key` and `sources.*.kind` required, max 50), so a path-to-text map under `sources` would 422 every tsx page. The function-side name `bundlePage(...).sources` in the issue stays the **return field name** of the bundler; only the wire key is `source_files`.
- **R2 — compiled shape (manager ruling, cost if wrong: one constant).** The compiled module mirrors the server's worker exactly: esbuild `format: 'iife'`, wrapped as `globalThis.__saPlatform.define(function () {\n<output>});\n`, entry mounted with `globalThis.__saPlatform.mount(Page)`, platform modules resolved to `globalThis.__saPlatform.modules["<name>"]`. The issue says "one module"; this is it. If app#2653 asks for something else, only `WRAP_PREFIX`/`WRAP_SUFFIX` and the main source in `page-bundle.ts` change.
- **R3 — `react/jsx-runtime` is refused, not mapped (manager ruling, cost if wrong: a package built with the automatic JSX runtime is unusable until the platform script exports it).** Platform modules are exactly `react`, `react-dom`, `recharts`, `@tanstack/react-table`, `sa`, `@solidactions/sa` (copied from `PLATFORM_MODULES` in the worker). Any import that starts with one of those names plus `/` (for example `react/jsx-runtime`, `react-dom/client`) is a bundle error naming the specifier.
- **R4 — `sources` of a bundle holds project files only.** Files under any `node_modules` directory are not included (the lockfile pins them). A file the bundle read from outside the project directory is a bundle error (never uploaded). Caps: at most 50 files and 1 MiB (1048576 bytes) together, both errors name the limit.

## Global Constraints

- esbuild is pinned to exactly `0.28.2` in `package.json` (no caret, no tilde): the server accepts only versions in `config('docs.page_compiler_versions')` = `['0.28.2']`.
- Compiled module cap: 2 MiB = 2097152 bytes (`COMPILED_LIMIT_BYTES`), measured with `Buffer.byteLength`. Page source cap stays 1 MiB (already enforced for the entry by `validate-items.ts`).
- Platform modules: `react`, `react-dom`, `recharts`, `@tanstack/react-table`, `sa`, `@solidactions/sa`.
- esbuild options (copied from the worker, `compilePage`): `bundle: true`, `write: false`, `metafile: true`, `logLevel: 'silent'`, `format: 'iife'`, `target: 'es2022'`, `platform: 'browser'`, `charset: 'utf8'`, `legalComments: 'none'`, `minify: false`, `jsx: 'transform'`, `jsxFactory: 'React.createElement'`, `jsxFragment: 'React.Fragment'`, `logOverride: { 'unsupported-dynamic-import': 'error', 'unsupported-require-call': 'error' }`, `tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } }`.
- Refusal texts mirror the worker: no default export → `a page must export its component as the default export`; computed `import()`/`require()` → `import() and require() of a computed specifier are not allowed in a page; import platform modules by name: react, react-dom, recharts, @tanstack/react-table, sa`; compiled text containing `</script` (case-insensitive) is refused (the module is inlined in a script tag).
- Wire fields added per page (names frozen, R1): `language` (`'html'` | `'tsx'`, sent for every page), and for `tsx` pages only `source_files` (object path → text), `compiled` (string), `compiled_css` (string, `''` when the bundle has no CSS), `compiler_version` (string). `kind`, `body` (the entry's own text), `path`, `home`, `name`, `slug` and `sources` (the yaml data-source list, only when the yaml has one) are unchanged.
- No test runs on this box. Static check per task: `npx tsc --noEmit`. Never `git add`/commit/stash.
- Secret-bearing host paths this plan's code reads: none (the bundler reads files under the project directory only, R4).

Verify data: a tsx page project for the live smoke: `solidactions.yaml` with `pages: [{id: board, name: Board, file: pages/board.tsx}]`, `pages/board.tsx` importing `../lib/format` and one npm package in `node_modules` with a CSS import (`tests/deploy-code-pages.test.ts` builds this fixture in a temp dir; the smoke repeats it with the CLI built from the branch against a free app slot's stack). Until app#2653 ships, the smoke can only prove "deploys, page is live as before" on that stack; the new fields are ignored there.

## Review Focus

1. A project `tsconfig.json` with `"jsx": "react-jsx"` or `"jsxImportSource"` must not change the output: the worker's `jsx: 'transform'` + `React.createElement` wins (Task 1 row 7).
2. A page that imports a file outside the project (`../../outside.ts`, or a symlink pointing out) is refused and the file's text is in no payload (Task 1 rows 8, 9; secrets-in-sources).
3. A multi-page project where one page fails to bundle uploads nothing: no functions sync, no archive, no pages sync (Task 3 row 3).
4. An entry with no default export, and an entry with a TS/JSX syntax error, fail naming the slug, file, line (Task 1 rows 5, 6; Task 2 row 3).
5. `sources` keys use `/` separators on every OS and never a leading `./` (Task 1 row 3; Windows is not in the unit CI matrix, so the code normalizes and the test asserts the format).

## Invariants (must never happen)

- A deploy never uploads partial code pages: either every `tsx` page bundled, or nothing is sent (Task 3 row 3).
- A file outside the project directory, or under `node_modules`, is never in `source_files` (Task 1 rows 8, 9, 10).
- An old server (today's app main) never rejects the request because of this change (Task 2 row 5, Task 3 row 1: pinned copy of today's rules).

## Open PRs touching these files

`gh pr list --state open --json number,files` on solidactions-cli at plan time: none open. Callers grep (`grep -rnE "PageFile|buildPagesSyncPayload|readPageBodies|listCodePages|pages-sync" src tests`): `src/commands/deploy.ts` (lines 11, 752, 755, 818), `tests/pages-sync.test.ts`, `tests/functions-sync.test.ts:6` (imports only `terminalExitCode`, untouched).

## Dependencies and parallelism

Task 1 first (it freezes the `bundlePage` interface). Task 2 depends on Task 1. Task 3 depends on Task 2. The chain is serial because Task 3 spawns the built deploy and Task 2 owns the pinned-rules helper Task 3 imports.

## Frozen contract (copied verbatim into every card that uses it)

```ts
// src/utils/page-bundle.ts  (Task 1 produces; Tasks 2 and 3 consume)
export const COMPILED_LIMIT_BYTES = 2 * 1024 * 1024;
export const SOURCES_MAX_FILES = 50;
export const SOURCES_MAX_BYTES = 1024 * 1024;
export const PLATFORM_MODULES = ['react', 'react-dom', 'recharts', '@tanstack/react-table', 'sa', '@solidactions/sa'] as const;
export interface PageBundle {
    compiled: string;
    compiledCss: string;
    sources: Record<string, string>;   // project-relative posix path -> text
    compilerVersion: string;           // esbuild's own version string, '0.28.2'
}
export class PageBundleError extends Error {}   // message = one or more lines, "<file>:<line>:<col>: <text>" or "<text>"
export function bundlePage(entryPath: string, projectDir: string): Promise<PageBundle>;
```

```ts
// src/utils/pages-sync.ts  (Task 2 produces; Task 3 observes on the wire)
export type PageLanguage = 'html' | 'tsx';
// PageFile gains: language: PageLanguage
export function bundleCodePages(sourceDir: string, pages: PageFile[]): Promise<{ bundles: Map<string, PageBundle>; errors: string[] }>;
// errors line format: `page <slug> (<path>): <first line of the failure>` then each further line indented two spaces
export function buildPagesSyncPayload(pages: PageFile[], bodies: Map<string, string>, deploymentId: string | null, codeRef: PagesSyncPayload['code_ref'], bundles?: Map<string, PageBundle>): PagesSyncPayload;
```

---

### Task 1: the bundler (cli#236)

**Depends on:** none.

**Files (file scope — the only paths this task may touch):**
- Modify: `package.json` (add `"esbuild": "0.28.2"` to `dependencies`, alphabetical, exact)
- Modify: `package-lock.json` (only the changes `npm install --save-exact esbuild@0.28.2` makes)
- Create: `src/utils/page-bundle.ts`
- Create: `tests/page-bundle.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the Frozen contract's `page-bundle.ts` block, exactly.

- [ ] **Step 1: Install the pin.** Run `npm install --save-exact esbuild@0.28.2`. `package.json` must read `"esbuild": "0.28.2"` (no `^`). Do not run any test.

- [ ] **Step 2: Write `src/utils/page-bundle.ts`.**

```ts
import fs from 'fs';
import path from 'path';
import { build, version as esbuildVersion } from 'esbuild';
import type { Message, Plugin } from 'esbuild';

export const PLATFORM_MODULES = ['react', 'react-dom', 'recharts', '@tanstack/react-table', 'sa', '@solidactions/sa'] as const;
export const COMPILED_LIMIT_BYTES = 2 * 1024 * 1024;
export const SOURCES_MAX_FILES = 50;
export const SOURCES_MAX_BYTES = 1024 * 1024;

export interface PageBundle {
    compiled: string;
    compiledCss: string;
    sources: Record<string, string>;
    compilerVersion: string;
}

export class PageBundleError extends Error {}

const MAIN = 'sa-page:main';
const PLATFORM_NAMESPACE = 'sa-platform';
const WRAP_PREFIX = 'globalThis.__saPlatform.define(function () {\n';
const WRAP_SUFFIX = '});\n';
const NO_DEFAULT_EXPORT = 'a page must export its component as the default export';
const COMPUTED_SPECIFIER = 'import() and require() of a computed specifier are not allowed in a page; import platform modules by name: react, react-dom, recharts, @tanstack/react-table, sa';
const PLATFORM_LIST = 'react, react-dom, recharts, @tanstack/react-table, sa, @solidactions/sa';

function platformPlugin(): Plugin {
    return {
        name: 'sa-platform',
        setup(b) {
            b.onResolve({ filter: /^[^./]/ }, (args) => {
                if ((PLATFORM_MODULES as readonly string[]).includes(args.path)) {
                    return { path: args.path, namespace: PLATFORM_NAMESPACE };
                }
                if (PLATFORM_MODULES.some(name => args.path.startsWith(`${name}/`))) {
                    return { errors: [{ text: `import "${args.path}" is not available: platform modules are imported by name only (${PLATFORM_LIST})` }] };
                }
                return null;
            });
            b.onLoad({ filter: /.*/, namespace: PLATFORM_NAMESPACE }, (args) => ({
                contents: `module.exports = globalThis.__saPlatform.modules[${JSON.stringify(args.path)}];\n`,
                loader: 'js',
            }));
        },
    };
}

function toPosix(value: string): string {
    return value.split(path.sep).join('/').replace(/\\/g, '/');
}

function describe(message: Message, projectDir: string): string {
    const fromMain = message.location?.file === MAIN || message.location?.file === '<stdin>';
    const computed = message.id === 'unsupported-dynamic-import' || message.id === 'unsupported-require-call';
    const text = fromMain ? NO_DEFAULT_EXPORT : computed ? COMPUTED_SPECIFIER : message.text;
    if (fromMain || !message.location?.file) return text;
    const file = toPosix(path.relative(projectDir, path.resolve(projectDir, message.location.file)));
    return `${file}:${message.location.line}:${message.location.column}: ${text}`;
}

export async function bundlePage(entryPath: string, projectDir: string): Promise<PageBundle> {
    const root = path.resolve(projectDir);
    const entry = path.resolve(root, entryPath);
    const entryKey = toPosix(path.relative(root, entry));
    let result;
    try {
        result = await build({
            stdin: {
                contents: `import Page from ${JSON.stringify(entry)};\nglobalThis.__saPlatform.mount(Page);\n`,
                resolveDir: root,
                sourcefile: MAIN,
                loader: 'js',
            },
            absWorkingDir: root,
            outdir: path.join(root, '.sa-page-out'),
            bundle: true,
            write: false,
            metafile: true,
            logLevel: 'silent',
            format: 'iife',
            target: 'es2022',
            platform: 'browser',
            charset: 'utf8',
            legalComments: 'none',
            minify: false,
            jsx: 'transform',
            jsxFactory: 'React.createElement',
            jsxFragment: 'React.Fragment',
            logOverride: { 'unsupported-dynamic-import': 'error', 'unsupported-require-call': 'error' },
            tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
            plugins: [platformPlugin()],
        });
    } catch (error) {
        const errors = (error as { errors?: Message[] }).errors;
        if (!Array.isArray(errors) || errors.length === 0) throw new PageBundleError(String((error as Error).message ?? 'bundle failed'));
        throw new PageBundleError([...new Set(errors.slice(0, 20).map(message => describe(message, root)))].join('\n'));
    }
    if (result.metafile.inputs[entryKey]?.format !== 'esm') throw new PageBundleError(NO_DEFAULT_EXPORT);

    const sources: Record<string, string> = {};
    let totalBytes = 0;
    for (const key of Object.keys(result.metafile.inputs)) {
        if (key.startsWith(`${PLATFORM_NAMESPACE}:`) || key === MAIN || key === '<stdin>') continue;
        const relative = path.relative(root, path.resolve(root, key));
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new PageBundleError(`${toPosix(key)}: imported from outside the project directory; a page can only import files inside its project`);
        }
        const posix = toPosix(relative);
        if (posix.split('/').includes('node_modules')) continue;
        const text = fs.readFileSync(path.join(root, relative), 'utf8');
        if (Buffer.byteLength(text) !== result.metafile.inputs[key].bytes) throw new PageBundleError(`${posix}: changed while it was being bundled; deploy again`);
        sources[posix] = text;
        totalBytes += Buffer.byteLength(text);
    }
    if (Object.keys(sources).length > SOURCES_MAX_FILES) throw new PageBundleError(`the page reads ${Object.keys(sources).length} project files, over the ${SOURCES_MAX_FILES} file limit`);
    if (totalBytes > SOURCES_MAX_BYTES) throw new PageBundleError(`the page's project files total ${totalBytes} bytes, over the 1 MiB (${SOURCES_MAX_BYTES} bytes) limit`);

    const js = result.outputFiles.find(file => file.path.endsWith('.js'))?.text ?? '';
    const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
    const compiled = `${WRAP_PREFIX}${js}${WRAP_SUFFIX}`;
    if (/<\/script/i.test(compiled)) throw new PageBundleError('the compiled page contains "</script", which would end the script tag it is served in; split the string (for example "<\\/script")');
    const size = Buffer.byteLength(compiled);
    if (size > COMPILED_LIMIT_BYTES) throw new PageBundleError(`the compiled page is ${size} bytes, over the 2 MiB (${COMPILED_LIMIT_BYTES} bytes) limit`);
    return { compiled, compiledCss: css, sources, compilerVersion: esbuildVersion };
}
```

The developer may adjust incidental details (for example how the metafile key for the entry is read) so that every row below passes, but must not change an exported name, the option list, or any text copied in Global Constraints.

- [ ] **Step 3: Write `tests/page-bundle.test.ts`.** Each case builds its project in `fs.mkdtempSync(path.join(os.tmpdir(), 'sa-bundle-'))` and removes it in `finally`. Rows (each a separate `it`, with the expected-RED reason: the file does not exist on the base, so every row fails on import; the assertions below are what each row pins):

| # | Test | Assertion |
|---|---|---|
| 1 | entry `pages/board.tsx` imports `../lib/format` (a `.ts` file), `../lib/Card` (a `.tsx` file) and one fake npm package `fake-chart` (`node_modules/fake-chart/package.json` `{"main":"index.js"}`, `index.js` does `require('./style.css')`-free ESM `import './style.css'; export const mark = 'FAKE_CHART_MARK';`, plus `style.css` `.fake{color:red}`) | one string `compiled` that starts with `globalThis.__saPlatform.define(function () {` and ends with `});\n`, contains `FAKE_CHART_MARK`, the `lib/` function bodies and `globalThis.__saPlatform.mount(`; `compiledCss` contains `.fake`; no `import ` statement or `require(` left for relative or package files |
| 2 | entry `import React from 'react'; import { LineChart } from 'recharts'; import { useReactTable } from '@tanstack/react-table'; import sa from 'sa'; import sdk from '@solidactions/sa'; import ReactDOM from 'react-dom'` | `compiled` contains `globalThis.__saPlatform.modules["react"]` (and the other five names) and none of the package source |
| 3 | row 1's project | `Object.keys(bundle.sources).sort()` equals `['lib/Card.tsx','lib/format.ts','pages/board.tsx']` (forward slashes, no `./`, no `node_modules/...` key); values equal the files' text; `compilerVersion` is `'0.28.2'` |
| 4 | `package.json` read from disk | `dependencies.esbuild === '0.28.2'` exactly (guards the pin; a caret fails) |
| 5 | entry without a default export (`export const x = 1;`) and entry that is plain CJS (`module.exports = 1`) | rejects with `PageBundleError` whose message is `a page must export its component as the default export` |
| 6 | entry with a syntax error on line 3 | rejects with `PageBundleError`; message starts with `pages/board.tsx:3:` |
| 7 | project has `tsconfig.json` `{"compilerOptions":{"jsx":"react-jsx"}}` and the entry renders `<div/>` | `compiled` contains `React.createElement("div"` and does not contain `react/jsx-runtime` |
| 8 | entry imports `../../outside.ts` (a real file one level above the project dir, inside the temp root) | rejects `PageBundleError`; message names `outside.ts` and "outside the project directory"; the outside file's text is in no field of anything returned (the call rejects) |
| 9 | `lib` is a symlink to a directory outside the project and the entry imports `../lib/x` (skip the row with `it.skipIf(process.platform === 'win32')`) | rejects as row 8 |
| 10 | a file under `node_modules/fake-chart` is read | its path is not a key in `sources` (covered by row 3; assert explicitly: `Object.keys(sources).some(k => k.includes('node_modules'))` is false) |
| 11 | entry imports `fake-ui` whose `index.js` has `import { jsx } from 'react/jsx-runtime'` | rejects; message contains `react/jsx-runtime` and `platform modules are imported by name only`; same for a direct `import 'react-dom/client'` in the entry |
| 12 | entry `import x from 'not-installed-pkg'` | rejects; message contains `not-installed-pkg` |
| 13 | entry `const n = 'x'; import(n);` and `require(n)` (two cases) | rejects; message equals the `COMPUTED_SPECIFIER` text prefixed by `pages/board.tsx:<line>:<col>: ` |
| 14 | entry whose source contains a string `'</script>'` | rejects; message contains `</script` |
| 15 | entry that generates a compiled module over 2 MiB (an array literal of 200,000 distinct strings of 12 chars written to a `lib/big.ts`) | rejects; message contains `over the 2 MiB (2097152 bytes) limit` |
| 16 | 51 `lib/f<N>.ts` files each imported by the entry | rejects; message contains `51 project files, over the 50 file limit` |
| 17 | one `lib/big.ts` of 1,100,000 bytes imported by the entry | rejects; message contains `over the 1 MiB (1048576 bytes) limit` |
| 18 | an entry with no CSS | `compiledCss === ''` |

Expected-RED table for the reviewer: every row fails on the base only because `src/utils/page-bundle.ts` does not exist (import error); no row has a separate base behaviour to fail on, so there is no bugfix RED to prove.

- [ ] **Step 4: Static check.** Run `npx tsc --noEmit`. No test run.

- [ ] **Step 5: Report (do not commit).** List every changed path, the output of `git diff --stat -- package.json package-lock.json src/utils/page-bundle.ts tests/page-bundle.test.ts` and `wc -l` of the two new files, and the expected-RED table above.

---

### Task 2: sync wiring and the old-server guard (cli#236)

**Depends on:** Task 1 (committed).

**Files (file scope — the only paths this task may touch):**
- Modify: `src/utils/pages-sync.ts`
- Modify: `src/commands/deploy.ts` (around lines 11 and 752-760 only)
- Modify: `tests/pages-sync.test.ts`
- Create: `tests/helpers/pages-sync-main-rules.ts` (pinned copy of today's app `PagesSyncRequest` rules, a validator used by tests)

**Interfaces:**
- Consumes: `bundlePage`, `PageBundle`, `PageBundleError` (Frozen contract, Task 1).
- Produces: the Frozen contract's `pages-sync.ts` block (no `bundler` parameter and no `PageBundler` type: Ruling in the ledger), and `validatesAgainstAppMain(payload): string[]` (returns the list of rule violations; `[]` means valid) from the helper.

- [ ] **Step 1: Write the helper** `tests/helpers/pages-sync-main-rules.ts`: a pinned copy of the rules in app `app/Http/Requests/PagesSyncRequest.php` at app main blob `16571244ff0d9de5adf94dac069ccb187d864867` (last changed 2026-11-02, commit 3033cc4a). Header comment names that blob; if app#2653 changes the rules, the helper is updated deliberately.

```ts
/** Pinned copy of app PagesSyncRequest rules, app main blob 16571244ff0d9de5adf94dac069ccb187d864867. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SOURCE_KINDS = ['sql', 'connection', 'pegs'];

export function validatesAgainstAppMain(payload: any): string[] {
    const errors: string[] = [];
    if (!Array.isArray(payload.pages) || payload.pages.length > 50) errors.push('pages: present array, max 50');
    for (const [i, page] of (payload.pages ?? []).entries()) {
        const at = `pages.${i}`;
        if (typeof page.slug !== 'string' || !SLUG.test(page.slug)) errors.push(`${at}.slug`);
        if (typeof page.name !== 'string' || page.name.length > 255) errors.push(`${at}.name`);
        if (!['visual', 'dashboard'].includes(page.kind)) errors.push(`${at}.kind`);
        if (typeof page.path !== 'string' || page.path.length > 255) errors.push(`${at}.path`);
        if (typeof page.home !== 'boolean') errors.push(`${at}.home`);
        if (typeof page.body !== 'string' || Buffer.byteLength(page.body) > 1048576) errors.push(`${at}.body`);
        if (page.sources !== undefined && page.sources !== null) {
            if (!Array.isArray(page.sources) || page.sources.length > 50) errors.push(`${at}.sources: array, max 50`);
            else for (const [j, source] of page.sources.entries()) {
                if (typeof source !== 'object' || source === null || Array.isArray(source)) errors.push(`${at}.sources.${j}: array/object`);
                else {
                    if (typeof source.key !== 'string') errors.push(`${at}.sources.${j}.key`);
                    if (!SOURCE_KINDS.includes(source.kind)) errors.push(`${at}.sources.${j}.kind`);
                }
            }
        }
    }
    return errors;
}
```

- [ ] **Step 2: Edit `src/utils/pages-sync.ts`.** (a) `import type { PageBundle } from './page-bundle'; import { bundlePage, PageBundleError } from './page-bundle';`. (b) `export type PageLanguage = 'html' | 'tsx';` and `PageFile.language: PageLanguage`; `listCodePages` sets `language: page.file.endsWith('.tsx') ? 'tsx' : 'html'` placed right after `kind` (a `.tsx` file keeps `kind: 'dashboard'`, `.html` keeps `'visual'`; the order of keys in the object does not matter to `toEqual`). (c) add:

```ts
export async function bundleCodePages(sourceDir: string, pages: PageFile[]): Promise<{ bundles: Map<string, PageBundle>; errors: string[] }> {
    const bundles = new Map<string, PageBundle>();
    const errors: string[] = [];
    for (const page of pages.filter(candidate => candidate.language === 'tsx')) {
        try {
            bundles.set(page.slug, await bundlePage(path.join(sourceDir, page.path), sourceDir));
        } catch (error: any) {
            const lines = String(error?.message ?? 'bundle failed').split('\n');
            errors.push(`page ${page.slug} (${page.path}): ${lines[0]}`, ...lines.slice(1).map(line => `  ${line}`));
        }
    }
    return { bundles, errors };
}
```

(d) `buildPagesSyncPayload` gets the optional 5th parameter and maps each page to `{ ...page, body: bodies.get(page.slug)!, ...(bundle === undefined ? {} : { source_files: bundle.sources, compiled: bundle.compiled, compiled_css: bundle.compiledCss, compiler_version: bundle.compilerVersion }) }` where `bundle = bundles.get(page.slug)`. The payload type's `pages` element type gains the four optional fields.

- [ ] **Step 3: Edit `src/commands/deploy.ts`.** Import `bundleCodePages`. **Placement (manager ruling after the Task 2 review: the first-deploy project creation is a POST, so bundling must run before it):** put the call, its error printing and `process.exit(1)` immediately after `console.log(chalk.green('✓ Project structure validated'));` (before the project lookup/creation try block that starts `let projectSlug = projectName;`), using `listCodePages(yamlConfig ?? {})` there (move that one call up; `readPageBodies` may stay where it is). Add:

```ts
    const bundled = await bundleCodePages(sourceDir, pageFiles);
    if (bundled.errors.length > 0) {
        console.error(chalk.red('Page bundling failed; nothing was uploaded:'));
        for (const line of bundled.errors) console.error(chalk.red(line));
        process.exit(1);
    }
```

and pass `bundled.bundles` as the 5th argument of the `buildPagesSyncPayload(...)` call in `finishDeploy`. Nothing else in the file changes. Keep the exact `Page bundling failed; nothing was uploaded:` first line (Task 3 pins it).

- [ ] **Step 4: Edit `tests/pages-sync.test.ts`.** (a) the `pages` fixture gains `language: 'html'` on `home` and `language: 'tsx'` on `board`; the "lists code pages" test keeps passing with the new field. (b) add rows:

| # | Test | Assertion |
|---|---|---|
| 1 | `listCodePages` language | `.html` → `html`, `.tsx` → `tsx` |
| 2 | payload with a bundle for `board` (`{compiled:'C', compiledCss:'S', sources:{'pages/board.tsx':'T'}, compilerVersion:'0.28.2'}`) | page `board` equals `{...pages[1], body:'tsx', source_files:{'pages/board.tsx':'T'}, compiled:'C', compiled_css:'S', compiler_version:'0.28.2'}` and still carries `sources: [{key:'sales'}]` (the data sources, not the file map); page `home` has none of the four keys (`'compiled' in page` false) |
| 3 | `bundleCodePages` on a real temp project (no injected bundler: ruling, the real bundler is cheap and the shop forbids stand-ins) with a tsx page `board` whose file has a syntax error on line 3 plus an `.html` page | `errors[0]` starts with `page board (pages/board.tsx): pages/board.tsx:3:`; `bundles` is empty; the `html` page produces no error and no bundle |
| 4 | `bundleCodePages` on a real temp project with two tsx pages that both fail (one syntax error, one importing `react/jsx-runtime`), and a third valid tsx page | `errors` names both failing slugs (all pages are tried), `bundles` holds exactly the valid page |
| 5 | old-server guard | `validatesAgainstAppMain(buildPagesSyncPayload(pages, bodies, null, ref, bundles))` returns `[]` for the fixture with and without bundles; and returns a non-empty list for a payload that puts the file map under `sources` (`{...page, sources: {'a.ts':'x'}}`) — proves the helper would have caught R1 |

Expected-RED table: rows 1-5 fail on the base because `language`, `bundleCodePages`, the fifth parameter and the helper do not exist (row 5's last assertion fails on the base for the missing helper import, not for a behaviour).

- [ ] **Step 5: Static check.** `npx tsc --noEmit`. No test run.

- [ ] **Step 6: Report (do not commit).** Changed paths, `git diff --stat` for the four paths, the expected-RED table.

---

### Task 3: deploy end to end against a local server (cli#236)

**Depends on:** Task 2 (committed). Must not run beside Task 2.

**Files (file scope — the only paths this task may touch):**
- Create: `tests/deploy-code-pages.test.ts`

**Interfaces:**
- Consumes: the built `dist/commands/deploy.js` (`npm run build` runs before the tests in CI: `check:release`), `validatesAgainstAppMain` from `tests/helpers/pages-sync-main-rules.ts`.
- Produces: nothing.

- [ ] **Step 1: Write `tests/deploy-code-pages.test.ts`** on the pattern of `tests/deploy-archive-every.test.ts` (local `http.createServer` fake app, `spawn(process.execPath, ['-e', script, ...])` running `require('dist/commands/deploy.js').deploy('code-pages-project', sourceDir, { env: 'production', gitMetadata: false })`, recording every request). Copy that file's GET/POST responders; add `PUT .../functions/sync` → `{"functions":[],"retired":[],"retire_errors":[]}` and `PUT .../pages/sync` → `{"pages":[<one live row per sent page>],"trashed":[],"trash_errors":[],"stamp":"written"}` built from the request body.

Fixture (`fixture(variant)` in a temp dir, removed in `finally`): `solidactions.yaml` with `pages: [{id: board, name: Board, file: pages/board.tsx, home: true, sources: [{key: sales, kind: sql, database: main, sql: "select 1"}]}, {id: about, name: About, file: pages/about.html}]`; `pages/board.tsx` importing `../lib/format`, `fake-chart` and `react`; `lib/format.ts`; `node_modules/fake-chart/{package.json,index.js,style.css}` as in Task 1; `pages/about.html` `<h1>About</h1>`; `package.json`.

| # | Test | Assertion |
|---|---|---|
| 1 | clean deploy | exit 0, stderr `''`; exactly one `PUT .../pages/sync`; its parsed body: page `board` has `language:'tsx'`, `kind:'dashboard'`, `body` equal to the entry file text, `compiled` starting `globalThis.__saPlatform.define(`, `compiled_css` containing `.fake`, `compiler_version:'0.28.2'`, `Object.keys(source_files).sort()` equal `['lib/format.ts','pages/board.tsx']`, `sources` equal to the yaml data-source list (still an array of objects); page `about` has `language:'html'` and none of `compiled`, `compiled_css`, `compiler_version`, `source_files`; `validatesAgainstAppMain(body)` is `[]` (old-server guard) |
| 2 | functions sync order | the pages sync happens after the archive POST as in `deploy-archive-every` (unchanged behaviour): `requests.findIndex(PUT pages/sync)` is greater than the index of the `POST .../deploy` |
| 3 | one page fails to bundle (`lib/format.ts` replaced with an import of `react/jsx-runtime`) | exit 1; stderr contains `Page bundling failed; nothing was uploaded:` and `page board (pages/board.tsx):` and `react/jsx-runtime`; **`requests` contains no `PUT` or `POST` request at all** (no functions sync, no archive, no pages sync) |
| 3b | first deploy (the fake server answers the project GET with 404 so the CLI would create the project, run with `environment: 'production'`) and a page that fails to bundle | exit 1; same stderr lines as row 3; **no `POST` at all**, so no project was created (ruling from the Task 2 review: bundling runs right after "Project structure validated", before the project lookup/creation) |
| 4 | output over 2 MiB (a `lib/big.ts` as in Task 1 row 15) | exit 1; stderr contains `page board` and `over the 2 MiB (2097152 bytes) limit`; no PUT/POST |
| 5 | html-only project (yaml without the tsx page) | exit 0; pages sync body has no `compiled` key on any page, `language:'html'`, and `validatesAgainstAppMain` `[]` |

Expected-RED table: rows 1, 3, 4 fail on the base (no bundling: row 1 has no `compiled`; rows 3 and 4 exit 0 and upload); rows 2 and 5 pass on the base and are regression pins (stated so the reviewer does not ask for RED on them).

- [ ] **Step 2: Static check.** `npx tsc --noEmit` (the test file is outside `tsc`'s include if `tsconfig.json` excludes `tests`; check with `grep -n include tsconfig.json` and say so in the report). No test run.

- [ ] **Step 3: Report (do not commit).** Changed paths, diff size, the expected-RED table.

---

## Self-review (done 2026-11-10)

- Spec coverage: §6.1 bundler (Task 1), sync fields (Task 2), caps and refusals (Tasks 1, 3), deploy wiring (Task 2); acceptance 2 ("unsupported esbuild version or module over 2 MiB refused with the code and slug") is the CLI half: the 2 MiB refusal names the slug (Task 3 row 4); the unsupported-version refusal is the server's (app#2653). Acceptance 1 and 3 need the server half. Issue test list: lib + npm package → Task 1 rows 1, 3; `react/jsx-runtime` → row 11; over 2 MiB naming slug → Task 3 row 4; sources ≤50/1 MiB → rows 16, 17.
- Placeholders: none. Types: `PageBundle`, `PageBundleError`, `bundleCodePages`, `PageBundler`, `validatesAgainstAppMain` used with the same names in all tasks.
- Scope: each task's Files are exhaustive and disjoint; no task commits; no `Run:` line (no local tests; Speed rules); `tests/Architecture` greps do not apply to this repo.
- Premises probed at plan time: esbuild 0.28.2 exists on npm (`npm view esbuild@0.28.2 version` → `0.28.2`, engines node >=18); server option list and `PLATFORM_MODULES` read from app main `runner/src/query/page-compile-worker.ts`; wire rules read from app main `PagesSyncRequest.php`; `npm ci --ignore-scripts` in `check.yml` (release-candidate job): esbuild's binary comes from its optional platform packages, so skipping the postinstall is only slower — Task 1's tests run in that job and are the proof. Premise to measure in build: esbuild honours `tsconfigRaw` over a project `tsconfig.json` in the build API (Task 1 row 7 is the probe); the metafile `inputs[entryKey].format` key is the project-relative path (rows 1 and 5 are the probe). If row 7 or 5 fails for those reasons, the fix is in `page-bundle.ts` only.
- Out of scope (file, do not build): images/fonts via `dataurl` loaders, CSS size cap, Tailwind, `doc pull` of code pages (server), watch mode in `sa dev`.
- Midpoint row: none (three tasks).
- Deploy notes: new runtime dependency (`esbuild` with platform binary packages) enlarges `npm i -g @solidactions/cli`; nothing server-side to deploy; release is the PM's after the app server half (app#2653) is scheduled.

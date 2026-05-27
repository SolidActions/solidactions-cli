# CLI SOP-Surface Conformer (#248, conforming to #34) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. This is a TypeScript CLI (`@solidactions/cli`), tested with vitest.

**Goal:** Make a whole plugin's SOP content pushable/manageable from the CLI, conforming to the #34 taxonomy. Covers #248 items 1 (recursive `skill push` + `commands/`→skills), 3 (`skill list`/`pull`/`delete`), 4 (`role push`), 5 (`--dry-run`). **Out of scope (separate conformer):** #248.2 `doc push` (Context/docs surface) and the #34 `--help` section-header/`configureHelp` + `oauth-actions show`→`view` verb-canon migration.

**Branch dependency:** based on `fix/skill-push-references` (#247 — adds the recursive `readReferences`, which item 1 relies on). Rebase onto `main` once #247 (CLI PR #37) merges.

**Tech stack:** TypeScript, commander.js, `js-yaml`, vitest (in-process `http` stub for `/mcp/crews`). Run tests: `npx vitest run`. Build: `npm run build` (tsc). Install deps first in this worktree: `npm install`.

---

## Background (verified against the repo)

- **Command wiring** (`src/index.ts`): nouns are `const x = program.command('<noun>')`; verbs chain `.command('<verb>')...action(...)`. `skill` noun already exists (~line 444) with `push`. New verbs chain onto the same `skill` const; a new `role` noun is its own `program.command('role')`.
- **No `configureHelp`** help-grouping yet (deferred — #34 verb-canon conformer, NOT this plan).
- **`skill push`** (`src/commands/skill-push.ts`): `parseSkillFile(content)` → `{name,description,properties,body}` (requires `name` in frontmatter); `readReferences(dir)` (post-#247: recurses, keys by relative path); `skillPushWithConfig(dir, options, config)` does the create→(on `name_collision`)→edit upsert via `callCrewsTool`. Today it pushes exactly ONE skill dir.
- **`callCrewsTool(config, toolName, args)`** (`src/utils/mcp.ts`): stateless JSON-RPC POST to `${host}/mcp/crews`; returns `{ ok: boolean, data: any }` (`ok=false` → `data={code,message}`).
- **Crews `Skills` MCP** (backend):
  - `list`: `{action:'list', limit?, offset?}` → `{skills:[{doc_id,name,description,catalog_advertised}]}`
  - `read`: `{action:'read', identifier}` (flat `<name>` or `shared/<name>`) → `{identifier, doc_id, properties, body, reference}` (`reference` = `{relativePath: content}`); errors `skill_not_found`, `invalid_identifier_form`
  - `delete`: `{action:'delete', identifier}` → `{deleted:true, delete_token}`; **Admin-only** (errors `permission_denied`, `skill_not_found`)
  - `create`/`edit`: as used by `skill push` today.
- **Crews `Roles` MCP**: `create`: `{action:'create', name, description, body, properties?}` → `{role_doc_id, folder_id}`; collision → `{code:'name_collision'}`. `edit`: `{action:'edit', name, description?, body?, properties_patch?}`. **No `references`** on roles.
- **`commands/*.md`** (Claude Code slash-commands): YAML frontmatter with `description` (no `name`), optional `allowed-tools`/`argument-hint`; body = the command prompt. Conversion: `name` = kebab of filename, `description` = frontmatter `description`, `body` = post-frontmatter; drop `allowed-tools`/`argument-hint` (no crews equivalent).
- **No `--dry-run`** anywhere yet — establish the pattern (pre-flight `read` to detect create-vs-update, print intent, no mutation).
- **Tests** (`tests/*.test.ts`): in-process `http.createServer` stub for `/mcp/crews`; `stubConfig`, `responseQueue` (FIFO canned responses), `patchProcessExit`, `captureStderr`, `makeTmpSkillDir`, `makeMcpSuccess`/`makeMcpError`. Each command module exposes a `...WithConfig(...)` entry taking an injected `Config` so tests bypass on-disk config.
- **Output**: `--json` → `console.log(JSON.stringify(data))`; human → `chalk.green` success / `chalk.gray` detail / `stderr` red errors.

## Design decisions (codex to validate)

1. **`skill push <dir>` becomes recursive-aware, single entry.** If `<dir>` contains `SKILL.md` → push that one skill (today's behavior, unchanged). Else, treat `<dir>` as a plugin/parent: push every `<dir>/skills/<name>/SKILL.md` (and any nested `**/SKILL.md`?) — **decide depth** (recommend: `<dir>/skills/*/SKILL.md` one level, plus `<dir>/SKILL.md`). Also convert every `<dir>/commands/*.md` into a skill. One summary line per pushed skill. No separate `plugin push` concept (per #34).
2. **`commands/*.md` → skill** via a new `parseCommandFile(filename, content)` (derive `name` from filename, `description` from frontmatter, `body` from content); reuse `skillPushWithConfig`'s upsert by feeding it a synthesized payload (refactor `skillPushWithConfig` to accept a parsed `{name,description,properties,body,references}` so both SKILL.md and command files share the push path).
3. **`skill list`** → `skills.list`, print table (name, description, advertised) or `--json`.
4. **`skill pull <name> [dest]`** → `skills.read`, reconstruct a local skill folder: write `SKILL.md` (frontmatter `name`+`description`+properties, then body) and each `reference` entry to its relative path (keys are already relative paths post-#247). Default dest `./<name>/`.
5. **`skill delete <name>`** → `skills.delete` (verb `delete`, not `rm`, per #34). Surface the Admin-only `permission_denied` clearly.
6. **`role push <dir>`** → `roles.create`→(collision)→`roles.edit` upsert; role dir has a `ROLE.md` (or `SKILL.md`? — **decide**: recommend `SKILL.md` for symmetry, parsed same way; no references). Recommend reusing `parseSkillFile`.
7. **`--dry-run`** on `skill push` (+ `role push`): pre-flight `read` per skill/role; print `[dry-run] would create 'X'` / `would update 'X'`; make NO create/edit call.

**Open questions for codex:**
- (Q1) Recursion depth/conventions for `skill push <plugin-dir>`: exactly `{dir}/skills/*/SKILL.md` + `{dir}/commands/*.md` (+ top-level `{dir}/SKILL.md` single-skill mode)? Or deeper glob? Recommend the explicit one-level form (matches Claude Code plugin layout). Confirm.
- (Q2) `commands/*.md` name collision with a same-named `skills/<name>` — error, skip, or namespace? Recommend: push both; if identical resulting skill name, the second is an `update` of the first (upsert) — but warn. Confirm.
- (Q3) `role push` input file name (`SKILL.md` vs `ROLE.md`) + whether roles carry `references`. Recommend `SKILL.md`-shaped, no references. Confirm.
- (Q4) `skill pull` SKILL.md reconstruction: properties → frontmatter round-trips cleanly? (server strips `type`; `reference` keys are relative paths). Confirm the round-trip (push→pull→push) is idempotent.
- (Q5) `--dry-run` for the recursive/multi-skill case: one pre-flight read per item (N reads) acceptable? Confirm.

---

## #34 conformance check (explicit)

Cross-checked against the #34 north-star's ratified decisions + target tree:

- **Singular nouns** (#34 ratified #1): `skill`, `role` — singular. ✓
- **`push`, not `add`** (#34 ratified #2): `skill push` (the `crews skill add` rename already shipped in #36/#247). ✓
- **Flatten the SOP surface** (#34 ratified #3): `skill` and `role` are independent top-level nouns; no `crew(s)` umbrella; role-scoping stays a `--role <name>` flag (existing on `skill push`). ✓
- **Verb canon** (#34 #6): commands use #34's vocabulary — `push`/`pull` (file-sync: local↔remote upsert/fetch), `list`/`view` (read), `delete` (NOT `rm` — #248 said `rm`, #34 verb-canon wins). `pull` = fetch-to-local-files; `view` = show-one-to-terminal. ✓
- **`push` = idempotent upsert from files** (#34 forward-compat): create-or-update by identity. ✓

**Deliberate divergences from #34's target-tree phasing (flagged for codex/user):**
- #34 places `create/edit/delete` in the "(+ CRUD later)" phase and `push·pull·list·view` in the initial bridge. **#248 explicitly requests `skill rm`** (cleanup), so this plan pulls `delete` forward (named `delete` per verb-canon, not `rm`). The backend already supports it (`skills delete`, Admin-only).
- #34's initial skill row includes **`view`** (show-one). #248 didn't request it, but it's cheap and in #34's initial set — **added as `skill view <name>`** (terminal display via `skills.read`) to match #34's initial surface, complementing `pull` (file-fetch). [If you'd rather not, drop Task 5b.]
- `crew` noun and `role`'s `pull`/`list`/`view` are **out of scope** here (#248 only asks for `role push`; `crew` is a separate future conformer per #34). Names are chosen so they slot in later with zero restructuring.

> Net skill surface after this plan: `skill push · pull · list · view · delete` + `role push` — matches #34's flat singular-noun SOP model.

---

## File Structure
**Modified:** `src/index.ts` (register `skill list/pull/delete`, `role push`; `--dry-run`/recursive on `skill push`); `src/commands/skill-push.ts` (recursion + command-file conversion + dry-run; refactor to a payload-based push).
**Created:** `src/commands/skill-list.ts`, `src/commands/skill-pull.ts`, `src/commands/skill-delete.ts`, `src/commands/role-push.ts`; `tests/skill-list.test.ts`, `tests/skill-pull.test.ts`, `tests/skill-delete.test.ts`, `tests/role-push.test.ts`, plus additions to `tests/skill-push.test.ts`.

---

## Task 1: Refactor `skill push` to a payload-based push (prep for reuse)
Extract the upsert core so both SKILL.md, command-files, and roles can drive it.
- [x] Test: `pushParsedSkill({name,description,properties,body,references}, options, config)` creates then (on collision) edits, and RETURNS a result (`{status:'created'|'updated', name, ...}`) — it must NOT call `process.exit`. Port existing skill-push assertions to the new entry.
- [x] Implement: split `skillPushWithConfig` into `readSkillDir(dir) → parsed payload` + `pushParsedSkill(payload, options, config)`. **CODEX-FLAGGED: remove the `process.exit(0)` from the per-item push core** (`skill-push.ts:~195-210`) — it must RETURN, not exit, or a recursive multi-skill push (Task 2) stops after the first item. The command-level wrapper (`skillPushWithConfig` / the index.ts action) prints output and calls `process.exit` ONCE after all items. Keep `skillPushWithConfig` as a thin wrapper (read dir → push payload → print → exit) so existing single-skill tests/behavior hold.
- [x] Run `npx vitest run tests/skill-push.test.ts` green. Commit.

## Task 2: Recursive `skill push <plugin-dir>` + `commands/` conversion
- [x] Tests: a `<dir>` with `skills/a/SKILL.md` + `skills/b/SKILL.md` + `commands/c.md` pushes 3 skills (assert 3 create calls with names a, b, c; c's name from filename, description from frontmatter); a `<dir>` that IS a single skill (`<dir>/SKILL.md`) still pushes one (back-comp); **a `<dir>` where a `commands/foo.md` and `skills/foo/SKILL.md` resolve to the SAME skill name → ERROR before any push (CODEX-FLAGGED: silent "second wins" would corrupt the first via edit), and assert ZERO create/edit calls.** Stub multiple `responseQueue` successes; assert `allCaptures`.
- [x] Implement: `parseCommandFile(filename, content)`; in the `skill push` action, detect single-skill (`<dir>/SKILL.md` exists) vs plugin-dir. **CODEX-FLAGGED: the current entry-point requires a top-level `SKILL.md` and exits otherwise (`skill-push.ts:~130-135`) — change that so a plugin-dir (no top-level SKILL.md) is valid.** For plugin-dir, glob ONE level only — `skills/*/SKILL.md` + `commands/*.md` (NOT `**/SKILL.md`: the reference reader recurses inside a skill dir, so a deep glob would mistake bundled reference files for sub-skills). Build all payloads, **detect duplicate generated skill names across the combined set and abort with an error listing the conflicts (no silent overwrite)**, then push each via `pushParsedSkill`; print one summary line per skill + a final tally. Ignore `agents/`,`hooks/`,`.mcp.json` etc. silently.
- [x] Run green. Commit.

## Task 3: `--dry-run` on `skill push`
- [x] Tests: `skill push <dir> --dry-run` makes ZERO create/edit calls; performs a `read` per skill; prints `[dry-run] would create 'X'` (read→skill_not_found) / `would update 'X'` (read→found). Assert no create/edit in `allCaptures`.
- [x] Implement: `--dry-run` option; when set, `pushParsedSkill` pre-flights `skills.read` and prints intent instead of mutating.
- [x] Run green. Commit.

## Task 4: `skill list`
- [x] Tests: `skill list` calls `skills.list`, prints a table of name/description; `--json` prints raw `{skills:[...]}`; empty → friendly "no skills" line (non-error). Stub `makeMcpSuccess({skills:[...]})`.
- [x] Implement: `src/commands/skill-list.ts` (`skillListWithConfig`), register `skill list` in index.ts (`--json`, optional `--limit`).
- [x] Run green. Commit.

## Task 5: `skill pull <name> [dest]`
- [x] Tests: `skill pull foo` calls `skills.read` `{identifier:'foo'}`; writes `./foo/SKILL.md` (frontmatter has name+description; body matches) and each `reference` key as a file at its relative path (e.g. `./foo/references/x.md`); `skill_not_found` → error exit. **Add a push→pull→push idempotency test (or assert the reconstructed SKILL.md has no `type` key).** Use a tmp dest dir; assert files on disk.
- [x] Implement: `src/commands/skill-pull.ts` (`skillPullWithConfig`). **CODEX-FLAGGED: `skills.read` returns `{identifier, doc_id, properties, body, reference}` where `name` and `description` live INSIDE `properties` (not top-level), and `properties` is returned WITHOUT stripping `type` (`Skills.php:~598-603`).** So reconstruct SKILL.md frontmatter from `properties` (it already contains name/description + the rest), and explicitly OMIT `type` (mirrors what push strips). Write each `reference` entry to its key path; **guard/normalise the output path** (reference keys come from doc titles — reject path-traversal/absolute keys before writing under `dest`). `register skill pull <name> [dest]`.
- [x] Run green. Commit.

## Task 5b: `skill view <name>` (#34 initial verb — show one)
- [x] Tests: `skill view foo` calls `skills.read` `{identifier:'foo'}`; prints the skill's name/description/body to terminal (NOT to files); `--json` prints raw read result; `skill_not_found` → error. (Reuses the `read` action; the only difference from `pull` is terminal display vs. writing files.)
- [x] Implement: `src/commands/skill-view.ts` (`skillViewWithConfig`); register `skill view <name>` (`--json`).
- [x] Run green. Commit.

## Task 6: `skill delete <name>`
- [x] Tests: `skill delete foo` calls `skills.delete` `{identifier:'foo'}`, prints confirmation with delete_token; `permission_denied` (Admin-only) → clear error + non-zero exit; `skill_not_found` → error. (Consider a `--yes`/confirm guard — recommend no interactive prompt in v0; document that delete is immediate.)
- [x] Implement: `src/commands/skill-delete.ts` (`skillDeleteWithConfig`); register `skill delete <name>`.
- [x] Run green. Commit.

## Task 7: `role push <dir>`
- [x] Tests: `role push <dir>` (dir has SKILL.md-shaped role def) calls `roles.create` `{name,description,body,properties?}`; on `name_collision` → `roles.edit`; `--dry-run` pre-flights; reports created/updated. (No references sent.)
- [x] Implement: `src/commands/role-push.ts` (`rolePushWithConfig`) reusing `parseSkillFile` + the upsert pattern (no references); register `role push <dir>` (+ `--dry-run`, `--json`). **CODEX-FLAGGED: keep the `SKILL.md` filename convention for the role def (so `parseSkillFile`'s SKILL.md-worded errors stay accurate — don't introduce `ROLE.md` unless you also generalise those messages). The role `--dry-run` pre-flight must use `roles.read {name}` (roles key on `name`, NOT `identifier` — `Roles.php:~683-695`).**
- [x] Run green. Commit.

## Phase boundary
- [ ] `npx vitest run` (full suite) green; `npm run build` (tsc) clean.
- [ ] Live verification: a Sonnet tmux MCP agent (crews MCP → local stack) runs `skill push <plugin-dir>` (multi-skill + commands), `skill list`, `skill pull`, `skill delete`, `role push`, and `--dry-run` — confirm end-to-end over the wire.

## Self-review
- #248 coverage: item1 → Tasks 1,2; item3 → Tasks 4,5,5b,6; item4 → Task 7; item5 → Task 3. item2 (doc push) explicitly deferred. ✓
- #34 conformance: singular nouns (`skill`,`role`); verbs push/pull/list/view/delete; `push`=idempotent upsert; flat (no crew umbrella). ✓

## Codex review outcome (2026-05-26)

Codex validated the plan: **#34 conformance = PASS** (singular nouns, flat peers, push-not-add, `--role` flag, `delete` verb-canon, `view` correctly in initial set; pulling `delete` forward per #248's explicit ask is acceptable). Four technical revisions were required and are now folded into the tasks:

- **Task 1 (CODEX):** the per-item push core must RETURN, not `process.exit(0)` — else a recursive multi-skill push stops after item 1. Exit once at the command level.
- **Task 2 (CODEX):** change the entry-point `SKILL.md`-required guard so a plugin-dir is valid; one-level glob only (deep `**/SKILL.md` would mistake a skill's bundled reference files for sub-skills); detect duplicate generated skill names across `skills/` + `commands/` and ERROR (silent "second wins" corrupts the first via `edit`).
- **Task 5 (CODEX):** `skills.read` returns `name`/`description` INSIDE `properties` and does NOT strip `type` — pull reconstructs frontmatter from `properties`, omits `type`, and path-guards reference output (keys derive from doc titles).
- **Task 7 (CODEX):** role `--dry-run` pre-flight uses `roles.read {name}` (roles key on `name`, not `identifier`); keep `SKILL.md` convention so `parseSkillFile`'s errors stay accurate.

Q1/Q5 approved as written (one-level discovery; N pre-flight reads acceptable). Self-audit line corrected to include `view`.

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
- [ ] Test: `pushParsedSkill({name,description,properties,body,references}, options, config)` creates then (on collision) edits — port existing skill-push assertions to the new entry.
- [ ] Implement: split `skillPushWithConfig` into `readSkillDir(dir) → parsed payload` + `pushParsedSkill(payload, options, config)`. Keep `skillPushWithConfig` as a thin wrapper (read dir → push payload) so existing tests/behavior hold.
- [ ] Run `npx vitest run tests/skill-push.test.ts` green. Commit.

## Task 2: Recursive `skill push <plugin-dir>` + `commands/` conversion
- [ ] Tests: a `<dir>` with `skills/a/SKILL.md` + `skills/b/SKILL.md` + `commands/c.md` pushes 3 skills (assert 3 create calls with names a, b, c; c's name from filename, description from frontmatter); a `<dir>` that IS a single skill (`<dir>/SKILL.md`) still pushes one (back-comp). Stub multiple `responseQueue` successes; assert `allCaptures`.
- [ ] Implement: `parseCommandFile(filename, content)`; in the `skill push` action, detect single-skill (`<dir>/SKILL.md` exists) vs plugin-dir; for plugin-dir, glob `skills/*/SKILL.md` + `commands/*.md`, build payloads, push each via `pushParsedSkill`; print one summary line per skill + a final tally. Ignore `agents/`,`hooks/`,`.mcp.json` etc. silently.
- [ ] Run green. Commit.

## Task 3: `--dry-run` on `skill push`
- [ ] Tests: `skill push <dir> --dry-run` makes ZERO create/edit calls; performs a `read` per skill; prints `[dry-run] would create 'X'` (read→skill_not_found) / `would update 'X'` (read→found). Assert no create/edit in `allCaptures`.
- [ ] Implement: `--dry-run` option; when set, `pushParsedSkill` pre-flights `skills.read` and prints intent instead of mutating.
- [ ] Run green. Commit.

## Task 4: `skill list`
- [ ] Tests: `skill list` calls `skills.list`, prints a table of name/description; `--json` prints raw `{skills:[...]}`; empty → friendly "no skills" line (non-error). Stub `makeMcpSuccess({skills:[...]})`.
- [ ] Implement: `src/commands/skill-list.ts` (`skillListWithConfig`), register `skill list` in index.ts (`--json`, optional `--limit`).
- [ ] Run green. Commit.

## Task 5: `skill pull <name> [dest]`
- [ ] Tests: `skill pull foo` calls `skills.read` `{identifier:'foo'}`; writes `./foo/SKILL.md` (frontmatter has name+description; body matches) and each `reference` key as a file at its relative path (e.g. `./foo/references/x.md`); `skill_not_found` → error exit. Use a tmp dest dir; assert files on disk.
- [ ] Implement: `src/commands/skill-pull.ts` (`skillPullWithConfig`): read → reconstruct SKILL.md (yaml.dump frontmatter {name,description,...properties} + body) + write references by relative path; register `skill pull <name> [dest]`.
- [ ] Run green. Commit.

## Task 5b: `skill view <name>` (#34 initial verb — show one)
- [ ] Tests: `skill view foo` calls `skills.read` `{identifier:'foo'}`; prints the skill's name/description/body to terminal (NOT to files); `--json` prints raw read result; `skill_not_found` → error. (Reuses the `read` action; the only difference from `pull` is terminal display vs. writing files.)
- [ ] Implement: `src/commands/skill-view.ts` (`skillViewWithConfig`); register `skill view <name>` (`--json`).
- [ ] Run green. Commit.

## Task 6: `skill delete <name>`
- [ ] Tests: `skill delete foo` calls `skills.delete` `{identifier:'foo'}`, prints confirmation with delete_token; `permission_denied` (Admin-only) → clear error + non-zero exit; `skill_not_found` → error. (Consider a `--yes`/confirm guard — recommend no interactive prompt in v0; document that delete is immediate.)
- [ ] Implement: `src/commands/skill-delete.ts` (`skillDeleteWithConfig`); register `skill delete <name>`.
- [ ] Run green. Commit.

## Task 7: `role push <dir>`
- [ ] Tests: `role push <dir>` (dir has SKILL.md-shaped role def) calls `roles.create` `{name,description,body,properties?}`; on `name_collision` → `roles.edit`; `--dry-run` pre-flights; reports created/updated. (No references sent.)
- [ ] Implement: `src/commands/role-push.ts` (`rolePushWithConfig`) reusing `parseSkillFile` + the upsert pattern (no references); register `role push <dir>` (+ `--dry-run`, `--json`).
- [ ] Run green. Commit.

## Phase boundary
- [ ] `npx vitest run` (full suite) green; `npm run build` (tsc) clean.
- [ ] Live verification: a Sonnet tmux MCP agent (crews MCP → local stack) runs `skill push <plugin-dir>` (multi-skill + commands), `skill list`, `skill pull`, `skill delete`, `role push`, and `--dry-run` — confirm end-to-end over the wire.

## Self-review
- #248 coverage: item1 → Tasks 1,2; item3 → Tasks 4,5,6; item4 → Task 7; item5 → Task 3. item2 (doc push) explicitly deferred. ✓
- #34 conformance: singular nouns (`skill`,`role`); verbs push/list/pull/delete; `push`=idempotent upsert; flat (no crew umbrella). ✓

## Codex review outcome
_(to be filled in; if Codex is unavailable, self-review + per-task subagent reviews stand in — see #251 precedent.)_

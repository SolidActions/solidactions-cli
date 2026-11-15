# CLI functions docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sa-subagent-driven-development to implement this plan task-by-task (the wave's build step). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An AI building through the CLI learns that fast functions exist and that it must try an app (preview link) before calling a change done; the public docs describe functions; the CLI installs the new skill and pins the examples commit that carries it.

**Architecture:** Three repos, three PRs, one wave. (A) `solidactions-examples`: a new skill file `solidactions-functions`, a `function-echo` example, a functions pointer and a preview rule in two existing skills, the skill lists. (B) `solidactions-marketing` (its `site/` folder is the public docs at www.solidactions.com/docs): a Functions page, nav, cross-links, and the docs contract that names the installed skills. (C) `solidactions-cli` (the wave slot, the wave's own PR): add `solidactions-functions` to `SOLIDACTIONS_SKILL_NAMES`, README and the release smoke, then repin `EXAMPLES_REF` to the merged examples commit. No product behaviour changes anywhere.

**Tech Stack:** Markdown skill files, Astro (marketing site), TypeScript + vitest (CLI), Node ESM scripts (examples content checks).

**Spec:** No separate spec file: the wave is small and the brainstormer proposal is the design: `/home/mercer/crewops2/workspaces/solidactions/desk/proposals/2026-11-09-functions-docs-wave.md` (cards 1-3; card 4, the app line, runs in the app slot under manager-1 and is not this wave). Source text for every functions fact: `app/Mcp/Tools/WorkflowsGuideTool.php` `sections()['functions']` on app `origin/main` (lines 749-805 as read at plan time); the page builds on it, the developer reads it with `git -C /home/mercer/projects/solid/solidactions-app show origin/main:app/Mcp/Tools/WorkflowsGuideTool.php | sed -n 749,805p` (read only; never touch the app checkout).

**Issues:** `cli#249` ("Repin EXAMPLES_REF after the skill text names 'app preview' (cli#247 follow-up)"), sanctioned by Peter's go, approval ask `task-start-88e3` (size small), parent wave card `task-wavefunctions-ad65` (its comments of 2026-11-15 add the preview-text item and name cli#249 as its tracker). The wave card here is `task-waveclifunctions-20b8`.

## Global Constraints

- Binding ruling, verbatim from cli#249 (body, no comments): "The skill files in solidactions-examples (content/skills/) should tell agents to ask for a preview link (`solidactions app preview <app> [--page <id>]` or the MCP preview_link action) and try the app before calling an app change done. That repo has issues disabled, so this is the tracker. Rides with the functions docs wave (skill file change + EXAMPLES_REF repin)".
- Binding ruling, verbatim from cli#247 (the preview facts the text must carry): "the link works once, within 60 seconds; the session ends after 3 minutes idle or 10 minutes".
- Binding ruling, verbatim from the PM on the wave card `task-wavefunctions-ad65` (2026-11-15T13:48): "the skill text in solidactions-examples tells agents to run 'solidactions app preview' and try the app before calling an app change done (app#2748 W2, cli#247); ride with this wave's skill file change and its EXAMPLES_REF repin."
- Binding ruling, verbatim from the PM (comment on `task-wavefunctions-ad65`, 2026-11-15T20:09, "CLI v3.36.0 (app preview) is out: the skill text (cli#249) can name 'solidactions app preview', and the CLI repin builds on 3.36.0."): the command exists on a released CLI (v3.36.0, asset `command-manifest.json` verified at plan time with `gh release view v3.36.0`).
- Ruling (plan, repo choice): the card text says `solidactions-site`; the public docs at www.solidactions.com/docs are built from `SolidActions/solidactions-marketing`, folder `site/` (`site/src/pages/docs/`, `site/src/components/DocsNav.astro`), and `solidactions-site` has no `docs` pages (`ls solidactions-site/src/pages` at plan time: `blog, crews.astro, index.astro, pricing.astro, privacy.astro, terms.astro, v2-v4.astro`). The proposal also says marketing. Piece (1) goes to marketing. Cost if wrong: one repo swap before dispatch.
- Ruling (plan, no CLI manifest bump in the examples repo): the examples repo pins the CLI command manifest at v3.6.0 (`content/manifest-contract.json` `release_tag`), and its content validator flags `solidactions app preview` (new since 3.6.0). Bumping to 3.36.0 was tried in a scratch clone: `node scripts/check-content.mjs` then fails on 14 stale `content/validator-allowlist.json` entries, and `content/placeholder-contract.json` `guidance_cli_version` ("3.6") is baked into frozen goldens (`tests/golden/app/cloud/deploy.txt`, `full.txt`, `self-hosted/*`), so a bump is a separate, risky change. The repo's own precedent for a command newer than the pin is an allowlist entry with a reason (`#1146 documents the database group pending its first released CLI command manifest.`). Task 2 adds allowlist entries for exactly the new `app preview` spans. Follow-up (filed at the end of build, rung 4): bump the examples manifest pin to a current CLI release and drop the entries. Cost if wrong: the PM asks for the bump now and Task 2 grows by the allowlist cleanup and golden review.
- Static checks allowed in the examples and marketing slots (they run no test): `node scripts/check-docs.mjs` and `node scripts/check-content.mjs` in the examples checkout (validators, not `node --test`), `npm run build` and `npm run check:docs` in `site/` of the marketing checkout. Never run `node --test`, `npm run check:contract` against another repo, vitest, or any suite: CI runs those.
- Copy rules (every task): plain words in the site's tone (`site/src/pages/docs/triggers/webhooks/index.astro` is the model); no em dashes; no claim a source line does not support. Every number or limit is copied from the guide topic text (5 s CPU, 50 outbound requests, `timeout` 1 to 30 s default 10, 256 KB source, 50 functions per project, 300 calls a minute and 1,000,000 a month per workspace, a daily cap on new versions per workspace (no number, because the guide does not state one: the guide names only the code `version_cap_reached`, and the cap comes from app config, so the page says "a daily cap on new versions" and never a figure).
- The CLI repo takes no `package.json` change (version bump and release are the PM's), no new dependency.
- Premise check, other open PRs (`gh pr list --state open --json number,files` at plan time, 2026-11-15): cli: none. examples: #6 `security/override-koa-yaml` (touches package files only; no overlap). marketing: #27 `issues/github-1713` (files `site/docs-contract.json`, `site/src/pages/docs/analytical-databases/index.astro`) and #28 `issues/github-1819-analytical-sql-functions` (files `site/scripts/check-doc-routes.mjs`, same page). Task 3 edits `site/docs-contract.json` and `site/scripts/check-doc-routes.mjs`: if #27 or #28 merges first, Task 3's branch merges `origin/main` in (manager, never rebase) and re-reads both files before the final review; if Task 3 lands first, the two PRs re-derive. The edits are one list element each, so the conflict is a one-line fix.
- No tests run on this box (Speed rules). The CLI's tests (`tests/examples-ref.test.ts`, `tests/skills-manifest.test.ts`, `tests/readme-contract.test.ts`) run in `check.yml` on the pushed head; the examples and marketing checks run in their own GitHub workflows on their PRs.

Secret-bearing host paths this plan's code reads: none.

Verify data: the CLI smoke and cleanroom run the CLI built from this branch. Needs: (1) network to `raw.githubusercontent.com` (the repinned examples commit must be merged and reachable); (2) a free app slot's dev stack (`sa-dev-<slot>`, PM to name it at verify, no live wave holds it) with fast functions switched on, for the one deploy of `function-echo` (`solidactions project deploy fn-echo-<wave> ./function-echo -e dev`) and one `curl` to its webhook; if the stack has functions off the deploy reports `functions_disabled`, which the smoke records as "deploy not run: stack has functions off" and the cleanroom text goals still run; (3) the pre-merge fetch override for a branch not yet merged is not available, so the smoke runs after the examples PR merges. The `ai init` and `ai examples` goals need only a login on the target stack (`creds-<wave>` file as usual).

## Review Focus

1. A skill name the CLI installs that does not exist at the pinned examples ref makes `solidactions ai init` fail for every user with a 404 mid-install (Task 4 and Task 5 together; Task 5 is the proof: the pinned commit contains `content/skills/solidactions-functions.md`, read with `gh api repos/SolidActions/solidactions-examples/contents/content/skills/solidactions-functions.md?ref=<sha>`).
2. A repin to a SHA that is a PR branch commit and not the merged mainline commit (squash merges change the SHA): the pin then points at an orphan commit that GitHub can garbage-collect. Task 5 Step 1 proves it with `git merge-base --is-ancestor <sha> origin/main` in an examples clone: the SHA must be on `origin/main` of the examples repo.
3. The marketing contract check compares the CLI's `SOLIDACTIONS_SKILL_NAMES` to `site/docs-contract.json` `skills` (`site/scripts/check-docs-contract.mjs` lines 157-176) and CI checks out CLI and examples `main`: a skill added on one side only fails the daily cron and every other marketing PR. Merge order (below) and Task 3's `docs-contract.json` edit cover it; the manager proves it with a dispatched run of the marketing workflow against the wave refs before the PM merges.
4. An agent that reads the new skill and still writes a workflow for a one-file job: the decision rule must be the first thing in the skill, as a Hard Rule (Task 1 test: `scripts/check-docs.mjs` extension asserts the rule sentence is present).
5. An agent that changes an app page, deploys, and calls it done without ever opening it: the preview rule must be a Hard Rule in `solidactions-getting-started` and name both doors, the command and the MCP action (Task 2).
6. `solidactions app preview` span in skill prose flagged by the examples validator on CI: allowlisted with a reason (Task 2), the entry's `span` must equal the text in the skill byte for byte.

---

## Merge order and repo mechanics (frozen)

- Branch name in each satellite repo: `wave/2026-11-15-cli-functions-docs`. Developers never push and have no GitHub auth: the manager pushes each satellite branch and opens its PR (`gh pr create --repo SolidActions/<repo>`), confirms the head and that its checks registered, and records the PR numbers on the wave card. Satellite commits are the manager's, by explicit paths (`git add -- <paths>` then `git commit -m ... -- <paths>`), after the per-task review.
- **No push and no draft PR of the CLI branch before Task 5 is committed (exception to opening a draft PR at the first commit).** The CLI's `release-candidate` job runs `check:release`, which runs `smoke:init`; `smoke:init` reads `EXAMPLES_REF` and requires each skill name at that ref (`scripts/smoke-init.mjs` lines 52-60, `check.yml` lines 70-98, `package.json` line 36). A push of Task 4 alone (six names, old ref `47e887d`) is red. The one sanctioned mid-build push (context wall) is allowed only with Task 5 committed or with the red expected and stated on the card.
- Order the PM merges (the PM merges; the manager never does): (1) examples PR (Tasks 1 and 2); (2) the manager runs Task 5 (repin to the merged SHA) in the CLI slot, final review, CLI PR; the CLI PR is merged and released by the PM; (3) marketing PR (Task 3) last, because its contract check reads CLI `main` and examples `main` and needs both new. Before step 3 the manager dispatches the marketing workflow with `gh workflow run marketing-site-checks.yml --repo SolidActions/solidactions-marketing --ref wave/2026-11-15-cli-functions-docs -f cli_ref=wave/2026-11-15-cli-functions-docs -f examples_ref=<merged examples sha>` to have a green contract run in hand.
- The contract window (CLI `main` has six skill names, the marketing contract five) must be short: the PM merges marketing right after the CLI merge, in the same sitting, with the dispatched green marketing run in hand, and not across 09:23 UTC (the marketing workflow's daily cron, `marketing-site-checks.yml` `schedule`). Until then a red marketing cron or a red push on open marketing PRs #27 and #28 is expected and is not a finding.
- The CLI PR cannot be final-reviewed until the examples PR is merged (Task 5 needs the merged SHA). The build step therefore holds twice on the PM: once for "merge examples PR", once at the end (merge/release are the PM's anyway). The manager mails the PM when the examples PR is green on its exact head.
- Release note for the PM (goes in the CLI PR body): "`ai init` now installs the functions skill (`solidactions-functions`); run `solidactions ai init` again in existing projects to refresh. Agents are now told to try an app with `solidactions app preview` before calling a change done." The installed-skills version stamp is `EXAMPLES_REF` (`src/utils/skills.ts:7` `export const BUNDLED_SKILLS_VERSION = EXAMPLES_REF;`), so the repin alone makes every existing install report stale and the CLI's existing freshness nudge tells people to refresh.

## Frozen contract (every task quotes this; it changes only by a STOP comment on every open card)

- Skill name: `solidactions-functions`. Examples path: `content/skills/solidactions-functions.md`. Front matter, exactly the shape of the other skills (`---`, `name: solidactions-functions`, `description: <one sentence>`, `renderers: [skills]`, `---`), checked by `scripts/check-docs.mjs` (`skill.startsWith("---\nname: ${skillName}\ndescription:")`).
- The five existing skill names keep their order; the new one is last: `solidactions-getting-started`, `solidactions-workflow-coding`, `solidactions-deploy-and-config`, `solidactions-oauth-actions`, `solidactions-crew-skills`, `solidactions-functions`.
- Example folder name: `function-echo`. Project name in its yaml: `function-echo`. Function id: `echo`. Function file: `functions/echo.ts`.
- Pointer one-liner used in `CLAUDE.md`, `AGENTS.md` and `CLAUDE-skills-pointer.md` (examples repo): ``- `solidactions-functions` — fast functions: one-file webhook, app-page button and MCP tool handlers; when to pick a function over a workflow``
- Preview rule text (Task 2 owns it in `solidactions-getting-started`; Task 1 only points at it, never repeats the command span): the span `solidactions app preview <app> [--page <id>]` appears in exactly one file, `content/skills/solidactions-getting-started.md`, so the allowlist (Task 2) has one entry per distinct span there.
- Public route: `/docs/functions/`. Nav label: `Functions`. Docs contract: the skill is added to `skills` in `site/docs-contract.json`; no `features` entry is added (the contract check, `site/scripts/check-docs-contract.mjs` lines 112-125, fails any feature route whose page lacks `<ProblemExamples`, and `problemExamples` in `site/src/data/problem-examples` has no functions key; adding one is out of scope and the ask does not need it).
- Interface between Task 4 and Task 5: Task 4 changes only `SOLIDACTIONS_SKILL_NAMES` and its pins; Task 5 changes only `EXAMPLES_REF` and the pins on it. Both end in the same CLI branch and are pushed once.

---

## Task graph

| Task | Repo | Issue | Depends on |
|---|---|---|---|
| 1 | examples | cli#249 | none |
| 2 | examples | cli#249 | none (no shared path with Task 1) |
| 3 | marketing | cli#249 (wave card piece 1) | none |
| 4 | cli (slot) | cli#249 | none |
| 5 | cli (slot) | cli#249 | Tasks 1 and 2 committed, pushed and MERGED by the PM; Task 4 committed |

Tasks 1-4 run in parallel (four cards, disjoint paths, three different checkouts, so no path is shared even across cards). The Review Focus rows name their owning task.

Satellite checkout paths: the card names the absolute path. PM ruling requested before dispatch (see the plan-close mail): a fresh `git clone` of each satellite repo at `/home/mercer/projects/solid/__wave-cli-a/<repo>`, branch `wave/2026-11-15-cli-functions-docs` cut from `origin/main`, owned by this wave and removed by the PM afterwards. Until the PM answers no developer card is created for Tasks 1-3.

---

### Task 1: functions skill, example, skill lists (examples repo, cli#249)

**Files (file scope — the only paths this task may touch), all in the examples checkout:**
- Create: `content/skills/solidactions-functions.md`
- Create: `function-echo/solidactions.yaml`
- Create: `function-echo/functions/echo.ts`
- Create: `function-echo/README.md`
- Modify: `CLAUDE.md` (the skill bullet list at the top)
- Modify: `AGENTS.md` (same list)
- Modify: `CLAUDE-skills-pointer.md` (same list)
- Modify: `scripts/check-docs.mjs` (`skillNames` array, add the sixth name; add `'function-echo/README.md'` and `content/skills/solidactions-functions.md` is already covered by `skillNames.map`; add one assertion block, below)
- Modify: `README.md` (one row in the Projects table for `function-echo/`)

Grep pasted at plan time (every file naming the skill list): `grep -rn "solidactions-crew-skills" --exclude-dir=.git --exclude-dir=.clavix --exclude-dir=docs .` lists `AGENTS.md:7`, `CLAUDE-skills-pointer.md:7`, `scripts/check-docs.mjs:12`, `content/skills/solidactions-crew-skills.md:2`, and two comments in `tests/content/command-validator.test.mjs` (lines 111 and 514, comments only; not touched). `scripts/check-docs.mjs` `projectDirs` (line 14) is NOT extended: it asserts `package.json` and `package-lock.json` with Node 24 and the SDK line, and `function-echo` has no package.json by design (the CLI requires one only when `workflows:` is present, `src/commands/deploy.ts` `validateProject`, `hasFunctions` branch at line 79). `.github/workflows/docs-check.yml` `examples` matrix lists projects that build; `function-echo` is not added for the same reason.

**Interfaces:**
- Consumes: the frozen contract above; the guide topic text (source of every fact).
- Produces: the skill name and path Task 3 (`site/docs-contract.json`) and Task 4/5 (CLI) pin; the `function-echo` folder `ai examples` lists.

**Content requirements, `content/skills/solidactions-functions.md`** (same layout as the other five: front matter, `## Hard Rules`, then recipes; `solidactions-oauth-actions.md` lines 1-14 are the model; target 120-200 lines):
- Front matter `description`: "Use when the user wants a quick HTTP answer, a webhook receiver, a button handler on an app page or an AI-callable tool and the job is small enough for one file; OR when they reference a `functions:` list in `solidactions.yaml`. Encodes the function-versus-workflow decision, the handler shape, the yaml fields, and the deploy and error codes."
- Hard Rules (each with a `*Why: ...*` clause, as in the other skills), in this order:
  1. The decision rule first: use a function for a quick answer (about a second, no Docker image, no run); use a workflow for long, durable, many-step jobs, retries, sleeping or waiting. "Never write a workflow for a one-file quick answer." The exact sentence must appear: `Use a function for a quick answer; use a workflow for a long, durable, many-step job.`
  2. One file, no imports, TypeScript is stripped, at most 256 KB; handler shape `export default { async fetch(request, env) { ... } }`.
  3. Limits per call: 5 s of CPU, 50 outbound requests, the function's own `timeout` (1 to 30 seconds, default 10).
  4. A function acts as the project, never as a person; `SA_VIEWER_ID` and friends are data, never authority.
  5. Functions are stack-wide on or off: a deploy that reports `functions_disabled` is an operator switch, not a bug in the code.
  6. A page button may call only a function its page grant lists. The grant is captured when the page is published or saved, and a function goes into it only when the person publishing can build the project (edit access to Automate on it): a publisher with only Use-level access grants no functions, each name is refused as `capability_missing`, and the page answers `not_granted` when it calls one. So: publish the page again after the function gets its first live version, and if the button still answers `not_granted`, ask a person who can build the project to publish it (republishing as the same Use-level person never helps). Source: guide topic "The page grant rule" (`WorkflowsGuideTool.php`, app `origin/main`).
- Recipes: (a) the `functions:` entry with every field of `FunctionCodeEntry` (CLI `src/utils/env.ts`, read at plan time: `id`, `name`, `file`, `description`, `webhook`, `webhook_auth`, `mcp`, `mcp_tool_name`, `timeout`, `confirm`, `input_schema`; `owner` is implicit in a code entry and the guide documents no yaml `owner` key, so the skill does not write it); for `webhook_auth` the skill lists what the guide text lists (`hmac` default, `header`, `none`), not `basic`, which the CLI type allows but the guide does not document; (b) the handler with `env` (`env.sa.workflows.start/result`, `env.sa.fetch`, `env.sa.database`, project variables); (c) deploy and what the CLI prints: `solidactions project deploy <project> <path> -e production` (the path is written out, as the examples' own rules do at getting-started:11 and deploy-and-config:18; omitted, it deploys the current directory) prints `function <id>: live <url>` (format at `src/utils/functions-sync.ts` `formatFunctionsSummary`: `function ${row.id}: ${row.status}${webhook_url ? ' ' + webhook_url : ''}` with status `live`, `unchanged` or `error`); (d) the three doors (webhook, app page `sa.action('<slug>', params)`, MCP `functions_manage` `invoke`); (e) the error codes the agent meets: `not_granted` and `capability_missing` (the page grant, Hard Rule 6), `owned_by_editor` (CLI deploy of a slug the editor made), `owned_by_code`, `compile_failed`, `version_cap_reached`, `functions_disabled`, `slug_taken`, `too_many_functions`; (f) where the secret is: `solidactions webhook list <project> --show-secrets` (a function is a row of kind `function`).
- The skill ends with one line: "Before calling an app change done, follow the preview rule in the `solidactions-getting-started` skill." It carries no `solidactions app preview` span (frozen contract).
- Every `solidactions ...` code span in the file must pass `node scripts/check-content.mjs` against the pinned v3.6.0 manifest. `solidactions project deploy` and `solidactions webhook list` exist at v3.6.0 (`webhook` is in `content/command-manifest.json`; `project deploy` is used by `hello-world/README.md`). Run the validator, fix any finding by rewording the span, never by allowlisting (only Task 2 touches the allowlist; a finding that cannot be reworded is a STOP).

**Content, `function-echo/`** (exact text, the sample the proposal names, `fn-smoke`-style):

`function-echo/solidactions.yaml`:
```yaml
project: function-echo

functions:
  - id: echo
    name: Echo
    file: functions/echo.ts
    description: Answers with the JSON it was sent.
    webhook: true
    webhook_auth: hmac
    timeout: 10
```

`function-echo/functions/echo.ts`:
```typescript
export default {
  async fetch(request, env) {
    const input = await request.json().catch(() => ({}));
    return Response.json({ ok: true, echo: input });
  },
};
```

`function-echo/README.md`: title, one paragraph ("A fast function: one file that answers an HTTP call in about a second, with no workflow run."), `## Deploy` (`solidactions project deploy function-echo ./function-echo -e production`, run from the folder `solidactions ai examples function-echo` wrote it into; the CLI prints `function echo: live <url>`), `## Call it` (the signed webhook call, pointing to `solidactions webhook list function-echo --show-secrets` for the URL and secret), `## When to use a function` (two lines and a pointer to the `solidactions-functions` skill). Every `solidactions` span must validate against the v3.6.0 manifest (same rule as above).

**`scripts/check-docs.mjs` addition** (after the skill-front-matter loop): assert the decision rule and the example exist:

```js
const functionsSkill = await readFile(path.join(root, 'content/skills/solidactions-functions.md'), 'utf8');
assert(functionsSkill.includes('Use a function for a quick answer; use a workflow for a long, durable, many-step job.'), 'solidactions-functions must open with the function-versus-workflow rule');
const echoYaml = await readFile(path.join(root, 'function-echo/solidactions.yaml'), 'utf8');
assert(/^functions:\n  - id: echo$/m.test(echoYaml), 'function-echo must declare the echo function');
await readFile(path.join(root, 'function-echo/functions/echo.ts'), 'utf8');
```

- [ ] **Step 1: Write the files** as above. Read the guide topic text first (command above) and quote every limit from it.
- [ ] **Step 2: Static checks (no tests).** In the examples checkout: `node scripts/check-docs.mjs` and `node scripts/check-content.mjs`; both must print OK / exit 0. Expected-RED table: none (docs; no test code is added; the only assertion code is the `check-docs.mjs` addition, which fails on the base because the file does not exist).
- [ ] **Step 3: Size check.** `git diff --stat -- <paths>` plus `wc -l` of the new files; under 1000 lines (expected about 300).
- [ ] **Step 4: Report (do not commit).** List every changed path, test paths and source paths separately (tests: `scripts/check-docs.mjs`; the rest are content).

---

### Task 2: functions pointer, preview rule, allowlist (examples repo, cli#249)

**Files (file scope, examples checkout):**
- Modify: `content/skills/solidactions-getting-started.md` (`## Hard Rules` at line 7: add the preview rule; `## Platform Mental Model` at line 15: add the functions pointer paragraph)
- Modify: `content/skills/solidactions-deploy-and-config.md` (after `### Trigger types`, line 55-61: add the `functions:` block subsection before `### Webhook config options` at line 63)
- Modify: `content/validator-allowlist.json` (append entries for the new `app preview` spans only)

**Interfaces:**
- Consumes: the skill name `solidactions-functions` (frozen contract).
- Produces: the preview rule text Task 1 points at; the allowlist entries.

**Content requirements:**
- `solidactions-getting-started.md` Hard Rule (new, last in `## Hard Rules`, same bold-rule-plus-*Why* form as its neighbours): "**Before calling an app change done, deploy it to dev, ask for a preview link and try the app in your own browser.** Deploy the change to dev first (`solidactions project deploy <app> <path> -e dev`): the preview opens the dev copy, never production, and this skill's other rules default a new project to production. Then run `solidactions app preview <app> [--page <id>]` (or the MCP `projects_sandbox` action `preview_link`) and open the link it prints. *Why: a deploy that succeeds can still leave a page that does not load or a button that does nothing, and only opening the app shows it. The link works once, within 60 seconds; the session ends after 3 minutes idle or 10 minutes, so ask for a fresh link each time. The preview is the app's dev copy: a page call from a preview carries `SA_PREVIEW=1`, so a function must skip real side effects such as sending mail.*" The deploy-to-dev step is the CLI's own help text (`src/index.ts` lines 1092-1098 on this branch: "The link opens the app's dev copy only, never production … Deploy to dev first: solidactions project deploy <app> . -e dev"; the developer reads the lines and keeps the plan's `<path>` form because the examples' own rules write `<name> <path>`). The words "works once, within 60 seconds" and "3 minutes idle or 10 minutes" are copied from cli#247; `SA_PREVIEW=1` is copied from the guide topic's "The three doors" paragraph; the MCP action name `preview_link` and tool `projects_sandbox` are from the CLI plan `docs/superpowers/plans/2026-11-15-cli-agent-preview.md` (Global Constraints, server contract lines).
- `solidactions-getting-started.md` Platform Mental Model paragraph (new): functions are the third kind of thing a project can hold beside workflows and pages; one sentence "Use a function for a quick answer; use a workflow for a long, durable, many-step job." and "See the `solidactions-functions` skill."
- `solidactions-deploy-and-config.md` new subsection `### Functions` after Trigger types: the `functions:` yaml block (the same shape as `function-echo/solidactions.yaml` in the frozen contract, no new fields), the deploy command written with its path (`solidactions project deploy <project> <path> -e production`, never `<project>` alone), the line that `file:` is the TypeScript source path, that a project may hold `functions:` with no `workflows:` (no `package.json` needed, `src/commands/deploy.ts` `validateProject`), the deploy output line `function <id>: live <url>`, and "See the `solidactions-functions` skill."
- Allowlist: run `node scripts/check-content.mjs` after the edits; every finding it prints for an `app preview` span becomes one entry `{"file": "content/skills/solidactions-getting-started.md", "span": "<the exact span text it printed>", "reason": "cli#249 documents app preview (CLI v3.36.0) while the pinned CLI v3.6.0 manifest predates the app command group."}` in the same key order as the existing entries. A finding for anything else is fixed by rewording, never allowlisted. The check must then exit 0 with no stale-entry report.

- [ ] **Step 1: Make the edits.**
- [ ] **Step 2: Static checks.** `node scripts/check-content.mjs` exits 0 (allowlist entries used, none stale) and `node scripts/check-docs.mjs` exits 0. Expected-RED table: none (content).
- [ ] **Step 3: Size check** (under 1000 lines; expected under 80).
- [ ] **Step 4: Report (do not commit).** Paths, with the exact allowlist spans listed in the report.

---

### Task 3: public Functions page, nav, cross-links, docs contract (marketing repo, cli#249 piece 1)

**Files (file scope, marketing checkout):**
- Create: `site/src/pages/docs/functions/index.astro`
- Modify: `site/src/components/DocsNav.astro` (Automate group: `{ href: '/docs/functions/', label: 'Functions' },` after the Projects line, line 20)
- Modify: `site/src/pages/docs/projects/index.astro` (one sentence: a project holds workflows, pages and functions, link to `/docs/functions/`)
- Modify: `site/src/pages/docs/triggers/webhooks/index.astro` (one sentence: a function can also answer a webhook, link)
- Modify: `site/src/pages/docs/dashboards/index.astro` (one sentence: a button may call a function, link)
- Modify: `site/src/pages/docs/connect-ai.astro` (a Functions bullet in "What this connection can do" and one line: a connection approved before Functions existed must be re-approved to see the tools; the page's existing line "Settings → MCP Connections" (`connect-ai.astro:94`) stays as it is unless the named-agents wave (app#2232, PR #2768) has merged and renamed the screen before dispatch, in which case the developer fixes that one line as a same-surface papercut; otherwise the manager files it against marketing at the end of build)
- Modify: `site/src/pages/docs/workflows.astro` (lines 78-94: "Five local skill files" becomes "Six", "The five installed skills are:" becomes "The six installed skills are:", add `<li><code>solidactions-functions</code></li>` after the crew-skills item at line 94)
- Modify: `site/src/consts.ts` (`DOCS_LAST_REVIEWED`, line 8, to `'November 15, 2026'`)
- Modify: `site/docs-contract.json` (add skill `{"name": "solidactions-functions", "path": "content/skills/solidactions-functions.md"}` last in `skills`, after `solidactions-crew-skills`; no `features` entry, see the frozen contract)
- Modify: `site/scripts/check-doc-routes.mjs` (`requiredRoutes`: add `'/docs/functions/'` after `'/docs/projects/'`)

Grep pasted at plan time: `git grep -n -i "five.*skill\|solidactions-crew-skills" origin/main -- site` lists `site/docs-contract.json` lines 77, 121, 404 (line 404 is a `sourceAssertions` entry for the crew skill: read it, it is not a list the new skill must join), `site/src/pages/docs/crews/index.astro:88` (prose, untouched), `site/src/pages/docs/workflows.astro:78,88,94`. Open marketing PRs #27 and #28 touch `site/docs-contract.json` and `site/scripts/check-doc-routes.mjs` (see Global Constraints for the merge handling).

**Interfaces:**
- Consumes: skill name and path (frozen contract); the guide topic text.
- Produces: route `/docs/functions/`.

**Content requirements, the page** (shape: `site/src/pages/docs/triggers/webhooks/index.astro`: `DocsLayout`, `<p class="eyebrow">Automate</p>`, `<h1>`, `docs-lede`, `docs-meta` "Last reviewed {DOCS_LAST_REVIEWED}", `docs-path` "In the app: Projects → project → Functions"; `ProblemExamples` is NOT used because `problemExamples` has no `functions` key and the data file is out of scope):
- `title="Functions"`, `path="/docs/functions/"`, a one-sentence `description`.
- What a function is (one TypeScript file with a `fetch` handler, answers in about a second, no Docker image, no run). When to use a function and when a workflow (a quick answer versus a long, durable, many-step job).
- Three ways to call one: a webhook URL, a button on an app page, an AI over MCP. Three ways to make one: a `functions:` list in `solidactions.yaml` plus the CLI deploy, the project's Functions tab, MCP.
- A limits table (one `<table class="docs-table">` if the site has that class, else the same markup another docs page uses for tables: grep `<table` in `site/src/pages/docs/`): 5 s CPU; 50 outbound requests; timeout 1 to 30 s; 256 KB source; 50 functions per project; 300 calls a minute and 1,000,000 a month per workspace; new versions a day capped per workspace (say "a daily cap on new versions"; no number, see Global Constraints).
- Webhook auth choices (hmac default, header, none) and where the secret is (Webhooks tab, `solidactions webhook list <project> --show-secrets`).
- One full example: the yaml entry and the 10-line echo function (the `function-echo` pair from Task 1's frozen text).
- In the button-door paragraph: a button can call only a function its page grant lists; the grant is captured when the page is published, and only a person who can build the project (edit access to Automate) grants functions, so a page published by a person with Use-level access answers `not_granted` for them (the guide's page grant rule, quoted at plan time from `WorkflowsGuideTool.php`).
- A note that functions are on or off for the whole stack, and what `functions_disabled` means.
- No claim beyond the guide topic.

**Docs-contract edit.** Read `site/scripts/check-docs-contract.mjs` lines 112-215 first (quoted at plan time): every `features` route must contain `<ProblemExamples` (lines 120-125), `expectedSkillNames` is `contract.skills.map(name)` and must equal the CLI's `SOLIDACTIONS_SKILL_NAMES` in order (lines 129-176; the new skill goes last, matching the frozen contract), and every skill's `path` must exist in the examples checkout (lines 180-188). Add the `skills` entry only. If the check also demands that every skill be mapped by some feature (read lines 129-215 to see; nothing at plan time says it does), that is a STOP with the line quoted on the card, not a licence to add a feature entry.

- [ ] **Step 1: Make the edits.**
- [ ] **Step 2: Static checks (no tests).** In `site/`: `npm ci` is already done in the checkout; run `npm run build` and `npm run check:docs`; both must exit 0. `npm run check:contract` is NOT run here (it needs the CLI and examples checkouts; the manager proves it by a dispatched CI run). Expected-RED table: `check-doc-routes.mjs` with `'/docs/functions/'` in `requiredRoutes` fails on the base because `dist/docs/functions/index.html` does not exist.
- [ ] **Step 3: Size check** (under 1000 lines; expected about 350).
- [ ] **Step 4: Report (do not commit).** Paths; test paths (`site/scripts/check-doc-routes.mjs`, `site/docs-contract.json`) separately from page paths.

---

### Task 4: CLI installs the functions skill (cli slot, cli#249)

**Files (file scope, the wave slot `/home/mercer/projects/solid/solidactions-cli/__worktrees/wave-a`):**
- Modify: `src/utils/skills.ts` (`SOLIDACTIONS_SKILL_NAMES`, lines 10-16: add `'solidactions-functions',` last)
- Modify: `scripts/smoke-init.mjs` (`skillNames`, lines 54-60: same addition; read the rest of the file for other places the list or a count matters, `grep -n skillNames scripts/smoke-init.mjs`)
- Modify: `README.md` (lines 53 and 586 "five" becomes "six"; add `` - `solidactions-functions` `` to the list after line 60)
- Test: `tests/skills-manifest.test.ts` (the pinned array, lines 7-13: add the sixth name)

Grep pasted at plan time (`grep -rn "SOLIDACTIONS_SKILL_NAMES" src tests scripts`): `src/utils/skills.ts:10,50`, `tests/skills-manifest.test.ts:3,7`, `tests/readme-contract.test.ts:4,39` (iterates the list and asserts the README names each, so the README edit is required by that test). `grep -rn "solidactions-crew-skills" src tests scripts README.md`: `README.md:60`, `src/utils/skills.ts:15`, `tests/skills-manifest.test.ts:12`, `scripts/smoke-init.mjs:59`, and a comment in `src/utils/examples-ref.ts:17` (untouched: it is history). No caller or fake of a changed function: this task changes a constant list only.

**Push rule:** Task 4 is committed locally and NOT pushed until Task 5 is committed (see Merge order: smoke:init is red with six names at the old ref).

**Interfaces:**
- Consumes: skill name (frozen contract).
- Produces: nothing Task 5 reads; Task 5 changes the ref only.

- [ ] **Step 1: Update the test first.** In `tests/skills-manifest.test.ts` add `'solidactions-functions',` after `'solidactions-crew-skills',`. Expected RED on the base: `expect(SOLIDACTIONS_SKILL_NAMES).toEqual([...])` fails because the constant has five entries (row: `tests/skills-manifest.test.ts` "pins every skill installed by init and ai init", assertion `toEqual`, fails on the base because the sixth name is absent).
- [ ] **Step 2: Add the name** to `src/utils/skills.ts` and `scripts/smoke-init.mjs`; update the README (the `readme-contract` row "documents every skill in the generated manifest" fails on the base after Step 1's constant change but before the README edit, which is why the README is in this task).
- [ ] **Step 3: Static checks.** `npx tsc --noEmit -p tsconfig.json`; `npx prettier --check` on the changed `.ts` files if the repo configures prettier (`grep -n prettier package.json`), `npx eslint` on changed `.ts` files. No test is run; no `npm run build` in a task.
- [ ] **Step 4: Report (do not commit).** Test path `tests/skills-manifest.test.ts`; source paths the rest.

---

### Task 5: repin `EXAMPLES_REF` to the merged examples commit (cli slot, cli#249)

**Depends on:** Tasks 1 and 2 committed on the examples branch, the examples PR green on its exact head and MERGED by the PM; Task 4 committed.

**Files (file scope, the wave slot):**
- Modify: `src/utils/examples-ref.ts` (the constant at line 36 and the "Currently:" paragraph of the doc comment, lines 31-35)
- Test: `tests/examples-ref.test.ts` (line 30: the pinned expectation; the test at lines 41-49 asserts the doc comment mentions `merged solidactions-examples mainline`, `workspace-database-drizzle`, `mainline SHA`, "on every CLI release" and "release ritual": keep every one of those strings in the comment)

Grep at plan time: `grep -rn "47e887d" src tests scripts README.md` lists `src/utils/examples-ref.ts:36` and `tests/examples-ref.test.ts:30` only. `BUNDLED_SKILLS_VERSION = EXAMPLES_REF` (`src/utils/skills.ts:7`) follows with no edit.

**Interfaces:**
- Consumes: `<MERGED_SHA>`, the full 40-hex SHA of the examples repo `origin/main` after the PM merged the examples PR, delivered by the manager in the card text (the manager reads it with `git -C <examples clone> fetch origin && git -C <examples clone> rev-parse origin/main` and proves it contains the new files).
- Produces: the pin the release ritual verifies.

- [ ] **Step 1: Manager precondition (not the developer's).** Before the card exists: `gh api repos/SolidActions/solidactions-examples/contents/content/skills/solidactions-functions.md?ref=<MERGED_SHA> --jq .name` prints `solidactions-functions.md`; `gh api repos/SolidActions/solidactions-examples/contents/function-echo?ref=<MERGED_SHA> --jq '.[].name'` lists `README.md`, `functions`, `solidactions.yaml`; `git -C <examples clone> merge-base --is-ancestor <MERGED_SHA> origin/main` exits 0 (the SHA is on mainline, not an orphan branch commit); `gh api repos/SolidActions/solidactions-examples/contents/content/skills/solidactions-getting-started.md?ref=<MERGED_SHA>` carries `solidactions app preview` (grep the decoded body). Review Focus rows 1 and 2.
- [ ] **Step 2: Update the test first.** `tests/examples-ref.test.ts` line 30: `expect(EXAMPLES_REF).toBe('<MERGED_SHA>');` and the test title `'pins the merged examples mainline for CLI v3.8.0 ...'` becomes `'pins the merged examples mainline that carries the functions skill (cli#249, repinned per the #1146 release contract)'`. Expected RED on the base: `toBe('<MERGED_SHA>')` fails because the constant is still `47e887d348b45ab948c904a29c1354cbbc23cdab`.
- [ ] **Step 3: Repin.** `src/utils/examples-ref.ts`: the constant, and the "Currently:" paragraph now says the pin is the merged solidactions-examples mainline that includes the functions skill (`content/skills/solidactions-functions.md`), the `function-echo` example and the preview rule (cli#249), keeping every string the test at lines 41-49 greps for.
- [ ] **Step 4: Static checks.** `npx tsc --noEmit -p tsconfig.json`; eslint on `src/utils/examples-ref.ts`. No test run, no build.
- [ ] **Step 5: Report (do not commit).** Test path `tests/examples-ref.test.ts`, source path `src/utils/examples-ref.ts`.

---

## Verify (the manager, after the final APPROVE)

1. Slot clean, `HEAD == head_sha`. `npm run build` (allowed). Runner-a preflight and memory check as their own step, then `scripts/local-dev up` in the free slot the PM names (only if the deploy leg is run).
2. Live smoke, CLI built from the branch, saved to the SDD workspace: `solidactions ai init --claude` in an empty temp folder writes six `solidactions-*.md` files under `.claude/skills/`, the new one non-empty and starting with `---\nname: solidactions-functions`; `grep -c "solidactions app preview" .claude/skills/solidactions-getting-started.md` prints at least 1; `solidactions ai examples` lists `function-echo`; `solidactions ai examples function-echo` writes the three files; with a login on the free slot's stack and functions on: `solidactions project deploy function-echo ./function-echo -e dev` prints `function echo: live <url>` and the `curl` call answers `{"ok":true,"echo":{...}}`. `smoke` is `passed: <what ran>`; the deploy leg may be `not run: stack has functions off` and says so.
3. Cleanroom (qa, empty folder, the same free slot's stack, `creds-2026-11-15-cli-functions-docs`): goal-only prompts: (a) "You have a new empty folder and a SolidActions login. Set up the project's AI helper files, then build something that answers a webhook call with the JSON it was sent, in the quickest way the platform allows, and prove it answers." (the pass condition: the agent picks a function, not a workflow); (b) "You changed an app page. Show that the change works as a person would see it." (pass: the agent deploys to dev and asks for a preview link before saying done; fail: it deploys to production, or says done without opening the app). The qa result's first line decides as the role says.
4. Public page: after the PM merges marketing, open `https://www.solidactions.com/docs/functions/` once (record the status code); not a gate for the CLI PR.

## Incidents and rulings carried into the build

- Ruling (plan): marketing, not solidactions-site (Global Constraints). Ruling (plan): allowlist, no manifest bump (Global Constraints). Both go in the build result's "Rulings I made".
- Digest and filing: at the end of build, file the examples follow-up (bump the pinned CLI manifest to a current release and drop the `app preview` allowlist entries) as a GitHub issue in the CLI repo (`gh issue create --repo SolidActions/solidactions-cli`, label per the PM's instruction; the examples repo has issues disabled) and put its number in each issue's `deferred` answer.

## Continue here

(Written at the context wall or a stop; empty at plan commit.)

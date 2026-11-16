# CLI agent docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sa-subagent-driven-development to implement this plan task-by-task (the wave's build step). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An AI building through the CLI, and a person reading the public docs, can learn the function extras, source of truth, app pages and platform error codes that recent releases added; a project's `solidactions.yaml` can set a function's confirm text; the CLI pins the examples commit that carries the new skill text.

**Architecture:** Three repos, three PRs, one wave (same mechanics as wave cli-functions-docs, `docs/superpowers/plans/2026-11-15-cli-functions-docs.md`). (A) `solidactions-examples`: bump the pinned CLI command manifest to v3.37.0 and drop the stale allowlist entries (cli#251), then edit the functions skill, the getting-started skill and the deploy-and-config skill. (B) `solidactions-cli` (the wave slot, the wave's own PR): the functions sync sends `confirm_text` from `solidactions.yaml`, then `EXAMPLES_REF` is repinned to the merged examples commit. (C) `solidactions-marketing` (`site/` is the public docs): five existing pages gain the missing sections. No server behaviour changes anywhere; the app half of the parent wave (guide and tool descriptions) is a separate wave in an app slot.

**Tech Stack:** Markdown skill files, Node ESM validators (examples), TypeScript + vitest (CLI), Astro (marketing site).

**Spec:** No spec file. The design is the audit comment on `task-auditdoagents-4f85` (gaps 1, 2, 3, 5, 6, 7 as ranked there; gaps 3 and 4 name the app's guide and manifest and are the app half), the approval ask `task-starttheagent-aed8` and the wave card `task-wavecliagentdocs-60d9` (pieces 1-3). Source text for every fact: the app guide `app/Mcp/Tools/WorkflowsGuideTool.php` on app `origin/main` (read at plan time at `f56c1e596`; developers read it with `git -C /home/mercer/projects/solid/solidactions-app show origin/main:app/Mcp/Tools/WorkflowsGuideTool.php`, read only, never touch that checkout), and the other app files each task names.

**Issues:** `cli#254` ("confirm_text from solidactions.yaml", filed by the PM after plan-close, mail 12ae56cc, 2026-11-16T03:50Z; Task 4), `cli#251` ("examples: bump pinned CLI manifest, drop app preview allowlist, two skill wording fixes (from cli#249)") and `cli#253` ("examples skills: app page guidance and a no-dev path for the preview rule (from cli#249 cleanroom)"), both sanctioned by Peter's go on approval ask `task-starttheagent-aed8` ("Go, size normal", 2026-11-16T03:44Z). The wave card is `task-wavecliagentdocs-60d9`; the plan card is `task-plancliagentdocs-d421`. The wave's pieces (1) examples skills, (2) CLI `confirm_text` and repin and (3) public docs come from the wave card description; pieces (2, first half) and (3) have no GitHub issue of their own (see Rulings).

## Global Constraints

- Binding scope, verbatim from cli#251 body (no PM comment; one found-at-verify comment by the issue's filer, quoted below): "1. Bump the manifest pin to a current CLI release. Tried in a scratch clone against 3.36.0: `node scripts/check-content.mjs` then fails on 14 stale `content/validator-allowlist.json` entries, and `content/placeholder-contract.json` `guidance_cli_version` ("3.6") is baked into frozen goldens (`tests/golden/app/cloud/deploy.txt`, `full.txt`, `self-hosted/*`), so the goldens need review. 2. Drop the `app preview` allowlist entries and the 14 stale ones. 3. Two wording fixes … `content/skills/solidactions-functions.md`: "There is no yaml `owner` key" is false of the CLI (`owner: 'code'` is accepted on a code entry and `owner: 'editor'` is a pointer entry; `src/utils/env.ts` `FunctionCodeEntry`/`FunctionPointerEntry`, skipped by `listCodeFunctions` in `src/utils/functions-sync.ts`). Reword to "A code entry needs no `owner` key: the file is the owner" … `content/skills/solidactions-deploy-and-config.md`, Functions subsection: "The deploy prints `function <id>: live <url>`" is only the case for a new or changed function with `webhook: true`; a redeploy prints `unchanged` and a function without a webhook prints no URL (`formatFunctionsSummary`, `src/utils/functions-sync.ts`). Say so. 4. Optional: the `solidactions app preview` Hard Rule works from CLI v3.36.0; an older CLI answers "unknown command". Consider saying "CLI 3.36 or newer"."
- Binding scope, verbatim from cli#251's comment (that0n3guy, 2026-11-16T00:56:59Z, https://github.com/SolidActions/solidactions-cli/issues/251#issuecomment-6904363004): "`function-echo/README.md` says … deploys with `./function-echo` … Fix in the README: say the example lands in `.solidactions/examples/function-echo/`, and deploy with `solidactions project deploy function-echo ./.solidactions/examples/function-echo -e dev` … Check `content/skills/solidactions-functions.md` and `solidactions-deploy-and-config.md` for the same `./function-echo` form." **State at plan time:** examples `main` (`0dd65ba`, "fix(function-echo): deploy from the folder ai examples installs to (cli#249) (#36)") already carries the README fix (its Deploy section names `.solidactions/examples/function-echo/`). Task 2 and Task 3 each grep their skill for `./function-echo` and fix any hit; if none, they report "none found". No `function-echo/` path is in any task's scope.
- Binding scope, verbatim from cli#253 body: "1. App page guidance. … Add a short app-page section to the examples skills (likely `solidactions-deploy-and-config.md`, or a new skill), then repin `EXAMPLES_REF`. 2. Preview rule when dev is refused. `content/skills/solidactions-getting-started.md` says "Deploy the change to dev first ... never production" but has no instruction for a workspace whose plan has no dev copy (`project deploy <app> -e dev --create` answers "Staging and dev environments require a Pro or Scale plan."). … Say: if the dev deploy is refused, stop and ask the person before any production deploy. 3. Related (verify note): … worth a skills-discoverability look (CLAUDE.md pointer) when item 1 is done. Bundle with cli#251 (the examples follow-up) in one examples PR plus repin."
- Binding scope, verbatim from the wave card `task-wavecliagentdocs-60d9` (description): "(1) examples: solidactions-functions.md gets env.sa.workflows.start(slug, input, {after:true}) with its trade-off, batch(statements), sql_error 'statement N', confirm_text; deploy-and-config skill gets source of truth / --override-source-of-truth; (2) CLI: functions-sync.ts sends confirm_text from solidactions.yaml (app sync already accepts it), repin EXAMPLES_REF, release; (3) marketing site/: projects page (preview link, source of truth), functions page (after, batch, confirm_text), dashboards page ('Make this an app'), troubleshooting (sandbox_start_timeout, sandbox_capacity, image_not_ready, platform_error; never-started runs retry after 10/30/90 s; wait-mode caller should not resubmit), connect-ai (naming agents, reusing a name, 'Reconnect to add them'). Fold small items of cli#251/cli#253. Same mechanics as cli-functions-docs: clones under /home/mercer/projects/solid/__wave-cli-a/, merge order examples -> CLI -> marketing. Facts must match the app guide (WorkflowsGuideTool.php) on main."
- Binding scope, from the approval ask `task-starttheagent-aed8` (chief; Peter: "Go, size normal"): "One real gap: confirm text can't be set from a project's settings file through the command line, only in the app or by an agent. Command-line half (starts now, that slot is free): agent instructions and public docs, plus confirm text from the settings file. App half (next free app slot): the agent guide and tool descriptions." The app half is NOT this wave.
- Release facts (checked at plan time with `gh release list`): the latest CLI release is **v3.37.0** (2026-11-16T03:08Z); v3.36.0 carries `solidactions app preview`. The `confirm_text` yaml key ships in the NEXT release, expected **v3.38.0** (a new feature is a minor bump; the version is the PM's, a GitHub release tag, `package.json` is not the source of truth, README lines 674-685). Every sentence in the examples and marketing text that names a version for `confirm_text` says "CLI 3.38 or newer". See Rulings.
- Server facts the CLI task relies on (read at plan time, app `origin/main` `f56c1e596`): `app/Http/Requests/FastFunctionSyncRequest.php` rules `'functions.*.confirm_text' => ['nullable', 'string', 'max:255']`; `app/Domains/FastFunctions/Services/FunctionFields.php` `fromYaml`: `'confirm_text' => self::blankToNull($input['confirm_text'] ?? null)` (so a code function whose yaml has no `confirm_text`, or a blank one, has it cleared on every deploy: the file is the owner). Guide, "Confirm": "A function can set its own confirm text, at most 255 characters, in the editor or in `functions_manage` (`confirm_text`; null or empty clears it): the dialog shows it above the standard line, and only while `confirm` is true."
- Copy rules (every examples and marketing task): plain words, short sentences; no em dashes; every number, limit and code is copied from a source this plan names; a claim no source line supports is left out and named in the report. Skill files keep their existing form: bold rule, then an italic `*Why: ...*` clause.
- Static checks allowed (they run no test): in the examples checkout `node scripts/check-docs.mjs` and `node scripts/check-content.mjs`; in the marketing checkout `npm run build` and `npm run check:docs` inside `site/`; in the CLI slot `npx tsc --noEmit` (and `npm run build`). Never `node --test`, vitest, `npm test`, `npm run check:contract` against another repo, or any suite: CI runs those (Speed rules, mail f2a85e24).
- The CLI repo takes no `package.json` change (version bump and release are the PM's) and no new dependency.
- Open PRs touching the same files (`gh pr list --state open --json number,files` at plan time, 2026-11-15): cli: none. examples: #6 `security/override-koa-yaml` (touches `features-examples/`, `google-calendar-sync/`, `hello-world/` package files only; no overlap). marketing: #28 (`site/scripts/check-doc-routes.mjs`, `site/src/pages/docs/analytical-databases/index.astro`), #27 (`site/docs-contract.json`, the same page), #21 blog (`site/astro.config.mjs`, `site/src/content.config.ts`, blog files), #2 and #1 (root files). No task here edits those paths: no merge-order dependency. Greps of callers and fakes pasted into Task 4 and Task 2.
- No tests run on this box. The CLI's tests (`tests/functions-sync.test.ts`, `tests/validate-items.test.ts`, `tests/examples-ref.test.ts`, `tests/skills-manifest.test.ts`) run in `check.yml` on the pushed head; the examples and marketing checks run in their own GitHub workflows on their PRs (examples `docs-check.yml`: `check-docs.mjs`, `node --test 'tests/**/*.test.mjs'`, `check-content.mjs`).

Secret-bearing host paths this plan's code reads: none.

Verify data: the CLI smoke and cleanroom run the CLI built from this branch (`npm run build`, then `node dist/index.js` as the repo's `bin` does) against a free app slot's stack (`sa-dev-<slot>`, no live wave holds it, its head contains app `f56c1e596` or later; the PM names the slot at verify). Needs: (1) fast functions switched on in that stack; if off, a deploy reports `functions_disabled`, which the smoke records as "deploy not run: stack has functions off" and the validation and payload checks below still run; (2) a scratch project `fn-confirm-<wave>` holding `solidactions.yaml` with one function `ask` (`file: functions/ask.ts`, `confirm: true`, `confirm_text: "Send the weekly report to everyone?"`) and a second function `plain` with no `confirm_text`, deployed with `solidactions project deploy fn-confirm-<wave> <path> -e dev`; read the stored value back with the MCP `functions_read` `get` (it answers `confirm_text`, `FunctionsCrud.php:300`) or the app's Functions tab; redeploy with the key deleted and read it empty; deploy once with a 256-character `confirm_text` and see the CLI refuse it before any upload; (3) the `ai init` smoke needs network to `raw.githubusercontent.com` and the repinned examples commit merged (the pre-merge fetch override is not available, so the `ai init` goals run after the examples PR merges); (4) login via the `creds-<wave>` file as usual.

## Review Focus

1. A repin to a SHA that is a PR branch commit and not the merged mainline commit (squash merges change the SHA): the pin then points at an orphan commit that GitHub can garbage-collect. Task 5 Step 1 proves it with `git merge-base --is-ancestor <sha> origin/main` in the examples clone (Task 5).
2. A skill says `confirm_text` works in `solidactions.yaml` while the CLI an agent has still ignores the key silently (`listCodeFunctions` rebuilds each entry field by field, so an unknown yaml key is dropped without a word, `src/utils/functions-sync.ts` lines 22-39 at plan time). The skill text names "CLI 3.38 or newer" and says an older CLI ignores the key; the CLI repin in the same release makes `ai init` the only way the text reaches a user, and it ships with the CLI that sends the key (Task 2, Task 4).
3. A `confirm_text` the server would refuse (over 255 characters, or not a string) fails the whole functions sync with a 422 after the other work was done. The CLI refuses it before any upload, with a message naming the function and the limit, counting characters as the server does (Task 4 tests).
4. A manifest bump that makes `check-content.mjs` pass by allowlisting new spans, or by leaving the goldens stale, hides the very drift the bump is for. The bump removes every stale entry, adds none, and `tests/content/contract.test.mjs` plus the goldens are reviewed against the new `guidance_cli_version` (Task 1).
5. An agent that reads the preview rule on an account with no dev copy and deploys to production anyway (cli#253 item 2): the rule's new sentence is a Hard Rule sentence, checked by `scripts/check-docs.mjs` (Task 2).
6. An agent asked for "a small page that shows a greeting" finds no `pages:` block in any skill and reads compiled source (cli#253 item 1): the deploy-and-config skill gets a Pages subsection naming the four keys and both file kinds, proved by the reviewer's grep and `check-content.mjs` (Task 3).
7. A public page that states a retry or a limit no source line supports. "wait-mode caller should not resubmit" (wave card, troubleshooting) has no source in the app at plan time (`git grep -n -i "resubmit" origin/main -- app docs/decisions.md` finds only an unrelated dashboards sentence and a docs merge message): Task 6 leaves it out and reports it.

---

## Rulings (plan)

- **PM rulings after plan-close (mail 12ae56cc, chief, 2026-11-16T03:50Z, binding):** (a) clones OK; (b) the release is v3.38.0, so "CLI 3.38 or newer" stands; (c) cli#254 was filed for `confirm_text` from yaml: add it to the wave's issues in the PR body (the metadata `issues` carries `cli#254`); (d) the troubleshooting source exists, app release v0.285.0 notes (#2697): "A wait-mode caller with a short timeout may see a timeout while the retries run (up to about 2 minutes); it should not resubmit." and "re-queues itself after 10 s, 30 s and 90 s"; a missing image is not retried. Task 6 uses those words; (e) the v3.37.0 pin is right; (f) Peter ruled dashboards go away, so the "Make this an app" section is DROPPED: Task 7 no longer touches `site/src/pages/docs/dashboards/index.astro`. These override any older line in this plan (Review Focus 7, the Task 6 "omit" instruction, the Task 7 dashboards text, the earlier ruling "wait-mode caller should not resubmit is omitted").

- **Ruling: repo split and merge order (wave card).** Clones live at `/home/mercer/projects/solid/__wave-cli-a/solidactions-examples` and `/home/mercer/projects/solid/__wave-cli-a/solidactions-marketing`, branch `wave/2026-11-15-cli-agent-docs` cut from `origin/main` (examples `0dd65ba`, marketing `2155b6f`); the wave card text names this location, so the plan-time clones are the build-time clones. Developers never push and have no GitHub auth; the manager pushes each satellite branch and opens its PR, confirms head and registered checks, and records PR numbers on the wave card. Satellite commits are the manager's, by explicit paths (`git -C <clone> add -- <paths>` then `git -C <clone> commit -m ... -- <paths>`). The PM removes the clones after release. Cost if wrong: the PM names another location before dispatch.
- **Ruling: manifest pin goes to v3.37.0 (the latest release), not v3.36.0 (the issue tried 3.36.0).** v3.37.0 is released and is what an agent on a fresh install will have; the validator then agrees with what `ai init` users run. Cost if wrong: Task 1 repeats with another tag; no other task depends on the number.
- **Ruling: Task 1 runs first and Tasks 2 and 3 wait for it to be committed.** The validator `check-content.mjs` flags every `solidactions ...` span the pinned manifest lacks (`--override-source-of-truth` is new since v3.6.0), so Tasks 2 and 3 can only prove their text against the NEW manifest. Cost if wrong: Tasks 2 and 3 would have to allowlist spans and Task 1 remove them again.
- **Ruling: no new GitHub issue for the CLI `confirm_text` change and the marketing pages.** The wave card and the approval ask are the sanction; cli#251/cli#253 are the only issues the `ci` step can close, so the `Closes` block lists those two. The PM may want a cli issue for `confirm_text`: said in the plan-close mail. Cost if wrong: one `gh issue create` by the PM before verify; no code change.
- **Ruling: version words.** `confirm_text` is stated as "CLI 3.38 or newer" (the release after v3.37.0), `app preview` as "CLI 3.36 or newer" (cli#251 item 4, v3.36.0 verified with `gh release list`). Cost if wrong: the release is numbered differently; one wording edit in the examples and marketing text at the PM's release (the PM is asked in the plan-close mail to confirm 3.38.0).
- **Ruling: `basic` webhook auth stays out of the text.** The CLI type allows `webhook_auth: 'basic'` (`src/utils/env.ts` line 23) but the server refuses it (`FastFunctionSyncRequest.php`: `'in:hmac,header,none'`); the skills keep listing `hmac`, `header`, `none` only, as the guide does. Not changed here. Cost if wrong: none.
- **Ruling: the `functions` skill cites the guide's own sentences.** For `after`, `batch` and `confirm_text` the skill and the marketing page copy the guide's facts (quoted below under Frozen contract) in the skill's own tone; they never paraphrase a limit.
- **Ruling: "wait-mode caller should not resubmit" is omitted** (Review Focus 7). Cost if wrong: the PM names the source; one sentence is added to the troubleshooting page.

## Merge order and repo mechanics (frozen)

- **No push and no draft PR of the CLI branch before Task 5 is committed (as in wave cli-functions-docs).** The CLI's `release-candidate` job runs `check:release`, which runs `smoke:init`; `smoke:init` reads `EXAMPLES_REF` and requires each skill name at that ref (`scripts/smoke-init.mjs` lines 52-60). Task 4 alone does not change `EXAMPLES_REF`, so a push of Task 4 would be green; the mid-build push is still held to Task 5 so the PR opens once. The one sanctioned mid-build push (context wall) states what is not committed.
- Order the PM merges (the PM merges; the manager never does): (1) examples PR (Tasks 1, 2, 3); (2) the manager runs Task 5 (repin to the merged SHA), final review, CLI PR; the PM merges the CLI PR and releases (expected v3.38.0); (3) marketing PR (Tasks 6 and 7) last, so the public text says "CLI 3.38 or newer" only once that release exists. Before step 3 the manager dispatches the marketing checks against the wave refs the way wave cli-functions-docs did (`gh workflow run marketing-site-checks.yml --repo SolidActions/solidactions-marketing --ref wave/2026-11-15-cli-agent-docs -f cli_ref=<CLI main after merge> -f examples_ref=<merged examples sha>`) and has a green run in hand. This wave adds no skill name and no docs route, so `site/docs-contract.json` is not touched and the contract window of the last wave does not repeat.
- The CLI PR cannot be final-reviewed until the examples PR is merged (Task 5 needs the merged SHA). The build step holds twice on the PM: once for "merge examples PR", once at the end. The manager mails the PM when the examples PR is green on its exact head.
- Release note for the PM (goes in the CLI PR body): "`solidactions.yaml` functions now take `confirm_text` (at most 255 characters, shown only while `confirm: true`); the examples skills now cover function extras (`after`, `batch`, SQL errors, confirm text), source of truth, app pages and a no-dev preview fallback; the installed-skills stamp is `EXAMPLES_REF`, so existing installs report stale: run `solidactions ai init` again to refresh."
- Task graph:

| Task | Repo | Issue | Depends on |
|---|---|---|---|
| 1 | examples | cli#251 (items 1, 2) | none |
| 2 | examples | cli#251 (3a, 4), cli#253 (2), wave card piece 1 | Task 1 committed |
| 3 | examples | cli#251 (3b), cli#253 (1, 3), wave card piece 1 | Task 1 committed |
| 4 | cli (slot) | cli#254, wave card piece 2 | none |
| 5 | cli (slot) | cli#251, cli#253 (repin) | Tasks 1, 2, 3 committed, pushed and MERGED by the PM; Task 4 committed |
| 6 | marketing | wave card piece 3 | none |
| 7 | marketing | wave card piece 3 | none |

Tasks 1, 4, 6 and 7 run in parallel (four cards, four disjoint path sets in three checkouts); Tasks 2 and 3 run in parallel once Task 1 is committed. Task 2 and Task 3 share no path.

## Frozen contract (every task quotes the lines it needs verbatim; it changes only by a STOP comment on every open card)

- yaml key: `confirm_text`, a string on a code function entry beside `confirm`. At most 255 characters (counted as characters, not bytes). Shown only while `confirm: true`. A function with no `confirm_text`, or a blank one, has none: the deploy clears it (the file is the owner). Needs CLI 3.38 or newer; an older CLI ignores the key without a warning.
- CLI field name on the wire and in the TypeScript types: `confirm_text` (`CodeFunction.confirm_text?: string`, `FunctionCodeEntry.confirm_text?: string`).
- Validation message (Task 4 owns it, Task 2 and 6 may quote the limit only): `functions[<id>].confirm_text: confirm_text must be a string of at most 255 characters (got <what>).` where the entry label is `functions[<id>]` exactly as for the other fields in `src/utils/validate-items.ts`.
- Preview wording (Task 2 owns it): "CLI 3.36 or newer" next to the `solidactions app preview` span. The span `solidactions app preview <app> [--page <id>]` stays in exactly one file, `content/skills/solidactions-getting-started.md`.
- Source of truth facts (Task 3 and Task 6 quote these, verbatim from CLI `README.md` line 355 on this branch): "Every app records whether `git` or `solidactions` owns its source (Settings, "Source of truth"). When the source of truth is git, a deploy made from a sandbox (with its project-scoped token) is refused with `source_of_truth_git`; deploys from your laptop or CI are never refused. To deploy from the sandbox anyway, pass `--override-source-of-truth`: the CLI sends it on every call the deploy makes (functions, config, pages, app settings and the source archive). The deploy is stored and the app shows as drifted until you mark it reconciled in the app's settings or flip its source of truth to SolidActions. While an app is drifted, every deploy prints `Warning: this app is drifted: deployed outside git since <date>. Mark it reconciled in the app's settings, or flip its source of truth to SolidActions.` Apps whose source of truth is SolidActions never warn or refuse." The flag text (`src/index.ts` line 573): "Deploy from a sandbox even though the app's source of truth is git; the app shows as drifted until you mark it reconciled or flip its source of truth to SolidActions".
- Function extras facts (Task 2 and Task 7 quote these, verbatim from the guide, app `origin/main` `WorkflowsGuideTool.php` lines 775-777 and 799):
  - "`batch(statements)` on that database takes 1 to 50 `{ sql, args? }`, runs them in ONE round trip and answers one `{ columns, rows, rowsAffected }` per statement, in order. It is not atomic and does not stop at a failure: every statement runs, and the first failing one is thrown as `sql_error` with the message `statement N: ...` (N counts from 1), while the statements that succeeded stay applied. Use it for several statements per call. Bad input, a statement that is not an object with a string `sql` and an optional array `args`, or a list that is not 1 to 50 statements, is thrown as `bad_request` before a request is made, and an answer from the database that is not shaped like one is thrown as `database_unavailable`."
  - "`env.sa.workflows.start(slug, input, { after: true })` asks for a workflow start that happens after the function has answered, and answers `{ queued: true }` with no run id. The trade-off: there is no immediate refusal (a plan limit or a turned-off workflow shows up later as a "Not started" run on the workflow's run list), and the run only starts if the function returns a Response below 400 (a 2xx or a 3xx); a 4xx or 5xx, an uncaught throw, a timeout, a limit, an answer over 1 MB or a platform error drops it, so a function that answers "bad request" never starts the workflow. Await it before returning; a request sent after the answer is refused (`call_over`)."
  - "A function with `confirm: true` asks first. On an app dashboard and on a visual page the host shows a confirmation dialog naming the function, and the function does not run until the viewer says yes. A function can set its own confirm text, at most 255 characters, in the editor or in `functions_manage` (`confirm_text`; null or empty clears it): the dialog shows it above the standard line, and only while `confirm` is true. The server refuses a call to a `confirm: true` function without the host's confirmation (`confirm_required`), and page code never sees that code. If the viewer cancels, the page's `sa.action` rejects with `cancelled` (outcome `not_applied`). A function without `confirm` and a workflow call open no dialog."
- Deploy output facts (Task 3 and Task 7 quote, from `src/utils/functions-sync.ts` `formatFunctionsSummary`, lines 70-79 at plan time): one line per function: `function <id>: <status>` plus ` <webhook_url>` only when the server returned a URL; `<status>` is `live` (new or changed), `unchanged` (a redeploy with the same source) or `error` (printed as `function <id>: error <code>: <message>`); a function without `webhook: true` has no URL; a function dropped from the yaml prints `function <id>: retired`.
- Pages facts (Task 3 quotes; the developer reads the sources): a code page is declared under `pages:` in `solidactions.yaml` with `id`, `name`, `file` and optional `home: true` (`PageCodeEntry` in `src/utils/env.ts` line 20: `{ id: string; name: string; file: string; home?: boolean; owner?: 'code'; sources?: ... }`); the file is an `.html` page or a `.tsx` page (a tsx page is bundled by the CLI with a pinned esbuild before upload, cli#236, `docs/superpowers/plans/2026-11-10-cli-code-pages.md`: platform modules `react`, `react-dom`, `recharts`, `@tanstack/react-table`, `sa`, `@solidactions/sa`; the page must export its component as the default export). The app's guide section "Pages in code" (`WorkflowsGuideTool.php` line 240 at plan time) is the text to match.
- Platform start-failure codes (Task 6 quotes, from app `app/Support/PlatformErrorMessages.php` and `docs/decisions.md` line 1208): four codes, `sandbox_start_timeout` ("This run could not start: its sandbox was not ready in time. Nothing ran. It is safe to run it again."), `sandbox_capacity` ("This run could not start: no sandbox was available. Nothing ran. It is safe to run it again."), `image_not_ready` ("This run could not start: your project's build is not ready. Nothing ran. Try again in a minute, or deploy the project again.") and `platform_error` ("This run could not start because of a problem on our side. Nothing ran. It is safe to run it again."); the platform re-queues a never-started run after 10 s, 30 s, 90 s (`services.daytona.start_retry_delays_seconds`, counted per start chain) and fails it with the sentence after the third retry; the session note while it retries: "This start attempt did not succeed; starting it again."

---

### Task 1: manifest pin to v3.37.0, stale allowlist entries gone (examples repo, cli#251 items 1 and 2)

**Files (file scope, examples checkout `/home/mercer/projects/solid/__wave-cli-a/solidactions-examples`; the only paths this task may touch):**
- Modify: `content/command-manifest.json` (replaced whole by the downloaded release asset, bytes untouched)
- Modify: `content/manifest-contract.json` (`release_tag`, `cli_version`, `sha256`, `asset_url`)
- Modify: `content/placeholder-contract.json` (`guidance_cli_version.public_value` only)
- Modify: `content/validator-allowlist.json` (remove stale entries)
- Modify: `tests/content/contract.test.mjs` (line 15: the pinned `guidance_cli_version` value)
- Modify: `tests/golden/app/cloud/deploy.txt`, `tests/golden/app/cloud/full.txt`, `tests/golden/app/self-hosted/deploy.txt`, `tests/golden/app/self-hosted/full.txt` ONLY if Step 3 shows the rendered text of the new `guidance_cli_version` appears in them (at plan time `grep -rn "3\.6" tests/golden` finds only the literal sentence "through CLI v3.6.0 the YAML parser keeps only the first" at `tests/golden/app/cloud/deploy.txt:39`, `cloud/full.txt:149`, `self-hosted/deploy.txt:39`, `self-hosted/full.txt:154`, which is a historical fact about a CLI release and is NOT changed)

Grep pasted at plan time (every reader of the pin): `grep -rn "guidance_cli_version" --exclude-dir=.git .` lists `content/README.md`, `content/placeholder-contract.json`, `content/guide/setup.md:5,41` (`v{{guidance_cli_version}}.x`), `scripts/check-docs.mjs`, `tests/content/{contract,completeness,app-parity,marketing-parity,fragments,manifest-contract}.test.mjs`. `app-parity.test.mjs` (lines 18-36) and `marketing-parity.test.mjs` (line 27) hardcode `'3.2'` "on purpose" and are NOT touched. `tests/content/manifest-contract.test.mjs:40` compares the placeholder with the manifest: read it before editing, the new `public_value` must satisfy it.

**Interfaces:**
- Consumes: the CLI release asset `https://github.com/SolidActions/solidactions-cli/releases/download/v3.37.0/command-manifest.json` (exists, v3.37.0 is the latest release).
- Produces: a pinned manifest that knows `app preview`, `--override-source-of-truth` and the database group, so Tasks 2 and 3 validate their new spans against it.

- [ ] **Step 1: Follow `content/README.md` "Bumping the pinned CLI command manifest" steps 1-3 exactly.** `curl -sL -o content/command-manifest.json <asset_url>` (never reformat or strip its trailing newline), then set `release_tag` `v3.37.0`, `cli_version` `3.37.0`, `sha256` (`sha256sum content/command-manifest.json`), `asset_url` in `manifest-contract.json`; set `guidance_cli_version.public_value` to `3.37` in `placeholder-contract.json`; set the same value in `tests/content/contract.test.mjs` line 15.
- [ ] **Step 2: Static check, find the stale entries.** `node scripts/check-content.mjs`. It prints each stale allowlist entry (an entry whose span now passes the validator) and each new finding. Delete every entry it reports as stale from `content/validator-allowlist.json` (expected: the 14 the issue names, plus the `app preview` entries added by examples PR #35; keep the file valid JSON, same key order and indentation). Add NO entry. A new finding for a span is fixed by rewording the skill or guide text, but that text belongs to other tasks: if a finding is in a file outside this task's scope, STOP and comment on the card (do not edit it; the manager rules).
- [ ] **Step 3: Golden review.** `grep -rn "3\.37\|{{guidance_cli_version}}" content/guide/setup.md` and run `node scripts/check-content.mjs` and `node scripts/check-docs.mjs` (both exit 0). Check whether any file under `tests/golden/` contains the rendered `guidance_cli_version` ("v3.6.x" produced by `setup.md` line 41, as opposed to the literal "CLI v3.6.0" sentence): `grep -rn "targets \`@solidactions/cli\` v" tests/golden`. If a golden holds the rendered value, update exactly that token in each golden; otherwise leave goldens untouched and say so in the report. Expected-RED table: none (data and a pinned value; the proof is `check-content.mjs` exiting 0 with no stale entry, then CI's `node --test` on the PR).
- [ ] **Step 4: Size check.** `git diff --stat -- <paths>`; `command-manifest.json` is a vendored asset and does not count against the 1000-line cap (state its diff size).
- [ ] **Step 5: Report (do not commit).** List every changed path (test path: `tests/content/contract.test.mjs`; the rest are content), the list of allowlist entries removed (file and span), and the golden decision.

---

### Task 2: functions skill extras, preview wording, no-dev fallback (examples repo, cli#251 3a and 4, cli#253 item 2, wave card piece 1)

**Files (file scope, examples checkout; the only paths this task may touch):**
- Modify: `content/skills/solidactions-functions.md` (the paragraph "Every field of a code entry" in `## Writing a function`, line 33 at plan time; the `env` paragraph below the handler example; one new `## Function extras` section before `## Deploy`; the `## Confirm` facts go in that section)
- Modify: `content/skills/solidactions-getting-started.md` (the preview Hard Rule at line 14: wording only)
- Modify: `scripts/check-docs.mjs` (one assertion block, below)

**Interfaces:**
- Consumes: Task 1 committed (the new manifest). The frozen contract lines "yaml key `confirm_text`", "Preview wording" and "Function extras facts".
- Produces: skill text Task 7 mirrors in prose; the assertion in `check-docs.mjs`.

**Content requirements:**
- `solidactions-functions.md`, field list: add `confirm_text` after `confirm`: "`confirm_text` (string, at most 255 characters: the question the confirm dialog asks; shown only while `confirm` is true; needs CLI 3.38 or newer, an older CLI ignores the key without a warning, so check `solidactions --version` before relying on it; a deploy with no `confirm_text` clears it, because the file is the owner)". Replace the sentence "There is no yaml `owner` key: the file is the owner, so the app and MCP can turn such a function off or on and nothing else (`owned_by_code`)." with exactly: "A code entry needs no `owner` key: the file is the owner, so the app and MCP can turn such a function off or on and nothing else (`owned_by_code`). A pointer entry (`owner: editor`) names a function made in the app: the deploy leaves it alone." (the pointer fact is from cli#251's quoted text: `owner: 'editor'` is a pointer entry skipped by `listCodeFunctions`).
- `solidactions-functions.md`, new `## Function extras` section (heading level 2, before `## Deploy`), four short subsections as bullets in the skill's tone, each fact copied from the Frozen contract "Function extras facts" (no new number or limit): (a) start a workflow after the answer, with the code line `await env.sa.workflows.start('weekly-report', input, { after: true });` and the full trade-off including "never starts the workflow" on a 4xx/5xx; (b) several statements in one call, `env.sa.database('ANALYTICS_DB').batch([{ sql: '...', args: [...] }, ...])`, 1 to 50, not atomic, `sql_error` `statement N: ...`, `bad_request` and `database_unavailable`; (c) a `sql_error` from `query` or `exec` is thrown with the database's own message and, from `batch`, with `statement N:` in front (the guide states only the `batch` form; do not add a claim about `query`/`exec` wording: say only what the guide says); (d) confirm text: `confirm: true`, `confirm_text`, 255 characters, dialog naming the function, `confirm_required` and `cancelled`.
- `solidactions-functions.md`, `env` paragraph: add `{ after: true }` and `batch` to the one-line list of `env.sa` features and point to `## Function extras`.
- `solidactions-getting-started.md` preview Hard Rule (line 14): keep every existing word; (1) after "Then run `solidactions app preview <app> [--page <id>]`" insert "(CLI 3.36 or newer; an older CLI answers "unknown command")"; (2) append to the bold rule's body, before `*Why:`, this sentence: "If the dev deploy is refused (a workspace whose plan has no dev copy answers "Staging and dev environments require a Pro or Scale plan."), stop and ask the person before any production deploy: do not deploy to production on your own to get a preview." (the refusal text is quoted from cli#253). Do not repeat the `solidactions app preview` span anywhere else.
- `grep -n "\./function-echo" content/skills/solidactions-functions.md content/skills/solidactions-getting-started.md` must print nothing (cli#251 comment); if it prints a line, fix it to `./.solidactions/examples/function-echo`.
- `scripts/check-docs.mjs`: add one assertion block in the file's existing style (read the file first; the prior wave's assertion for the rule sentence is the model): `content/skills/solidactions-functions.md` contains `{ after: true }`, `statement N`, `confirm_text` and `A code entry needs no \`owner\` key`; `content/skills/solidactions-getting-started.md` contains `CLI 3.36 or newer` and `stop and ask the person before any production deploy`. Expected-RED: on the base each of these strings is absent, so the assertion fails with the missing string named; `check-docs.mjs` exits 0 after.

- [ ] **Step 1: Read the sources** (`git -C /home/mercer/projects/solid/solidactions-app show origin/main:app/Mcp/Tools/WorkflowsGuideTool.php | sed -n 749,808p`, `scripts/check-docs.mjs`, the two skill files).
- [ ] **Step 2: Add the assertion to `scripts/check-docs.mjs` first** and run `node scripts/check-docs.mjs`: it must fail naming the missing strings (this is the expected-RED row; nothing else is run for RED).
- [ ] **Step 3: Make the edits.**
- [ ] **Step 4: Static checks.** `node scripts/check-docs.mjs` exits 0; `node scripts/check-content.mjs` exits 0 with no stale entry and no finding (Task 1's manifest). No test is run.
- [ ] **Step 5: Size check** (`git diff --stat -- <paths>`; expected under 120 lines).
- [ ] **Step 6: Report (do not commit).** List changed paths (test path: `scripts/check-docs.mjs`; the rest are content), the expected-RED row, and the result of the `./function-echo` grep.

---

### Task 3: deploy-and-config skill: source of truth, functions wording, app pages, pointers (examples repo, cli#251 3b, cli#253 items 1 and 3, wave card piece 1)

**Files (file scope, examples checkout; the only paths this task may touch):**
- Modify: `content/skills/solidactions-deploy-and-config.md` (line 80, the Functions subsection paragraph; a new `### Pages` subsection after it or after `### Functions`, wherever the existing `solidactions.yaml` reference sections end; a new `### Source of truth` subsection under the deploy section, near the `project deploy` description at line 18)
- Modify: `CLAUDE.md` (the skill bullet list at the top)
- Modify: `AGENTS.md` (same list)
- Modify: `CLAUDE-skills-pointer.md` (same list)

**Interfaces:**
- Consumes: Task 1 committed; frozen contract lines "Source of truth facts", "Deploy output facts", "Pages facts".
- Produces: nothing a later task consumes (Task 6 writes its own prose from the same facts).

**Content requirements:**
- Functions subsection (line 80): replace "The deploy prints `function <id>: live <url>`." with a paragraph copied from the "Deploy output facts" contract line: one line per function, `function <id>: live <url>` only for a new or changed function with `webhook: true`; a redeploy of the same source prints `function <id>: unchanged` (with the URL when it has a webhook); a function without a webhook prints no URL; an error prints `function <id>: error <code>: <message>`; a function removed from the yaml prints `function <id>: retired`. Also add one sentence: "A code function can set `confirm_text` (CLI 3.38 or newer); see the `solidactions-functions` skill."
- `### Source of truth` (new): copy the facts of the frozen "Source of truth facts" line into four short bullets plus the command line `solidactions project deploy <project> <path> -e dev --override-source-of-truth` and the warning line. First bullet is a bold rule form like neighbours; add: "Ask the person before using `--override-source-of-truth`: it leaves the app drifted." (the guide's `projects_sandbox` description: "A git source of truth refuses sandbox deploys (source_of_truth_git); --override-source-of-truth marks it drifted.", app `app/Mcp/Catalog/CatalogDescriptions.php` line 39).
- `### Pages` (new, cli#253 item 1; about 25-40 lines): a short section titled "App pages in code": the `pages:` block with a complete working example (`id`, `name`, `file`, `home: true`), a ten-line `pages/greeting.html` that shows a greeting, the deploy command with the path written out, how a person opens it (the app's page link; `solidactions app preview <app> --page <id>` is named once as "see the preview rule in `solidactions-getting-started`", never as a span), and the tsx variant in two sentences (default export, bundled by the CLI, the platform modules list from the Pages facts line). Read `src/utils/pages-sync.ts`, `src/utils/validate-items.ts` (page rules) and the guide's "Pages in code" in the CLI repo `/home/mercer/projects/solid/solidactions-cli/__worktrees/wave-a` (read only) and the app guide, and state only what they support; the example yaml must pass the CLI's own validation rules (read them; id slug rule `[a-z0-9][a-z0-9-]{0,62}`, file extension, size caps).
- Pointers (`CLAUDE.md`, `AGENTS.md`, `CLAUDE-skills-pointer.md`; cli#253 item 3): in the existing bullet for `solidactions-deploy-and-config` and `solidactions-getting-started` add the words "app pages (`pages:`), source of truth, the preview rule" in the same style (one clause each, no new bullet, no new skill name). Read the three files first; the bullet text is identical in all three and stays identical.
- `grep -n "\./function-echo" content/skills/solidactions-deploy-and-config.md` must print nothing; fix any hit to `./.solidactions/examples/function-echo`.
- `scripts/check-docs.mjs` is Task 2's file: this task adds no assertion there. Review Focus 6 is proved by: `node scripts/check-content.mjs` exits 0 (the new `solidactions project deploy ... --override-source-of-truth` span validates against the v3.37.0 manifest) and the reviewer's grep `grep -c "pages:" content/skills/solidactions-deploy-and-config.md` is at least 2 (the new Pages subsection holds the `pages:` block and its prose).

- [ ] **Step 1: Read the sources** (the three files, the pages sources above, `src/utils/functions-sync.ts` `formatFunctionsSummary`).
- [ ] **Step 2: Make the edits.**
- [ ] **Step 3: Static checks.** `node scripts/check-docs.mjs` exits 0; `node scripts/check-content.mjs` exits 0 (no stale entry, no finding; a span the validator flags is reworded, never allowlisted: the allowlist file is Task 1's). Expected-RED table: none (content).
- [ ] **Step 4: Size check** (expected under 150 lines).
- [ ] **Step 5: Report (do not commit).** Paths (all content), the `./function-echo` grep result, and the page example's yaml and html as pasted evidence.

---

### Task 4: send `confirm_text` from `solidactions.yaml` (CLI slot, cli#254, wave card piece 2)

**Files (file scope, CLI slot `/home/mercer/projects/solid/solidactions-cli/__worktrees/wave-a`; the only paths this task may touch):**
- Modify: `src/utils/functions-sync.ts` (interface `CodeFunction` lines 8-19: add `confirm_text?: string;` after `confirm`; `listCodeFunctions` lines 22-40: add `...(fn.confirm_text === undefined ? {} : { confirm_text: fn.confirm_text }),` after the `confirm` line)
- Modify: `src/utils/env.ts` (line 23, `FunctionCodeEntry`: add `confirm_text?: string;` after `confirm?: boolean;`)
- Modify: `src/utils/validate-items.ts` (the function-entry loop; add the check after the `webhook_auth` check, lines 167-171 at plan time)
- Test: `tests/functions-sync.test.ts`
- Test: `tests/validate-items.test.ts`

Grep pasted at plan time (every caller and fake of the changed names): `grep -rln "listCodeFunctions\|CodeFunction\|FunctionCodeEntry\|buildFunctionsSyncPayload" src tests` lists `src/commands/deploy.ts`, `src/utils/env.ts`, `src/utils/functions-sync.ts`, `tests/deploy-override-source-of-truth.test.ts`, `tests/validate-items.test.ts`, `tests/functions-sync.test.ts`. `deploy.ts` and `deploy-override-source-of-truth.test.ts` only pass a `CodeFunction[]` through (an added optional field changes no signature), so they are not edited; the developer greps again before editing and, if a caller builds a `CodeFunction` literal that would stop type-checking, STOPs and comments (the field is optional, so none should).

**Interfaces:**
- Consumes: the frozen contract lines "yaml key `confirm_text`", "CLI field name" and "Validation message".
- Produces: nothing a later task consumes except the released behaviour the examples and marketing text describe.

- [ ] **Step 1: Write the failing tests.**

In `tests/functions-sync.test.ts`, add (after the existing "lists code functions in YAML order and skips editor pointers" test; keep the existing fixtures unchanged):

```typescript
    it('passes confirm_text through, only when the yaml sets it', () => {
        expect(listCodeFunctions({ functions: [
            { id: 'ask', name: 'Ask', file: 'functions/ask.ts', confirm: true, confirm_text: 'Send the weekly report to everyone?' },
            { id: 'plain', name: 'Plain', file: 'functions/plain.ts', confirm: true },
        ] })).toEqual([
            { id: 'ask', name: 'Ask', file: 'functions/ask.ts', confirm: true, confirm_text: 'Send the weekly report to everyone?' },
            { id: 'plain', name: 'Plain', file: 'functions/plain.ts', confirm: true },
        ]);
    });
    it('sends confirm_text in the sync payload and leaves it out when absent', () => {
        const ask: CodeFunction = { id: 'ask', name: 'Ask', file: 'functions/ask.ts', confirm: true, confirm_text: 'Sure?' };
        const plain: CodeFunction = { id: 'plain', name: 'Plain', file: 'functions/plain.ts' };
        const payload = buildFunctionsSyncPayload([ask, plain], new Map([['ask', 'a'], ['plain', 'p']]), null);
        expect(payload.functions[0]).toEqual({ ...ask, source: 'a' });
        expect(Object.keys(payload.functions[1])).not.toContain('confirm_text');
    });
```

In `tests/validate-items.test.ts`, add after the "rejects an unknown function webhook_auth" test (read it first and copy its fixture style: it writes a valid function file in a temp dir, so only the new rule fires):

```typescript
    it('accepts a confirm_text of 255 characters and refuses 256, counting characters not bytes', () => {
        // fixture: the same valid hook file as the webhook_auth test above
        // ok: 255 two-byte characters ("é" x 255 is 510 bytes but 255 characters)
        // refused: 256 characters
        // expected error: { entry: 'functions[hook]', field: 'confirm_text',
        //   message: 'functions[hook].confirm_text: confirm_text must be a string of at most 255 characters (got 256 characters).' }
    });
    it('refuses a confirm_text that is not a string', () => {
        // confirm_text: 7 -> { entry: 'functions[hook]', field: 'confirm_text',
        //   message: 'functions[hook].confirm_text: confirm_text must be a string of at most 255 characters (got 7).' }
    });
```
(The developer writes both bodies in the file's existing style; the comments above fix the inputs and the exact expected error objects. `(got 256 characters)` for a too-long string, `(got <JSON.stringify(value)>)` for a non-string.)

- [ ] **Step 2: Expected-RED table (checked by the per-task reviewer against the test code; nothing runs for RED).**

| Test | Assertion that must fail on the base | Why |
|---|---|---|
| passes confirm_text through | `toEqual` with `confirm_text` on `ask` | `listCodeFunctions` rebuilds each entry field by field and drops unknown keys, so `confirm_text` is missing from the result |
| sends confirm_text in the sync payload | `expect(payload.functions[0]).toEqual({ ...ask, source: 'a' })` | `buildFunctionsSyncPayload` spreads what it is given, so this row passes on the base with the new type but fails to COMPILE without the `CodeFunction` field (vitest does not type-check; the row guards the shape once the field exists; the plain-function `not.toContain` half passes on both). The reviewer accepts it as a type-contract row, not a RED row. |
| 256 characters refused | the expected error is returned | no `confirm_text` rule exists, `validateItems` returns no error |
| non-string refused | the expected error is returned | same |
| 255 characters accepted | no `confirm_text` error | passes on the base too (guard row against an off-by-one in the new rule) |

- [ ] **Step 3: Write the minimal implementation.** The three source edits named in Files. The validation (insert after the `webhook_auth` block, inside the same `functions.forEach`):

```typescript
        const confirmText = (entry as { confirm_text?: unknown }).confirm_text;
        if (confirmText !== undefined && (typeof confirmText !== 'string' || [...confirmText].length > 255)) {
            const got = typeof confirmText === 'string' ? `${[...confirmText].length} characters` : JSON.stringify(confirmText);
            errors.push({ entry: entryLabel, field: 'confirm_text', message: `${entryLabel}.confirm_text: confirm_text must be a string of at most 255 characters (got ${got}).` });
        }
```
(`[...s].length` counts code points, which matches the server's `max:255`; the editor-owned branch above returns before this code, so a pointer entry is never checked.)

- [ ] **Step 4: Static checks.** `npx tsc --noEmit` and `npm run build` exit 0. No test is run; `tests/functions-sync.test.ts` and `tests/validate-items.test.ts` run in `check.yml` on the pushed head (GREEN is that CI run; the manager records its run id on the wave card).
- [ ] **Step 5: Size check** (`git diff --stat -- <paths>`; expected under 90 lines).
- [ ] **Step 6: Report (do not commit).** Test paths: `tests/functions-sync.test.ts`, `tests/validate-items.test.ts`. Source paths: `src/utils/functions-sync.ts`, `src/utils/env.ts`, `src/utils/validate-items.ts`. Include the expected-RED table and the caller grep. The manager commits with `git add -- <paths>` then `git commit -m "feat: send confirm_text from solidactions.yaml functions" -- <paths>`.

---

### Task 5: repin `EXAMPLES_REF` to the merged examples commit (CLI slot, cli#251 and cli#253 follow-through)

**Files (file scope, CLI slot; the only paths this task may touch):**
- Modify: `src/utils/examples-ref.ts` (the `EXAMPLES_REF` constant at line 37, and the "Currently:" comment lines 30-36: name this wave's examples PR content)
- Test: `tests/examples-ref.test.ts` (line 30, the literal the test pins, to the new SHA)

Grep pasted at plan time: `grep -rn "0dd65bab" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist .` lists exactly `src/utils/examples-ref.ts` and `tests/examples-ref.test.ts`; `scripts/smoke-init.mjs` reads the constant from source and needs no edit (its `skillNames` list is unchanged: this wave adds no skill).

**Interfaces:**
- Consumes: `<MERGED_SHA>`, the full 40-hex SHA of the examples repo `origin/main` after the PM merged the examples PR, delivered by the manager in the card text.
- Produces: the pin that makes the new skill text reach users.

- [ ] **Step 1: Manager precondition (not the developer's).** Before the card exists: `git -C /home/mercer/projects/solid/__wave-cli-a/solidactions-examples fetch origin && git -C ... rev-parse origin/main` gives `<MERGED_SHA>`; `git -C ... merge-base --is-ancestor <MERGED_SHA> origin/main` exits 0 (Review Focus 1); `gh api repos/SolidActions/solidactions-examples/contents/content/skills/solidactions-functions.md?ref=<MERGED_SHA>` (decoded) contains `{ after: true }`, `confirm_text` and `CLI 3.36 or newer` is in `solidactions-getting-started.md` at that ref; `content/manifest-contract.json` at that ref says `v3.37.0`.
- [ ] **Step 2: Edit.** Replace the SHA in both files; in `examples-ref.ts` rewrite the "Currently:" sentence to say the pin is the merged examples mainline that carries the wave cli-agent-docs skill text (manifest v3.37.0, function extras, source of truth, app pages, preview fallback; cli#251, cli#253), keeping the sentence about ex#34 and the standing #1146 contract.
- [ ] **Step 3: Static checks.** `npx tsc --noEmit` exits 0. No test runs; `tests/examples-ref.test.ts` and the `release-candidate` job (`smoke:init`, which fetches every skill at the new ref) run in `check.yml`. Expected-RED table: none (a pin).
- [ ] **Step 4: Report (do not commit).** Paths: test `tests/examples-ref.test.ts`; source `src/utils/examples-ref.ts`.

---

### Task 6: projects, troubleshooting and connect-ai pages (marketing repo, wave card piece 3)

**Files (file scope, marketing checkout `/home/mercer/projects/solid/__wave-cli-a/solidactions-marketing`; the only paths this task may touch):**
- Modify: `site/src/pages/docs/projects/index.astro` (preview link, source of truth)
- Modify: `site/src/pages/docs/troubleshooting.astro` (platform start-failure codes)
- Modify: `site/src/pages/docs/connect-ai.astro` (named agents)

**Interfaces:**
- Consumes: the frozen "Source of truth facts" and "Platform start-failure codes" lines; for connect-ai the app spec `docs/superpowers/specs/2026-11-15-named-agents-design.md` (app `origin/main`, read with `git -C /home/mercer/projects/solid/solidactions-app show origin/main:docs/superpowers/specs/2026-11-15-named-agents-design.md`, decisions 2, 3, 5, 7, 8; it shipped as app PR #2768 on `origin/main`).
- Produces: nothing a later task consumes.

**Content requirements** (model the page structure and tone on the page's own existing sections, and on `site/src/pages/docs/functions/index.astro`; read each target page and `site/src/components/` first; no new route, no new component, no `docs-contract.json` change):
- `projects/index.astro`: (a) a section "Try the app before you call it done": an AI (or you) asks for a preview link with `solidactions app preview <app> [--page <id>]` (CLI 3.36 or newer) or the MCP `projects_sandbox` action `preview_link`; it opens the app's dev copy, never production; the link works once, within 60 seconds; the session ends after 3 minutes idle or 10 minutes; a page call from a preview carries `SA_PREVIEW=1` so a function skips real side effects such as sending mail (these facts are the cli#247 ruling text and the guide's "The three doors" paragraph, quoted in `docs/superpowers/plans/2026-11-15-cli-functions-docs.md` Global Constraints; the developer reads that file in the CLI slot); (b) a section "Who owns an app's source": the Source of truth facts as plain prose (Settings, "Source of truth"; `git` or `solidactions`; a sandbox deploy over a git-owned app is refused with `source_of_truth_git`; `--override-source-of-truth`; drifted until reconciled; deploys from a laptop or CI are never refused).
- `troubleshooting.astro`: a section "A run could not start" listing the four codes with their sentences (copied from the contract line, the sentence a customer sees) and what to do (run it again; for `image_not_ready` try again in a minute or deploy the project again), plus the retry: the platform starts a never-started run again by itself after 10 s, 30 s and 90 s, then fails it with the sentence. Also write, in plain words from the PM's source (app release v0.285.0 notes, #2697): a wait-mode caller with a short timeout may see a timeout while the retries run (up to about 2 minutes), and it should not resubmit; and a missing image (`image_not_ready`) is not retried by the platform. Where this conflicts with the contract line's "fails it with the sentence after the third retry" for `image_not_ready`, the PM's words win: do not say `image_not_ready` is retried.
- `connect-ai.astro`: a section "Name your agent": on the consent screen you type a name for the agent being connected ("Steve", "Billy"); each name is its own agent; left blank it is the app's default connection; the same app with the same name replaces that connection (a reconnect); a different app using a name you already have is refused with "{name}" is already the name of one of your agents ({app name}). Pick another name.; Settings, Agents lists one row per agent with rename, revoke and last used; new tool areas reach old connections by default, except an area you left unticked (decision 5); and "Reconnect to add them": when a connection lacks tool areas the agent says "Not turned on for this connection: {areas}. A person can add them by connecting the app again and ticking them." (decision 8). Read the spec's decisions and state only what they say; name nothing the spec lists as out of this wave (decision 11).

- [ ] **Step 1: Read the sources and the three pages.**
- [ ] **Step 2: Make the edits.**
- [ ] **Step 3: Static checks.** In `site/`: `npm run build` and `npm run check:docs` exit 0. No test runs. Expected-RED table: none (docs).
- [ ] **Step 4: Size check** (expected under 200 lines).
- [ ] **Step 5: Report (do not commit).** Paths, the omitted claim, and any fact a source did not support.

---

### Task 7: functions page (marketing repo, wave card piece 3; the dashboards section is dropped by PM ruling, see Rulings)

**Files (file scope, marketing checkout; the only paths this task may touch):**
- Modify: `site/src/pages/docs/functions/index.astro` (after, batch, confirm text)

**Interfaces:**
- Consumes: the frozen "Function extras facts" and "yaml key `confirm_text`" lines. (The dashboards "Make this an app" section is dropped: PM ruling, Rulings.)
- Produces: nothing.

**Content requirements:** model on the existing sections of each page (the functions page already has a confirm paragraph at line 128 and a page-grant paragraph; extend, do not duplicate):
- `functions/index.astro`: (a) "Start a workflow after you answer": `after: true`, with the trade-off exactly as the contract (including the "Not started" run list and the below-400 rule); (b) "Several statements in one call": `batch`, 1 to 50, one round trip, not atomic, `statement N`; (c) confirm text: the existing confirm paragraph gains `confirm_text` (255 characters, shown above the standard line, only while `confirm` is true) and how to set it: in the app's editor, over MCP (`functions_manage`), or in `solidactions.yaml` with CLI 3.38 or newer.

- [ ] **Step 1: Read the sources and both pages.**
- [ ] **Step 2: Make the edits.**
- [ ] **Step 3: Static checks.** In `site/`: `npm run build` and `npm run check:docs` exit 0. Expected-RED table: none (docs).
- [ ] **Step 4: Size check** (expected under 150 lines).
- [ ] **Step 5: Report (do not commit).** Paths and any fact a source did not support.

---

## Self-review (run at plan time)

- Spec coverage: wave card piece 1 (Tasks 1-3), piece 2 (Tasks 4, 5), piece 3 (Tasks 6, 7); cli#251 items 1-4 (Tasks 1, 2, 3; the `function-echo` README comment is already fixed on examples main and grepped in Tasks 2, 3); cli#253 items 1-3 (Tasks 2, 3). Audit gaps 1, 2, 5, 6, 7 are covered; gaps 3 and 4 and the #2791 pointer are the app half. Every issue has a task.
- Placeholders: the `<MERGED_SHA>` in Task 5 is delivered by the manager at dispatch; the two `validate-items` test bodies are fixed by inputs and exact expected error objects.
- File scope: every task has an exhaustive Files list; no two open cards share a path (Task 2 owns `scripts/check-docs.mjs`; Task 1 owns `content/validator-allowlist.json`; Task 3 owns the three pointer files and the deploy skill).
- Premises probed: `confirm_text` server rule and clear-on-omit (`FastFunctionSyncRequest.php`, `FunctionFields.php::fromYaml`, quoted above); silent drop of unknown yaml keys (`listCodeFunctions`, `src/utils/functions-sync.ts` lines 22-39); latest CLI v3.37.0 (`gh release list`); the function-echo README fix on examples main (`0dd65ba`, #36); the manifest bump's golden risk (`tests/golden` grep: only a literal "CLI v3.6.0" sentence; `app-parity` hardcodes `3.2`). The one unprobed premise: whether `check-content.mjs` against v3.37.0 passes after only the stale entries are removed; Task 1 Step 2 measures it and STOPs if a finding sits in another task's file.

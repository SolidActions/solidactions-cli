# Live crews and docs suite

These tests run against a real sa-dev `/mcp` endpoint. There are no mocks: they create crews, roles and skills on the dev stack and check what the CLI's crews commands (`skill push/publish/pull`, `role push/pull`) actually do, plus the transport (JSON-RPC errors, UTF-8 decoding, HTTP 429 retry). `vitest run` collects them along with the unit tests, but they skip themselves unless the `SOLIDACTIONS_LIVE_*` variables are set. With those variables set they run for real, including the throttle waits described below.

## Run

Build first, with the sa-dev stack already up (it serves `http://localhost:<APP_PORT>`):

```bash
npm run build
eval "$(scripts/live-test-env.sh)" && npx vitest run tests/live/
```

`scripts/live-test-env.sh` prints `export` lines for `SOLIDACTIONS_LIVE_HOST`, `SOLIDACTIONS_LIVE_API_KEY` and `SOLIDACTIONS_LIVE_WORKSPACE_ID`, so `eval` puts them in your shell only. Do not run the script without `eval` in a shared terminal or log.

## Things to know

- **Each `eval` mints a new dev token** (a Sanctum token for the dev `test@example.com` user). Never print, echo or commit it, and do not paste `env` output. Tokens are cheap; re-run the `eval` rather than saving one.
- **The files run serially** (`fileParallelism: false` in the `live` project of `vitest.config.mts`). Each file creates a crew, and the dev plan caps crews at 3, so parallel files would fail on the limit.
- **A run spends about 2 minutes waiting on the throttle, by design.** The server limits `/mcp` to 60 calls per minute per token and answers HTTP 429 with `Retry-After`. `rate-limit.live.test.ts` makes 75 rapid calls on purpose to prove the transport waits and retries instead of failing. The live project's timeouts (240s) allow for those waits.
- **Cleanup goes through `tests/live/cleanup.ts`.** Register each crew, role or shared skill with `createCleanup(config)` before the call that creates it, and `await cleanup.run()` in `afterAll`. Items are deleted in reverse order; a failed delete is logged, not swallowed. If a run is killed mid-way, list crews on the dev stack (the CLI has no `crew list`; call `crews_read` with `action: list` through `callCrewsTool`) and delete any leftover test crews with `crews_delete` (`action: delete_crew`).
- **The docs suite (`docs.live.test.ts`)** runs the built CLI's `doc push`, `doc pull` and `doc upload` against a throwaway top-level docs folder `cli-docs-live-<stamp>`: push with `--folder`, a byte-for-byte pull round-trip (multibyte UTF-8), a tracked re-push (the `docs_manage write` path with `base_revision`, including drift and `--force`), a single-doc pull (`read_doc`), and a PNG upload plus its download. Register the folder with `cleanup.docFolder(name)` before creating anything: at `run()` time it finds the folder in the docs root by name and deletes it with `docs_delete` (`delete_folder`, which removes everything inside). If a run is killed mid-way, list the docs root (`callDocsTool(config, { action: 'list' })`) and delete any leftover `cli-docs-live-*` folder with `docs_delete`.

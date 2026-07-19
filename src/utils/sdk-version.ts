/**
 * The git ref used when fetching SDK docs from the solidactions-ts-sdk repo.
 *
 * `ai init` used to fetch `docs/sdk-reference.md` from that repo's default
 * branch, so a freshly-scaffolded project got whatever happened to be on SDK
 * `main` — documenting APIs the pinned SDK dependency doesn't ship yet. This
 * constant pins the fetch to the tag matching the `@solidactions/sdk` version
 * declared in package.json.
 *
 * Keep it in lockstep with that dependency: `tests/sdk-docs-ref.test.ts`
 * fails the build if this ref drifts from the declared range's minimum.
 */
export const SDK_DOCS_REF = 'v0.7.3';

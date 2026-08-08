/**
 * The git ref used for every fetch from the solidactions-examples repo:
 * `init`'s project template (TEMPLATE_FILES) and the AI skills / helper content
 * installed alongside it.
 *
 * These fetches previously defaulted to `main`, so the scaffold a user got —
 * including the `@solidactions/sdk` version their new project depends on — was
 * whatever happened to be on that repo's default branch at that moment. That is
 * the same unpinned-fetch class as the SDK docs fetch fixed in #39; see
 * {@link ./sdk-version.ts}.
 *
 * WHY A COMMIT SHA AND NOT A TAG: the SDK pin derives its ref from this CLI's
 * declared `@solidactions/sdk` range, because the SDK repo tags `vX.Y.Z` in step
 * with the package it publishes. solidactions-examples does NOT version in
 * lockstep with the SDK — its newest tag (v0.7.0) predates the current template
 * by a wide margin: it declares `@solidactions/sdk` ^0.6.0 (this CLI declares
 * ^0.7.3) and lacks skills/solidactions-crew-skills.md entirely. Pinning to that
 * tag would regress every new scaffold, so the same derived-version scheme cannot
 * apply here. A commit SHA is immutable and gives the property that actually
 * matters — the scaffold no longer moves under us.
 *
 * TO UPDATE: point this at the new solidactions-examples commit and re-run
 * `npm run check:release`; smoke:init serves template content at exactly this
 * ref, so a bad or unreachable SHA fails the release check rather than reaching
 * users. If solidactions-examples ever starts publishing tags in step with the
 * SDK, replace this with a derivation the way sdk-version.ts does.
 *
 * Currently: solidactions-examples PR #29 head @ 8a47ced4 "docs: add database
 * CLI guidance". Pinning this immutable PR-head commit is a temporary build-time necessity
 * while the coordinated wave is pending merge; no delivery override
 * was granted. Before any CLI release, repin EXAMPLES_REF to the
 * merged mainline SHA and verify that exact ref during the release ritual.
 */
export const EXAMPLES_REF = '8a47ced4a248fe57543efd91471b57fa49b4c26d';

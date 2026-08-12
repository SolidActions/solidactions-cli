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
 * ^0.8.0) and lacks skills/solidactions-crew-skills.md entirely. Pinning to that
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
 * Currently: the solidactions-examples issue #1201 branch head @ cf3a0df6
 * "docs(#1201): refresh workspace database guidance". Pinning this immutable
 * PR-head commit is a temporary build-time necessity while the coordinated wave
 * is pending merge. Before the examples branch is deleted, repin EXAMPLES_REF
 * to the merged mainline SHA. Before any CLI release, verify that exact ref
 * during the release ritual.
 */
export const EXAMPLES_REF = 'cf3a0df634895e549600fb5d632fef2ba547aa8d';

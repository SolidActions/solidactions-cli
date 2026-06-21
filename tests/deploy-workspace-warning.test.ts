import { describe, expect, it } from 'vitest';

// shouldPrintWorkspaceMismatch does not exist yet — this import will fail (RED).
// After the fix it is exported from deploy.ts.
import { shouldPrintWorkspaceMismatch } from '../src/commands/deploy';

// These tests fail before the fix because:
// (a) shouldPrintWorkspaceMismatch is not exported yet (import error → RED), and
// (b) the decision logic doesn't exist as a pure function — it's embedded inline.
//
// After the fix they document the invariant: the warning must ONLY fire on paths
// that actually abort. A 404 on the production-existence check (first deploy) and
// a 404 on the env lookup with --create should both produce shouldPrint === false.

describe('shouldPrintWorkspaceMismatch — warning only on abort paths', () => {
    it('returns false for production environment (404 → create, not abort)', () => {
        // Production 404 at site 1 (existence check) or site 2 — always falls through
        // to create. The warning must not fire.
        expect(shouldPrintWorkspaceMismatch('production', false)).toBe(false);
        expect(shouldPrintWorkspaceMismatch('production', true)).toBe(false);
    });

    it('returns false for non-production with --create (404 → create, not abort)', () => {
        // Non-production 404 with --create proceeds to create the env. No abort → no warning.
        expect(shouldPrintWorkspaceMismatch('dev', true)).toBe(false);
        expect(shouldPrintWorkspaceMismatch('staging', true)).toBe(false);
    });

    it('returns true for non-production without --create (404 → abort)', () => {
        // Non-production 404 without --create exits 1. This is a real abort → warn.
        expect(shouldPrintWorkspaceMismatch('dev', false)).toBe(true);
        expect(shouldPrintWorkspaceMismatch('staging', false)).toBe(true);
    });
});

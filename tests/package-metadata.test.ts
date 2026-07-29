/**
 * Pins two package.json fields per PR #90's fix round:
 * - engines.node floor: archiver@8 resolves readdir-glob -> minimatch ->
 *   brace-expansion@5.0.8, which declares `"node": "20 || >=22"` — a
 *   PRODUCTION dependency path (verified via `npm ls brace-expansion --omit=dev`).
 *   Node 18 is EOL; the floor must be >=20.
 * - version: publish.yml rewrites this from the release tag before packing
 *   (since 3e1c966), so the in-repo field is vestigial. It must not be
 *   "corrected" ad hoc to track the live published version.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

function readPackageJson(): Record<string, unknown> {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
    return JSON.parse(raw);
}

describe('package.json metadata', () => {
    it('requires Node >=20 (brace-expansion@5.0.8, a production dependency, needs it)', () => {
        const pkg = readPackageJson();
        expect((pkg.engines as Record<string, string>).node).toBe('>=20.0.0');
    });

    it('leaves the vestigial version field untouched by this PR (publish.yml rewrites it from the release tag)', () => {
        const pkg = readPackageJson();
        expect(pkg.version).toBe('1.33.0');
    });
});

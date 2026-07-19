import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { sdkDocsRef, sdkRefFromRange } from '../src/utils/sdk-version';
import { rawContentUrl } from '../src/utils/github';

const packageJsonPath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const declaredSdkRange: string =
    packageJson.dependencies?.['@solidactions/sdk']
    ?? packageJson.devDependencies?.['@solidactions/sdk'];

// ---------------------------------------------------------------------------
// The range → tag conversion, isolated from the filesystem.
// ---------------------------------------------------------------------------

describe('sdkRefFromRange', () => {
    it('uses the minimum version of a caret range', () => {
        expect(sdkRefFromRange('^0.7.3')).toBe('v0.7.3');
    });

    it('uses the minimum version of a tilde range', () => {
        expect(sdkRefFromRange('~1.2.0')).toBe('v1.2.0');
    });

    it('handles an exact pin with no range operator', () => {
        expect(sdkRefFromRange('2.0.1')).toBe('v2.0.1');
    });

    it('handles a >= range', () => {
        expect(sdkRefFromRange('>=3.4.5')).toBe('v3.4.5');
    });

    it('does not double up the v prefix if one is already present', () => {
        expect(sdkRefFromRange('v0.7.3')).toBe('v0.7.3');
    });

    it('preserves a prerelease suffix', () => {
        expect(sdkRefFromRange('^1.0.0-beta.2')).toBe('v1.0.0-beta.2');
    });

    // Failure paths: a range with no explicit minimum must fail loudly rather
    // than silently degrading to a moving ref like `main`.
    for (const bad of ['*', 'latest', '', 'workspace:*', 'github:SolidActions/solidactions-ts-sdk']) {
        it(`throws on a range with no explicit minimum: ${JSON.stringify(bad)}`, () => {
            expect(() => sdkRefFromRange(bad)).toThrow(/explicit minimum version/);
        });
    }

    it('never returns a moving branch name', () => {
        expect(sdkRefFromRange(declaredSdkRange)).not.toBe('main');
    });
});

// ---------------------------------------------------------------------------
// The derivation itself — asserted against package.json, not a copied literal.
// ---------------------------------------------------------------------------

describe('sdkDocsRef', () => {
    it('derives the ref from the @solidactions/sdk range declared in package.json', () => {
        // Both sides read the same source, so bumping the dependency moves the
        // docs ref automatically — there is no literal here to drift.
        expect(sdkDocsRef()).toBe(sdkRefFromRange(declaredSdkRange));
    });

    it('produces a vX.Y.Z tag, never a branch name', () => {
        expect(sdkDocsRef()).toMatch(/^v\d+\.\d+\.\d+/);
        expect(sdkDocsRef()).not.toBe('main');
    });

    it('declares an SDK dependency at all (the derivation has a source)', () => {
        expect(declaredSdkRange).toBeTruthy();
    });

    it('builds a raw-content URL against the derived tag rather than main', () => {
        delete process.env.SOLIDACTIONS_RAW_CONTENT_BASE_URL;

        const ref = sdkDocsRef();
        const url = rawContentUrl(
            'SolidActions',
            'solidactions-ts-sdk',
            'docs/sdk-reference.md',
            ref,
        );

        expect(url).toBe(
            `https://raw.githubusercontent.com/SolidActions/solidactions-ts-sdk/${ref}/docs/sdk-reference.md`,
        );
        expect(url).not.toContain('/main/');
    });
});

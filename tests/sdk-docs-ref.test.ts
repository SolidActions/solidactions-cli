import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { SDK_DOCS_REF } from '../src/utils/sdk-version';
import { rawContentUrl } from '../src/utils/github';

const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
);

describe('SDK docs ref pinning', () => {
    it('matches the @solidactions/sdk version declared in package.json', () => {
        const declared: string = packageJson.devDependencies['@solidactions/sdk'];
        // Strip the range operator (^, ~, >=) to get the minimum satisfying version.
        const minVersion = declared.replace(/^[^\d]*/, '');

        expect(SDK_DOCS_REF).toBe(`v${minVersion}`);
    });

    it('is a version tag, not a moving branch', () => {
        // `main` was the old default — the whole point of the pin is that a
        // branch name must never reappear here.
        expect(SDK_DOCS_REF).toMatch(/^v\d+\.\d+\.\d+$/);
    });

    it('builds a raw-content URL against the pinned tag rather than main', () => {
        delete process.env.SOLIDACTIONS_RAW_CONTENT_BASE_URL;

        const url = rawContentUrl(
            'SolidActions',
            'solidactions-ts-sdk',
            'docs/sdk-reference.md',
            SDK_DOCS_REF,
        );

        expect(url).toBe(
            `https://raw.githubusercontent.com/SolidActions/solidactions-ts-sdk/${SDK_DOCS_REF}/docs/sdk-reference.md`,
        );
        expect(url).not.toContain('/main/');
    });
});

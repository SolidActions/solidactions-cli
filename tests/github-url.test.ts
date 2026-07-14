import { afterEach, describe, expect, it } from 'vitest';
import { rawContentUrl } from '../src/utils/github';

const originalBaseUrl = process.env.SOLIDACTIONS_RAW_CONTENT_BASE_URL;

afterEach(() => {
    if (originalBaseUrl === undefined) {
        delete process.env.SOLIDACTIONS_RAW_CONTENT_BASE_URL;
    } else {
        process.env.SOLIDACTIONS_RAW_CONTENT_BASE_URL = originalBaseUrl;
    }
});

describe('rawContentUrl', () => {
    it('uses GitHub raw content by default', () => {
        delete process.env.SOLIDACTIONS_RAW_CONTENT_BASE_URL;

        expect(rawContentUrl('SolidActions', 'solidactions-examples', 'skills/example.md')).toBe(
            'https://raw.githubusercontent.com/SolidActions/solidactions-examples/main/skills/example.md',
        );
    });

    it('supports a release-check content server without changing the requested source path', () => {
        process.env.SOLIDACTIONS_RAW_CONTENT_BASE_URL = 'http://127.0.0.1:4321/';

        expect(rawContentUrl('SolidActions', 'solidactions-ts-sdk', 'docs/sdk-reference.md', 'release-candidate')).toBe(
            'http://127.0.0.1:4321/SolidActions/solidactions-ts-sdk/release-candidate/docs/sdk-reference.md',
        );
    });
});

import { describe, expect, it } from 'vitest';
import { augmentTokenMissingAbilityMessage } from '../src/utils/api';

describe("augmentTokenMissingAbilityMessage — 'env:reveal' branch", () => {
    it("appends actionable API-key guidance for a 403 missing the 'env:reveal' ability", () => {
        const error: any = {
            response: {
                status: 403,
                data: {
                    code: 'token_missing_ability',
                    message: "This API key does not have the 'env:reveal' ability.",
                    required_ability: 'env:reveal',
                },
            },
        };

        const result = augmentTokenMissingAbilityMessage(error);
        const message = result.response.data.message as string;

        // Preserves the original server message.
        expect(message).toContain("does not have the 'env:reveal' ability");

        // Names the ability and explains what it unlocks.
        expect(message).toContain('env:reveal');
        expect(message.toLowerCase()).toContain('plaintext');

        // Points at the actual fix: minting a Personal Access Token with the
        // ability checked, from Settings → API keys.
        expect(message).toContain('API key');
        expect(message).toContain('Settings');
        expect(message).toMatch(/API keys/);

        // Since #1252, device-flow consent can also grant this ability (an
        // opt-in checkbox on the consent screen), so the hint must offer both
        // routes rather than steering the user away from `login --device`.
        expect(message).toMatch(/solidactions login --device/);
        expect(message.toLowerCase()).toContain('consent');
    });

    it('is idempotent — applying it twice does not double-append the hint', () => {
        const error: any = {
            response: {
                status: 403,
                data: {
                    code: 'token_missing_ability',
                    message: "This API key does not have the 'env:reveal' ability.",
                    required_ability: 'env:reveal',
                },
            },
        };

        const once = augmentTokenMissingAbilityMessage(error).response.data.message as string;
        const twice = augmentTokenMissingAbilityMessage(error).response.data.message as string;

        expect(twice).toBe(once);
        // Sanity check the guidance only appears a single time.
        const occurrences = twice.split('API keys').length - 1;
        expect(occurrences).toBe(1);
    });

    it('leaves an unrelated ability failure (e.g. plain "env") untouched by this branch', () => {
        const error: any = {
            response: {
                status: 403,
                data: {
                    code: 'token_missing_ability',
                    message: "This API key does not have the 'env' ability.",
                    required_ability: 'env',
                },
            },
        };

        const result = augmentTokenMissingAbilityMessage(error);
        expect(result.response.data.message).toBe("This API key does not have the 'env' ability.");
    });

    it('still appends the existing databases hint unchanged (regression)', () => {
        const error: any = {
            response: {
                status: 403,
                data: {
                    code: 'token_missing_ability',
                    message: "This API key does not have the 'databases' ability.",
                    required_ability: 'databases',
                },
            },
        };

        const result = augmentTokenMissingAbilityMessage(error);
        expect(result.response.data.message).toBe(
            "This API key does not have the 'databases' ability.\n\n"
            + 'Run `solidactions login --device` to refresh database access.',
        );
    });
});

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
        // routes: the browser sign-in first, then a key given to `login --api-key`.
        expect(message).toContain('`solidactions login` and tick "Show secret values"');
        expect(message).not.toContain('Reveal secret values');
        expect(message).not.toContain('login --device');
        expect(message).toContain('`solidactions login --api-key` with that key');
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
            + 'Run `solidactions login` to refresh database access.',
        );
    });
});

function missingAbility(ability: string, message?: string): any {
    return {
        response: {
            status: 403,
            data: {
                code: 'token_missing_ability',
                ...(message === undefined ? {} : { message }),
                required_ability: ability,
            },
        },
    };
}

describe('augmentTokenMissingAbilityMessage — fine abilities', () => {
    it.each(['deploy:edit', 'runs:read'])(
        'names the area and the fix once for a 403 missing the fine ability %s',
        (ability) => {
            const server = `This API key does not have the '${ability}' ability.`;
            const error = missingAbility(ability, server);

            const once = augmentTokenMissingAbilityMessage(error).response.data.message as string;
            const twice = augmentTokenMissingAbilityMessage(error).response.data.message as string;

            expect(once).toBe(
                `${server}\n\n`
                + `This sign-in does not allow ${ability}. `
                + 'Run "solidactions login" and turn it on, or use an API key with that ability.',
            );
            expect(twice).toBe(once);
        },
    );

    it('falls back to a default sentence when the server sent no message for a fine ability', () => {
        const message = augmentTokenMissingAbilityMessage(missingAbility('deploy:edit')).response.data.message as string;

        expect(message).toContain("This session does not have the 'deploy:edit' ability.");
        expect(message).toContain('This sign-in does not allow deploy:edit.');
    });

    it('leaves a fine ability on a non-token_missing_ability 403 untouched', () => {
        const error: any = {
            response: { status: 403, data: { code: 'forbidden', message: 'Access denied.', required_ability: 'deploy:edit' } },
        };

        expect(augmentTokenMissingAbilityMessage(error).response.data.message).toBe('Access denied.');
    });

    it('gives a fine databases ability only the database hint, not a second line', () => {
        const message = augmentTokenMissingAbilityMessage(
            missingAbility('databases:read', "This API key does not have the 'databases:read' ability."),
        ).response.data.message as string;

        expect(message).toContain('Run `solidactions login` to refresh database access.');
        expect(message).not.toContain('This sign-in does not allow');
    });
});

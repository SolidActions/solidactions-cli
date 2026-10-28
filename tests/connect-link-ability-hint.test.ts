import { describe, expect, it } from 'vitest';
import { augmentTokenMissingAbilityMessage } from '../src/utils/api';

const SERVER_MESSAGE = "This API key does not have the 'connections:request' ability.";

function missingConnectionsRequest(): any {
    return {
        response: {
            status: 403,
            data: {
                code: 'token_missing_ability',
                message: SERVER_MESSAGE,
                required_ability: 'connections:request',
            },
        },
    };
}

describe("augmentTokenMissingAbilityMessage — 'connections:request' branch", () => {
    it('keeps the server sentence and appends the re-login and API-key guidance', () => {
        const result = augmentTokenMissingAbilityMessage(missingConnectionsRequest());
        const message = result.response.data.message as string;

        expect(message.startsWith(SERVER_MESSAGE)).toBe(true);
        expect(message).toContain('solidactions login --device');
        expect(message).toContain('Settings → API keys');
        expect(message).toContain("'connections:request'");
    });

    it('is idempotent — applying it twice does not double-append the hint', () => {
        const error = missingConnectionsRequest();

        const once = augmentTokenMissingAbilityMessage(error).response.data.message as string;
        const twice = augmentTokenMissingAbilityMessage(error).response.data.message as string;

        expect(twice).toBe(once);
        expect(twice.split('Settings → API keys').length - 1).toBe(1);
    });

    it('falls back to a default sentence when the server sent no message', () => {
        const error = missingConnectionsRequest();
        delete error.response.data.message;

        const message = augmentTokenMissingAbilityMessage(error).response.data.message as string;

        expect(message).toContain("This session does not have the 'connections:request' ability.");
        expect(message).toContain('solidactions login --device');
    });

    it('returns a 403 forbidden (the user cannot build in Automate) unchanged', () => {
        const error: any = {
            response: { status: 403, data: { code: 'forbidden', message: 'Access denied.' } },
        };

        const result = augmentTokenMissingAbilityMessage(error);

        expect(result).toBe(error);
        expect(error.response.data.message).toBe('Access denied.');
    });

    it("returns a 403 naming a different ability ('env') unchanged by this branch", () => {
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
});

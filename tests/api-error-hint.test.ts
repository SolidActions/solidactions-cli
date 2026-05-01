import { describe, expect, it } from 'vitest';
import { augmentNotFoundMessage } from '../src/utils/api';

function makeAxiosError(status: number, message: string): any {
    const err: any = new Error(message);
    err.isAxiosError = true;
    err.response = { status, data: { message } };
    return err;
}

describe('augmentNotFoundMessage (axios response interceptor)', () => {
    it('appends the workspace-switch hint to a 404 "not found in your active workspace" error', () => {
        const err = makeAxiosError(404, "Project 'foo' not found in your active workspace 'mercer'.");
        const result = augmentNotFoundMessage(err);
        expect(result.response.data.message).toContain("Project 'foo' not found in your active workspace 'mercer'.");
        expect(result.response.data.message).toContain('Did you mean to switch workspaces?');
        expect(result.response.data.message).toContain("solidactions workspace set <name> --local");
    });

    it('does NOT append the hint to a 422 unique-violation message', () => {
        const err = makeAxiosError(422, "A project named 'foo' already exists in workspace 'mercer'.");
        const result = augmentNotFoundMessage(err);
        expect(result.response.data.message).toBe("A project named 'foo' already exists in workspace 'mercer'.");
        expect(result.response.data.message).not.toContain('Did you mean to switch workspaces?');
    });

    it('does NOT append the hint to a generic 500', () => {
        const err = makeAxiosError(500, 'Internal server error');
        const result = augmentNotFoundMessage(err);
        expect(result.response.data.message).toBe('Internal server error');
    });

    it('returns the error unchanged when there is no response body', () => {
        const err: any = new Error('Network error');
        err.isAxiosError = true;
        const result = augmentNotFoundMessage(err);
        expect(result).toBe(err);
    });
});

import { Readable } from 'stream';
import { describe, expect, it } from 'vitest';
import { API_KEY_PROMPT, resolveLoginApiKey } from '../src/commands/login';

describe('resolveLoginApiKey — secret-safe login input', () => {
    it('keeps the positional API key for backwards compatibility', async () => {
        await expect(resolveLoginApiKey(' legacy-key ', {})).resolves.toBe('legacy-key');
    });

    it('uses a masked prompt when the key is omitted in a TTY', async () => {
        let promptCalls = 0;

        const key = await resolveLoginApiKey(undefined, {}, {
            isTTY: true,
            prompt: async () => {
                promptCalls++;
                return ' prompted-key ';
            },
        });

        expect(key).toBe('prompted-key');
        expect(promptCalls).toBe(1);
        expect(API_KEY_PROMPT.type).toBe('password');
    });

    it('reads a key from stdin without placing it in argv', async () => {
        const key = await resolveLoginApiKey(undefined, { stdin: true }, {
            input: Readable.from([' stdin-key\n']),
            isTTY: false,
        });

        expect(key).toBe('stdin-key');
    });

    it('rejects ambiguous positional plus --stdin input', async () => {
        await expect(resolveLoginApiKey('legacy-key', { stdin: true })).rejects.toThrow(
            'Pass the API key either as the legacy positional argument or via --stdin, not both.',
        );
    });

    it('refuses an omitted key non-interactively unless --stdin is explicit', async () => {
        await expect(resolveLoginApiKey(undefined, {}, { isTTY: false })).rejects.toThrow(
            'API key is required in non-interactive mode. Pipe it with --stdin',
        );
    });

    it('rejects empty stdin and cancelled prompts', async () => {
        await expect(resolveLoginApiKey(undefined, { stdin: true }, {
            input: Readable.from(['\n']),
            isTTY: false,
        })).rejects.toThrow('API key is required.');

        await expect(resolveLoginApiKey(undefined, {}, {
            isTTY: true,
            prompt: async () => undefined,
        })).rejects.toThrow('Login cancelled.');
    });
});

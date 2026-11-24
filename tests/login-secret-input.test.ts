import { Readable } from 'stream';
import { describe, expect, it } from 'vitest';
import { API_KEY_PROMPT, resolveLoginApiKey } from '../src/commands/login';

const NOT_BOTH = 'Pass the API key one way only: --api-key KEY, --stdin, or the legacy positional argument, not more than one.';
const DEVICE_WITH_KEY = 'A key and the browser sign-in cannot be combined. Drop --device to sign in with the key, or drop the key to sign in with the browser.';

describe('resolveLoginApiKey — secret-safe login input', () => {
    it('keeps the positional API key for backwards compatibility', async () => {
        await expect(resolveLoginApiKey(' legacy-key ', {})).resolves.toEqual({ kind: 'key', apiKey: 'legacy-key' });
    });

    it('chooses the browser sign-in when no key source is given, in a terminal or not', async () => {
        await expect(resolveLoginApiKey(undefined, {}, { isTTY: true })).resolves.toEqual({ kind: 'browser' });
        await expect(resolveLoginApiKey(undefined, {}, { isTTY: false })).resolves.toEqual({ kind: 'browser' });
    });

    it('treats --device alone as the browser sign-in (accepted and ignored)', async () => {
        await expect(resolveLoginApiKey(undefined, { device: true }, { isTTY: false })).resolves.toEqual({ kind: 'browser' });
    });

    it('uses a masked prompt for --api-key with no value in a TTY', async () => {
        let promptCalls = 0;

        const decision = await resolveLoginApiKey(undefined, { apiKeyFlag: true }, {
            isTTY: true,
            prompt: async () => {
                promptCalls++;
                return ' prompted-key ';
            },
        });

        expect(decision).toEqual({ kind: 'key', apiKey: 'prompted-key' });
        expect(promptCalls).toBe(1);
        expect(API_KEY_PROMPT.type).toBe('password');
    });

    it('refuses --api-key with no value without a terminal, naming the three other ways, and never prompts', async () => {
        let promptCalls = 0;

        await expect(resolveLoginApiKey(undefined, { apiKeyFlag: true }, {
            isTTY: false,
            prompt: async () => {
                promptCalls++;
                return 'never';
            },
        })).rejects.toThrow(/--api-key KEY.*--stdin.*SOLIDACTIONS_API_KEY/);
        expect(promptCalls).toBe(0);
    });

    it('uses --api-key KEY without asking, in a terminal or not', async () => {
        let promptCalls = 0;
        const prompt = async () => {
            promptCalls++;
            return 'never';
        };

        await expect(resolveLoginApiKey(undefined, { apiKeyFlag: ' flag-key ' }, { isTTY: true, prompt }))
            .resolves.toEqual({ kind: 'key', apiKey: 'flag-key' });
        await expect(resolveLoginApiKey(undefined, { apiKeyFlag: 'flag-key' }, { isTTY: false, prompt }))
            .resolves.toEqual({ kind: 'key', apiKey: 'flag-key' });
        expect(promptCalls).toBe(0);
    });

    it('reads a key from stdin without placing it in argv, and --stdin keeps meaning the key path', async () => {
        const decision = await resolveLoginApiKey(undefined, { stdin: true }, {
            input: Readable.from([' stdin-key\n']),
            isTTY: false,
        });

        expect(decision).toEqual({ kind: 'key', apiKey: 'stdin-key' });
    });

    it('lets a valueless --api-key and --stdin together read stdin (both mean the key path)', async () => {
        const decision = await resolveLoginApiKey(undefined, { stdin: true, apiKeyFlag: true }, {
            input: Readable.from(['both-key\n']),
            isTTY: false,
        });

        expect(decision).toEqual({ kind: 'key', apiKey: 'both-key' });
    });

    it.each([
        ['a positional key plus --stdin', 'legacy-key', { stdin: true }],
        ['--api-key KEY plus --stdin', undefined, { stdin: true, apiKeyFlag: 'flag-key' }],
        ['--api-key KEY plus a positional key', 'legacy-key', { apiKeyFlag: 'flag-key' }],
        ['a valueless --api-key plus a positional key', 'legacy-key', { apiKeyFlag: true }],
    ])('rejects two key sources: %s', async (_label, positional, options) => {
        await expect(resolveLoginApiKey(positional, options, { isTTY: true })).rejects.toThrow(NOT_BOTH);
    });

    it.each([
        ['--device KEY', 'legacy-key', {}],
        ['--device --stdin', undefined, { stdin: true }],
        ['--device --api-key', undefined, { apiKeyFlag: true }],
        ['--device --api-key KEY', undefined, { apiKeyFlag: 'flag-key' }],
    ])('rejects a key combined with the browser sign-in: %s', async (_label, positional, options) => {
        await expect(resolveLoginApiKey(positional, { ...options, device: true }, { isTTY: true }))
            .rejects.toThrow(DEVICE_WITH_KEY);
    });

    it('does not read stdin or prompt when --device is combined with a key', async () => {
        let promptCalls = 0;
        const input = Readable.from(['stdin-key\n']);

        await expect(resolveLoginApiKey(undefined, { device: true, stdin: true }, {
            input,
            isTTY: true,
            prompt: async () => {
                promptCalls++;
                return 'never';
            },
        })).rejects.toThrow(DEVICE_WITH_KEY);
        expect(promptCalls).toBe(0);
        expect(input.readableDidRead).toBe(false);
    });

    it('rejects an empty positional or --api-key value instead of falling back to the browser', async () => {
        await expect(resolveLoginApiKey('', {}, { isTTY: true })).rejects.toThrow('API key is required.');
        await expect(resolveLoginApiKey(undefined, { apiKeyFlag: '' }, { isTTY: true })).rejects.toThrow('API key is required.');
    });

    it('rejects empty stdin and cancelled prompts', async () => {
        await expect(resolveLoginApiKey(undefined, { stdin: true }, {
            input: Readable.from(['\n']),
            isTTY: false,
        })).rejects.toThrow('API key is required.');

        await expect(resolveLoginApiKey(undefined, { apiKeyFlag: true }, {
            isTTY: true,
            prompt: async () => undefined,
        })).rejects.toThrow('Login cancelled.');
    });
});

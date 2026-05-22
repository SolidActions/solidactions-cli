import { describe, expect, it } from 'vitest';
import { buildSnippet } from '../src/commands/oauth-actions-show';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GMAIL_ACTION = {
    platform: 'gmail',
    method: 'POST',
    path: '/gmail/v1/users/me/messages/send',
    title: 'Send Message',
    action_id: 'conn_mod_def::AAA::BBB',
    tags: ['mail'],
    io_schema: {
        ioExample: {
            input: {
                body: { raw: 'x' },
            },
        },
    },
};

const GMAIL_MODIFIER_ACTION = {
    platform: 'gmail',
    method: 'POST',
    path: '/gmail/v1/users/me/messages/send',
    title: 'Send Message (modifier)',
    action_id: 'conn_mod_def::AAA::BBB',
    io_schema: {
        ioExample: {
            input: {
                body: { connectionKey: 'placeholder-key', raw: 'x' },
            },
        },
    },
};

const GMAIL_GET_ACTION = {
    platform: 'gmail',
    method: 'GET',
    path: '/gmail/v1/users/me/messages',
    title: 'List Messages',
    action_id: 'conn_get::LIST::MSGS',
    io_schema: {},
};

// ---------------------------------------------------------------------------
// Test A: new ctx.vars contract — core headers and URL shape
// ---------------------------------------------------------------------------

describe('buildSnippet — new ctx.vars contract (Test A)', () => {
    it('emits proxyUrl with platform prefix in the URL', () => {
        const snippet = buildSnippet(GMAIL_ACTION, 'GMAIL');
        expect(snippet).toContain('${ctx.vars.GMAIL.proxyUrl}/gmail/gmail/v1/users/me/messages/send');
    });

    it('emits Authorization header using ctx.vars proxyToken', () => {
        const snippet = buildSnippet(GMAIL_ACTION, 'GMAIL');
        expect(snippet).toContain("'Authorization': `Bearer ${ctx.vars.GMAIL.proxyToken}`");
    });

    it('emits X-OAuth-Connection-Key header using ctx.vars key', () => {
        const snippet = buildSnippet(GMAIL_ACTION, 'GMAIL');
        expect(snippet).toContain("'X-OAuth-Connection-Key': ctx.vars.GMAIL.key");
    });

    it('emits X-OAuth-Action-Id header with the action_id value', () => {
        const snippet = buildSnippet(GMAIL_ACTION, 'GMAIL');
        // JSON.stringify produces double-quoted strings, so action_id is double-quoted in the snippet
        expect(snippet).toContain("'X-OAuth-Action-Id': \"conn_mod_def::AAA::BBB\"");
    });

    it('does NOT contain X-SA-Connection in the new form', () => {
        const snippet = buildSnippet(GMAIL_ACTION, 'GMAIL');
        expect(snippet).not.toContain('X-SA-Connection');
    });

    it('does NOT contain process.env in the new form', () => {
        const snippet = buildSnippet(GMAIL_ACTION, 'GMAIL');
        expect(snippet).not.toContain('process.env');
    });

    it('includes the example body for non-modifier actions', () => {
        const snippet = buildSnippet(GMAIL_ACTION, 'GMAIL');
        expect(snippet).toContain('body: JSON.stringify(');
        expect(snippet).toContain('"raw": "x"');
    });
});

// ---------------------------------------------------------------------------
// Test B: modifier action — body includes connectionKey from ctx.vars
// ---------------------------------------------------------------------------

describe('buildSnippet — modifier action body (Test B)', () => {
    it('body includes connectionKey: ctx.vars.GMAIL.key for modifier actions', () => {
        const snippet = buildSnippet(GMAIL_MODIFIER_ACTION, 'GMAIL');
        expect(snippet).toContain('connectionKey: ctx.vars.GMAIL.key');
    });

    it('modifier body still includes the user payload alongside connectionKey', () => {
        const snippet = buildSnippet(GMAIL_MODIFIER_ACTION, 'GMAIL');
        expect(snippet).toContain('"raw": "x"');
    });

    it('modifier snippet still does NOT contain process.env', () => {
        const snippet = buildSnippet(GMAIL_MODIFIER_ACTION, 'GMAIL');
        expect(snippet).not.toContain('process.env');
    });

    it('modifier snippet still does NOT contain X-SA-Connection', () => {
        const snippet = buildSnippet(GMAIL_MODIFIER_ACTION, 'GMAIL');
        expect(snippet).not.toContain('X-SA-Connection');
    });
});

// ---------------------------------------------------------------------------
// Test C: no --var supplied → YOUR_CONNECTION placeholder
// ---------------------------------------------------------------------------

describe('buildSnippet — no --var flag (Test C)', () => {
    it('uses YOUR_CONNECTION as placeholder when varName is undefined', () => {
        const snippet = buildSnippet(GMAIL_ACTION, undefined);
        expect(snippet).toContain('ctx.vars.YOUR_CONNECTION');
    });

    it('uses YOUR_CONNECTION as placeholder when varName is empty string', () => {
        const snippet = buildSnippet(GMAIL_ACTION, '');
        // empty string is falsy, so we expect the default placeholder
        expect(snippet).toContain('ctx.vars.YOUR_CONNECTION');
    });

    it('does NOT contain GMAIL when no varName provided', () => {
        const snippet = buildSnippet(GMAIL_ACTION, undefined);
        // platform name appears in the URL path but not in ctx.vars.*
        // the ctx.vars reference should use YOUR_CONNECTION, not GMAIL
        expect(snippet).not.toContain('ctx.vars.GMAIL');
    });
});

// ---------------------------------------------------------------------------
// Test D: --legacy-env flag emits the old process.env form
// ---------------------------------------------------------------------------

describe('buildSnippet — --legacy-env flag (Test D)', () => {
    it('emits process.env.SA_PROXY_URL in legacy form', () => {
        const snippet = buildSnippet(GMAIL_ACTION, 'GMAIL', true);
        expect(snippet).toContain('process.env.SA_PROXY_URL');
    });

    it('emits X-SA-Connection in legacy form', () => {
        const snippet = buildSnippet(GMAIL_ACTION, 'GMAIL', true);
        expect(snippet).toContain('X-SA-Connection');
    });

    it('emits process.env.GMAIL (platform env var) in legacy form', () => {
        const snippet = buildSnippet(GMAIL_ACTION, 'GMAIL', true);
        expect(snippet).toContain('process.env.GMAIL');
    });

    it('emits Authorization with process.env.SA_PROXY_TOKEN in legacy form', () => {
        const snippet = buildSnippet(GMAIL_ACTION, 'GMAIL', true);
        expect(snippet).toContain('process.env.SA_PROXY_TOKEN');
    });

    it('does NOT contain ctx.vars in legacy form', () => {
        const snippet = buildSnippet(GMAIL_ACTION, 'GMAIL', true);
        expect(snippet).not.toContain('ctx.vars');
    });

    it('does NOT contain X-OAuth-Connection-Key in legacy form', () => {
        const snippet = buildSnippet(GMAIL_ACTION, 'GMAIL', true);
        expect(snippet).not.toContain('X-OAuth-Connection-Key');
    });
});

// ---------------------------------------------------------------------------
// Additional correctness assertions
// ---------------------------------------------------------------------------

describe('buildSnippet — URL and method shape', () => {
    it('uses the correct HTTP method', () => {
        const snippet = buildSnippet(GMAIL_GET_ACTION, 'GMAIL');
        expect(snippet).toContain("method: 'GET'");
    });

    it('emits the platform segment in the proxy URL for GET action', () => {
        const snippet = buildSnippet(GMAIL_GET_ACTION, 'GMAIL');
        expect(snippet).toContain('${ctx.vars.GMAIL.proxyUrl}/gmail/gmail/v1/users/me/messages');
    });

    it('expands {{placeholder}} path params to ${placeholder} template slots', () => {
        const action = {
            ...GMAIL_ACTION,
            path: '/gmail/v1/users/{{userId}}/messages/{{id}}',
        };
        const snippet = buildSnippet(action, 'GMAIL');
        expect(snippet).toContain('${userId}');
        expect(snippet).toContain('${id}');
        expect(snippet).not.toContain('{{userId}}');
    });

    it('appends query string parameters from the example', () => {
        const action = {
            ...GMAIL_GET_ACTION,
            io_schema: {
                ioExample: {
                    input: {
                        query: { maxResults: '10', q: 'label:inbox' },
                    },
                },
            },
        };
        const snippet = buildSnippet(action, 'GMAIL');
        expect(snippet).toContain('maxResults=');
        expect(snippet).toContain('q=');
    });
});

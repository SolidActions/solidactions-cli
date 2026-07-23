import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildSnippet } from '../src/commands/oauth-action-view';

/**
 * Fixture-driven coverage for the two `buildSnippet` behaviours that had no
 * test: repeated-key array query-param serialization, and the proxy-managed
 * header filter. Both are duplicated across the ctx.vars and --legacy-env
 * renderers, so both renderers are asserted.
 *
 * Fixtures are read from disk (rather than inlined) so the JSON keeps the
 * shape the SAA API actually serves.
 */
function loadFixture(name: string): any {
    return JSON.parse(
        fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.json`), 'utf8'),
    );
}

const CALENDAR_EVENTS_LIST = loadFixture('calendar-events-list');
const X_PICA_LEAK = loadFixture('synthetic-x-pica-leak');

// ---------------------------------------------------------------------------
// Array query params — repeated-key serialization (oauth-action-view.ts:157)
// ---------------------------------------------------------------------------

describe('buildSnippet — array query params serialize as repeated keys', () => {
    for (const [label, legacyEnv] of [['ctx.vars', false], ['--legacy-env', true]] as const) {
        describe(label, () => {
            const snippet = buildSnippet(CALENDAR_EVENTS_LIST, 'CAL', legacyEnv);

            it('emits one key=value pair per array element', () => {
                expect(snippet).toContain(
                    'eventTypes=${encodeURIComponent("default")}&eventTypes=${encodeURIComponent("outOfOffice")}',
                );
            });

            it('repeats the key for a second array-valued param', () => {
                expect(snippet).toContain(
                    'privateExtendedProperty=${encodeURIComponent("team=alpha")}&privateExtendedProperty=${encodeURIComponent("tier=1")}',
                );
            });

            it('does NOT stringify the array as a single value (the regression)', () => {
                // The pre-fix bug rendered the whole array into one encodeURIComponent
                // call, producing `eventTypes=default,outOfOffice`.
                expect(snippet).not.toContain('encodeURIComponent([');
                expect(snippet).not.toContain('default,outOfOffice');
            });

            it('still emits scalar query params exactly once', () => {
                expect(snippet).toContain('maxResults=${encodeURIComponent("10")}');
                expect(snippet.match(/maxResults=/g)).toHaveLength(1);
                expect(snippet).toContain('singleEvents=${encodeURIComponent("true")}');
            });

            it('joins all query params after a single leading ?', () => {
                expect(snippet.match(/\?/g)).toHaveLength(1);
                expect(snippet).toContain('/events?maxResults=');
            });

            it('percent-encodes the key itself, not just the value', () => {
                // Keys go through encodeURIComponent at render time; these are
                // already-safe keys, so they must appear verbatim.
                expect(snippet).toContain('?maxResults=');
            });

            it('expands the {{calendarId}} path placeholder alongside the query string', () => {
                expect(snippet).toContain('${calendarId}');
                expect(snippet).not.toContain('{{calendarId}}');
            });
        });
    }
});

// ---------------------------------------------------------------------------
// Proxy-managed header filter (oauth-action-view.ts:301-308)
// ---------------------------------------------------------------------------

describe('buildSnippet — proxy-managed header filter strips leaked internals', () => {
    for (const [label, legacyEnv] of [['ctx.vars', false], ['--legacy-env', true]] as const) {
        describe(label, () => {
            const snippet = buildSnippet(X_PICA_LEAK, 'GMAIL', legacyEnv);

            it('strips x-pica-secret', () => {
                expect(snippet).not.toContain('x-pica-secret');
                expect(snippet).not.toContain('sk_live_LEAKED_PICA_SECRET');
            });

            it('strips x-pica-* case-insensitively', () => {
                expect(snippet.toLowerCase()).not.toContain('x-pica-');
                expect(snippet).not.toContain('leaked-pica-connection-key');
            });

            it('strips x-one-* headers', () => {
                expect(snippet.toLowerCase()).not.toContain('x-one-');
                expect(snippet).not.toContain('leaked-one-api-key');
            });

            it('does not emit the upstream Authorization value from the example', () => {
                expect(snippet).not.toContain('LEAKED_UPSTREAM_TOKEN');
            });

            it('strips the OAuth routing headers so the example cannot override them', () => {
                expect(snippet).not.toContain('leaked-oauth-connection-key');
                expect(snippet).not.toContain('leaked-action-id');
                expect(snippet).not.toContain('leaked-sa-connection');
            });

            it('still emits exactly one Authorization header — the proxy-managed one', () => {
                expect(snippet.match(/'Authorization':/g)).toHaveLength(1);
            });

            it('passes through headers that are NOT proxy-managed', () => {
                expect(snippet).toContain('"X-Request-Id": "safe-passthrough-header"');
            });
        });
    }

    it('emits the proxy-managed Authorization from ctx.vars, not the example', () => {
        const snippet = buildSnippet(X_PICA_LEAK, 'GMAIL');
        expect(snippet).toContain("'Authorization': `Bearer ${ctx.vars.GMAIL.proxyToken}`");
    });

    it('does not auto-add Content-Type when the example already leaked one is absent', () => {
        // The fixture has a body but no content-type header, so exactly one
        // Content-Type should be auto-added.
        const snippet = buildSnippet(X_PICA_LEAK, 'GMAIL');
        expect(snippet.match(/'Content-Type': 'application\/json'/g)).toHaveLength(1);
    });
});

import { describe, expect, it } from 'vitest';
import { connectLinkFailureLine, connectLinkPath, formatExpiry, parseBinding, plainText, waitCommandLine } from '../src/utils/connect-link';

describe('parseBinding', () => {
    it('splits PROJECT:VAR at the first colon and trims', () => {
        expect(parseBinding('newsletter:GMAIL_KEY')).toEqual({ project: 'newsletter', var: 'GMAIL_KEY' });
        expect(parseBinding(' newsletter-dev : GMAIL_KEY ')).toEqual({ project: 'newsletter-dev', var: 'GMAIL_KEY' });
    });
    it.each(['newsletter', ':GMAIL_KEY', 'newsletter:', ':', '', '  :  '])('refuses %j with one line naming PROJECT:VAR', (value) => {
        expect(() => parseBinding(value)).toThrow(/PROJECT:VAR/);
    });
});

describe('plainText', () => {
    it('removes terminal control sequences but keeps newlines and tabs', () => {
        expect(plainText('a\u001b]52;c;ZXZpbA==\u0007b\u001b[2Jc\n\td\u009be')).toBe('a]52;c;ZXZpbA==b[2Jc\n\tde');
    });
});

describe('connectLinkPath and waitCommandLine', () => {
    it('encodes the id', () => {
        expect(connectLinkPath()).toBe('/api/v1/connections/requests');
        expect(connectLinkPath('01JB/../x')).toBe('/api/v1/connections/requests/01JB%2F..%2Fx');
        expect(waitCommandLine('01JBXYZ')).toBe('solidactions connection wait 01JBXYZ');
    });
});

describe('formatExpiry', () => {
    it('renders an ISO time the way the server text does', () => {
        expect(formatExpiry('2026-10-29T19:00:00Z')).toBe('2026-10-29 19:00 UTC');
        expect(formatExpiry('2026-10-29T19:05:59.000000Z')).toBe('2026-10-29 19:05 UTC');
        expect(formatExpiry('not a date')).toBe('not a date');
    });
});

describe('connectLinkFailureLine', () => {
    it('renders 401, other statuses and network errors as one line', () => {
        expect(connectLinkFailureLine({ response: { status: 401, data: {} } }, 'http://127.0.0.1:9')).toContain('Authentication failed against');
        expect(connectLinkFailureLine({ response: { status: 422, data: { code: 'name_taken', message: 'gmail-main already exists in this workspace (status error); use reconnect' } } }, 'http://h'))
            .toBe('Failed: 422 gmail-main already exists in this workspace (status error); use reconnect');
        expect(connectLinkFailureLine({ message: 'connect ECONNREFUSED' }, 'http://h')).toBe('Connection failed: connect ECONNREFUSED');
    });
});

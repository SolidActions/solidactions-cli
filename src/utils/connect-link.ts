import { authFailedLine, formatApiFailure } from './api';

export interface ConnectLinkBinding {
    project: string;
    var: string;
}

export interface ConnectLink {
    id: string;
    status: string;
    mode: 'connect' | 'reconnect';
    platform: string;
    platform_name: string;
    name: string;
    bindings: ConnectLinkBinding[];
    expires_at: string;
    url?: string;
    text?: string;
    requested_by: { type: string; label: string } | null;
    requested_at?: string;
    connection: { id: number; name: string; status: string } | null;
    connected_by: { name: string } | null;
    connected_at: string | null;
}

export const CONNECT_LINK_MAX_BINDINGS = 10;

/** 'PROJECT:VAR' → {project, var}; split at the first ':'; both sides trimmed and non-empty, else throws Error with a one-line message. */
export function parseBinding(value: string): ConnectLinkBinding {
    const index = value.indexOf(':');
    const project = index === -1 ? '' : value.slice(0, index).trim();
    const variable = index === -1 ? '' : value.slice(index + 1).trim();
    if (project === '' || variable === '') {
        throw new Error(`--bind must be PROJECT:VAR (got "${plainText(value)}")`);
    }
    return { project, var: variable };
}

/** Removes C0/C1 control characters (U+0000-U+0008, U+000B-U+001F, U+007F-U+009F), keeping '\n' and '\t'. */
export function plainText(value: string): string {
    return value.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '');
}

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,.\/-]+$/;

/**
 * Quote a value for pasting into a POSIX shell command line. Values of
 * letters, digits and a few safe punctuation marks stay bare; anything else
 * (spaces, quotes, `;`, `&`, …) is single-quoted (`'` → `'\''`), so the
 * suggestion still parses as the same single argument.
 */
export function shellArg(value: string): string {
    if (SHELL_SAFE.test(value)) {
        return value;
    }
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 'solidactions connection wait <id>' (the id is quoted unless it is shell-safe, e.g. a ULID). */
export function waitCommandLine(id: string): string {
    return `solidactions connection wait ${shellArg(id)}`;
}

/** '2026-10-29T19:00:00Z' → '2026-10-29 19:00 UTC' (the server's own `text` format); a value Date cannot parse → plainText(value); a non-string → 'unknown'. */
export function formatExpiry(iso: string): string {
    if (typeof iso !== 'string') {
        return 'unknown';
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
        return plainText(iso);
    }
    return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/** The one line for a failed request: 401 → authFailedLine(host); a response → formatApiFailure(status, data); none → 'Connection failed: <message>'. */
export function connectLinkFailureLine(error: any, host: string): string {
    if (error?.response?.status === 401) {
        return authFailedLine(host);
    }
    if (error?.response) {
        return formatApiFailure(error.response.status, error.response.data);
    }
    return `Connection failed: ${error?.message ?? String(error)}`;
}

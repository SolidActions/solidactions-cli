/**
 * Host as shown in user-facing output: a URL with any userinfo stripped
 * (credentials must never reach the terminal), otherwise shown as
 * configured. Every printed host goes through this (cli#156, cli#163);
 * tests/host-display-guard.test.ts fails on a raw host in a printed template.
 */
export function displayHost(host: string): string {
    let shown = host;
    try {
        const url = new URL(host);
        if (url.host === '') {
            // Parses as an opaque `scheme:rest` (`u:secret@host`): no authority to trust.
            shown = stripUnparsedUserinfo(host);
        } else if (url.username || url.password) {
            url.username = '';
            url.password = '';
            shown = url.toString().replace(/\/$/, '');
        }
    } catch {
        shown = stripUnparsedUserinfo(host);
    }
    return shown;
}

/**
 * True when a host carries userinfo (`user:pass@`, `user@`). axios turns URL
 * userinfo into a Basic Authorization header that replaces the CLI's API-key header, so
 * such a host can never authenticate; config resolution and login refuse it
 * (cli#195, Peter's ruling on CrewOps ask task-cliahostwithuser-922c).
 */
export function hostHasUserinfo(host: string): boolean {
    try {
        const url = new URL(host);
        if (url.host !== '') {
            return url.username !== '' || url.password !== '';
        }
    } catch {
        // Not a URL `new URL` accepts: look at the authority by hand below.
    }
    return /^([a-z][a-z0-9+.-]*:\/\/)?[^/?#]*@/i.test(host);
}

const INVALID_HOST_PLACEHOLDER = '<invalid host>';

/**
 * Fallback for a value `new URL` rejects (`http://u:secret@localhost:bad-port`),
 * which must not keep its userinfo (cli#163): cut the authority at its LAST `@`
 * (an `@` inside a password cannot leak), and if an `@` is still left after
 * that, or nothing is, show a placeholder rather than guess. A value without
 * `@` is shown as configured.
 */
function stripUnparsedUserinfo(host: string): string {
    if (!host.includes('@')) {
        return host;
    }
    const [, scheme = '', authority = '', rest = ''] = host.match(/^([a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)(.*)$/is) ?? [];
    const afterUserinfo = authority.slice(authority.lastIndexOf('@') + 1);
    if (afterUserinfo === '' || rest.includes('@')) {
        return INVALID_HOST_PLACEHOLDER;
    }
    return scheme + afterUserinfo + rest;
}

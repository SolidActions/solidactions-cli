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
        if (url.username || url.password) {
            url.username = '';
            url.password = '';
            shown = url.toString().replace(/\/$/, '');
        }
    } catch {
        // Not a URL: show it as configured.
    }
    return shown;
}

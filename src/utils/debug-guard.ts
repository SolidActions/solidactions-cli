import chalk from 'chalk';

/**
 * cli#194: keep the API key out of every debug channel.
 *
 * - `DEBUG` (the `debug` package): axios sends every request through
 *   follow-redirects, whose `debug` namespace dumps the request options (the
 *   Authorization header, a URL's userinfo). `debug` reads DEBUG once, when it
 *   first loads, and a skip (`-name`) beats any match, so appending the skip
 *   here turns that namespace off while every other one keeps working.
 * - `NODE_DEBUG` (Node's util.debuglog): the http/net/tls sections dump
 *   connection options, headers included, for the axios path and the MCP
 *   transport. Node fixes the enabled sections during bootstrap, before any
 *   user code, so they cannot be turned off here: refuse to run instead
 *   (recorded on cli#194).
 *
 * src/index.ts imports this module first, before anything can load `debug`
 * or make a request.
 */
const DEBUG_SKIP = '-follow-redirects';
const NETWORK_SECTIONS = ['http', 'https', 'http2', 'net', 'tls'];

export function guardDebugNamespaces(env: NodeJS.ProcessEnv = process.env): void {
    const value = env.DEBUG;
    if (value === undefined || value.trim() === '') {
        return;
    }
    if (value.split(/[\s,]+/).includes(DEBUG_SKIP)) {
        return;
    }
    env.DEBUG = `${value},${DEBUG_SKIP}`;
}

/** The first network section NODE_DEBUG enables, matched exactly as Node's initializeDebugEnv does; null when none. */
export function nodeDebugNetworkSection(value: string | undefined): string | null {
    if (!value) {
        return null;
    }
    const pattern = value
        .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/,/g, '$|^');
    const enabled = new RegExp(`^${pattern}$`, 'i');
    return NETWORK_SECTIONS.find((section) => enabled.test(section)) ?? null;
}

export function refuseNetworkNodeDebug(env: NodeJS.ProcessEnv = process.env): void {
    const section = nodeDebugNetworkSection(env.NODE_DEBUG);
    if (section === null) {
        return;
    }
    process.stderr.write(`${chalk.red(`error: NODE_DEBUG=${JSON.stringify(env.NODE_DEBUG)} turns on Node's "${section}" debug output, which prints request headers including your API key. Remove http, https, http2, net and tls from NODE_DEBUG (or unset it) and run again.`)}\n`);
    process.exit(1);
}

refuseNetworkNodeDebug();
guardDebugNamespaces();

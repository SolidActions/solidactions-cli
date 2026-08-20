/**
 * app#1335: `project view <name>` defaults `-e` to `dev`, silently rewrites the
 * argument to the env-suffixed slug (e.g. `smoke1329-dev`), gets a 404, and prints
 * the server's raw "not found in your active workspace" message plus a
 * "switch workspaces?" hint — even when the project family exists, just not in
 * `dev`. That names a slug the user never typed and offers the wrong remedy.
 *
 * This wires the same `describeProjectEnvironments`-style lookup already used by
 * env-list/set/reset/delete and `run start` into `project view`'s 404 branch, but
 * also emits a copy-pasteable remedy command naming the actual environment.
 *
 * Test-double policy: real in-process HTTP server (Node's http.createServer),
 * patchProcessExit + captureStderr helpers. No mock/spy/stub libraries.
 * Matches the pattern in tests/run-start-env-mismatch.test.ts. Uses
 * `projectViewWithConfig` (the injectable entry point already used by
 * tests/project-view.test.ts) so the 404 path is genuinely exercised without
 * needing on-disk config files.
 */
import * as http from 'http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { projectViewWithConfig, quoteCommandArg } from '../src/commands/project-view';
import { describeProjectEnvironments } from '../src/utils/api';
import type { Config } from '../src/utils/config';

class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

function patchProcessExit(): () => void {
    const orig = process.exit.bind(process);
    (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };
    return () => { (process as any).exit = orig; };
}

function captureStderr(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    return { lines, restore: () => { console.error = orig; } };
}

let server: http.Server;
let port: number;
let projectsListBody: Record<string, unknown>;
let projectsListStatus: number;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/api/v1/projects') {
            res.writeHead(projectsListStatus, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(projectsListStatus === 200 ? projectsListBody : { message: 'Server Error' }));
            return;
        }
        if (req.method === 'GET' && req.url?.startsWith('/api/v1/projects/')) {
            // Every project detail lookup 404s here — this suite only exercises the miss path.
            const slug = decodeURIComponent(req.url.slice('/api/v1/projects/'.length).split('?')[0]);
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                message: `Project '${slug}' not found in your active workspace 'test-workspace'.`,
            }));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: `unhandled ${req.method} ${req.url}` }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => {
        port = (server.address() as any).port;
        resolve();
    }));
});

afterAll(() => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))));

beforeEach(() => {
    projectsListBody = { data: [] };
    projectsListStatus = 200;
});

function config(): Config {
    return { host: `http://127.0.0.1:${port}`, apiKey: 'test-key', workspaceId: 'workspace-1' };
}

async function runProjectView(project: string, options: { env?: string } = {}): Promise<{ code: number | undefined; text: string }> {
    const restoreExit = patchProcessExit();
    const { lines, restore: restoreErr } = captureStderr();
    try {
        let caught: ProcessExitError | null = null;
        try {
            await projectViewWithConfig(project, options, config());
        } catch (e) {
            if (e instanceof ProcessExitError) {
                caught = e;
            } else {
                throw e;
            }
        }
        return { code: caught?.code, text: lines.join('\n') };
    } finally {
        restoreExit();
        restoreErr();
    }
}

describe('project view — env-miss remedy (app#1335)', () => {
    it('names the user-typed project (not the env-suffixed slug) and suggests the environment the family actually has', async () => {
        projectsListBody = { data: [{ name: 'smoke1329', slug: 'smoke1329', environments: ['production'], environment_details: [{ environment: 'production', slug: 'smoke1329', enabled: true }] }] };

        const { code, text } = await runProjectView('smoke1329');

        expect(code).toBe(1);
        expect(text).toContain('Project "smoke1329" has no dev environment (exists in: production).');
        expect(text).toContain('  solidactions project view smoke1329 -e production');
        expect(text.toLowerCase()).not.toContain('workspace');
        expect(text).not.toContain('smoke1329-dev');
    });

    it('falls back to the server message when the projects list and the detail 404 disagree about the requested environment', async () => {
        // GET /api/v1/projects can report `dev` as existing (environment rows can exist
        // standalone, or a row can exist before its deployment lands) even though the
        // detail endpoint 404s for that exact slug. Claiming "has no dev environment"
        // against a list that says dev exists would be self-contradictory, so the CLI
        // says nothing it can't stand behind and lets the server's message through.
        projectsListBody = { data: [{
            name: 'smoke1329',
            slug: 'smoke1329',
            environments: ['production', 'dev'],
            environment_details: [
                { environment: 'production', slug: 'smoke1329', enabled: true },
                { environment: 'dev', slug: 'smoke1329-dev', enabled: true },
            ],
        }] };

        const { code, text } = await runProjectView('smoke1329');

        expect(code).toBe(1);
        expect(text).toContain("Project 'smoke1329-dev' not found in your active workspace 'test-workspace'.");
        expect(text).not.toMatch(/has no .* environment/);
    });

    it('suggests the environment\'s real slug — not the name the user typed — for a name-typed argument', async () => {
        // `project view` passes a production argument through un-slugified, so echoing
        // back "My App" would print a remedy that 404s in its turn (the detail route
        // binds on the strict slug). Drive the suggestion off environment_details.
        projectsListBody = { data: [{
            name: 'My App',
            slug: 'my-app',
            environments: ['production'],
            environment_details: [{ environment: 'production', slug: 'my-app', enabled: true }],
        }] };

        const { code, text } = await runProjectView('My App');

        expect(code).toBe(1);
        expect(text).toContain('Project "My App" has no dev environment (exists in: production).');
        expect(text).toContain('  solidactions project view my-app -e production');
        expect(text).not.toContain('project view My App');
    });

    it('falls back to the server message when the environment discovery call itself fails', async () => {
        projectsListStatus = 500;

        const { code, text } = await runProjectView('smoke1329');

        expect(code).toBe(1);
        expect(text).toContain("Project 'smoke1329-dev' not found in your active workspace 'test-workspace'.");
        expect(text).toContain('Did you mean to switch workspaces?');
        expect(text).not.toMatch(/has no .* environment/);
    });

    it('falls back to the server message and workspace hint when the only reported environment is the one that just 404d', async () => {
        projectsListBody = { data: [{ name: 'smoke1329', slug: 'smoke1329', environments: ['dev'], environment_details: [{ environment: 'dev', slug: 'smoke1329-dev', enabled: true }] }] };

        const { code, text } = await runProjectView('smoke1329');

        expect(code).toBe(1);
        expect(text).toContain("Project 'smoke1329-dev' not found in your active workspace 'test-workspace'.");
        expect(text).toContain('Did you mean to switch workspaces?');
        expect(text).not.toMatch(/has no .* environment/);
    });

    it('falls back to the server message and workspace hint when the family exists in no environment', async () => {
        projectsListBody = { data: [] };

        const { code, text } = await runProjectView('smoke1329');

        expect(code).toBe(1);
        expect(text).toContain("Project 'smoke1329-dev' not found in your active workspace 'test-workspace'.");
        expect(text).toContain('Did you mean to switch workspaces?');
    });

    it('falls back to the server message and workspace hint when nothing by that name is visible in this workspace', async () => {
        projectsListBody = { data: [{ name: 'other-project', slug: 'other-project', environments: ['production', 'dev'] }] };

        const { code, text } = await runProjectView('smoke1329');

        expect(code).toBe(1);
        expect(text).toContain('Did you mean to switch workspaces?');
        expect(text).not.toMatch(/has no .* environment/);
    });
});

describe('describeProjectEnvironments (refactor pin — must stay byte-identical for existing callers)', () => {
    it('returns the joined env list for a two-env family', async () => {
        projectsListBody = { data: [{ name: 'smoke1329', slug: 'smoke1329', environments: ['production', 'dev'] }] };

        await expect(describeProjectEnvironments(config(), 'smoke1329')).resolves.toBe('production, dev');
    });

    it('returns null when the project is absent from the workspace', async () => {
        projectsListBody = { data: [] };

        await expect(describeProjectEnvironments(config(), 'smoke1329')).resolves.toBeNull();
    });
});

describe('quoteCommandArg', () => {
    it('leaves an ordinary slug bare', () => {
        expect(quoteCommandArg('my-app')).toBe('my-app');
    });

    it('single-quotes an argument containing whitespace so the printed remedy survives a shell', () => {
        expect(quoteCommandArg('my app')).toBe("'my app'");
    });

    it('escapes an embedded single quote', () => {
        expect(quoteCommandArg("pete's app")).toBe("'pete'\\''s app'");
    });
});

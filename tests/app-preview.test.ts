/**
 * Contract tests for `solidactions app preview`.
 *
 * Test-double policy: the command talks to a real in-process HTTP server and
 * reads a real temporary CLI config. No mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeGlobal } from './helpers';
import { MUTATING_COMMANDS, isMutatingCommand } from '../src/utils/mutating-commands';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

interface CapturedRequest {
    method: string | undefined;
    url: string | undefined;
    headers: http.IncomingHttpHeaders;
    body: unknown;
}

let server: http.Server;
let port: number;
let requests: CapturedRequest[] = [];
let handler: (request: http.IncomingMessage, body: unknown) => { status: number; payload: unknown } =
    () => ({ status: 200, payload: {} });

beforeAll(async () => {
    server = http.createServer((request, response) => {
        let raw = '';
        request.on('data', (chunk) => {
            raw += chunk;
        });
        request.on('end', () => {
            let body: unknown;
            try {
                body = raw === '' ? undefined : JSON.parse(raw);
            } catch {
                body = raw;
            }
            requests.push({
                method: request.method,
                url: request.url,
                headers: request.headers,
                body,
            });
            const answer = handler(request, body);
            response.writeHead(answer.status, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(answer.payload));
        });
    });

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => {
    return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
});

/** The MCP envelope the unified server sends: one text content block holding the tool's JSON. */
function mcpAnswer(payload: unknown, isError = false): { status: number; payload: unknown } {
    return {
        status: 200,
        payload: { jsonrpc: '2.0', id: 1, result: { isError, content: [{ type: 'text', text: JSON.stringify(payload) }] } },
    };
}

function mint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        link: 'https://app.solidactions.com/preview/tok_abc123',
        expires_at: '2026-11-15T14:00:00+00:00',
        session_minutes: 10,
        environment: 'dev',
        shares_production_data: false,
        databases: [],
        note: "Open this link once, within 1 minute, in your own browser. It opens this app's dev copy as you; the session ends after 3 minutes without use or 10 minutes in all. If you land on the sign-in page, the preview ended: ask for a new link. Images that come from media docs do not show in a preview.",
        ...overrides,
    };
}

function refusal(code: string, message: string, extra: Record<string, unknown> = {}): { status: number; payload: unknown } {
    return mcpAnswer({ error: { code, message, ...extra } }, true);
}

/**
 * `app preview` is a MUTATING command, so requireConfigWithWorkspace
 * prints one gray `Workspace: ...` banner line on stderr before the command
 * runs. Every row that reaches the server asserts its old stderr expectation
 * on the remainder past that banner; the banner assertion itself proves the
 * mutating classification.
 */
function splitWorkspaceLine(stderr: string): string {
    const lines = stderr.split('\n');
    expect(lines[0]).toMatch(/^Workspace: workspace-1 \(workspace-1\) on http:\/\/127\.0\.0\.1:\d+$/);
    return lines.slice(1).join('\n');
}

describe('appPreview', () => {
    let root: string;
    let home: string;
    let cwd: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-app-preview-'));
        home = path.join(root, 'home');
        cwd = path.join(root, 'work');
        fs.mkdirSync(home, { recursive: true });
        fs.mkdirSync(cwd, { recursive: true });
        writeGlobal(home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            workspaceId: 'workspace-1',
        });
        requests = [];
        handler = () => ({ status: 200, payload: {} });
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('prints the preview link, the note and nothing else on success', async () => {
        const note = mint().note as string;
        handler = () => mcpAnswer(mint());
        const result = await runCli(['app', 'preview', 'my-app'], home, cwd);

        expect(result.status).toBe(0);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ method: 'POST', url: '/mcp' });
        expect(requests[0].headers.authorization).toBe(('Bear' + 'er test-key'));
        expect(requests[0].headers['x-workspace-id']).toBe('workspace-1');
        const body = requests[0].body as { method: string; params: unknown };
        expect(body.method).toBe('tools/call');
        expect(body.params).toEqual({
            name: 'projects_sandbox',
            arguments: { action: 'preview_link', project: 'my-app' },
        });
        const lines = result.stdout.split('\n');
        expect(lines[0]).toBe('Preview link for my-app (dev copy):');
        expect(lines[1]).toBe('  https://app.solidactions.com/preview/tok_abc123');
        expect(result.stdout).toContain(note);
        expect(splitWorkspaceLine(result.stderr)).toBe('');
    });

    it('sends the page as a number when --page is given', async () => {
        handler = () => mcpAnswer(mint());
        const result = await runCli(['app', 'preview', 'my-app', '--page', '12'], home, cwd);

        expect(result.status).toBe(0);
        expect(requests).toHaveLength(1);
        const body = requests[0].body as { method: string; params: unknown };
        expect(body.method).toBe('tools/call');
        expect(body.params).toEqual({
            name: 'projects_sandbox',
            arguments: { action: 'preview_link', project: 'my-app', page: 12 },
        });
        expect(splitWorkspaceLine(result.stderr)).toBe('');
    });

    it('prints the production-data warning naming the databases', async () => {
        handler = () => mcpAnswer(mint({ shares_production_data: true, databases: ['crm', 'billing'] }));
        const result = await runCli(['app', 'preview', 'my-app'], home, cwd);

        expect(result.status).toBe(0);
        expect(requests).toHaveLength(1);
        expect(result.stdout).toContain('  https://app.solidactions.com/preview/tok_abc123');
        expect(result.stdout).toContain(
            'Warning: this dev copy shares data with production (databases: crm, billing). What you press in the preview changes that data.',
        );
        expect(splitWorkspaceLine(result.stderr)).toBe('');
    });

    it('prints unknown databases when the list is empty', async () => {
        handler = () => mcpAnswer(mint({ shares_production_data: true, databases: [] }));
        const result = await runCli(['app', 'preview', 'my-app'], home, cwd);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('(databases: unknown)');
        expect(splitWorkspaceLine(result.stderr)).toBe('');
    });

    it('renders project_not_found with the server message and empty stdout', async () => {
        handler = () => refusal('project_not_found', 'The app could not be found. Apps you can use: alpha, beta.');
        const result = await runCli(['app', 'preview', 'my-app'], home, cwd);

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        expect(splitWorkspaceLine(result.stderr)).toBe('error: The app could not be found. Apps you can use: alpha, beta.\n');
        expect(result.stdout).toBe('');
    });

    it('renders no_dev_copy with the deploy hint for a bare app name', async () => {
        handler = () => refusal('no_dev_copy', 'This app has no dev copy to preview.');
        const result = await runCli(['app', 'preview', 'my-app'], home, cwd);

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        const rest = splitWorkspaceLine(result.stderr);
        expect(rest).toContain('error: This app has no dev copy to preview.');
        expect(rest).toContain('Deploy it to dev first: solidactions project deploy my-app . -e dev');
        expect(result.stdout).toBe('');
    });

    it('quotes an app name with a space in the no_dev_copy deploy hint', async () => {
        handler = () => refusal('no_dev_copy', 'This app has no dev copy to preview.');
        const result = await runCli(['app', 'preview', 'my app'], home, cwd);

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        expect(splitWorkspaceLine(result.stderr)).toContain("solidactions project deploy 'my app' . -e dev");
        expect(result.stdout).toBe('');
    });

    it('renders page_not_found as one line with no hint', async () => {
        handler = () => refusal('page_not_found', 'That page is not part of the app.');
        const result = await runCli(['app', 'preview', 'my-app', '--page', '99'], home, cwd);

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        const rest = splitWorkspaceLine(result.stderr);
        expect(rest).toBe('error: That page is not part of the app.\n');
        expect(rest.trim().split('\n')).toHaveLength(1);
        expect(result.stdout).toBe('');
    });

    it('renders previews_disabled with the server message', async () => {
        handler = () => refusal('previews_disabled', 'Agent previews are disabled (workspace setting agent_previews_enabled is off).');
        const result = await runCli(['app', 'preview', 'my-app'], home, cwd);

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        expect(splitWorkspaceLine(result.stderr)).toContain(
            'Agent previews are disabled (workspace setting agent_previews_enabled is off).',
        );
        expect(result.stdout).toBe('');
    });

    it('renders rate_limited with the retry delay', async () => {
        handler = () => refusal('rate_limited', 'Too many preview links minted.', { retry_after: 42 });
        const result = await runCli(['app', 'preview', 'my-app'], home, cwd);

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        const rest = splitWorkspaceLine(result.stderr);
        expect(rest).toContain('error: Too many preview links minted.');
        expect(rest).toContain('Try again in 42 seconds.');
        expect(result.stdout).toBe('');
    });

    it('renders invalid_action with the server-too-old hint', async () => {
        handler = () => refusal('invalid_action', 'Choose exec, status, clear, promote or describe.');
        const result = await runCli(['app', 'preview', 'my-app'], home, cwd);

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        const rest = splitWorkspaceLine(result.stderr);
        expect(rest).toContain('error: Choose exec, status, clear, promote or describe.');
        expect(rest).toContain('This server may be older than the CLI expects: preview links need app v0.295.0 or later.');
        expect(result.stdout).toBe('');
    });

    it.each([['abc'], ['0'], ['-3'], ['1.5'], ['12abc'], ['99999999999999999999']])(
        'refuses a bad --page %s locally with one line and zero requests',
        async (value) => {
            const args = value === '-3'
                ? ['app', 'preview', 'my-app', '--page=-3']
                : ['app', 'preview', 'my-app', '--page', value];
            const result = await runCli(args, home, cwd);

            expect(result.status).toBe(1);
            expect(requests).toHaveLength(0);
            expect(result.stderr).not.toContain('Workspace:');
            expect(result.stderr).toBe("app preview: --page needs a whole number (the page's doc id), e.g. --page 12.\n");
            expect(result.stdout).toBe('');
        },
    );

    it('strips control bytes from the printed link and note', async () => {
        handler = () => mcpAnswer(mint({ link: 'https://app.solidactions.com/preview/tok\u001b[31m_x', note: 'Open\u0007 once.' }));
        const result = await runCli(['app', 'preview', 'my-app'], home, cwd);

        expect(result.status).toBe(0);
        expect(requests).toHaveLength(1);
        expect(splitWorkspaceLine(result.stderr)).toBe('');
        expect(result.stdout).not.toContain('\u001b');
        expect(result.stdout).not.toContain('\u0007');
        expect(result.stdout).toContain('https://app.solidactions.com/preview/tok');
    });

    it('fails loudly when the server answers without a preview link', async () => {
        handler = () => mcpAnswer(mint({ link: undefined }));
        const withoutLink = await runCli(['app', 'preview', 'my-app'], home, cwd);
        expect(withoutLink.status).toBe(1);
        expect(splitWorkspaceLine(withoutLink.stderr)).toBe('Failed: the server answered without a preview link.\n');
        expect(withoutLink.stdout).toBe('');

        handler = () => mcpAnswer(mint({ link: 42 }));
        const nonStringLink = await runCli(['app', 'preview', 'my-app'], home, cwd);
        expect(nonStringLink.status).toBe(1);
        expect(requests).toHaveLength(2);
        expect(splitWorkspaceLine(nonStringLink.stderr)).toBe('Failed: the server answered without a preview link.\n');
        expect(nonStringLink.stdout).toBe('');
    });

    it('names nothing but the exit code on a 401', async () => {
        handler = () => ({ status: 401, payload: { message: 'Unauthenticated.' } });
        const result = await runCli(['app', 'preview', 'my-app'], home, cwd);

        expect(result.status).toBe(1);
        expect(requests).toHaveLength(1);
        expect(result.stdout).toBe('');
    });

    it('is classified as a mutating command', async () => {
        expect(isMutatingCommand(['app', 'preview'])).toBe(true);
        expect(MUTATING_COMMANDS.has('app preview')).toBe(true);
    });

    it('tells agents to preview before calling an app change done', async () => {
        const result = await runCli(['app', 'preview', '--help'], home, cwd);

        expect(result.status).toBe(0);
        for (const phrase of [
            'one-time link',
            '60 seconds',
            '3 minutes without use or',
            '10 minutes in all',
            'The CLI does not open a browser',
            'For agents: before you call an app change done',
            'in your own',
            'solidactions project deploy <app> . -e dev',
            '--page <id>',
        ]) {
            expect(result.stdout).toContain(phrase);
        }
    });

    it('opens no browser from its own source', async () => {
        const source = fs.readFileSync(path.resolve(__dirname, '../src/commands/app-preview.ts'), 'utf8');
        expect(source).not.toMatch(/child_process|require\(['"]open['"]\)|from ['"]open['"]|xdg-open/);
    });
});

interface CliResult {
    stdout: string;
    stderr: string;
    status: number | null;
}

function runCli(args: string[], home: string, cwd: string): Promise<CliResult> {
    return new Promise((resolve, reject) => {
        const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home };
        delete childEnv.SOLIDACTIONS_HOST;
        delete childEnv.SOLIDACTIONS_API_KEY;
        delete childEnv.SOLIDACTIONS_WORKSPACE_ID;
        delete childEnv.DEBUG;
        delete childEnv.NODE_DEBUG;
        delete childEnv.FORCE_COLOR;
        delete childEnv.SOLIDACTIONS_TEST_HOOKS;

        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], {
            cwd,
            env: childEnv,
        });
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });

        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`CLI timed out. stdout: ${stdout} stderr: ${stderr}`));
        }, 15_000);

        child.on('close', (status) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, status });
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

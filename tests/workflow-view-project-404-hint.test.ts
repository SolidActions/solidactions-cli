/**
 * `workflow view` for a project that exists only in another environment
 * (cli#161): the 404 must name the environment gap, not blame the workspace,
 * and a typed mixed-case project name must resolve through the shared resolver.
 * A real in-process HTTP server, a real temp HOME, the real built CLI; no
 * mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as http from 'http';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpEnv, writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

const WORKSPACE_BLAME_BODY = {
    message: "Project 'clitrustsmoke-dev' not found in your active workspace 'test-workspace'. Did you mean to switch workspaces?",
};

const WORKFLOW_DATA = {
    type: 'workflow',
    name: 'Hello',
    slug: 'hello',
    enabled: true,
    enabled_source: 'yaml',
    retired: false,
    project_enabled: true,
    effective_enabled: true,
    project_name: 'CliTrustSmoke',
    project_slug: 'clitrustsmoke-dev',
    environment: 'dev',
};

let familyRows: object[] = [];
/** Project slugs the server knows, by exact slug. */
let knownProjectSlugs: string[] = [];
let requestedUrls: string[] = [];
let server: http.Server;
let port: number;

beforeAll(async () => {
    server = http.createServer((request, response) => {
        request.resume();
        const url = request.url ?? '';
        requestedUrls.push(url);
        response.setHeader('Content-Type', 'application/json');

        if (url === '/api/v1/projects') {
            response.writeHead(200);
            response.end(JSON.stringify({ data: familyRows }));
            return;
        }

        const workflowRoute = url.match(/^\/api\/v1\/projects\/([^/?]+)\/workflows\/[^/?]+$/);
        if (workflowRoute && knownProjectSlugs.includes(decodeURIComponent(workflowRoute[1]))) {
            response.writeHead(200);
            response.end(JSON.stringify({ data: WORKFLOW_DATA }));
            return;
        }

        const projectRoute = url.match(/^\/api\/v1\/projects\/([^/?]+)$/);
        if (projectRoute && knownProjectSlugs.includes(decodeURIComponent(projectRoute[1]))) {
            response.writeHead(200);
            response.end(JSON.stringify({ slug: decodeURIComponent(projectRoute[1]) }));
            return;
        }

        response.writeHead(404);
        response.end(JSON.stringify(WORKSPACE_BLAME_BODY));
    });
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
}));

interface CliResult {
    stdout: string;
    stderr: string;
    status: number | null;
}

function runCli(args: string[], home: string, cwd: string): Promise<CliResult> {
    return new Promise((resolve, reject) => {
        const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1' };
        delete childEnv.SOLIDACTIONS_HOST;
        delete childEnv.SOLIDACTIONS_API_KEY;
        delete childEnv.SOLIDACTIONS_WORKSPACE_ID;

        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], { cwd, env: childEnv });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });

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

function failureLines(stderr: string): string[] {
    return stderr
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.includes('AGENT NOTE') && !line.startsWith('Workspace:'));
}

describe('workflow view 404 for a project that exists in another environment', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'test-key', workspaceId: 'workspace-1' });
        familyRows = [];
        knownProjectSlugs = [];
        requestedUrls = [];
    });
    afterEach(() => env.cleanup());

    it('a production-only family gets the no-dev-environment hint, not the workspace-switching message, and exit 1', async () => {
        familyRows = [{
            name: 'CliTrustSmoke',
            slug: 'clitrustsmoke',
            environments: ['production'],
            environment_details: [{ environment: 'production', slug: 'clitrustsmoke' }],
        }];

        const result = await runCli(['workflow', 'view', 'CliTrustSmoke', 'Hello'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(failureLines(result.stderr)).toEqual([
            'Project "CliTrustSmoke" has no dev environment (exists in: production). Pass -e <env> to target a different environment.',
        ]);
        expect(result.stderr).not.toContain('switch workspaces');
    });

    it("a project missing from every environment prints the server's message", async () => {
        familyRows = [];

        const result = await runCli(['workflow', 'view', 'CliTrustSmoke', 'Hello'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(failureLines(result.stderr)).toEqual([WORKSPACE_BLAME_BODY.message]);
    });

    it("a family that has the requested environment prints the server's message, not the hint", async () => {
        familyRows = [{
            name: 'CliTrustSmoke',
            slug: 'clitrustsmoke',
            environments: ['production', 'dev'],
            environment_details: [],
        }];

        const result = await runCli(['workflow', 'view', 'CliTrustSmoke', 'Hello'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(failureLines(result.stderr)).toEqual([WORKSPACE_BLAME_BODY.message]);
    });

    it('a typed mixed-case project name resolves through the shared resolver and the view succeeds', async () => {
        knownProjectSlugs = ['clitrustsmoke-dev'];

        const result = await runCli(['workflow', 'view', 'CliTrustSmoke', 'Hello'], env.home, env.cwd);

        expect(result.status).toBe(0);
        expect(result.stderr.split('\n').filter((line) => line.includes('not found'))).toEqual([]);
        expect(result.stdout).toContain('Workflow: Hello');
        expect(result.stdout).toContain('Project slug: clitrustsmoke-dev');
        expect(requestedUrls).toEqual([
            '/api/v1/projects/CliTrustSmoke-dev',
            '/api/v1/projects/clitrustsmoke-dev',
            '/api/v1/projects/clitrustsmoke-dev/workflows/Hello',
        ]);
    });
});

/**
 * `workflow view` on a project that lacks the targeted environment (cli#179):
 * the 404 used to read "Project 'x-dev' not found in your active workspace"
 * with no hint that the project exists in another environment. It now names the
 * environments the project does have, through the command's own display()
 * sanitiser, and still never calls the shared slug resolver (a read-only token
 * may not read the single-project route, so the resolver would break it).
 * A real in-process HTTP server, a real temp HOME, the real built CLI; no
 * mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as http from 'http';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpEnv, writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

const WORKFLOW = {
    type: 'workflow',
    name: 'Hello',
    slug: 'hello',
    enabled: true,
    enabled_source: 'manual',
    retired: false,
    project_enabled: true,
    effective_enabled: true,
    project_name: 'CliTrustSmoke',
    project_slug: 'clitrustsmoke',
    environment: 'production',
};

const FAMILY = [
    { name: 'CliTrustSmoke', slug: 'clitrustsmoke', environments: ['production'] },
    { name: 'Cli\nTrust', slug: 'cli-trust', environments: ['production'] },
];

let server: http.Server;
let port: number;
let requests: string[] = [];
let projectReadStatus = 200;

beforeAll(async () => {
    server = http.createServer((request, response) => {
        request.resume();
        const url = request.url ?? '';
        requests.push(`${request.method} ${url}`);
        const json = (status: number, body: unknown) => {
            response.writeHead(status, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(body));
        };

        if (url === '/api/v1/projects' || /^\/api\/v1\/projects\/[^/?]+$/.test(url)) {
            if (projectReadStatus !== 200) {
                json(projectReadStatus, { message: 'This action is unauthorized.' });
                return;
            }
            json(200, url === '/api/v1/projects' ? { data: FAMILY } : { slug: 'clitrustsmoke' });
            return;
        }

        const workflowRoute = url.match(/^\/api\/v1\/projects\/([^/]+)\/workflows\/([^/?]+)$/);
        if (workflowRoute && workflowRoute[1] === 'clitrustsmoke' && workflowRoute[2] === 'hello') {
            json(200, { data: WORKFLOW });
            return;
        }
        json(404, { message: `Project '${workflowRoute?.[1] ?? 'x'}' not found in your active workspace 'ws'.` });
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

describe('workflow view names the missing environment (cli#179)', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();
        requests = [];
        projectReadStatus = 200;
        writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'test-key', workspaceId: 'ws-1' });
    });
    afterEach(() => env.cleanup());

    it('says the project has no dev environment and where it does exist', async () => {
        const result = await runCli(['workflow', 'view', 'CliTrustSmoke', 'Hello'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            'Project "CliTrustSmoke" has no dev environment (exists in: production). Pass -e <env> to target a different environment.',
        );
        expect(result.stderr).not.toContain('active workspace');
    });

    it('views the production workflow on the canonical slug without the single-project lookup', async () => {
        const result = await runCli(['workflow', 'view', 'CliTrustSmoke', 'hello', '-e', 'production'], env.home, env.cwd);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Workflow:');
        expect(requests[0]).toBe('GET /api/v1/projects/clitrustsmoke/workflows/hello');
        expect(requests.filter((request) => /^GET \/api\/v1\/projects\/[^/?]+$/.test(request))).toEqual([]);
    });

    it('still views the workflow when a read-only token is refused the project reads', async () => {
        projectReadStatus = 403;

        const result = await runCli(['workflow', 'view', 'CliTrustSmoke', 'hello', '-e', 'production'], env.home, env.cwd);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Workflow:');
    });

    it('keeps the server message for a project that is in no environment', async () => {
        const result = await runCli(['workflow', 'view', 'NoSuch', 'hello'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Project 'nosuch-dev' not found in your active workspace 'ws'.");
        expect(result.stderr).not.toContain('has no dev environment');
    });

    it('prints a project name with a newline through display(), never raw', async () => {
        const result = await runCli(['workflow', 'view', 'Cli\nTrust', 'hello'], env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('has no dev environment');
        expect(result.stderr).not.toMatch(/Project "[^"]*\n[^"]*" has no/);
        expect(result.stderr).toContain(
            'Project "CliTrust" has no dev environment (exists in: production). Pass -e <env> to target a different environment.',
        );
    });
});

/**
 * Contract tests for project/workflow enable and disable.
 *
 * The real built CLI talks to an in-process HTTP server and reads a real
 * temporary config, so registration, argument parsing, request shape, output,
 * and exit status are covered together without mocks.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

interface CapturedRequest {
    method: string | undefined;
    url: string | undefined;
    headers: http.IncomingHttpHeaders;
    body: unknown;
}

interface QueuedResponse {
    status: number;
    body: object;
}

let server: http.Server;
let port: number;
let requests: CapturedRequest[] = [];
let responses: QueuedResponse[] = [];
let temporaryRoots: string[] = [];

beforeAll(async () => {
    server = http.createServer((request, response) => {
        let rawBody = '';
        request.on('data', (chunk) => { rawBody += chunk; });
        request.on('end', () => {
            const body = rawBody ? JSON.parse(rawBody) : null;
            requests.push({
                method: request.method,
                url: request.url,
                headers: request.headers,
                body,
            });

            const queued = responses.shift();
            if (queued) {
                response.writeHead(queued.status, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(queued.body));
                return;
            }

            const enabled = (body as { enabled?: boolean } | null)?.enabled === true;
            const workflowMatch = request.url?.match(/\/workflows\/([^/]+)\/enabled$/);
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({
                data: workflowMatch
                    ? {
                        type: 'workflow',
                        name: decodeURIComponent(workflowMatch[1]),
                        slug: decodeURIComponent(workflowMatch[1]),
                        enabled,
                        project_name: 'billing',
                        project_slug: request.url?.split('/projects/')[1]?.split('/')[0],
                        environment: request.url?.includes('-staging/')
                            ? 'staging'
                            : request.url?.includes('-dev/') ? 'dev' : 'production',
                    }
                    : {
                        type: 'project',
                        name: 'billing',
                        slug: request.url?.split('/projects/')[1]?.split('/')[0],
                        enabled,
                        environment: request.url?.includes('-staging/')
                            ? 'staging'
                            : request.url?.includes('-dev/') ? 'dev' : 'production',
                    },
            }));
        });
    });

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
}));

beforeEach(() => {
    requests = [];
    responses = [];
});

afterEach(() => {
    for (const root of temporaryRoots) {
        fs.rmSync(root, { recursive: true, force: true });
    }
    temporaryRoots = [];
});

function configuredHome(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-state-'));
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    writeGlobal(home, {
        host: `http://127.0.0.1:${port}`,
        apiKey: 'state-test-key',
        workspaceId: 'workspace-state-1',
    });
    temporaryRoots.push(root);
    return home;
}

interface CliResult {
    stdout: string;
    stderr: string;
    status: number | null;
}

function runCli(args: string[], home = configuredHome()): Promise<CliResult> {
    return new Promise((resolve, reject) => {
        const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home };
        delete environment.SOLIDACTIONS_HOST;
        delete environment.SOLIDACTIONS_API_KEY;
        delete environment.SOLIDACTIONS_WORKSPACE_ID;

        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], {
            env: environment,
        });
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

describe('project and workflow state command registration', () => {
    it.each([
        ['project', 'enable', '<project>'],
        ['project', 'disable', '<project>'],
        ['workflow', 'enable', '<project> <workflow>'],
        ['workflow', 'disable', '<project> <workflow>'],
    ])('registers solidactions %s %s with dev-default environment help', async (noun, verb, argumentsLabel) => {
        const result = await runCli([noun, verb, '--help']);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain(`Usage: solidactions ${noun} ${verb} [options] ${argumentsLabel}`);
        expect(result.stdout).toContain('-e, --env <environment>');
        expect(result.stdout).toMatch(/Defaults to\s+dev/i);
    });
});

describe('project state mutations', () => {
    it('defaults disable to dev and PUTs the exact body with workspace headers', async () => {
        const result = await runCli(['project', 'disable', 'billing']);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(requests).toEqual([expect.objectContaining({
            method: 'PUT',
            url: '/api/v1/projects/billing-dev/enabled',
            body: { enabled: false },
        })]);
        expect(requests[0].headers.authorization).toBe('Bearer state-test-key');
        expect(requests[0].headers['x-workspace-id']).toBe('workspace-state-1');
        expect(requests[0].headers['content-type']).toMatch(/^application\/json/);
        expect(result.stdout).toContain('Project "billing" (dev) disabled.');
        expect(result.stdout).toContain('New root starts are blocked');
        expect(result.stdout).toContain('CLI/API, schedules, webhooks, MCP, manual dead-letter retry, and manual rerun');
        expect(result.stdout).toContain('Already-created roots continue');
        expect(result.stdout).toContain('queued work, automatic retries, child legs, sleeping/signal-waiting phases, and running work');
        expect(result.stdout).toContain('Deploy will not undo this manual state.');
        expect(result.stdout).toContain('solidactions project enable billing --env dev');
        expect(result.stdout).not.toMatch(/confirm|continue\?/i);
    });

    it.each([
        ['enable', 'production', '/api/v1/projects/billing/enabled', true],
        ['disable', 'staging', '/api/v1/projects/billing-staging/enabled', false],
    ])('resolves project %s --env %s and sends the explicit state', async (verb, environment, url, enabled) => {
        const result = await runCli(['project', verb, 'billing', '--env', environment]);

        expect(result.status).toBe(0);
        expect(requests).toEqual([expect.objectContaining({ method: 'PUT', url, body: { enabled } })]);
        expect(requests[0].headers.authorization).toBe('Bearer state-test-key');
        expect(requests[0].headers['x-workspace-id']).toBe('workspace-state-1');
    });

    it('resolves the normalized production base slug and suffixes non-production environments', async () => {
        const production = await runCli(['project', 'enable', 'Billing API', '--env', 'production']);
        const staging = await runCli(['project', 'enable', 'Billing API', '--env', 'staging']);

        expect(production.status).toBe(0);
        expect(staging.status).toBe(0);
        expect(requests.map((request) => request.url)).toEqual([
            '/api/v1/projects/billing-api/enabled',
            '/api/v1/projects/billing-api-staging/enabled',
        ]);
    });

    it('prints the remaining workflow and schedule gates after enabling, including an idempotent response', async () => {
        responses.push({
            status: 200,
            body: { data: { type: 'project', name: 'billing', slug: 'billing-dev', environment: 'dev', enabled: true } },
        });

        const result = await runCli(['project', 'enable', 'billing']);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Project "billing" (dev) enabled.');
        expect(result.stdout).toContain('Direct starts require an enabled target workflow');
        expect(result.stdout).toContain('Scheduled starts additionally require an enabled schedule');
        expect(result.stdout).toContain('does not enable its workflows or schedules');
        expect(result.stdout).toContain('solidactions project disable billing --env dev');
    });
});

describe('workflow state mutations', () => {
    it('defaults enable to dev and PUTs the exact nested body with workspace headers', async () => {
        const result = await runCli(['workflow', 'enable', 'billing', 'daily-report']);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(requests).toEqual([expect.objectContaining({
            method: 'PUT',
            url: '/api/v1/projects/billing-dev/workflows/daily-report/enabled',
            body: { enabled: true },
        })]);
        expect(requests[0].headers.authorization).toBe('Bearer state-test-key');
        expect(requests[0].headers['x-workspace-id']).toBe('workspace-state-1');
        expect(result.stdout).toContain('Workflow "daily-report" in project "billing" (dev) enabled.');
        expect(result.stdout).toContain('Direct starts require an enabled parent project');
        expect(result.stdout).toContain('Scheduled starts additionally require an enabled schedule');
        expect(result.stdout).toContain('does not enable its project or schedule');
        expect(result.stdout).toContain('Deploy will not undo this manual state.');
        expect(result.stdout).toContain('solidactions workflow disable billing daily-report --env dev');
    });

    it.each([
        ['enable', 'production', '/api/v1/projects/billing/workflows/daily-report/enabled', true],
        ['disable', 'staging', '/api/v1/projects/billing-staging/workflows/daily-report/enabled', false],
    ])('resolves workflow %s --env %s and sends the explicit state', async (verb, environment, url, enabled) => {
        const result = await runCli(['workflow', verb, 'billing', 'daily-report', '-e', environment]);

        expect(result.status).toBe(0);
        expect(requests).toEqual([expect.objectContaining({ method: 'PUT', url, body: { enabled } })]);
        expect(requests[0].headers.authorization).toBe('Bearer state-test-key');
        expect(requests[0].headers['x-workspace-id']).toBe('workspace-state-1');
    });

    it('prints the full disable blast radius and inverse command for an idempotent response', async () => {
        responses.push({
            status: 200,
            body: {
                data: {
                    type: 'workflow',
                    name: 'daily-report',
                    slug: 'daily-report',
                    enabled: false,
                    project_name: 'billing',
                    project_slug: 'billing-dev',
                    environment: 'dev',
                },
            },
        });

        const result = await runCli(['workflow', 'disable', 'billing', 'daily-report']);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('New root starts are blocked');
        expect(result.stdout).toContain('Already-created roots continue');
        expect(result.stdout).toContain('Deploy will not undo this manual state.');
        expect(result.stdout).toContain('solidactions workflow enable billing daily-report --env dev');
    });
});

describe('state command failures', () => {
    it.each([
        [401, { message: 'Unauthenticated.' }, /Authentication failed/i],
        [404, { message: 'Project not found.' }, /Project not found/i],
        [409, { error: 'workflow_retired', message: 'Workflow is not part of the current deployment.' }, /not part of the current deployment/i],
        [422, { message: 'The enabled field must be true or false.', errors: { enabled: ['The enabled field must be true or false.'] } }, /enabled field must be true or false/i],
        [500, { message: 'State service unavailable.' }, /State service unavailable/i],
    ])('uses existing error conventions and exits non-zero for HTTP %s', async (status, body, expected) => {
        responses.push({ status, body });

        const result = await runCli(['workflow', 'disable', 'billing', 'daily-report']);

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(expected);
        // workflow disable is a mutating command — requireConfigWithWorkspace() always
        // announces the resolved workspace before the command runs, even on a subsequent
        // failure (#1437).
        expect(result.stdout).toBe('Workspace: workspace-state-1 (workspace-state-1)\n');
    });

    it('rejects an unsupported environment without sending a request', async () => {
        const result = await runCli(['project', 'enable', 'billing', '--env', 'qa']);

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/production.*staging.*dev/i);
        expect(requests).toHaveLength(0);
    });
});

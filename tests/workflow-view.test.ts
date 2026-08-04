/**
 * Contract tests for `solidactions workflow view`.
 *
 * These exercise the built CLI against a real local HTTP server so command
 * registration, argument parsing, environment resolution, request shape,
 * output safety, and exit conventions stay pinned together.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCommandManifest } from '../src/utils/command-manifest';
import { workflowEffectiveState } from '../src/utils/workflow-state';
import { writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');
const pkg = require('../package.json');

interface CapturedRequest {
    method: string | undefined;
    url: string | undefined;
    headers: http.IncomingHttpHeaders;
    rawBody: string;
}

interface QueuedResponse {
    status: number;
    body: object;
}

const baseData = {
    type: 'workflow',
    name: 'Daily Report',
    slug: 'daily-report',
    enabled: true,
    enabled_source: 'manual',
    retired: false,
    project_enabled: true,
    effective_enabled: true,
    project_name: 'Billing',
    project_slug: 'billing-dev',
    environment: 'dev',
};

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
            requests.push({
                method: request.method,
                url: request.url,
                headers: request.headers,
                rawBody,
            });

            const queued = responses.shift() ?? { status: 200, body: { data: baseData } };
            response.writeHead(queued.status, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(queued.body));
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

function configuredHome(host = `http://127.0.0.1:${port}`): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-workflow-view-'));
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    writeGlobal(home, {
        host,
        apiKey: 'workflow-view-key',
        workspaceId: 'workspace-view-1',
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
        const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1' };
        delete environment.SOLIDACTIONS_HOST;
        delete environment.SOLIDACTIONS_API_KEY;
        delete environment.SOLIDACTIONS_WORKSPACE_ID;

        const child = childProcess.spawn(process.execPath, [CLI_BINARY, ...args], { env: environment });
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

describe('workflow view registration and resolution', () => {
    it('registers view with explanatory dev-default help and JSON output', async () => {
        const result = await runCli(['workflow', 'view', '--help']);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('Usage: solidactions workflow view [options] <project> <workflow>');
        expect(result.stdout).toContain('-e, --env <environment>');
        expect(result.stdout).toContain('--json');
        expect(result.stdout).toMatch(/defaults? to dev/i);
        expect(result.stdout).toMatch(/project view/i);
        expect(result.stdout).toMatch(/exact slug/i);
    });

    it('appears in the generated command manifest with its arguments and flags', () => {
        const { program } = require(CLI_BINARY);
        const manifest = buildCommandManifest(program, pkg.version);
        const command = manifest.commands.find((entry) => entry.path.join(' ') === 'workflow view');

        expect(command).toBeDefined();
        expect(command!.arguments.map((argument) => argument.name)).toEqual(['project', 'workflow']);
        expect(command!.options.map((option) => option.long)).toEqual(expect.arrayContaining(['--env', '--json']));
    });

    it('defaults to dev and sends a bodyless GET with auth and workspace headers', async () => {
        const result = await runCli(['workflow', 'view', 'Billing API', 'Daily Report']);

        expect(result.status).toBe(0);
        expect(requests).toEqual([expect.objectContaining({
            method: 'GET',
            url: '/api/v1/projects/billing-api-dev/workflows/Daily%20Report',
            rawBody: '',
        })]);
        expect(requests[0].headers.authorization).toBe('Bearer workflow-view-key');
        expect(requests[0].headers['x-workspace-id']).toBe('workspace-view-1');
        expect(requests[0].headers.accept).toBe('application/json');
        expect(requests[0].headers['content-type']).toBeUndefined();
    });

    it.each([
        ['production', '/api/v1/projects/billing-api/workflows/daily-report'],
        ['staging', '/api/v1/projects/billing-api-staging/workflows/daily-report'],
        ['dev', '/api/v1/projects/billing-api-dev/workflows/daily-report'],
    ])('uses shared state slug resolution for explicit %s', async (environment, url) => {
        const result = await runCli(['workflow', 'view', 'Billing API', 'daily-report', '--env', environment]);

        expect(result.status).toBe(0);
        expect(requests).toEqual([expect.objectContaining({ method: 'GET', url })]);
    });

    it('keeps project view exact-slug behavior while workflow view defaults to dev', async () => {
        const workflow = await runCli(['workflow', 'view', 'billing', 'daily-report']);
        const project = await runCli(['project', 'view', 'billing']);

        expect(workflow.status).toBe(0);
        expect(project.status).toBe(0);
        expect(requests.map((request) => request.url)).toEqual([
            '/api/v1/projects/billing-dev/workflows/daily-report',
            '/api/v1/projects/billing?include=deployment',
        ]);
    });
});

describe('workflow view rendering', () => {
    it.each([
        [{ retired: true, enabled: false, project_enabled: false, effective_enabled: false }, 'retired'],
        [{ retired: false, enabled: false, project_enabled: false, effective_enabled: false }, 'off'],
        [{ retired: false, enabled: true, project_enabled: false, effective_enabled: false }, 'blocked (project off)'],
        [{ retired: false, enabled: true, project_enabled: true, effective_enabled: true }, 'on'],
    ])('renders resolved identity and the %s state precedence', async (state, expected) => {
        responses.push({ status: 200, body: { data: { ...baseData, ...state } } });

        const result = await runCli(['workflow', 'view', 'alias', 'lookup-name']);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('Workflow: Daily Report');
        expect(result.stdout).toContain('Slug: daily-report');
        expect(result.stdout).toContain('Project: Billing');
        expect(result.stdout).toContain('Project slug: billing-dev');
        expect(result.stdout).toContain('Environment: dev');
        expect(result.stdout).toContain(`Workflow enabled: ${state.enabled ? 'on' : 'off'}`);
        expect(result.stdout).toContain(`Project enabled: ${state.project_enabled ? 'on' : 'off'}`);
        expect(result.stdout).toContain(`Retired: ${state.retired ? 'yes' : 'no'}`);
        expect(result.stdout).toContain(`Effective state: ${expected}`);
    });

    it.each([
        ['manual', 'manual override (deploy will not change it)'],
        ['yaml', 'YAML declaration'],
    ])('explains the %s enabled source', async (enabledSource, label) => {
        responses.push({ status: 200, body: { data: { ...baseData, enabled_source: enabledSource } } });

        const result = await runCli(['workflow', 'view', 'billing', 'daily-report']);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`Enabled source: ${label}`);
    });

    it('gives the retired+non-overridden state distinct wording instead of a bare YAML declaration claim', async () => {
        // Retirement nulls the app's yaml_enabled column, but enabled_source
        // still reports 'yaml' for a non-overridden retired workflow (the API
        // shape is unchanged — see app plan decision ledger for #1098's PM fix
        // round). "YAML declaration" alone would contradict `Retired: yes`.
        responses.push({
            status: 200,
            body: { data: { ...baseData, enabled_source: 'yaml', retired: true, effective_enabled: false } },
        });

        const result = await runCli(['workflow', 'view', 'billing', 'daily-report']);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Enabled source: YAML-managed (retired)');
        expect(result.stdout).toContain('Retired: yes');
    });

    it('keeps the manual override wording for a retired workflow with a manual override', async () => {
        responses.push({
            status: 200,
            body: { data: { ...baseData, enabled_source: 'manual', retired: true, effective_enabled: false } },
        });

        const result = await runCli(['workflow', 'view', 'billing', 'daily-report']);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Enabled source: manual override (deploy will not change it)');
    });

    it('treats a retired workflow as readable state, not an error', async () => {
        responses.push({
            status: 200,
            body: { data: { ...baseData, retired: true, effective_enabled: false } },
        });

        const result = await runCli(['workflow', 'view', 'billing', 'daily-report']);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('Retired: yes');
        expect(result.stdout).toContain('Effective state: retired');
    });

    it('writes only the unmodified server data object with --json', async () => {
        const data = { ...baseData, extra_future_field: { still: 'present' } };
        responses.push({ status: 200, body: { data } });

        const result = await runCli(['workflow', 'view', 'billing', 'daily-report', '--json']);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toEqual(data);
        expect(result.stdout).toBe(`${JSON.stringify(data, null, 2)}\n`);
    });

    it('removes terminal controls and bidi formatting from server identities', async () => {
        responses.push({
            status: 200,
            body: {
                data: {
                    ...baseData,
                    name: 'Daily\u001b[31m\nReport\u202e',
                    slug: 'daily\r-report',
                    project_name: 'Bill\u0000ing',
                    project_slug: 'billing\u200b-dev',
                    environment: 'd\tev',
                },
            },
        });

        const result = await runCli(['workflow', 'view', 'billing', 'daily-report']);

        expect(result.status).toBe(0);
        expect(result.stdout).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f\u202e\u200b]/);
        expect(result.stdout).toContain('Workflow: Daily[31mReport');
        expect(result.stdout).toContain('Project slug: billing-dev');
    });
});

describe('workflow view failures', () => {
    it.each([
        [403, { error: 'token_missing_ability', message: 'Token is missing the deploy:read ability.' }, /missing the deploy:read ability/i],
        [404, { error: 'workflow_not_found', message: 'Workflow not found.' }, /Workflow not found/i],
        [500, { error: 'server_error', message: 'Workflow state unavailable.' }, /Workflow state unavailable/i],
    ])('uses existing error and non-zero exit conventions for HTTP %s', async (status, body, expected) => {
        responses.push({ status, body });

        const result = await runCli(['workflow', 'view', 'billing', 'daily-report']);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(expected);
    });

    it('tells the operator to re-authenticate on HTTP 401', async () => {
        responses.push({
            status: 401,
            body: { code: 'unauthenticated', message: 'Unauthenticated.' },
        });

        const result = await runCli(['workflow', 'view', 'billing', 'daily-report']);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('Authentication failed. Run "solidactions login --global" to re-configure.');
    });

    it('prints safe ambiguity candidates and tells the operator to retry with a slug', async () => {
        responses.push({
            status: 409,
            body: {
                // The GET workflow endpoint uses the v1 {code, message} convention.
                code: 'ambiguous_workflow',
                message: 'More than one workflow has that name.',
                candidates: [
                    { slug: 'daily\n-report', retired: false },
                    { slug: 'daily-old\u001b[31m', retired: true },
                ],
            },
        });

        const result = await runCli(['workflow', 'view', 'billing', 'Daily Report']);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('More than one workflow has that name.');
        expect(result.stderr).toContain('daily-report (active)');
        expect(result.stderr).toContain('daily-old[31m (retired)');
        expect(result.stderr).toMatch(/re-run.*exact slug/i);
        expect(result.stderr).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f\u202e\u200b]/);
    });

    it('falls back to the legacy error key for ambiguity detection defensively', async () => {
        responses.push({
            status: 409,
            body: {
                error: 'ambiguous_workflow',
                message: 'More than one workflow has that name.',
                candidates: [{ slug: 'daily-report', retired: false }],
            },
        });

        const result = await runCli(['workflow', 'view', 'billing', 'Daily Report']);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('More than one workflow has that name.');
        expect(result.stderr).toContain('daily-report (active)');
    });

    it('reports network failures and exits non-zero', async () => {
        const result = await runCli(
            ['workflow', 'view', 'billing', 'daily-report'],
            configuredHome('http://127.0.0.1:1'),
        );

        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(/Connection failed/i);
    });

    it('rejects an invalid environment before making a request', async () => {
        const result = await runCli(['workflow', 'view', 'billing', 'daily-report', '--env', 'qa']);

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/production.*staging.*dev/i);
        expect(requests).toHaveLength(0);
    });
});

describe('shared workflow effective-state precedence', () => {
    it.each([
        [{ retired: true, enabled: true, project_enabled: true }, 'retired'],
        [{ retired: false, enabled: false, project_enabled: true }, 'off'],
        [{ retired: false, enabled: true, project_enabled: false }, 'blocked (project off)'],
        [{ retired: false, enabled: true, project_enabled: true }, 'on'],
    ])('derives $expected', (state, expected) => {
        expect(workflowEffectiveState(state)).toBe(expected);
    });
});

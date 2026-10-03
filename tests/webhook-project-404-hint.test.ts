/**
 * `webhook list` / `webhook secret` for a project that exists only in another
 * environment (cli#161): the 404 must name the environment gap, not claim the
 * project is missing. A real in-process HTTP server, a real temp HOME, the real
 * built CLI; no mock/spy/stub libraries.
 */
import * as childProcess from 'child_process';
import * as http from 'http';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpEnv, writeGlobal } from './helpers';

const CLI_BINARY = path.resolve(__dirname, '../dist/index.js');

const NOT_FOUND_BODY = { message: "Project 'clitrustsmoke-dev' not found in your active workspace 'test-workspace'. Did you mean to switch workspaces?" };

let familyRows: object[] = [];
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
        response.writeHead(404);
        response.end(JSON.stringify(NOT_FOUND_BODY));
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

/** The failure lines on stderr: the AGENT NOTE, Workspace banner and environment-note lines are not the command's own failure. */
function failureLines(stderr: string): string[] {
    return stderr
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== ''
            && !line.includes('AGENT NOTE')
            && !line.startsWith('Workspace:')
            && !line.startsWith('(environment:'));
}

const PRODUCTION_ONLY_FAMILY = [{
    name: 'CliTrustSmoke',
    slug: 'clitrustsmoke',
    environments: ['production'],
    environment_details: [{ environment: 'production', slug: 'clitrustsmoke' }],
}];

const COMMANDS: Array<[string, string[]]> = [
    ['webhook list', ['webhook', 'list', 'CliTrustSmoke']],
    ['webhook secret', ['webhook', 'secret', 'CliTrustSmoke']],
];

describe('webhook 404 for a project that exists in another environment', () => {
    let env: ReturnType<typeof makeTmpEnv>;

    beforeEach(() => {
        env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${port}`, apiKey: 'test-key', workspaceId: 'workspace-1' });
        familyRows = [];
        requestedUrls = [];
    });
    afterEach(() => env.cleanup());

    it.each(COMMANDS)('%s: a production-only family gets the no-dev-environment hint and exit 1', async (_name, args) => {
        familyRows = PRODUCTION_ONLY_FAMILY;

        const result = await runCli(args, env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(failureLines(result.stderr)).toEqual([
            'Project "CliTrustSmoke" has no dev environment (exists in: production). Pass -e <env> to target a different environment.',
        ]);
        expect(result.stderr).not.toContain('not found');
    });

    it.each(COMMANDS)("%s: a project missing from every environment prints the server's message", async (_name, args) => {
        familyRows = [];

        const result = await runCli(args, env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(failureLines(result.stderr)).toEqual([`Failed: 404 ${NOT_FOUND_BODY.message}`]);
    });

    it.each(COMMANDS)("%s: a family that has the requested environment prints the server's message, not the hint", async (_name, args) => {
        familyRows = [{ ...PRODUCTION_ONLY_FAMILY[0], environments: ['production', 'dev'] }];

        const result = await runCli(args, env.home, env.cwd);

        expect(result.status).toBe(1);
        expect(failureLines(result.stderr)).toEqual([`Failed: 404 ${NOT_FOUND_BODY.message}`]);
    });

    it.each(COMMANDS)('%s: resolves the typed project through the shared resolver (typed slug, then the canonical slug) before the webhooks request', async (_name, args) => {
        familyRows = PRODUCTION_ONLY_FAMILY;

        await runCli(args, env.home, env.cwd);

        expect(requestedUrls.slice(0, 2)).toEqual([
            '/api/v1/projects/CliTrustSmoke-dev',
            '/api/v1/projects/clitrustsmoke-dev',
        ]);
    });
});

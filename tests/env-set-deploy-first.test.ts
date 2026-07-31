import * as http from 'http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { envSet } from '../src/commands/env-set';
import { makeTmpEnv, writeGlobal } from './helpers';

class ProcessExitError extends Error {
    constructor(public readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}

let server: http.Server;
let port: number;
let projectRows: Array<{ name: string; slug: string; environments: string[] }> = [];

beforeAll(async () => {
    server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url?.match(/\/api\/v1\/projects\/.+\/variable-mappings\/bulk/)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'Project not found.' }));
            return;
        }
        if (req.method === 'GET' && req.url === '/api/v1/projects') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: projectRows }));
            return;
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: `Unexpected ${req.method} ${req.url}` }));
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
    projectRows = [];
});

async function failedEnvSet(
    project: string,
    options: { yes: true; env?: string },
): Promise<string> {
    const env = makeTmpEnv();
    writeGlobal(env.home, {
        host: `http://127.0.0.1:${port}`,
        apiKey: 'test-key',
        workspaceId: 'ws-1',
    });
    const originalExit = process.exit.bind(process);
    const originalError = console.error;
    const lines: string[] = [];
    (process as any).exit = (code?: number) => { throw new ProcessExitError(code); };
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };

    try {
        await expect(envSet(project, 'API_KEY', 'secret', options))
            .rejects.toMatchObject({ code: 1 });
        return lines.join('\n');
    } finally {
        (process as any).exit = originalExit;
        console.error = originalError;
        env.cleanup();
    }
}

describe('env set missing environment deploy-first hint', () => {
    it('prints the exact production creation command with the actual project', async () => {
        projectRows = [{ name: 'X', slug: 'X', environments: ['dev'] }];

        const output = await failedEnvSet('X', { yes: true, env: 'production' });

        expect(output).toContain('Project "X" has no production environment (exists in: dev).');
        expect(output).toContain(
            "Run 'solidactions project deploy X -e production --create' first.",
        );
    });

    it('uses the default dev environment in the creation command', async () => {
        projectRows = [{ name: 'my-project', slug: 'my-project', environments: ['production'] }];

        const output = await failedEnvSet('my-project', { yes: true });

        expect(output).toContain('Project "my-project" has no dev environment (exists in: production).');
        expect(output).toContain(
            "Run 'solidactions project deploy my-project -e dev --create' first.",
        );
    });

    it('preserves the plain prefix and creation command when discovery returns null', async () => {
        const output = await failedEnvSet('missing-project', { yes: true, env: 'production' });

        expect(output).toContain('Project "missing-project" has no production environment.');
        expect(output).toContain(
            "Run 'solidactions project deploy missing-project -e production --create' first.",
        );
    });
});

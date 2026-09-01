/**
 * #140 — `env pull` must EXPLAIN an absent database credential, not silently
 * skip it.
 *
 * A mapped database always pulls with a null value: the platform deliberately
 * refuses to resolve database credentials to a command that writes a file.
 * Rendered as a blank, that absence reads as broken or unsupported — the exact
 * misreading that made an AI agent conclude direct database access was
 * impossible. It is a security posture, so it must SAY so in both places
 * someone looks: the CLI output and the written `.env` at the variable's own
 * position. Both end with one copy-pasteable next step naming the real env.
 *
 * Real in-process HTTP stub, real temp dirs, real stdout capture. No mocks.
 */

import fs from 'fs';
import http from 'http';
import path from 'path';
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { envPull, devEnvHintLine } from '../src/commands/env-pull';
import { makeTmpEnv, writeGlobal } from './helpers';

/** Strip chalk's SGR sequences so assertions read the plain copy. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (s: string): string => s.replace(ANSI, '');

const FIXTURE_VARS = [
    { env_name: 'PLAIN', resolved_value: 'plain-value', source_type: 'plain', is_secret: false },
    {
        env_name: 'APP_DB',
        resolved_value: null,
        source_type: 'workspace_database',
        workspace_database_name: 'orders',
        is_secret: false,
    },
    {
        // Bound only by its YAML declaration — the display name must still resolve.
        env_name: 'REPORTS_DB',
        resolved_value: null,
        source_type: 'workspace_database',
        workspace_database_name: null,
        yaml_default_workspace_database_name: 'reports',
        is_secret: false,
    },
];

let stubServer: http.Server;
let stubPort: number;

beforeAll(async () => {
    stubServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(FIXTURE_VARS));
    });
    await new Promise<void>((resolve) => {
        stubServer.listen(0, '127.0.0.1', () => {
            stubPort = (stubServer.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => new Promise<void>((resolve, reject) => {
    stubServer.close((err) => (err ? reject(err) : resolve()));
}));

describe('env pull — mapped database explanation', () => {
    let env: ReturnType<typeof makeTmpEnv>;
    let logged: string[];
    let originalLog: typeof console.log;

    beforeEach(() => {
        env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${stubPort}`, apiKey: 'test-key', workspaceId: 'ws-1' });
        logged = [];
        originalLog = console.log;
        console.log = (...args: unknown[]) => { logged.push(args.join(' ')); };
    });

    afterEach(() => {
        console.log = originalLog;
        env.cleanup();
    });

    async function pull(environment = 'staging'): Promise<{ content: string; output: string }> {
        const outputPath = path.join(env.cwd, `.env.${environment}`);
        await envPull('my-project', { env: environment, output: outputPath, yes: true });
        return {
            content: fs.readFileSync(outputPath, 'utf8'),
            output: stripAnsi(logged.join('\n')),
        };
    }

    it('never renders a mapped database as a bare "no value configured" blank', async () => {
        const { content } = await pull();
        expect(content).not.toContain('# APP_DB= (no value configured)');
        expect(content).not.toContain('# REPORTS_DB= (no value configured)');
        // And no credential is ever written.
        expect(content).not.toContain('libsql://');
    });

    it("writes the explanation into the .env at the variable's own position", async () => {
        const { content } = await pull();
        const lines = content.split('\n');

        const at = lines.findIndex((l) => l.startsWith('# APP_DB: mapped database'));
        expect(at).toBeGreaterThan(-1);
        expect(lines[at]).toContain('(orders)');
        expect(lines[at]).toContain('Credentials resolve live at run time via');
        expect(lines[at + 1]).toContain("'solidactions dev --env staging'");
        expect(lines[at + 1]).toContain('never stored in this file');

        // The plain var is still written, and the database block sits with its
        // own variable rather than being collected into a footer.
        expect(content).toContain('PLAIN=plain-value');
        expect(lines.findIndex((l) => l.startsWith('# REPORTS_DB: mapped database'))).toBeGreaterThan(at);
    });

    it('falls back to the YAML-declared database name when the mapping carries none', async () => {
        const { content } = await pull();
        expect(content).toContain('# REPORTS_DB: mapped database (reports).');
    });

    it('prints a CLI note per mapped database', async () => {
        const { output } = await pull();
        expect(output).toContain(
            'NOTE: APP_DB is a mapped database (orders) — credentials are resolved live at run time '
            + "('solidactions dev --env staging' locally, automatic in deployed workflows) "
            + 'and are never written to files.',
        );
        expect(output).toContain('NOTE: REPORTS_DB is a mapped database (reports)');
    });

    it('ends BOTH surfaces with the copy-pasteable hint naming the pulled env', async () => {
        const { content, output } = await pull('staging');
        const hint = devEnvHintLine('staging');

        expect(hint).toBe(
            'To run locally with live platform vars + this database: '
            + 'solidactions dev <your-workflow-file> --env staging',
        );
        // In the .env, as a comment line.
        expect(content).toContain(`# ${hint}`);
        // In the CLI output.
        expect(output).toContain(hint);
    });

    it('substitutes the ACTUAL pulled env, not a hardcoded default', async () => {
        const { content, output } = await pull('production');
        expect(content).toContain(devEnvHintLine('production'));
        expect(output).toContain(devEnvHintLine('production'));
        expect(content).not.toContain('--env dev');
        expect(content).toContain("'solidactions dev --env production'");
    });
});

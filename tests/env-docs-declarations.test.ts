/**
 * cli#230 (docs-access-w1) — `parseYamlEnvVars` parses the `docs:` YAML form
 * the same way it parses `database:` and `oauth:`:
 *
 *   - POSTS:
 *       docs: "Content/Posts"
 *
 * and `env list` shows a `docs_node` mapping as `docs: <path>`. A real
 * in-process HTTP server backs the `env list` rows; no mocks, spies or stubs.
 */
import * as http from 'http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { envList } from '../src/commands/env-list';
import { parseYamlEnvVars, SolidActionsConfig } from '../src/utils/env';
import { makeTmpEnv, writeGlobal } from './helpers';

function configWithEnv(env: SolidActionsConfig['env']): SolidActionsConfig {
    return { workflows: [], env };
}

describe('parseYamlEnvVars: docs form', () => {
    it('parses a docs binding', () => {
        const [v] = parseYamlEnvVars(configWithEnv([{ POSTS: { docs: 'Content/Posts' } }]));

        expect(v).toMatchObject({
            key: 'POSTS',
            docsPath: 'Content/Posts',
            mappedTo: null,
            oauthName: null,
            databaseName: null,
        });
    });

    it.each([[{ docs: '' }], [{ docs: '   ' }], [{ docs: 3 }]])('refuses %j', (value) => {
        const config = configWithEnv([{ POSTS: value as { docs: string } }]);

        expect(() => parseYamlEnvVars(config)).toThrow(
            "Invalid env config for POSTS: 'docs' must be a non-empty string",
        );
    });

    it('classifies plain, mapped, oauth, database and docs declarations independently', () => {
        const parsed = parseYamlEnvVars(configWithEnv([
            'PLAIN_VAR',
            { MAPPED: 'GLOBAL_KEY' },
            { GCAL: { oauth: 'Google Calendar' } },
            { MYDB: { database: 'analytics' } },
            { POSTS: { docs: 'Content/Posts' } },
        ]));

        expect(parsed).toEqual([
            { key: 'PLAIN_VAR', mappedTo: null, oauthName: null, databaseName: null, docsPath: null },
            { key: 'MAPPED', mappedTo: 'GLOBAL_KEY', oauthName: null, databaseName: null, docsPath: null },
            { key: 'GCAL', mappedTo: null, oauthName: 'Google Calendar', databaseName: null, docsPath: null },
            { key: 'MYDB', mappedTo: null, oauthName: null, databaseName: 'analytics', docsPath: null },
            { key: 'POSTS', mappedTo: null, oauthName: null, databaseName: null, docsPath: 'Content/Posts' },
        ]);
    });
});

const DOCS_FOLDER_MAPPING = {
    id: 51,
    env_name: 'POSTS',
    source_type: 'docs_node',
    yaml_default_docs_path: 'Content/Posts',
    docs_node_type: 'folder',
    global_variable_key: null,
    has_value: false,
    is_secret: false,
    resolved_value: null,
    oauth_connection_id: null,
    workspace_database_broken: false,
    yaml_default_not_found: false,
};

let responseBody: unknown[] = [];
let server: http.Server;
let port: number;

beforeAll(async () => {
    server = http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(responseBody));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
});

afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
});

describe('env list: docs_node mappings', () => {
    let env: ReturnType<typeof makeTmpEnv>;
    let originalLog: typeof console.log;
    let output: string[];

    beforeEach(() => {
        env = makeTmpEnv();
        writeGlobal(env.home, {
            host: `http://127.0.0.1:${port}`,
            apiKey: 'test-key',
            workspaceId: 'workspace-1',
        });
        responseBody = [];
        output = [];
        originalLog = console.log;
        console.log = (...parts: unknown[]) => output.push(parts.map(String).join(' '));
    });

    afterEach(() => {
        console.log = originalLog;
        env.cleanup();
    });

    it('renders a docs binding as type docs with its path as the source and no value', async () => {
        responseBody = [DOCS_FOLDER_MAPPING];

        await envList('social-stats');

        const row = output.find((line) => line.includes('POSTS'));
        expect(row).toBeDefined();
        expect(row).toMatch(/POSTS\s+-\s+docs\s+Content\/Posts/);
    });

    it('keeps a current local override ahead of a docs binding', async () => {
        responseBody = [{
            ...DOCS_FOLDER_MAPPING,
            env_name: 'OVERRIDDEN_LOCAL',
            source_type: 'local',
            has_value: true,
            value: 'local-value',
            resolved_value: 'local-value',
        }];

        await envList('social-stats');

        const row = output.find((line) => line.includes('OVERRIDDEN_LOCAL'));
        expect(row).toMatch(/OVERRIDDEN_LOCAL\s+local-value\s+project var\s+local/);
        expect(row).not.toContain('docs');
    });
});

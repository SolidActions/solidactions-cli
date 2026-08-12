/**
 * Issue #1201 — database mappings must be diagnosable in the human table while
 * `--json` remains the raw API projection. Uses a real in-process HTTP server;
 * no mocks, spies, or request stubs.
 */
import * as http from 'http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { envList } from '../src/commands/env-list';
import { makeTmpEnv, writeGlobal } from './helpers';

const HEALTHY_DATABASE_MAPPING = {
    env_name: 'SYNC_DB',
    source_type: 'workspace_database',
    workspace_database_id: '85dc58d9-c8db-491a-81c4-e92b126e1b20',
    workspace_database_name: 'calendar-sync',
    workspace_database_broken: false,
    yaml_default_not_found: false,
    status: 'yaml_default',
};

const DELETED_DATABASE_MAPPING = {
    id: 42,
    env_name: 'DELETED_DB',
    global_variable_id: null,
    global_variable_key: null,
    value: null,
    is_secret: false,
    has_value: false,
    plain_value: null,
    yaml_default_global_id: null,
    yaml_default_global_key: null,
    yaml_default_oauth_connection_name: null,
    yaml_default_workspace_database_name: 'archived-reports',
    source_type: 'workspace_database',
    oauth_connection_id: null,
    oauth_connection_name: null,
    workspace_database_id: 'dfdd4541-664a-414b-a69c-d2a3f8c1fb47',
    workspace_database_name: null,
    workspace_database_broken: true,
    source: 'yaml',
    status: 'yaml_default',
    global_not_found: false,
    yaml_default_not_found: false,
    resolved_value: null,
    token_expires_at: null,
    oauth_warning: null,
};

const UNRESOLVED_DATABASE_MAPPING = {
    id: 43,
    env_name: 'PENDING_DB',
    global_variable_id: null,
    global_variable_key: null,
    value: null,
    is_secret: false,
    has_value: false,
    plain_value: null,
    yaml_default_global_id: null,
    yaml_default_global_key: null,
    yaml_default_oauth_connection_name: null,
    yaml_default_workspace_database_name: 'not-yet-created',
    source_type: 'global_variable',
    oauth_connection_id: null,
    oauth_connection_name: null,
    workspace_database_id: null,
    workspace_database_name: null,
    workspace_database_broken: false,
    source: 'yaml',
    status: 'yaml_default',
    global_not_found: false,
    yaml_default_not_found: true,
    resolved_value: null,
    token_expires_at: null,
    oauth_warning: null,
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

describe('env list database mappings', () => {
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

    it('renders the real healthy mapping shape as a database with no credential value', async () => {
        responseBody = [HEALTHY_DATABASE_MAPPING];

        await envList('calendar-worker');

        const row = output.find((line) => line.includes('SYNC_DB'));
        expect(row).toBeDefined();
        expect(row).toMatch(/SYNC_DB\s+-\s+database\s+calendar-sync/);
    });

    it('renders a deleted database target with its YAML name and a missing marker', async () => {
        responseBody = [DELETED_DATABASE_MAPPING];

        await envList('calendar-worker');

        const row = output.find((line) => line.includes('DELETED_DB'));
        expect(row).toMatch(/DELETED_DB\s+-\s+database\s+archived-reports \(missing\)/);
    });

    it('renders an unresolved YAML database default without keying on source_type', async () => {
        responseBody = [UNRESOLVED_DATABASE_MAPPING];

        await envList('calendar-worker');

        const row = output.find((line) => line.includes('PENDING_DB'));
        expect(row).toMatch(/PENDING_DB\s+-\s+database\s+not-yet-created \(not configured\)/);
    });

    it('keeps a current global override ahead of unresolved YAML database metadata', async () => {
        responseBody = [{
            ...UNRESOLVED_DATABASE_MAPPING,
            env_name: 'OVERRIDDEN_GLOBAL',
            global_variable_id: 91,
            global_variable_key: 'REPORTING_DATABASE_URL',
            resolved_value: 'https://global.example',
        }];

        await envList('calendar-worker');

        const row = output.find((line) => line.includes('OVERRIDDEN_GLOBAL'));
        expect(row).toMatch(/OVERRIDDEN_GLOBAL\s+https:\/\/global\.example\s+global\s+REPORTING_DATABASE_URL/);
        expect(row).not.toContain('not configured');
    });

    it('keeps a current OAuth override ahead of unresolved YAML database metadata', async () => {
        responseBody = [{
            ...UNRESOLVED_DATABASE_MAPPING,
            env_name: 'OVERRIDDEN_OAUTH',
            source_type: 'oauth_connection',
            oauth_connection_id: 73,
            oauth_connection_name: 'Google Calendar',
        }];

        await envList('calendar-worker');

        const row = output.find((line) => line.includes('OVERRIDDEN_OAUTH'));
        expect(row).toMatch(/OVERRIDDEN_OAUTH\s+-\s+oauth\s+Google Calendar/);
        expect(row).not.toContain('not configured');
    });

    it('keeps a current local override ahead of unresolved YAML database metadata', async () => {
        responseBody = [{
            ...UNRESOLVED_DATABASE_MAPPING,
            env_name: 'OVERRIDDEN_LOCAL',
            has_value: true,
            value: 'local-database-url',
            resolved_value: 'local-database-url',
        }];

        await envList('calendar-worker');

        const row = output.find((line) => line.includes('OVERRIDDEN_LOCAL'));
        expect(row).toMatch(/OVERRIDDEN_LOCAL\s+local-database-url\s+project var\s+local/);
        expect(row).not.toContain('not configured');
    });

    it('prints the exact healthy API array unchanged in JSON mode', async () => {
        responseBody = [HEALTHY_DATABASE_MAPPING];

        await envList('calendar-worker', { json: true });

        expect(JSON.parse(output.join('\n'))).toEqual([HEALTHY_DATABASE_MAPPING]);
    });
});

/**
 * Issue app#1334 — `project list` REVISION column.
 *
 * `run list` (cli#123) already renders a compact REVISION column via
 * formatRevisionCell (now living in src/utils/source-provenance.ts, promoted
 * out of src/commands/run-list.ts so there is one implementation). This test
 * carries the same compact projection into `project list`, sourced from
 * project.deployed_revision (the shape RunsApiController::deployedRevision()
 * already defines).
 *
 * Test-double policy: real in-process HTTP server (Node's http.createServer),
 * real tmp dirs (makeTmpEnv/writeGlobal). No mock/spy/stub libraries.
 */
import * as http from 'http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { projectList } from '../src/commands/project-list';
import { formatRevisionCell } from '../src/utils/source-provenance';
import { makeTmpEnv, writeGlobal } from './helpers';

let stubServer: http.Server;
let stubPort: number;
let nextBody: unknown = { data: [] };

beforeAll(async () => {
    stubServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(nextBody));
    });
    await new Promise<void>((resolve) => {
        stubServer.listen(0, '127.0.0.1', () => {
            stubPort = (stubServer.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => {
    return new Promise<void>((resolve, reject) => {
        stubServer.close((err) => (err ? reject(err) : resolve()));
    });
});

const baseRevision = {
    commit_sha: 'abc1234567890abc1234567890abc1234567890',
    short_sha: 'abc1234',
    remote_url: 'https://example.test/acme/demo.git',
    default_branch: 'main',
    default_branch_sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
};

describe('project list REVISION column', () => {
    let env: ReturnType<typeof makeTmpEnv>;
    let logLines: string[];
    let originalLog: typeof console.log;

    beforeEach(() => {
        env = makeTmpEnv();
        writeGlobal(env.home, { host: `http://127.0.0.1:${stubPort}`, apiKey: 'k', workspaceId: 'ws-1' });
        logLines = [];
        originalLog = console.log;
        console.log = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };
    });

    afterEach(() => {
        console.log = originalLog;
        env.cleanup();
    });

    it('renders dirty, behind, dirty+behind, unknown-dirty, clean, and absent revision cells between SNAPSHOT and ENVIRONMENTS', async () => {
        nextBody = {
            data: [
                { name: 'alpha-dirty', status: 'ready', snapshot_name: 'snap-1', environments: ['production'], deployed_revision: { ...baseRevision, dirty: true, commits_behind: 0 } },
                { name: 'bravo-behind', status: 'ready', snapshot_name: 'snap-2', environments: ['production'], deployed_revision: { ...baseRevision, dirty: false, commits_behind: 3 } },
                { name: 'charlie-dirtybehind', status: 'ready', snapshot_name: 'snap-3', environments: ['production'], deployed_revision: { ...baseRevision, dirty: true, commits_behind: 3 } },
                { name: 'delta-unknowndirty', status: 'ready', snapshot_name: 'snap-4', environments: ['production'], deployed_revision: { ...baseRevision, dirty: null, commits_behind: 0 } },
                { name: 'echo-clean', status: 'ready', snapshot_name: 'snap-5', environments: ['production'], deployed_revision: { ...baseRevision, dirty: false, commits_behind: 0 } },
                { name: 'foxtrot-none', status: 'ready', snapshot_name: 'snap-6', environments: ['production'], deployed_revision: null },
            ],
        };

        await projectList({});

        expect(logLines.some((l) => l.includes('REVISION'))).toBe(true);

        const lineFor = (name: string) => logLines.find((l) => l.includes(name)) ?? '';

        // SNAPSHOT must appear before the REVISION cell, which must appear before ENVIRONMENTS.
        const dirtyLine = lineFor('alpha-dirty');
        expect(dirtyLine).toContain('snap-1');
        expect(dirtyLine).toContain('abc1234*');
        expect(dirtyLine.indexOf('abc1234*')).toBeGreaterThan(dirtyLine.indexOf('snap-1'));
        expect(dirtyLine.indexOf('production')).toBeGreaterThan(dirtyLine.indexOf('abc1234*'));

        expect(lineFor('bravo-behind')).toContain('abc1234 ↓3');
        expect(lineFor('charlie-dirtybehind')).toContain('abc1234* ↓3');
        expect(lineFor('delta-unknowndirty')).toContain('abc1234?');
        expect(lineFor('echo-clean')).toContain('abc1234');
        expect(lineFor('echo-clean')).not.toContain('abc1234*');
        expect(lineFor('echo-clean')).not.toContain('abc1234?');
        expect(lineFor('echo-clean')).not.toContain('abc1234 ↓');

        const noneLine = lineFor('foxtrot-none');
        expect(noneLine).toMatch(/snap-6\s+-\s+production/);
    });

    it('prints the REVISION legend after the table when at least one project row exists', async () => {
        nextBody = { data: [{ name: 'demo', status: 'ready', snapshot_name: 'snap-1', environments: ['production'], deployed_revision: null }] };

        await projectList({});

        expect(logLines).toContain(
            'REVISION shows the latest successful deployment: * dirty, ? dirty state unknown, ↓N behind default branch at deploy.',
        );
    });

    it('does not print the REVISION legend when there are no projects', async () => {
        nextBody = { data: [] };

        await projectList({});

        expect(logLines.some((l) => l.includes('REVISION shows'))).toBe(false);
    });

    it('passes deployed_revision through untouched in --json output', async () => {
        const deployedRevision = { ...baseRevision, dirty: true, commits_behind: 3 };
        nextBody = { data: [{ name: 'demo', status: 'ready', snapshot_name: 'snap-1', environments: ['production'], deployed_revision: deployedRevision }] };

        await projectList({ json: true });

        const parsed = JSON.parse(logLines.join('\n'));
        expect(parsed[0].deployed_revision).toEqual(deployedRevision);
    });
});

describe('formatRevisionCell lives in utils/source-provenance', () => {
    it('is exported as a function usable directly (single implementation, no copy)', () => {
        expect(formatRevisionCell({ ...baseRevision, dirty: true, commits_behind: 3 })).toBe('abc1234* ↓3');
        expect(formatRevisionCell(null)).toBe('-');
    });
});

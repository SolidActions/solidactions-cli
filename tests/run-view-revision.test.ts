import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runView } from '../src/commands/run-view';

vi.mock('axios', () => ({
    default: { get: vi.fn() },
}));

vi.mock('../src/utils/api', () => ({
    getApiHeaders: vi.fn(() => ({})),
    requireConfigWithWorkspace: vi.fn(async () => ({
        host: 'https://api.example.test',
        apiKey: 'test-key',
        workspaceId: 'test-workspace',
    })),
}));

afterEach(() => vi.restoreAllMocks());

const revision = {
    commit_sha: 'abcdef1234567890abcdef1234567890abcdef12',
    short_sha: 'abcdef123456',
    dirty: true,
    remote_url: 'https://example.test/acme/project.git',
    default_branch: 'main',
    default_branch_sha: '1234567890abcdef1234567890abcdef12345678',
    commits_behind: 2,
};

/**
 * Stubs the three axios GETs `runView`'s full-view path issues (run detail,
 * steps, logs), routed by URL suffix so call ORDER in the command doesn't
 * matter to the test.
 */
function mockRunViewEndpoints(runData: any) {
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
        if (url.endsWith('/logs')) {
            return { data: { logs: '' } };
        }
        if (url.endsWith('/steps')) {
            return { data: { workers: [] } };
        }
        return { data: runData };
    });
}

describe('run view revision', () => {
    it('renders the revision line with a full revision object, including the N-behind clause', async () => {
        mockRunViewEndpoints({ id: 1, workflow_name: 'wf', project_name: 'proj', deployed_revision: revision });
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        await runView('1', {});

        const output = log.mock.calls.map((call) => String(call[0])).join('\n');
        expect(output).toContain('Revision (latest session): abcdef123456 (DIRTY, 2 behind origin/main at deploy)');
    });

    it('renders "unknown" when deployed_revision is present but null', async () => {
        mockRunViewEndpoints({ id: 2, workflow_name: 'wf', project_name: 'proj', deployed_revision: null });
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        await runView('2', {});

        const output = log.mock.calls.map((call) => String(call[0])).join('\n');
        expect(output).toContain('Revision (latest session): unknown');
    });

    it('omits the revision line entirely when the key is absent (old server)', async () => {
        mockRunViewEndpoints({ id: 3, workflow_name: 'wf', project_name: 'proj' });
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        await runView('3', {});

        const output = log.mock.calls.map((call) => String(call[0])).join('\n');
        expect(output).not.toContain('Revision (latest session):');
    });

    it('passes through all seven revision fields unchanged in --json output', async () => {
        mockRunViewEndpoints({ id: 4, workflow_name: 'wf', project_name: 'proj', deployed_revision: revision });
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        await runView('4', { json: true });

        const output = JSON.parse(String(log.mock.calls[0][0]));
        expect(output.deployed_revision).toEqual(revision);
    });

    it('omits deployed_revision key in --json when absent, and emits null when the server sent null', async () => {
        mockRunViewEndpoints({ id: 5, workflow_name: 'wf', project_name: 'proj' });
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        await runView('5', { json: true });
        let output = JSON.parse(String(log.mock.calls[0][0]));
        expect(Object.prototype.hasOwnProperty.call(output, 'deployed_revision')).toBe(false);

        log.mockClear();
        mockRunViewEndpoints({ id: 6, workflow_name: 'wf', project_name: 'proj', deployed_revision: null });
        await runView('6', { json: true });
        output = JSON.parse(String(log.mock.calls[0][0]));
        expect(Object.prototype.hasOwnProperty.call(output, 'deployed_revision')).toBe(true);
        expect(output.deployed_revision).toBeNull();
    });

    it('sanitizes control/ANSI/bidi characters out of the human revision line', async () => {
        mockRunViewEndpoints({
            id: 7,
            workflow_name: 'wf',
            project_name: 'proj',
            deployed_revision: {
                ...revision,
                short_sha: 'abc\nINJECTED‮',
                default_branch: 'main‮-EVIL',
            },
        });
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        await runView('7', {});

        const revisionLine = log.mock.calls.map((call) => String(call[0])).find((line) => line.includes('Revision (latest session):'));
        expect(revisionLine).toBeDefined();
        expect(revisionLine).toContain('abcINJECTED');
        expect(revisionLine).not.toContain('‮');
    });
});

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

afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(axios.get).mockReset();
});

/**
 * Stubs the three axios GETs `runView`'s full-view path issues (run detail,
 * steps, logs), routed by URL suffix so call ORDER in the command doesn't
 * matter to the test. Mirrors tests/run-view-revision.test.ts.
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

describe('run view — id resolution (app#1306)', () => {
    it('accepts a numeric id and requests /api/v1/runs/<id>', async () => {
        mockRunViewEndpoints({ id: 42, workflow_name: 'wf', project_name: 'proj' });
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        await runView('42', {});

        expect(exit).not.toHaveBeenCalled();
        const requestedUrls = vi.mocked(axios.get).mock.calls.map((call) => call[0]);
        expect(requestedUrls).toContain('https://api.example.test/api/v1/runs/42');
    });

    it('accepts a canonical UUID and requests /api/v1/runs/<uuid> verbatim', async () => {
        const uuid = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
        mockRunViewEndpoints({ id: uuid, workflow_name: 'wf', project_name: 'proj' });
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        await runView(uuid, {});

        expect(exit).not.toHaveBeenCalled();
        const requestedUrls = vi.mocked(axios.get).mock.calls.map((call) => call[0]);
        expect(requestedUrls).toContain(`https://api.example.test/api/v1/runs/${uuid}`);
    });

    it('accepts an uppercase-hex UUID and lowercases it before forwarding', async () => {
        const uuid = '3FA85F64-5717-4562-B3FC-2C963F66AFA6';
        mockRunViewEndpoints({ id: uuid.toLowerCase(), workflow_name: 'wf', project_name: 'proj' });
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        await runView(uuid, {});

        expect(exit).not.toHaveBeenCalled();
        const requestedUrls = vi.mocked(axios.get).mock.calls.map((call) => call[0]);
        // The server stores `run_uuid` lowercase and compares it verbatim, so an
        // uppercase UUID must be normalized here or it 404s.
        expect(requestedUrls).toContain(`https://api.example.test/api/v1/runs/${uuid.toLowerCase()}`);
        expect(requestedUrls).toContain(`https://api.example.test/api/v1/runs/${uuid.toLowerCase()}/logs`);
        expect(requestedUrls).toContain(`https://api.example.test/api/v1/runs/${uuid.toLowerCase()}/steps`);
        expect(requestedUrls.some((url) => String(url).includes(uuid))).toBe(false);
    });

    it('rejects a garbage identifier with the invalid-id error and exit code 1', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        await runView('not-a-run-id', {});

        expect(exit).toHaveBeenCalledWith(1);
        const output = error.mock.calls.map((call) => String(call[0])).join('\n');
        expect(output).toContain('Invalid run id: "not-a-run-id"');
        expect(vi.mocked(axios.get)).not.toHaveBeenCalled();
    });

    it('rejects a UUID-ish-but-malformed value (wrong segment lengths)', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        await runView('3fa85f64-571-4562-b3fc-2c963f66afa6', {});

        expect(exit).toHaveBeenCalledWith(1);
        const output = error.mock.calls.map((call) => String(call[0])).join('\n');
        expect(output).toContain('Invalid run id: "3fa85f64-571-4562-b3fc-2c963f66afa6"');
        expect(vi.mocked(axios.get)).not.toHaveBeenCalled();
    });
});

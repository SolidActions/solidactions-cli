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

const RUN_UUID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const RUN_NUMERIC_ID = '42';

// One server payload, served for BOTH id forms — the app resolves a numeric id
// and a run UUID to the same RunTrigger, so the rendered output must not differ.
const RUN_DATA = {
    id: 42,
    run_uuid: RUN_UUID,
    workflow_name: 'nightly-report',
    project_name: 'acme',
    execution_status: 'completed',
    exit_code: 0,
    triggered_by: 'schedule',
    triggered_at: '2026-07-01T00:00:00Z',
    session_started_at_epoch_ms: 1782950400000,
    session_completed_at_epoch_ms: 1782950404500,
    deployed_revision: { sha: 'abc1234', message: 'ship it' },
    output: { rows: 12 },
};
const STEPS_DATA = {
    workers: [
        {
            steps: [
                { name: 'fetch-rows', started_at: '2026-07-01T00:00:01Z', completed_at: '2026-07-01T00:00:02Z', duration_ms: 1000, output: { ok: true }, status: 'completed', error: null },
                { name: 'render-report', started_at: '2026-07-01T00:00:02Z', completed_at: '2026-07-01T00:00:04Z', duration_ms: 2000, output: null, status: 'failed', error: 'Error: boom' },
            ],
        },
    ],
};
const LOGS_DATA = { logs: 'line one\nline two\nline three\n', errors: [{ worker: 'w1', error: 'boom' }] };

function mockRunViewEndpoints() {
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
        if (url.endsWith('/logs')) {
            return { data: LOGS_DATA };
        }
        if (url.endsWith('/steps')) {
            return { data: STEPS_DATA };
        }
        return { data: RUN_DATA };
    });
}

/** Runs `run view` for one identifier and returns everything it wrote to stdout. */
async function render(runId: string, options: Record<string, unknown>): Promise<string> {
    mockRunViewEndpoints();
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => String(arg)).join(' '));
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await runView(runId, options);

    expect(exit).not.toHaveBeenCalled();
    const output = lines.join('\n');
    vi.restoreAllMocks();
    vi.mocked(axios.get).mockReset();
    return output;
}

describe('run view — render parity between the numeric id and the run UUID (app#1306)', () => {
    it('renders byte-identical full-view output for both id forms', async () => {
        const byNumericId = await render(RUN_NUMERIC_ID, {});
        const byUuid = await render(RUN_UUID, {});

        expect(byUuid).toBe(byNumericId);
        expect(byNumericId).toContain('nightly-report');
    });

    it('renders byte-identical --logs output for both id forms', async () => {
        const byNumericId = await render(RUN_NUMERIC_ID, { logs: true });
        const byUuid = await render(RUN_UUID, { logs: true });

        expect(byUuid).toBe(byNumericId);
        expect(byNumericId).toContain('line two');
    });

    it('renders byte-identical --steps output for both id forms', async () => {
        const byNumericId = await render(RUN_NUMERIC_ID, { steps: true });
        const byUuid = await render(RUN_UUID, { steps: true });

        expect(byUuid).toBe(byNumericId);
        expect(byNumericId).toContain('render-report');
    });

    it('renders byte-identical --json output for both id forms', async () => {
        const byNumericId = await render(RUN_NUMERIC_ID, { json: true });
        const byUuid = await render(RUN_UUID, { json: true });

        expect(byUuid).toBe(byNumericId);
        expect(JSON.parse(byNumericId).workflow).toBe('nightly-report');
    });

    it('renders byte-identical output for an uppercase UUID too', async () => {
        const byNumericId = await render(RUN_NUMERIC_ID, {});
        const byUppercaseUuid = await render(RUN_UUID.toUpperCase(), {});

        expect(byUppercaseUuid).toBe(byNumericId);
    });
});

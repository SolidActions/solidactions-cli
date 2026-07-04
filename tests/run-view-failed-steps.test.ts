import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { displayStepsTable, errorMessage, flattenSteps, stepDisplayStatus } from '../src/commands/run-view';

// Fixture mirroring GET /api/v1/runs/{id}/steps (RunsApiController::deriveStepStatus
// emits per-step status + error; timestamps are set on BOTH success and failure).
const FAILED_ERROR = 'TypeError: fetch failed (GET http://localhost:3000/x, cause: Error: connect ECONNREFUSED 127.0.0.1:3000)';
const failedRunPayload = {
    workers: [
        {
            steps: [
                { name: 'build-greeting', started_at: '2026-07-01T00:00:00Z', completed_at: '2026-07-01T00:00:01Z', duration_ms: 1000, output: { ok: true }, status: 'completed', error: null },
                { name: 'fetch-data', started_at: '2026-07-01T00:00:01Z', completed_at: '2026-07-01T00:00:03Z', duration_ms: 2000, output: null, status: 'failed', error: FAILED_ERROR },
            ],
        },
    ],
};
const successOnlyPayload = {
    workers: [
        { steps: [{ name: 'only-step', started_at: '2026-07-01T00:00:00Z', completed_at: '2026-07-01T00:00:01Z', duration_ms: 1000, output: { ok: true }, status: 'completed', error: null }] },
    ],
};
// Older servers: no status/error fields at all.
const legacyPayload = {
    workers: [
        { steps: [{ name: 'legacy-step', started_at: '2026-07-01T00:00:00Z', completed_at: '2026-07-01T00:00:01Z', duration_ms: 1000, output: null }] },
    ],
};
// Stack-trace-style error: a newline lands well within the ~37-char truncation window.
const MULTILINE_ERROR = 'Error: boom\n    at fetchData (/app/src/fetch.ts:42:11)\n    at process (/app/src/process.ts:10:3)';
const multilineErrorPayload = {
    workers: [
        { steps: [{ name: 'fetch-data', started_at: '2026-07-01T00:00:01Z', completed_at: '2026-07-01T00:00:03Z', duration_ms: 2000, output: null, status: 'failed', error: MULTILINE_ERROR }] },
    ],
};
// Real server shape (confirmed live, GET /api/v1/runs/{id}/steps): a thrown
// native Error is superjson-wrapped as an OBJECT, not a plain string.
const SUPERJSON_ERROR_OBJECT = {
    json: { name: 'TypeError', message: 'fetch failed', stack: 'TypeError: fetch failed' },
    __solidactions_serializer: 'superjson',
};
const superjsonErrorPayload = {
    workers: [
        { steps: [{ name: 'fetch-unreachable', started_at: '2026-07-01T00:00:01Z', completed_at: '2026-07-01T00:00:03Z', duration_ms: 3, output: null, status: 'failed', error: SUPERJSON_ERROR_OBJECT }] },
    ],
};

describe('flattenSteps', () => {
    it('carries the server status and error through', () => {
        const steps = flattenSteps(failedRunPayload.workers);
        expect(steps[1]).toMatchObject({ name: 'fetch-data', status: 'failed', error: FAILED_ERROR });
        expect(steps[0]).toMatchObject({ name: 'build-greeting', status: 'completed', error: null });
    });

    it('defaults status/error to null for legacy payloads', () => {
        const steps = flattenSteps(legacyPayload.workers);
        expect(steps[0].status).toBeNull();
        expect(steps[0].error).toBeNull();
    });
});

describe('stepDisplayStatus', () => {
    it('prefers the server status — a failed step with completedAt set renders failed', () => {
        const [, failed] = flattenSteps(failedRunPayload.workers);
        expect(stepDisplayStatus(failed)).toBe('failed');
    });

    it('falls back to the timestamp heuristic for legacy payloads', () => {
        const [legacy] = flattenSteps(legacyPayload.workers);
        expect(stepDisplayStatus(legacy)).toBe('completed');
        expect(stepDisplayStatus({ status: null, startedAt: 'x', completedAt: null })).toBe('running');
        expect(stepDisplayStatus({ status: null, startedAt: null, completedAt: null })).toBe('pending');
    });
});

describe('displayStepsTable', () => {
    let lines: string[];
    const originalLog = console.log;

    beforeEach(() => {
        lines = [];
        console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    });
    afterEach(() => { console.log = originalLog; });

    it('renders failed status, truncated error in the output column, and the full error below', () => {
        displayStepsTable(flattenSteps(failedRunPayload.workers));
        const table = lines.join('\n');

        expect(table).toContain('failed');
        // Truncated (40-char) error in the row…
        expect(lines.some((l) => l.includes('fetch-data') && l.includes('TypeError: fetch failed'))).toBe(true);
        // …and the FULL untruncated error below the table.
        expect(lines.some((l) => l.includes(FAILED_ERROR))).toBe(true);
    });

    it('renders a success-only payload with no error block', () => {
        displayStepsTable(flattenSteps(successOnlyPayload.workers));
        const table = lines.join('\n');
        expect(table).toContain('completed');
        expect(table).not.toContain('failed:');
        expect(lines.some((l) => l.includes('TypeError'))).toBe(false);
    });

    it('collapses a multiline stack-trace error to a single-line truncated table cell, while the block below the table keeps the real newlines', () => {
        displayStepsTable(flattenSteps(multilineErrorPayload.workers));

        // The table row itself: no raw newline, so column alignment for subsequent rows can't break.
        const rowLine = lines.find((l) => l.includes('fetch-data'));
        expect(rowLine).toBeDefined();
        expect(rowLine).not.toContain('\n');

        // The untruncated block below the table preserves the real multiline text
        // (search for text past the table row's truncation point, so this only matches the full block).
        const fullBlockLine = lines.find((l) => l.includes('process.ts:10:3'));
        expect(fullBlockLine).toBeDefined();
        expect(fullBlockLine).toContain('\n');
    });

    it('unwraps a superjson-wrapped error object to "Name: message" instead of "[object Object]"', () => {
        displayStepsTable(flattenSteps(superjsonErrorPayload.workers));
        const table = lines.join('\n');

        expect(table).not.toContain('[object Object]');
        expect(lines.some((l) => l.includes('fetch-unreachable') && l.includes('TypeError: fetch failed'))).toBe(true);
    });
});

describe('errorMessage', () => {
    it('returns a plain string error unchanged', () => {
        expect(errorMessage(FAILED_ERROR)).toBe(FAILED_ERROR);
    });

    it('unwraps a superjson-wrapped error object to "Name: message"', () => {
        expect(errorMessage(SUPERJSON_ERROR_OBJECT)).toBe('TypeError: fetch failed');
    });

    it('unwraps a superjson-wrapped error that arrives pre-JSON.stringified (the run-level `error` field shape)', () => {
        expect(errorMessage(JSON.stringify(SUPERJSON_ERROR_OBJECT))).toBe('TypeError: fetch failed');
    });

    it('returns an empty string for null/undefined', () => {
        expect(errorMessage(null)).toBe('');
        expect(errorMessage(undefined)).toBe('');
    });
});

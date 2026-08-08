import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

const WORKFLOW_PATH = path.resolve(__dirname, '../.github/workflows/check.yml');

interface WorkflowStep {
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
}

interface WorkflowJob {
    'runs-on': string;
    strategy?: { matrix?: { os?: unknown[]; node?: unknown[] } };
    services?: Record<string, { image?: string }>;
    steps?: WorkflowStep[];
}

const REMOTE_SYNC_IMAGE = 'ghcr.io/tursodatabase/libsql-server:3ec6803@sha256:1bc51611928ccc51229bdc40ca0defcb915907f8f9f6a664b43529de0ca45fab';

describe('native database client CI contract', () => {
    it('runs the embedded probe on Node 20 and 24 across Linux, macOS, and Windows', () => {
        const workflow = yaml.load(fs.readFileSync(WORKFLOW_PATH, 'utf8')) as {
            jobs?: Record<string, WorkflowJob>;
        };
        const job = workflow.jobs?.['native-database-client'];

        expect(job).toBeDefined();
        if (!job) return;

        expect(job['runs-on']).toBe('${{ matrix.os }}');
        expect(job.strategy?.matrix?.os).toEqual([
            'ubuntu-latest',
            'macos-latest',
            'windows-latest',
        ]);
        expect(job.strategy?.matrix?.node?.map(String)).toEqual(['20', '24']);
        expect(
            (job.strategy?.matrix?.os?.length ?? 0) * (job.strategy?.matrix?.node?.length ?? 0),
        ).toBe(6);

        const setupNode = job.steps?.find((step) => step.uses?.startsWith('actions/setup-node@'));
        expect(setupNode?.with?.['node-version']).toBe('${{ matrix.node }}');

        const commands = (job.steps ?? []).map((step) => step.run ?? '').join('\n');
        expect(commands).toContain('npm ci');
        expect(commands).toContain('node scripts/probe-native-database-client.mjs');
    });

    it('keeps the remote sync probe in a separate pinned Linux service job', () => {
        const workflow = yaml.load(fs.readFileSync(WORKFLOW_PATH, 'utf8')) as {
            jobs?: Record<string, WorkflowJob>;
        };
        const nativeJob = workflow.jobs?.['native-database-client'];
        const remoteSyncJob = workflow.jobs?.['database-client-remote-sync'];

        expect(nativeJob).toBeDefined();
        expect(remoteSyncJob).toBeDefined();
        expect(remoteSyncJob).not.toBe(nativeJob);
        if (!remoteSyncJob) return;

        expect(remoteSyncJob['runs-on']).toBe('ubuntu-latest');
        expect(remoteSyncJob.strategy?.matrix).toBeUndefined();
        expect(
            Object.values(remoteSyncJob.services ?? {}).map((service) => service.image),
        ).toContain(REMOTE_SYNC_IMAGE);

        const commands = (remoteSyncJob.steps ?? []).map((step) => step.run ?? '').join('\n');
        expect(commands).toContain('npm ci');
        expect(commands).toContain('node scripts/probe-database-client-sync.mjs');
    });
});

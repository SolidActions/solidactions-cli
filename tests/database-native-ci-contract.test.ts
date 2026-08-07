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
    steps?: WorkflowStep[];
}

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

        const setupNode = job.steps?.find((step) => step.uses?.startsWith('actions/setup-node@'));
        expect(setupNode?.with?.['node-version']).toBe('${{ matrix.node }}');

        const commands = (job.steps ?? []).map((step) => step.run ?? '').join('\n');
        expect(commands).toContain('npm ci');
        expect(commands).toContain('node scripts/probe-native-database-client.mjs');
    });
});

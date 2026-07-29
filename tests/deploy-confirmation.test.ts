import * as http from 'http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    fetchDeploymentConfirmation,
    formatDeploymentConfirmation,
    projectStatusUrl,
} from '../src/commands/deploy';
import { formatRevisionSummary } from '../src/utils/source-provenance';
import type { Config } from '../src/utils/config';

let server: http.Server;
let port: number;
let requests: string[] = [];
let responseBody: Record<string, unknown>;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        requests.push(req.url ?? '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseBody));
    });
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as { port: number }).port;
            resolve();
        });
    });
});

afterAll(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
}));

beforeEach(() => {
    requests = [];
    responseBody = {
        slug: 'billing',
        status: 'deployed',
        deployment_matches_deployed_hash: true,
        latest_successful_deployment: {
            id: 'accepted-deployment',
            status: 'succeeded',
            source_hash: 'archive-md5',
            metadata_source: 'git',
            commit_sha: 'abcdef1234567890',
            short_sha: 'abcdef123456',
            branch: 'main',
            tag: null,
            commit_subject: 'ship',
            commit_author_date: '2026-07-27T10:00:00-05:00',
            remote_url: null,
            dirty: false,
            completed_at: '2026-07-27T15:00:00Z',
        },
    };
});

function config(): Config {
    return {
        host: `http://127.0.0.1:${port}`,
        apiKey: 'test-key',
        workspaceId: 'workspace-1',
    };
}

describe('deploy polling and final confirmation', () => {
    it('keeps the one-second status URL plain', () => {
        expect(projectStatusUrl('https://example.test', 'billing')).toBe(
            'https://example.test/api/v1/projects/billing',
        );
    });

    it('makes exactly one final deployment-detail request', async () => {
        const result = await fetchDeploymentConfirmation(config(), 'billing');

        expect(requests).toEqual(['/api/v1/projects/billing?include=deployment']);
        expect(result.latest_successful_deployment?.id).toBe('accepted-deployment');
    });

    it('confirms only when the accepted ID is the matching latest successful deployment', () => {
        const lines = formatDeploymentConfirmation(
            responseBody as any,
            'accepted-deployment',
            null,
        ).join('\n');

        expect(lines).toContain('Deployment revision confirmed');
        expect(lines).toContain('abcdef123456');
        expect(lines).toContain('clean');
    });

    it('reports a deployment-ID mismatch without displaying the other deployment revision', () => {
        const lines = formatDeploymentConfirmation(
            responseBody as any,
            'different-deployment',
            null,
        ).join('\n');

        expect(lines).toContain('this deployment was not recorded as the latest successful deployment');
        expect(lines).not.toContain('abcdef123456');
    });

    it('reports a deployed-hash mismatch with a message distinct from a deployment-ID mismatch', () => {
        const body = structuredClone(responseBody) as any;
        body.deployment_matches_deployed_hash = false;

        const lines = formatDeploymentConfirmation(body, 'accepted-deployment', null).join('\n');

        expect(lines).toContain('running revision hash does not match');
        expect(lines).not.toContain('this deployment was not recorded as the latest successful deployment');
        expect(lines).not.toContain('abcdef123456');
    });

    it('reports no matching deployment row distinctly when the server has none recorded yet', () => {
        const body = structuredClone(responseBody) as any;
        body.latest_successful_deployment = null;

        const lines = formatDeploymentConfirmation(body, 'accepted-deployment', null).join('\n');

        expect(lines).toContain('has no successful deployment recorded yet');
        expect(lines).not.toContain('running revision hash does not match');
        expect(lines).not.toContain('this deployment was not recorded as the latest successful deployment');
    });

    it('renders metadata rejection safely after a confirmed build', () => {
        const body = structuredClone(responseBody) as any;
        body.latest_successful_deployment.commit_sha = null;
        body.latest_successful_deployment.short_sha = null;
        body.latest_successful_deployment.metadata_source = null;

        const lines = formatDeploymentConfirmation(
            body,
            'accepted-deployment',
            'invalid_metadata',
        ).join('\n');

        expect(lines).toContain('source metadata was rejected');
        expect(lines).toContain('invalid_metadata');
        expect(lines).toContain('no source revision was reported');
    });

    it('does not contradict itself when a matching deployment has no reported SHA', () => {
        const body = structuredClone(responseBody) as any;
        body.latest_successful_deployment.commit_sha = null;
        body.latest_successful_deployment.short_sha = null;

        const lines = formatDeploymentConfirmation(body, 'accepted-deployment', null);

        // Must not both claim the revision is confirmed AND that none was reported.
        expect(lines).not.toContain('Deployment revision confirmed.');
        expect(lines.join('\n')).not.toContain('No source revision was reported.');
    });

    it('uses a legacy-safe message when the 202 response has no deployment ID', () => {
        const lines = formatDeploymentConfirmation(responseBody as any, null, null).join('\n');

        expect(lines).toContain('legacy server response');
        expect(lines).not.toContain('abcdef123456');
    });
});

describe('compact pre-upload revision summary', () => {
    const metadata = {
        metadata_source: 'git' as const,
        commit_sha: 'abcdef1234567890',
        short_sha: 'abcdef123456',
        branch: 'main',
        tag: null,
        commit_subject: 'ship',
        commit_author_date: '2026-07-27T10:00:00-05:00',
        remote_url: null,
        dirty: false,
    };

    it('prints clean, dirty, and unknown state beside every SHA', () => {
        expect(formatRevisionSummary(metadata)).toContain('abcdef123456 (clean)');
        expect(formatRevisionSummary({ ...metadata, dirty: true })).toContain('abcdef123456 (DIRTY)');
        expect(formatRevisionSummary({ ...metadata, dirty: null })).toContain(
            'abcdef123456 (dirty state unknown)',
        );
    });
});

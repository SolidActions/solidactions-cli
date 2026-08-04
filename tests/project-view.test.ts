import * as http from 'http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    formatProjectView,
    projectSlugForView,
    projectViewWithConfig,
    type ProjectDeploymentDetail,
} from '../src/commands/project-view';
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
        slug: 'billing-dev',
        status: 'deployed',
        deployed_hash: 'archive-md5',
        deployment_matches_deployed_hash: true,
        latest_successful_deployment: {
            id: 'deployment-1',
            status: 'succeeded',
            source_hash: 'archive-md5',
            metadata_source: 'git',
            commit_sha: 'abcdef1234567890',
            short_sha: 'abcdef123456',
            branch: 'feature/payments',
            tag: 'v2.0.0',
            commit_subject: 'Ship payments',
            commit_author_date: '2026-07-27T10:00:00-05:00',
            remote_url: 'git@example.test:team/repo.git',
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

describe('project slug resolution for view', () => {
    it('treats the positional value as an exact slug when --env is absent', () => {
        expect(projectSlugForView('Already-Exact_slug', undefined)).toBe('Already-Exact_slug');
    });

    it('uses the supplied production slug unchanged', () => {
        expect(projectSlugForView('billing-api', 'production')).toBe('billing-api');
    });

    it('derives staging and dev slugs with the deploy slug rule', () => {
        expect(projectSlugForView('Billing API', 'staging')).toBe('billing-api-staging');
        expect(projectSlugForView('Billing API', 'dev')).toBe('billing-api-dev');
    });

    it('rejects unsupported explicit environments', () => {
        expect(() => projectSlugForView('billing', 'qa')).toThrow(/production.*staging.*dev/i);
    });
});

describe('project view request and rendering', () => {
    it('renders enabled state immediately after deployment status', () => {
        const enabled = formatProjectView({ slug: 'billing', status: 'deployed', enabled: true } as any);
        const disabled = formatProjectView({ slug: 'billing', status: 'deployed', enabled: false } as any);

        expect(enabled.slice(0, 3)).toEqual(['Project: billing', 'Status: deployed', 'Enabled: on']);
        expect(disabled.slice(0, 3)).toEqual(['Project: billing', 'Status: deployed', 'Enabled: off']);
    });

    it('requests the exact slug with the bounded deployment include', async () => {
        const lines: string[] = [];
        await projectViewWithConfig('billing-dev', {}, config(), (line) => lines.push(line));

        expect(requests).toEqual(['/api/v1/projects/billing-dev?include=deployment']);
        expect(lines.join('\n')).toContain('Status: deployed');
        expect(lines.join('\n')).toContain('abcdef123456');
        expect(lines.join('\n')).toContain('clean');
        expect(lines.join('\n')).toContain('Client-reported');
    });

    it('renders dirty as a prominent warning and preserves ordinary Unicode', () => {
        const body = structuredClone(responseBody) as any;
        body.latest_successful_deployment.dirty = true;
        body.latest_successful_deployment.commit_subject = 'Ship café 東京';

        const output = formatProjectView(body).join('\n');
        expect(output).toContain('DIRTY');
        expect(output).toContain('Ship café 東京');
    });

    it('strips controls, bidi overrides, and zero-width characters at rendering', () => {
        const body = structuredClone(responseBody) as any;
        body.latest_successful_deployment.branch = 'fea\u001bture/\u202egnimoc\u200b';
        body.latest_successful_deployment.commit_subject = 'safe\u0000 subject';

        const output = formatProjectView(body).join('\n');
        expect(output).toContain('feature/gnimoc');
        expect(output).toContain('safe subject');
        expect(output).not.toMatch(/[\u001b\u202e\u200b\u0000]/);
    });

    it('sanitizes credentials out of remote_url even if an unnormalized server response carries them', () => {
        const body = structuredClone(responseBody) as any;
        body.latest_successful_deployment.remote_url = 'https://user:secret@host.example/repo';

        const output = formatProjectView(body).join('\n');
        expect(output).toContain('Remote: https://host.example/repo');
        expect(output).not.toContain('secret');
        expect(output).not.toContain('user:secret@');
    });

    it('labels CI dirty state as unknown', () => {
        const body = structuredClone(responseBody) as any;
        body.latest_successful_deployment.metadata_source = 'github_actions';
        body.latest_successful_deployment.dirty = null;

        expect(formatProjectView(body).join('\n')).toContain('dirty state unknown');
    });

    it('does not invent a revision when the successful deployment has no metadata', () => {
        const body = {
            slug: 'no-revision',
            status: 'deployed',
            deployed_hash: 'archive-md5',
            deployment_matches_deployed_hash: true,
            latest_successful_deployment: {
                id: 'deployment-no-revision',
                status: 'succeeded',
                source_hash: 'archive-md5',
                metadata_source: null,
                commit_sha: null,
                short_sha: null,
                branch: null,
                tag: null,
                commit_subject: null,
                commit_author_date: null,
                remote_url: null,
                dirty: null,
                completed_at: '2026-07-27T15:00:00Z',
            },
        } satisfies ProjectDeploymentDetail;

        expect(formatProjectView(body).join('\n')).toContain('No source revision was reported');
    });

    it('does not show an older revision when the deployed hash does not match', () => {
        const body = structuredClone(responseBody) as any;
        body.deployment_matches_deployed_hash = false;

        const output = formatProjectView(body).join('\n');
        expect(output).toContain('Revision unknown for the running build');
        expect(output).not.toContain('abcdef123456');
    });

    it('uses the neutral legacy message when provenance predates tracking', () => {
        const body = {
            slug: 'legacy',
            status: 'deployed',
            deployed_hash: null,
            deployment_matches_deployed_hash: false,
            latest_successful_deployment: null,
        };

        expect(formatProjectView(body).join('\n')).toContain(
            'No deployment provenance recorded (deployed before tracking)',
        );
    });
});

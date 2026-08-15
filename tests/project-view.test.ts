import * as http from 'http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => {
    vi.restoreAllMocks();
});

function config(): Config {
    return {
        host: `http://127.0.0.1:${port}`,
        apiKey: 'test-key',
        workspaceId: 'workspace-1',
    };
}

describe('project slug resolution for view', () => {
    it('passes through the exact project when the environment is omitted', () => {
        // #970's six schedule commands share this helper and intentionally pass undefined;
        // defaulting here would silently retarget their reads and writes to another project.
        expect(projectSlugForView('Billing API', undefined)).toBe('Billing API');
        expect(projectSlugForView('billing-dev', undefined)).toBe('billing-dev');
        expect(projectSlugForView('!!!', undefined)).toBe('!!!');
    });

    it('uses the supplied production slug unchanged', () => {
        expect(projectSlugForView('Billing API', 'production')).toBe('Billing API');
    });

    it('derives staging and dev slugs with the deploy slug rule', () => {
        expect(projectSlugForView('Billing API', 'staging')).toBe('billing-api-staging');
        expect(projectSlugForView('Billing API', 'dev')).toBe('billing-api-dev');
    });

    it('rejects unsupported explicit environments', () => {
        expect(() => projectSlugForView('billing', 'qa')).toThrow(/production.*staging.*dev/i);
    });

    it.each(['dev', 'staging', 'production'])(
        'rejects a project with no usable slug before resolving %s',
        (environment) => {
            expect(() => projectSlugForView('!!!', environment)).toThrow(/letter or number/i);
        },
    );
});

describe('project view request and rendering', () => {
    it('renders enabled state immediately after deployment status', () => {
        const enabled = formatProjectView({ slug: 'billing', status: 'deployed', enabled: true } as any);
        const disabled = formatProjectView({ slug: 'billing', status: 'deployed', enabled: false } as any);

        expect(enabled.slice(0, 3)).toEqual(['Project: billing', 'Status: deployed', 'Enabled: on']);
        expect(disabled.slice(0, 3)).toEqual(['Project: billing', 'Status: deployed', 'Enabled: off']);
    });

    it('requests the default dev project with the bounded deployment include', async () => {
        const lines: string[] = [];
        await projectViewWithConfig('billing', {}, config(), (line) => lines.push(line));

        expect(requests).toEqual(['/api/v1/projects/billing-dev?include=deployment']);
        expect(lines.join('\n')).toContain('Status: deployed');
        expect(lines.join('\n')).toContain('abcdef123456');
        expect(lines.join('\n')).toContain('clean');
        expect(lines.join('\n')).toContain('Client-reported');
    });

    it('treats an exact-suffixed project as a family on the default-dev view surface', async () => {
        await projectViewWithConfig('billing-dev', {}, config(), () => undefined);

        expect(requests).toEqual(['/api/v1/projects/billing-dev-dev?include=deployment']);
    });

    it.each([
        ['the default dev environment', {}],
        ['explicit production', { env: 'production' }],
    ])('rejects punctuation-only input before HTTP for %s', async (_label, options) => {
        const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
        const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await projectViewWithConfig('!!!', options, config());

        expect(exit).toHaveBeenCalledWith(1);
        expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/letter or number/i));
        expect(requests).toEqual([]);
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

    it('renders the drift clause inside the revision parenthetical when commits_behind is positive, byte-identical to run list', () => {
        const body = structuredClone(responseBody) as any;
        body.latest_successful_deployment.dirty = true;
        body.latest_successful_deployment.default_branch = 'main';
        body.latest_successful_deployment.commits_behind = 1;

        const output = formatProjectView(body).join('\n');
        expect(output).toContain('Revision (Client-reported): abcdef123456 (DIRTY, 1 behind origin/main at deploy)');
    });

    it.each([
        ['commits_behind is zero', { commits_behind: 0, default_branch: 'main' }],
        ['commits_behind is null', { commits_behind: null, default_branch: 'main' }],
        ['default_branch is null', { commits_behind: 3, default_branch: null }],
    ])('omits the drift clause when %s — byte-identical to today', (_label, overrides) => {
        const body = structuredClone(responseBody) as any;
        Object.assign(body.latest_successful_deployment, overrides);

        const output = formatProjectView(body).join('\n');
        expect(output).toContain('Revision (Client-reported): abcdef123456 (clean)');
        expect(output).not.toContain('behind');
    });
});

describe('project view --json', () => {
    it('emits the full projection with all seven revision fields intact under latest_successful_deployment', async () => {
        const body = structuredClone(responseBody) as any;
        body.latest_successful_deployment.default_branch = 'main';
        body.latest_successful_deployment.default_branch_sha = 'fedcba987654';
        body.latest_successful_deployment.commits_behind = 4;
        responseBody = body;

        const lines: string[] = [];
        await projectViewWithConfig('billing', { json: true }, config(), (line) => lines.push(line));

        expect(requests).toEqual(['/api/v1/projects/billing-dev?include=deployment']);
        const output = JSON.parse(lines.join('\n'));
        expect(output).toEqual({
            project: 'billing-dev',
            name: null,
            status: 'deployed',
            enabled: null,
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
                default_branch: 'main',
                default_branch_sha: 'fedcba987654',
                commits_behind: 4,
                completed_at: '2026-07-27T15:00:00Z',
            },
        });
    });

    it('still emits deployment_matches_deployed_hash: false and the deployment object when the recorded deployment is not the running build', async () => {
        const body = structuredClone(responseBody) as any;
        body.deployment_matches_deployed_hash = false;
        responseBody = body;

        const lines: string[] = [];
        await projectViewWithConfig('billing', { json: true }, config(), (line) => lines.push(line));

        const output = JSON.parse(lines.join('\n'));
        expect(output.deployment_matches_deployed_hash).toBe(false);
        expect(output.latest_successful_deployment).not.toBeNull();
        expect(output.latest_successful_deployment.commit_sha).toBe('abcdef1234567890');
    });

    it('emits latest_successful_deployment: null when there is no deployment', async () => {
        responseBody = {
            slug: 'legacy',
            status: 'deployed',
            deployed_hash: null,
            deployment_matches_deployed_hash: false,
            latest_successful_deployment: null,
        };

        const lines: string[] = [];
        await projectViewWithConfig('billing', { json: true }, config(), (line) => lines.push(line));

        const output = JSON.parse(lines.join('\n'));
        expect(output.latest_successful_deployment).toBeNull();
    });
});

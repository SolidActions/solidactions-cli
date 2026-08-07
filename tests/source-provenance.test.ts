import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import FormData from 'form-data';
import { afterEach, describe, expect, it } from 'vitest';
import {
    buildDeployForm,
    collectSourceMetadata,
    createDeployArchiveLocation,
    parseDeployAcceptance,
    sanitizeRemoteUrl,
    shouldCollectGitMetadata,
} from '../src/utils/source-provenance';

const roots: string[] = [];

function tempDir(prefix: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    roots.push(root);
    return root;
}

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

async function multipartBody(form: FormData): Promise<string> {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
        form.on('data', (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        form.on('end', resolve);
        form.on('error', reject);
        form.resume();
    });
    return Buffer.concat(chunks).toString('utf8');
}

function repository(): string {
    const root = tempDir('sa-provenance-git-');
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.name', 'Provenance Test');
    git(root, 'config', 'user.email', 'provenance@example.test');
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'clean\n');
    git(root, 'add', 'tracked.txt');
    git(root, 'commit', '-m', 'Initial subject');
    git(root, 'remote', 'add', 'origin', 'https://deploy-user:secret@example.test/acme/private.git');
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

describe('sanitizeRemoteUrl', () => {
    it('strips credentials from a ssh:// remote', () => {
        expect(sanitizeRemoteUrl('ssh://token:secret@host.example/acme/repo.git')).toBe(
            'ssh://host.example/acme/repo.git',
        );
    });

    it('strips a credential-bearing user from an SCP-style remote', () => {
        expect(sanitizeRemoteUrl('token@host.example:acme/repo.git')).toBe(
            'host.example:acme/repo.git',
        );
    });

    it('drops a secret carried in the query string of an https remote', () => {
        expect(sanitizeRemoteUrl('https://host.example/acme/repo.git?access_token=secret')).toBe(
            'https://host.example/acme/repo.git',
        );
    });

    it('drops a fragment from a remote URL', () => {
        expect(sanitizeRemoteUrl('https://host.example/acme/repo.git#readme')).toBe(
            'https://host.example/acme/repo.git',
        );
    });

    it('keeps a bracketed IPv6 canonical https remote valid', () => {
        expect(sanitizeRemoteUrl('https://[::1]:443/repo')).toBe('https://[::1]/repo');
    });

    it('passes a benign SCP-style remote through with the host intact', () => {
        expect(sanitizeRemoteUrl('git@example.test:acme/repo.git')).toBe(
            'example.test:acme/repo.git',
        );
    });

    it('strips credentials behind a git remote-helper prefix', () => {
        expect(sanitizeRemoteUrl('hg::https://token:secret@host.example/repo')).toBe(
            'hg::https://host.example/repo',
        );
    });

    it('drops a secret query string behind a git remote-helper prefix', () => {
        expect(sanitizeRemoteUrl('hg::https://host.example/repo?access_token=secret')).toBe(
            'hg::https://host.example/repo',
        );
    });

    it('passes an unrecognized remainder behind a helper prefix through unchanged', () => {
        expect(sanitizeRemoteUrl('fossil::/local/path')).toBe('fossil::/local/path');
    });

    it('strips credentials from a protocol-relative remote', () => {
        expect(sanitizeRemoteUrl('//token:secret@host.example/repo')).toBe(
            '//host.example/repo',
        );
    });

    it('drops query and fragment from a protocol-relative remote', () => {
        expect(sanitizeRemoteUrl('//host.example/repo?access_token=secret#frag')).toBe(
            '//host.example/repo',
        );
    });
});

describe('collectSourceMetadata — local Git', () => {
    it('collects a clean branch, SHA, subject, author date, and credential-free remote', () => {
        const root = repository();
        const metadata = collectSourceMetadata(root, {});

        expect(metadata).toMatchObject({
            metadata_source: 'git',
            commit_sha: git(root, 'rev-parse', 'HEAD'),
            short_sha: git(root, 'rev-parse', '--short=12', 'HEAD'),
            branch: 'main',
            commit_subject: 'Initial subject',
            dirty: false,
            remote_url: 'https://example.test/acme/private.git',
        });
        expect(metadata?.commit_author_date).toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
        );
    });

    it('includes tracked and untracked changes in the deployed subtree only', () => {
        const root = repository();
        const deployed = path.join(root, 'packages', 'deployed');
        const sibling = path.join(root, 'packages', 'sibling');
        fs.mkdirSync(deployed, { recursive: true });
        fs.mkdirSync(sibling, { recursive: true });
        fs.writeFileSync(path.join(deployed, 'workflow.ts'), 'export {};\n');
        fs.writeFileSync(path.join(sibling, 'outside.ts'), 'export {};\n');
        git(root, 'add', '.');
        git(root, 'commit', '-m', 'Add monorepo packages');

        fs.writeFileSync(path.join(sibling, 'outside.ts'), 'changed outside\n');
        expect(collectSourceMetadata(deployed, {})?.dirty).toBe(false);

        fs.writeFileSync(path.join(deployed, 'workflow.ts'), 'changed in deploy\n');
        expect(collectSourceMetadata(deployed, {})?.dirty).toBe(true);
        git(root, 'checkout', '--', 'packages/deployed/workflow.ts');
        expect(collectSourceMetadata(deployed, {})?.dirty).toBe(false);

        fs.writeFileSync(path.join(deployed, 'untracked.txt'), 'included in deploy\n');
        expect(collectSourceMetadata(deployed, {})?.dirty).toBe(true);
    });

    it('discovers Git from a subdirectory and a linked worktree', () => {
        const root = repository();
        const nested = path.join(root, 'nested', 'project');
        fs.mkdirSync(nested, { recursive: true });
        fs.writeFileSync(path.join(nested, 'workflow.ts'), 'export {};\n');
        git(root, 'add', '.');
        git(root, 'commit', '-m', 'Add nested project');
        expect(collectSourceMetadata(nested, {})?.commit_sha).toBe(git(root, 'rev-parse', 'HEAD'));

        const worktree = tempDir('sa-provenance-worktree-');
        fs.rmSync(worktree, { recursive: true, force: true });
        git(root, 'worktree', 'add', '-b', 'deploy-worktree', worktree);
        expect(collectSourceMetadata(worktree, {})).toMatchObject({
            branch: 'deploy-worktree',
            dirty: false,
        });
    });

    it('reports a tag pointing exactly at HEAD and no invented branch for detached HEAD', () => {
        const root = repository();
        git(root, 'tag', 'v1.2.3');
        git(root, 'checkout', '--detach', 'HEAD');

        expect(collectSourceMetadata(root, {})).toMatchObject({
            branch: null,
            tag: 'v1.2.3',
            dirty: false,
        });
    });

    it('does not report a tag that points only at an ancestor of HEAD', () => {
        const root = repository();
        git(root, 'tag', 'v1.2.3');
        fs.writeFileSync(path.join(root, 'later.txt'), 'later clean commit\n');
        git(root, 'add', 'later.txt');
        git(root, 'commit', '-m', 'Later untagged commit');

        expect(collectSourceMetadata(root, {})).toMatchObject({
            commit_sha: git(root, 'rev-parse', 'HEAD'),
            tag: null,
            dirty: false,
        });
    });

    it('strips terminal controls, bidi, and zero-width formatting from display strings', () => {
        const root = repository();
        git(root, 'remote', 'set-url', 'origin', 'git@example.test:acme/repo\u202E.git');
        fs.writeFileSync(path.join(root, 'subject.txt'), 'next\n');
        git(root, 'add', '.');
        git(root, 'commit', '-m', 'Safe\u200B subject');

        const metadata = collectSourceMetadata(root, {});

        expect(metadata?.commit_subject).toBe('Safe subject');
        expect(metadata?.remote_url).toBe('example.test:acme/repo.git');
    });

    it('returns no metadata for a non-repository directory', () => {
        expect(collectSourceMetadata(tempDir('sa-provenance-plain-'), {})).toBeNull();
    });

    it('keeps a local Git identity when an optional command fails instead of mixing in CI data', () => {
        const root = repository();
        git(root, 'remote', 'remove', 'origin');

        expect(collectSourceMetadata(root, {
            GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
            GITHUB_REF_NAME: 'unrelated-ci-branch',
            GITHUB_REF_TYPE: 'branch',
        })).toMatchObject({
            metadata_source: 'git',
            branch: 'main',
            remote_url: null,
        });
    });
});

describe('collectSourceMetadata — CI fallback', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';

    it('uses GitHub Actions first and distinguishes pull-request branches and tags', () => {
        const pr = collectSourceMetadata(tempDir('sa-ci-gh-'), {
            GITHUB_SHA: sha,
            GITHUB_HEAD_REF: 'feature/provenance',
            GITHUB_REF_NAME: '123/merge',
            GITHUB_REF_TYPE: 'branch',
            GITHUB_SERVER_URL: 'https://github.example.test',
            GITHUB_REPOSITORY: 'acme/private',
        });
        expect(pr).toMatchObject({
            metadata_source: 'github_actions',
            commit_sha: sha,
            short_sha: sha.slice(0, 12),
            branch: 'feature/provenance',
            dirty: null,
            remote_url: 'https://github.example.test/acme/private',
        });

        const tag = collectSourceMetadata(tempDir('sa-ci-gh-tag-'), {
            GITHUB_SHA: sha,
            GITHUB_REF_NAME: 'v2.0.0',
            GITHUB_REF_TYPE: 'tag',
        });
        expect(tag).toMatchObject({ branch: null, tag: 'v2.0.0' });
    });

    it('supports GitLab, CircleCI, and Bitbucket variables', () => {
        expect(collectSourceMetadata(tempDir('sa-ci-gl-'), {
            CI_COMMIT_SHA: sha,
            CI_COMMIT_REF_NAME: 'release',
            CI_COMMIT_TAG: 'v2',
            CI_COMMIT_TITLE: 'Release\u202E title',
            CI_COMMIT_TIMESTAMP: '2026-07-27T10:11:12-05:00',
            CI_REPOSITORY_URL: 'https://oauth2:token@gitlab.example.test/acme/private.git',
        })).toMatchObject({
            metadata_source: 'gitlab_ci',
            branch: 'release',
            tag: 'v2',
            commit_subject: 'Release title',
            remote_url: 'https://gitlab.example.test/acme/private.git',
            dirty: null,
        });

        expect(collectSourceMetadata(tempDir('sa-ci-circle-'), {
            CIRCLE_SHA1: sha,
            CIRCLE_BRANCH: 'main',
            CIRCLE_TAG: 'nightly',
            CIRCLE_REPOSITORY_URL: 'git@example.test:acme/repo.git',
        })).toMatchObject({
            metadata_source: 'circleci',
            branch: 'main',
            tag: 'nightly',
            dirty: null,
        });

        expect(collectSourceMetadata(tempDir('sa-ci-bb-'), {
            BITBUCKET_COMMIT: sha,
            BITBUCKET_BRANCH: 'main',
            BITBUCKET_TAG: 'stable',
            BITBUCKET_GIT_HTTP_ORIGIN: 'https://x-token-auth:token@bitbucket.example.test/acme/private.git',
        })).toMatchObject({
            metadata_source: 'bitbucket_pipelines',
            branch: 'main',
            tag: 'stable',
            remote_url: 'https://bitbucket.example.test/acme/private.git',
            dirty: null,
        });
    });

    it('uses documented CI precedence and ignores incomplete SHA sources', () => {
        const gitlabSha = 'abcdef0123456789abcdef0123456789abcdef01';
        expect(collectSourceMetadata(tempDir('sa-ci-precedence-'), {
            GITHUB_SHA: 'not-a-sha',
            CI_COMMIT_SHA: gitlabSha,
            CIRCLE_SHA1: sha,
        })?.metadata_source).toBe('gitlab_ci');
    });

    it('omits a malformed optional CI author date so it cannot reject valid SHA metadata', () => {
        expect(collectSourceMetadata(tempDir('sa-ci-bad-date-'), {
            CI_COMMIT_SHA: sha,
            CI_COMMIT_TIMESTAMP: 'not-an-iso-date',
        })).toMatchObject({
            metadata_source: 'gitlab_ci',
            commit_author_date: null,
        });
    });
});

describe('deploy provenance transport', () => {
    const metadata = {
        metadata_source: 'git' as const,
        commit_sha: '0123456789abcdef0123456789abcdef01234567',
        short_sha: '0123456789ab',
        branch: 'main',
        tag: null,
        commit_subject: 'Subject',
        commit_author_date: '2026-07-27T10:11:12-05:00',
        remote_url: 'https://example.test/acme/repo.git',
        dirty: false,
    };

    it('builds the live deploy multipart with the archive and one normalized source_metadata field', async () => {
        const archive = path.join(tempDir('sa-deploy-form-'), 'source.tar.gz');
        fs.writeFileSync(archive, 'valid archive bytes');
        const body = await multipartBody(buildDeployForm(archive, metadata));

        expect(body).toContain('name="source"');
        expect(body).toContain('valid archive bytes');
        expect(body).toContain('name="source_metadata"');
        expect(body).toContain(JSON.stringify(metadata));
    });

    it('keeps a non-repository source upload valid without adding a metadata field', async () => {
        const root = tempDir('sa-nonrepo-deploy-');
        const archive = path.join(root, 'source.tar.gz');
        fs.writeFileSync(archive, 'valid archive bytes');
        const body = await multipartBody(buildDeployForm(archive, collectSourceMetadata(root, {})));

        expect(body).toContain('name="source"');
        expect(body).not.toContain('name="source_metadata"');
    });

    it('builds a source-only multipart when either privacy opt-out omits collected metadata', async () => {
        const archive = path.join(tempDir('sa-private-deploy-'), 'source.tar.gz');
        fs.writeFileSync(archive, 'valid archive bytes');

        for (const enabled of [
            shouldCollectGitMetadata({ gitMetadata: false }, {}),
            shouldCollectGitMetadata({}, { SOLIDACTIONS_NO_GIT_METADATA: '1' }),
        ]) {
            const body = await multipartBody(buildDeployForm(archive, enabled ? metadata : null));
            expect(body).toContain('name="source"');
            expect(body).not.toContain('name="source_metadata"');
        }
    });

    it('omits metadata for either privacy opt-out', () => {
        expect(shouldCollectGitMetadata({ gitMetadata: false }, {})).toBe(false);
        expect(shouldCollectGitMetadata({}, { SOLIDACTIONS_NO_GIT_METADATA: '1' })).toBe(false);
        expect(shouldCollectGitMetadata({}, {})).toBe(true);
    });

    it('creates the archive outside the source tree and removes its whole temp directory', () => {
        const source = tempDir('sa-provenance-source-');
        const location = createDeployArchiveLocation();
        roots.push(location.directory);

        expect(path.relative(source, location.archivePath)).toMatch(/^\.\./);
        expect(location.archivePath).not.toContain('.steps-deploy.tar.gz');
        fs.writeFileSync(location.archivePath, 'archive');
        location.cleanup();
        expect(fs.existsSync(location.directory)).toBe(false);
        expect(fs.readdirSync(source)).toEqual([]);
    });

    it('captures the accepted deployment identity, normalized metadata, and safe rejection code', () => {
        expect(parseDeployAcceptance({
            deployment_id: 'deployment-123',
            source_metadata: metadata,
            source_metadata_rejected: 'invalid_commit_sha',
            schedules_paused: true,
        })).toEqual({
            deploymentId: 'deployment-123',
            sourceMetadata: metadata,
            sourceMetadataRejected: 'invalid_commit_sha',
            schedulesPaused: true,
        });

        expect(parseDeployAcceptance({ message: 'queued' })).toEqual({
            deploymentId: null,
            sourceMetadata: null,
            sourceMetadataRejected: null,
            schedulesPaused: null,
        });
    });
});

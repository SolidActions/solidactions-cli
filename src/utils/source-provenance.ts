import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import FormData from 'form-data';
import { sanitizeCell } from './table';

export type MetadataSource =
    | 'git'
    | 'github_actions'
    | 'gitlab_ci'
    | 'circleci'
    | 'bitbucket_pipelines';

export interface SourceMetadata {
    metadata_source: MetadataSource;
    commit_sha: string;
    short_sha: string | null;
    branch: string | null;
    tag: string | null;
    commit_subject: string | null;
    commit_author_date: string | null;
    remote_url: string | null;
    dirty: boolean | null;
    default_branch: string | null;
    default_branch_sha: string | null;
    commits_behind: number | null;
}

export interface DeployAcceptance {
    deploymentId: string | null;
    sourceMetadata: SourceMetadata | null;
    sourceMetadataRejected: string | null;
    schedulesPaused: boolean | null;
}

type Environment = Record<string, string | undefined>;

const DISPLAY_FORMATTING = /[\x00-\x1f\x7f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
const STRICT_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function displayValue(value: string | undefined, maxLength: number): string | null {
    if (!value) {
        return null;
    }

    const sanitized = value.replace(DISPLAY_FORMATTING, '').trim().slice(0, maxLength);
    return sanitized === '' ? null : sanitized;
}

export function sanitizeDisplayText(value: unknown, maxLength = 2048): string | null {
    return typeof value === 'string' ? displayValue(value, maxLength) : null;
}

function dirtyLabel(dirty: boolean | null): string {
    if (dirty === true) {
        return 'DIRTY';
    }
    if (dirty === false) {
        return 'clean';
    }
    return 'dirty state unknown';
}

export function formatRevisionSummary(metadata: {
    commit_sha: string | null;
    short_sha: string | null;
    dirty: boolean | null;
}): string {
    const sha = sanitizeDisplayText(metadata.short_sha, 16)
        ?? sanitizeDisplayText(metadata.commit_sha, 64);
    if (!sha) {
        return 'No source revision was reported.';
    }

    return `${sha} (${dirtyLabel(
        typeof metadata.dirty === 'boolean' ? metadata.dirty : null,
    )})`;
}

export interface DeployedRevision {
    commit_sha?: unknown;
    short_sha?: unknown;
    dirty?: unknown;
    default_branch?: unknown;
    commits_behind?: unknown;
}

export function revisionSha(revision: DeployedRevision | null | undefined): string | null {
    if (!revision) return null;
    return sanitizeDisplayText(revision.short_sha, 16)
        ?? sanitizeDisplayText(revision.commit_sha, 64);
}

export function formatDetailedRevision(revision: DeployedRevision | null | undefined): string {
    const sha = revisionSha(revision);
    if (!sha) return 'unknown';
    const states = [revision?.dirty === true
        ? 'DIRTY'
        : revision?.dirty === false ? 'clean' : 'dirty state unknown'];
    const branch = sanitizeDisplayText(revision?.default_branch, 255);
    if (branch && typeof revision?.commits_behind === 'number'
        && Number.isSafeInteger(revision.commits_behind) && revision.commits_behind > 0) {
        states.push(`${revision.commits_behind} behind origin/${branch} at deploy`);
    }
    return sanitizeCell(`${sha} (${states.join(', ')})`);
}

function shaValue(value: string | undefined): string | null {
    const sanitized = displayValue(value, 64);
    return sanitized && SHA_PATTERN.test(sanitized) ? sanitized : null;
}

function authorDateValue(value: string | undefined): string | null {
    const sanitized = displayValue(value, 40);
    return sanitized && STRICT_ISO_PATTERN.test(sanitized) ? sanitized : null;
}

const SCP_STYLE_PATTERN = /^[^@\s/]+@([^\s/:]+):(.+)$/;
// Git remote helper syntax: `<helper>::<address>`, e.g. `hg::https://host/repo`.
// https://git-scm.com/docs/gitremote-helpers
const HELPER_PREFIX_PATTERN = /^([a-zA-Z0-9-]+::)(.*)$/;

export function sanitizeRemoteUrl(value: string | undefined): string | null {
    const sanitized = displayValue(value, 2048);
    if (!sanitized) {
        return null;
    }

    const helperMatch = HELPER_PREFIX_PATTERN.exec(sanitized);
    if (helperMatch) {
        const [, prefix, remainder] = helperMatch;
        const sanitizedRemainder = sanitizeRemoteUrl(remainder);
        return sanitizedRemainder === null ? null : `${prefix}${sanitizedRemainder}`;
    }

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(sanitized)) {
        try {
            const remote = new URL(sanitized);
            remote.username = '';
            remote.password = '';
            remote.search = '';
            remote.hash = '';
            return remote.toString();
        } catch {
            return null;
        }
    }

    if (/^\/\//.test(sanitized)) {
        // Protocol-relative: //[user[:pass]@]host[:port]/path[?query][#fragment]
        return sanitized
            .split('#')[0]
            .split('?')[0]
            .replace(/^\/\/[^/@]*@/, '//');
    }

    const scpMatch = SCP_STYLE_PATTERN.exec(sanitized);
    if (scpMatch) {
        const [, host, path] = scpMatch;
        return `${host}:${path}`;
    }

    return sanitized;
}

function git(sourceDir: string, args: string[]): string | null {
    const result = spawnSync('git', ['-C', sourceDir, ...args], {
        encoding: 'utf8',
        timeout: 2_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
    });

    if (result.status !== 0 || result.error) {
        return null;
    }

    return result.stdout.trim();
}

interface DefaultBranchEvidence {
    default_branch: string | null;
    default_branch_sha: string | null;
    commits_behind: number | null;
}

const NULL_DEFAULT_BRANCH_EVIDENCE: DefaultBranchEvidence = {
    default_branch: null,
    default_branch_sha: null,
    commits_behind: null,
};

function defaultBranchEvidence(
    sourceDir: string,
    hasOrigin: boolean,
    hint?: (message: string) => void,
): DefaultBranchEvidence {
    if (!hasOrigin || git(sourceDir, ['rev-parse', '--is-shallow-repository']) !== 'false') {
        return NULL_DEFAULT_BRANCH_EVIDENCE;
    }

    let trackingRef = git(sourceDir, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    if (trackingRef === null) {
        // Only a genuinely absent origin/HEAD permits the conventional-name fallback.
        // An unexpected direct ref is existing-but-invalid evidence, just like a stale
        // symbolic target, and must not be silently replaced with a guess.
        if (git(sourceDir, ['rev-parse', '--verify', 'refs/remotes/origin/HEAD']) !== null) {
            return NULL_DEFAULT_BRANCH_EVIDENCE;
        }
        const candidates = ['main', 'master'].filter((branch) =>
            git(sourceDir, ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]) !== null,
        );
        if (candidates.length !== 1) {
            hint?.('Unable to determine origin default branch; run `git remote set-head origin -a`.');
            return NULL_DEFAULT_BRANCH_EVIDENCE;
        }
        trackingRef = `refs/remotes/origin/${candidates[0]}`;
    }

    const prefix = 'refs/remotes/origin/';
    if (!trackingRef.startsWith(prefix)) {
        return NULL_DEFAULT_BRANCH_EVIDENCE;
    }
    const branch = displayValue(trackingRef.slice(prefix.length), 255);
    const sha = shaValue(git(sourceDir, ['rev-parse', '--verify', `${trackingRef}^{commit}`]) ?? undefined);
    if (!branch || !sha) {
        return NULL_DEFAULT_BRANCH_EVIDENCE;
    }

    const counts = git(sourceDir, ['rev-list', '--left-right', '--count', `HEAD...${trackingRef}`]);
    const match = counts?.match(/^(\d+)\s+(\d+)$/);
    if (!match) {
        return NULL_DEFAULT_BRANCH_EVIDENCE;
    }
    const behind = Number(match[2]);
    if (!Number.isSafeInteger(behind) || behind < 0 || behind > 2_147_483_647) {
        return NULL_DEFAULT_BRANCH_EVIDENCE;
    }

    return { default_branch: branch, default_branch_sha: sha, commits_behind: behind };
}

function localGitMetadata(
    sourceDir: string,
    hint?: (message: string) => void,
): SourceMetadata | null {
    if (git(sourceDir, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
        return null;
    }

    const commitSha = shaValue(git(sourceDir, ['rev-parse', 'HEAD']) ?? undefined);
    if (!commitSha) {
        return null;
    }

    const status = git(sourceDir, ['status', '--porcelain=v1', '--untracked-files=all', '--', '.']);
    const shortSha = shaValue(git(sourceDir, ['rev-parse', '--short=12', 'HEAD']) ?? undefined);
    const remoteUrl = sanitizeRemoteUrl(git(sourceDir, ['config', '--get', 'remote.origin.url']) ?? undefined);

    return {
        metadata_source: 'git',
        commit_sha: commitSha,
        short_sha: shortSha,
        branch: displayValue(git(sourceDir, ['symbolic-ref', '--short', '-q', 'HEAD']) ?? undefined, 255),
        tag: displayValue(git(sourceDir, ['describe', '--tags', '--exact-match', 'HEAD']) ?? undefined, 255),
        commit_subject: displayValue(git(sourceDir, ['show', '-s', '--format=%s', 'HEAD']) ?? undefined, 500),
        commit_author_date: authorDateValue(git(sourceDir, ['show', '-s', '--format=%aI', 'HEAD']) ?? undefined),
        remote_url: remoteUrl,
        dirty: status === null ? null : status !== '',
        ...defaultBranchEvidence(sourceDir, remoteUrl !== null, hint),
    };
}

function baseCiMetadata(source: MetadataSource, sha: string): SourceMetadata {
    return {
        metadata_source: source,
        commit_sha: sha,
        short_sha: sha.slice(0, 12),
        branch: null,
        tag: null,
        commit_subject: null,
        commit_author_date: null,
        remote_url: null,
        dirty: null,
        default_branch: null,
        default_branch_sha: null,
        commits_behind: null,
    };
}

function githubMetadata(environment: Environment): SourceMetadata | null {
    const sha = shaValue(environment.GITHUB_SHA);
    if (!sha) {
        return null;
    }

    const metadata = baseCiMetadata('github_actions', sha);
    metadata.branch = displayValue(
        environment.GITHUB_HEAD_REF
            || (environment.GITHUB_REF_TYPE === 'branch' ? environment.GITHUB_REF_NAME : undefined),
        255,
    );
    metadata.tag = displayValue(
        environment.GITHUB_REF_TYPE === 'tag' ? environment.GITHUB_REF_NAME : undefined,
        255,
    );
    const server = displayValue(environment.GITHUB_SERVER_URL, 1024);
    const repository = displayValue(environment.GITHUB_REPOSITORY, 1024);
    metadata.remote_url = sanitizeRemoteUrl(server && repository ? `${server.replace(/\/$/, '')}/${repository}` : undefined);
    return metadata;
}

function gitlabMetadata(environment: Environment): SourceMetadata | null {
    const sha = shaValue(environment.CI_COMMIT_SHA);
    if (!sha) {
        return null;
    }

    return {
        ...baseCiMetadata('gitlab_ci', sha),
        branch: displayValue(environment.CI_COMMIT_REF_NAME, 255),
        tag: displayValue(environment.CI_COMMIT_TAG, 255),
        commit_subject: displayValue(environment.CI_COMMIT_TITLE, 500),
        commit_author_date: authorDateValue(environment.CI_COMMIT_TIMESTAMP),
        remote_url: sanitizeRemoteUrl(environment.CI_REPOSITORY_URL),
    };
}

function circleMetadata(environment: Environment): SourceMetadata | null {
    const sha = shaValue(environment.CIRCLE_SHA1);
    if (!sha) {
        return null;
    }

    return {
        ...baseCiMetadata('circleci', sha),
        branch: displayValue(environment.CIRCLE_BRANCH, 255),
        tag: displayValue(environment.CIRCLE_TAG, 255),
        remote_url: sanitizeRemoteUrl(environment.CIRCLE_REPOSITORY_URL),
    };
}

function bitbucketMetadata(environment: Environment): SourceMetadata | null {
    const sha = shaValue(environment.BITBUCKET_COMMIT);
    if (!sha) {
        return null;
    }

    return {
        ...baseCiMetadata('bitbucket_pipelines', sha),
        branch: displayValue(environment.BITBUCKET_BRANCH, 255),
        tag: displayValue(environment.BITBUCKET_TAG, 255),
        remote_url: sanitizeRemoteUrl(
            environment.BITBUCKET_GIT_HTTP_ORIGIN || environment.BITBUCKET_GIT_SSH_ORIGIN,
        ),
    };
}

export function collectSourceMetadata(
    sourceDir: string,
    environment: Environment = process.env,
    hint?: (message: string) => void,
): SourceMetadata | null {
    return localGitMetadata(path.resolve(sourceDir), hint)
        ?? githubMetadata(environment)
        ?? gitlabMetadata(environment)
        ?? circleMetadata(environment)
        ?? bitbucketMetadata(environment);
}

export function shouldCollectGitMetadata(
    options: { gitMetadata?: boolean },
    environment: Environment = process.env,
): boolean {
    return options.gitMetadata !== false && environment.SOLIDACTIONS_NO_GIT_METADATA !== '1';
}

function appendSourceMetadata(form: FormData, metadata: SourceMetadata | null): void {
    if (metadata) {
        form.append('source_metadata', JSON.stringify(metadata));
    }
}

export function buildDeployForm(archivePath: string, metadata: SourceMetadata | null): FormData {
    const form = new FormData();
    form.append('source', fs.createReadStream(archivePath));
    appendSourceMetadata(form, metadata);
    return form;
}

export function createDeployArchiveLocation(): {
    directory: string;
    archivePath: string;
    cleanup: () => void;
} {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'solidactions-deploy-'));
    return {
        directory,
        archivePath: path.join(directory, 'source.tar.gz'),
        cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
    };
}

function nullableString(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

export function parseDeployAcceptance(data: unknown): DeployAcceptance {
    const body = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    const sourceMetadata = body.source_metadata && typeof body.source_metadata === 'object'
        ? body.source_metadata as SourceMetadata
        : null;

    return {
        deploymentId: nullableString(body.deployment_id),
        sourceMetadata,
        sourceMetadataRejected: nullableString(body.source_metadata_rejected),
        schedulesPaused: typeof body.schedules_paused === 'boolean'
            ? body.schedules_paused
            : null,
    };
}

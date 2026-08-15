import axios from 'axios';
import chalk from 'chalk';
import { getApiHeaders, requireConfigWithWorkspace } from '../utils/api';
import type { Config } from '../utils/config';
import { buildProjectSlug, slugifyName } from '../utils/slug';
import {
    formatDetailedRevision,
    revisionSha,
    sanitizeDisplayText,
    sanitizeRemoteUrl,
    type MetadataSource,
} from '../utils/source-provenance';

export interface DeploymentDetail {
    id: string;
    status: string;
    source_hash: string;
    metadata_source: MetadataSource | null;
    commit_sha: string | null;
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
    completed_at: string | null;
}

export interface ProjectDeploymentDetail {
    slug?: string;
    name?: string;
    status?: string;
    enabled?: boolean;
    deployed_hash?: string | null;
    deployment_matches_deployed_hash?: boolean;
    latest_successful_deployment?: DeploymentDetail | null;
}

export interface ProjectViewOptions {
    env?: string;
    json?: boolean;
}

/**
 * Projects exactly the fields `DeploymentDetail` declares.
 *
 * The server's DeploymentResource serializes more than this — `failure_reason`
 * today, more tomorrow — and that field is always null for a *successful*
 * deployment, which is the only kind this endpoint returns here. Listing the
 * fields explicitly keeps `--json` a documented contract instead of a mirror of
 * whatever the API happens to add next.
 */
function deploymentJsonProjection(deployment: DeploymentDetail): Record<string, unknown> {
    return {
        id: deployment.id,
        status: deployment.status,
        source_hash: deployment.source_hash,
        metadata_source: deployment.metadata_source ?? null,
        commit_sha: deployment.commit_sha ?? null,
        short_sha: deployment.short_sha ?? null,
        branch: deployment.branch ?? null,
        tag: deployment.tag ?? null,
        commit_subject: deployment.commit_subject ?? null,
        commit_author_date: deployment.commit_author_date ?? null,
        remote_url: deployment.remote_url ?? null,
        dirty: deployment.dirty ?? null,
        default_branch: deployment.default_branch ?? null,
        default_branch_sha: deployment.default_branch_sha ?? null,
        commits_behind: deployment.commits_behind ?? null,
        completed_at: deployment.completed_at ?? null,
    };
}

export function projectViewJsonProjection(project: ProjectDeploymentDetail): Record<string, unknown> {
    const deployment = project.latest_successful_deployment ?? null;

    return {
        slug: project.slug ?? null,
        name: project.name ?? null,
        status: project.status ?? null,
        enabled: project.enabled ?? null,
        deployed_hash: project.deployed_hash ?? null,
        deployment_matches_deployed_hash: project.deployment_matches_deployed_hash ?? false,
        latest_successful_deployment: deployment === null ? null : deploymentJsonProjection(deployment),
    };
}

export function projectSlugForView(project: string, environment?: string): string {
    if (environment === undefined) {
        return project;
    }

    if (!['production', 'staging', 'dev'].includes(environment)) {
        throw new Error('Environment must be production, staging, or dev.');
    }

    if (slugifyName(project) === '') {
        throw new Error('Project must contain at least one letter or number.');
    }

    return environment === 'production'
        ? project
        : buildProjectSlug(project, environment);
}

function metadataSourceLabel(source: unknown): string | null {
    const labels: Record<string, string> = {
        git: 'Git',
        github_actions: 'GitHub Actions',
        gitlab_ci: 'GitLab CI',
        circleci: 'CircleCI',
        bitbucket_pipelines: 'Bitbucket Pipelines',
    };
    const safe = sanitizeDisplayText(source, 32);
    return safe ? labels[safe] ?? safe : null;
}

export function formatDeploymentRevision(deployment: DeploymentDetail): string[] {
    if (revisionSha(deployment) === null) {
        const archiveHash = sanitizeDisplayText(deployment.source_hash, 64);
        return [
            'No source revision was reported.',
            ...(archiveHash ? [`Archive: ${archiveHash}`] : []),
        ];
    }

    const lines = [
        `Revision (Client-reported): ${formatDetailedRevision(deployment)}`,
    ];
    const source = metadataSourceLabel(deployment.metadata_source);
    if (source) {
        lines.push(`Source: ${source}`);
    }

    const branch = sanitizeDisplayText(deployment.branch, 255);
    const tag = sanitizeDisplayText(deployment.tag, 255);
    if (branch) {
        lines.push(`Branch: ${branch}`);
    }
    if (tag) {
        lines.push(`Tag: ${tag}`);
    }

    const subject = sanitizeDisplayText(deployment.commit_subject, 500);
    const authorDate = sanitizeDisplayText(deployment.commit_author_date, 40);
    // Defense in depth: sanitizeRemoteUrl already strips credentials at
    // collection time (source-provenance.ts), but a legacy or unnormalized
    // server response could still carry them, so re-sanitize at this display
    // boundary too — remote_url must never reach the terminal with a token.
    const remote = sanitizeRemoteUrl(sanitizeDisplayText(deployment.remote_url, 2048) ?? undefined);
    if (subject) {
        lines.push(`Subject: ${subject}`);
    }
    if (authorDate) {
        lines.push(`Author date: ${authorDate}`);
    }
    if (remote) {
        lines.push(`Remote: ${remote}`);
    }

    return lines;
}

export function formatProjectView(project: ProjectDeploymentDetail): string[] {
    const slug = sanitizeDisplayText(project.slug ?? project.name, 255) ?? 'unknown';
    const status = sanitizeDisplayText(project.status, 64) ?? 'unknown';
    const lines = [`Project: ${slug}`, `Status: ${status}`];
    if (typeof project.enabled === 'boolean') {
        lines.push(`Enabled: ${project.enabled ? 'on' : 'off'}`);
    }
    const deployment = project.latest_successful_deployment ?? null;

    if (!project.deployed_hash && !deployment) {
        lines.push('No deployment provenance recorded (deployed before tracking).');
        return lines;
    }

    if (project.deployment_matches_deployed_hash !== true || !deployment) {
        lines.push('Revision unknown for the running build.');
        return lines;
    }

    lines.push(...formatDeploymentRevision(deployment));
    return lines;
}

export async function projectViewWithConfig(
    project: string,
    options: ProjectViewOptions,
    config: Config,
    writeLine: (line: string) => void = console.log,
): Promise<void> {
    let slug: string;
    try {
        slug = projectSlugForView(project, options.env ?? 'dev');
    } catch (error: any) {
        console.error(chalk.red(error.message));
        process.exit(1);
        return;
    }

    try {
        const response = await axios.get(
            `${config.host}/api/v1/projects/${encodeURIComponent(slug)}?include=deployment`,
            { headers: getApiHeaders(config) },
        );
        if (options.json) {
            writeLine(JSON.stringify(projectViewJsonProjection(response.data), null, 2));
        } else {
            for (const line of formatProjectView(response.data)) {
                writeLine(line);
            }
        }
    } catch (error: any) {
        if (error.response?.status === 401) {
            console.error(chalk.red('Authentication failed. Run "solidactions login --global" to re-configure.'));
        } else if (error.response?.status === 404) {
            const message = sanitizeDisplayText(error.response.data?.message, 500)
                ?? `Project "${slug}" not found.`;
            console.error(chalk.red(message));
        } else if (error.response) {
            console.error(chalk.red(`Failed to view project: ${error.response.status}`));
        } else {
            console.error(chalk.red('Connection failed:'), error.message);
        }
        process.exit(1);
    }
}

export async function projectView(project: string, options: ProjectViewOptions): Promise<void> {
    const config = await requireConfigWithWorkspace();
    await projectViewWithConfig(project, options, config);
}

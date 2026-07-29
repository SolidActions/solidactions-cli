/**
 * App issue #972: rebuild provenance can lag server-side, so the single
 * confirmation GET fired the instant status flips to "deployed" can catch
 * the server before latest_successful_deployment / deployment_matches_deployed_hash
 * have caught up, wrongly printing the mismatch message for a healthy deploy.
 * confirmDeploymentWithRetry is the extracted, independently testable retry
 * wrapper around fetchDeploymentConfirmation — injected fetcher/wait keep
 * this deterministic and fast (no real network, no real timers).
 */
import { describe, expect, it } from 'vitest';
import { confirmDeploymentWithRetry, isConfirmationMatch } from '../src/commands/deploy';
import type { ProjectDeploymentDetail } from '../src/commands/project-view';

function project(overrides: Partial<ProjectDeploymentDetail> = {}): ProjectDeploymentDetail {
    return {
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
        ...overrides,
    };
}

const mismatched = project({ deployment_matches_deployed_hash: false });
const matched = project();

describe('isConfirmationMatch', () => {
    it('is true when the hash matches and the deployment ID matches', () => {
        expect(isConfirmationMatch(matched, 'accepted-deployment')).toBe(true);
    });

    it('is false on a deployed-hash mismatch', () => {
        expect(isConfirmationMatch(mismatched, 'accepted-deployment')).toBe(false);
    });

    it('is false when no matching deployment row exists', () => {
        expect(isConfirmationMatch(project({ latest_successful_deployment: null }), 'accepted-deployment')).toBe(false);
    });

    it('is false on a deployment-ID mismatch', () => {
        expect(isConfirmationMatch(matched, 'different-deployment')).toBe(false);
    });

    it('is true (nothing to retry against) for a legacy null accepted ID', () => {
        expect(isConfirmationMatch(mismatched, null)).toBe(true);
    });
});

describe('confirmDeploymentWithRetry', () => {
    it('does not retry when the first fetch already matches', async () => {
        let calls = 0;
        const result = await confirmDeploymentWithRetry(
            'accepted-deployment',
            async () => { calls++; return matched; },
            { wait: async () => {} },
        );

        expect(calls).toBe(1);
        expect(result).toBe(matched);
    });

    it('retries a mismatch and returns the eventually-matching result', async () => {
        let calls = 0;
        const waited: number[] = [];
        const result = await confirmDeploymentWithRetry(
            'accepted-deployment',
            async () => { calls++; return calls < 3 ? mismatched : matched; },
            { wait: async (ms: number) => { waited.push(ms); } },
        );

        expect(calls).toBe(3);
        expect(result).toBe(matched);
        expect(waited).toHaveLength(2);
        expect(waited.every((ms) => ms > 0)).toBe(true);
    });

    it('gives up after a bounded number of attempts (2-3) and returns the last mismatch', async () => {
        let calls = 0;
        const result = await confirmDeploymentWithRetry(
            'accepted-deployment',
            async () => { calls++; return mismatched; },
            { wait: async () => {} },
        );

        expect(calls).toBeGreaterThanOrEqual(2);
        expect(calls).toBeLessThanOrEqual(3);
        expect(result).toBe(mismatched);
    });
});

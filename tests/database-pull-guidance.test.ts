import { describe, expect, it } from 'vitest';
import {
    DATABASE_PULL_HELP,
    WORKFLOW_RUN_PULL_WARNING,
    isInsideWorkflowRun,
} from '../src/utils/database-pull-guidance';

describe('database pull guidance', () => {
    it('detects a workflow run only from a non-empty run env key', () => {
        expect(isInsideWorkflowRun({})).toBe(false);
        expect(isInsideWorkflowRun({ SOLIDACTIONS_RUN_ID: '' })).toBe(false);
        expect(isInsideWorkflowRun({ SOLIDACTIONS_RUN_ID: 'r' })).toBe(true);
        expect(isInsideWorkflowRun({ STEPS_TRIGGER_ID: '7' })).toBe(true);
    });

    it('pins the frozen workflow-run pull warning verbatim', () => {
        expect(WORKFLOW_RUN_PULL_WARNING).toBe(
            'Warning: database pull is running inside a workflow run. A workflow or function can query the database directly (ctx.vars with createDatabaseClient); pulling a copy on every run downloads it again each time. Use pull only for local analysis and keep one copy.',
        );
    });

    it('names no supplier in either frozen string', () => {
        for (const text of [WORKFLOW_RUN_PULL_WARNING, DATABASE_PULL_HELP]) {
            expect(text).not.toMatch(/turso|libsql|daytona|cloudflare/i);
            expect(text).not.toMatch(/\br2\b/i);
        }
    });

    it('tells pull users to query directly, reuse one copy, and how to skip the cache', () => {
        expect(DATABASE_PULL_HELP).toContain('createDatabaseClient');
        expect(DATABASE_PULL_HELP).toContain('--no-cache');
        expect(DATABASE_PULL_HELP).toContain('~/.solidactions/cache/database-replicas');
    });
});

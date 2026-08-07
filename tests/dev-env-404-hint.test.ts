/**
 * Free-plan environment fallback (billing v0.5): `dev --env <env>` 404s
 * unhelpfully when the requested environment project can't exist because
 * the tenant is on the free plan (staging/dev are Pro+ only).
 *
 * runDev() now appends a hint to the "failed to fetch platform vars" error
 * when the failure is a 404 AND the requested env isn't 'production' —
 * pointing the user at `--env production` instead of leaving a bare 404.
 *
 * Test-double policy: the SaApiClient injection seam (api option) is a real
 * object implementing the interface — same pattern as the "dropped secret"
 * test in dev.test.ts. No mock/spy/stub libraries.
 */
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { runDev, type SaApiClient, type PlatformVar } from '../src/commands/dev';

const ECHO_FIXTURE = path.resolve(__dirname, '../fixtures/echo.ts');

function fakeApi404(): SaApiClient {
    return {
        projectSlug: 'test-project-dev',
        async fetchVarsAndConnections(_env: string): Promise<PlatformVar[]> {
            const err: any = new Error('Request failed with status code 404');
            err.response = { status: 404, data: { message: "Project 'test-project-dev' not found." } };
            throw err;
        },
    };
}

function fakeApi500(): SaApiClient {
    return {
        projectSlug: 'test-project-dev',
        async fetchVarsAndConnections(_env: string): Promise<PlatformVar[]> {
            const err: any = new Error('Request failed with status code 500');
            err.response = { status: 500, data: { message: 'Internal server error' } };
            throw err;
        },
    };
}

describe('runDev — free-plan 404 hint on vars-fetch failure', () => {
    it("appends the free-plan hint when env='dev' 404s", async () => {
        const out = await runDev({ entry: ECHO_FIXTURE, input: '{"n":1}', env: 'dev', api: fakeApi404() });
        expect(out.stderr).toContain("The 'dev' environment project doesn't exist");
        expect(out.stderr).toContain('staging/dev environments require a paid plan');
        expect(out.stderr).toContain('use --env production');
    }, 20_000);

    it("appends the free-plan hint when env='staging' 404s", async () => {
        const out = await runDev({ entry: ECHO_FIXTURE, input: '{"n":1}', env: 'staging', api: fakeApi404() });
        expect(out.stderr).toContain("The 'staging' environment project doesn't exist");
    }, 20_000);

    it("does NOT append the hint when env='production' 404s", async () => {
        const out = await runDev({ entry: ECHO_FIXTURE, input: '{"n":1}', env: 'production', api: fakeApi404() });
        expect(out.stderr).toMatch(/failed to fetch platform vars/);
        expect(out.stderr).not.toContain('environment project doesn\'t exist');
        expect(out.stderr).not.toContain('use --env production');
    }, 20_000);

    it('does NOT append the hint for a non-404 failure (e.g. 500)', async () => {
        const out = await runDev({ entry: ECHO_FIXTURE, input: '{"n":1}', env: 'dev', api: fakeApi500() });
        expect(out.stderr).toMatch(/failed to fetch platform vars/);
        expect(out.stderr).not.toContain('environment project doesn\'t exist');
    }, 20_000);

    it('the run still completes despite the vars-fetch failure (hint is additive, not fatal)', async () => {
        const out = await runDev({ entry: ECHO_FIXTURE, input: '{"n":3}', env: 'dev', api: fakeApi404() });
        expect(out.result).toEqual({ status: 'completed', output: 6 });
    }, 20_000);
});

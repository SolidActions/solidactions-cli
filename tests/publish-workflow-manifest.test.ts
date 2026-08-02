// #1004 PR 0: the release workflow must attach the command manifest as a release
// asset (the content repo's pinnable artifact), and must build AFTER the tag-derived
// version rewrite so the manifest carries the released version, not package.json's
// vestigial one.
import { describe, expect, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';

const WORKFLOW_PATH = path.resolve(__dirname, '../.github/workflows/publish.yml');
const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
const parsedWorkflow = yaml.load(workflow) as {
    jobs: { publish: { permissions: Record<string, string> } };
};
const permissions = parsedWorkflow.jobs.publish.permissions;

describe('publish workflow — command manifest release asset', () => {
    it('grants contents: write (not read) so the asset can be uploaded', () => {
        expect(permissions.contents).toBe('write');
    });

    it('keeps id-token: write for npm provenance', () => {
        expect(permissions['id-token']).toBe('write');
    });

    it('uploads dist/command-manifest.json to the release', () => {
        expect(workflow).toContain('dist/command-manifest.json');
        expect(workflow).toMatch(/gh release upload/);
        expect(workflow).toContain('--clobber');
    });

    it('builds after the tag-derived version rewrite so the manifest carries the released version', () => {
        const versionRewrite = workflow.indexOf('npm version --no-git-tag-version');
        const build = workflow.indexOf('npm run build');
        const publishGuard = workflow.indexOf('npm view "@solidactions/cli@$VERSION"');
        // Anchor on the flagged invocation, not the bare phrase — the restored
        // #77 comment above the version-rewrite step also mentions "npm publish".
        const publish = workflow.indexOf('npm publish --provenance');
        const upload = workflow.indexOf('gh release upload');

        expect(versionRewrite).toBeGreaterThan(-1);
        expect(build).toBeGreaterThan(versionRewrite);
        expect(publishGuard).toBeGreaterThan(build);
        expect(publish).toBeGreaterThan(publishGuard);
        expect(upload).toBeGreaterThan(publish);
    });

    it('guards npm publish with an already-published check so a rerun after a failed upload can proceed', () => {
        expect(workflow).toContain('npm view "@solidactions/cli@$VERSION" version');
        expect(workflow).toContain('npm publish --provenance --access public');
    });

    it('still asserts the release tag is a literal semver before rewriting the version', () => {
        const assertion = workflow.indexOf('is not a semver version');
        const versionRewrite = workflow.indexOf('npm version --no-git-tag-version');

        expect(assertion).toBeGreaterThan(-1);
        expect(assertion).toBeLessThan(versionRewrite);
    });
});

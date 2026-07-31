// #1004 PR 0: the release workflow must attach the command manifest as a release
// asset (the content repo's pinnable artifact), and must build AFTER the tag-derived
// version rewrite so the manifest carries the released version, not package.json's
// vestigial one.
import { describe, expect, it } from 'vitest';
import path from 'path';
import fs from 'fs';

const WORKFLOW_PATH = path.resolve(__dirname, '../.github/workflows/publish.yml');
const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

describe('publish workflow — command manifest release asset', () => {
    it('grants contents: write so the asset can be uploaded', () => {
        expect(workflow).toMatch(/contents:\s*write/);
        expect(workflow).not.toMatch(/contents:\s*read/);
    });

    it('keeps id-token: write for npm provenance', () => {
        expect(workflow).toMatch(/id-token:\s*write/);
    });

    it('uploads dist/command-manifest.json to the release', () => {
        expect(workflow).toContain('dist/command-manifest.json');
        expect(workflow).toMatch(/gh release upload/);
        expect(workflow).toContain('--clobber');
    });

    it('builds after the tag-derived version rewrite so the manifest carries the released version', () => {
        const versionRewrite = workflow.indexOf('npm version --no-git-tag-version');
        const build = workflow.indexOf('npm run build');
        const publish = workflow.indexOf('npm publish');
        const upload = workflow.indexOf('gh release upload');

        expect(versionRewrite).toBeGreaterThan(-1);
        expect(build).toBeGreaterThan(versionRewrite);
        expect(publish).toBeGreaterThan(build);
        expect(upload).toBeGreaterThan(publish);
    });

    it('still asserts the release tag is a literal semver before rewriting the version', () => {
        const assertion = workflow.indexOf('is not a semver version');
        const versionRewrite = workflow.indexOf('npm version --no-git-tag-version');

        expect(assertion).toBeGreaterThan(-1);
        expect(assertion).toBeLessThan(versionRewrite);
    });
});

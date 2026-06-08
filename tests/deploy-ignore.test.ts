import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    isHardDenied,
    buildDeployMatcher,
    isIgnoredDirectory,
    planDeployFiles,
} from '../src/utils/deploy-ignore';
import { SolidActionsConfig } from '../src/utils/env';

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-deploy-ignore-'));
}

function writeFile(root: string, relPath: string, content = ''): void {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
}

describe('isHardDenied (Layer 1)', () => {
    it('denies .env and .env.* variants', () => {
        expect(isHardDenied('.env')).toBe(true);
        expect(isHardDenied('.env.local')).toBe(true);
        expect(isHardDenied('.env.production')).toBe(true);
    });

    it('denies a nested .env', () => {
        expect(isHardDenied('src/.env')).toBe(true);
    });

    it('denies the deploy artifacts', () => {
        expect(isHardDenied('.steps-deploy.tar.gz')).toBe(true);
        expect(isHardDenied('.steps-deploy.zip')).toBe(true);
    });

    it('does NOT false-positive on .env-prefixed names', () => {
        expect(isHardDenied('environment.ts')).toBe(false);
        expect(isHardDenied('.envrc')).toBe(false);
        expect(isHardDenied('src/environment.ts')).toBe(false);
    });
});

describe('buildDeployMatcher (Layer 2)', () => {
    it('excludes the defaults', () => {
        const { matcher } = buildDeployMatcher('/nonexistent', null);
        expect(matcher.ignores('node_modules/x')).toBe(true);
        expect(matcher.ignores('.git/HEAD')).toBe(true);
        expect(matcher.ignores('dist/a.js')).toBe(true);
        expect(matcher.ignores('vendor/x')).toBe(true);
    });

    it('does NOT exclude a normal source file', () => {
        const { matcher } = buildDeployMatcher('/nonexistent', null);
        expect(matcher.ignores('src/index.ts')).toBe(false);
    });

    it('applies deploy.exclude additively', () => {
        const config: SolidActionsConfig = {
            workflows: [],
            deploy: { exclude: ['web/', '*.tmp'] },
        };
        const { matcher, summary } = buildDeployMatcher('/nonexistent', config);
        expect(matcher.ignores('web/index.html')).toBe(true);
        expect(matcher.ignores('foo.tmp')).toBe(true);
        // defaults still apply
        expect(matcher.ignores('node_modules/x')).toBe(true);
        expect(summary.excludeRuleCount).toBe(2);
    });

    it('handles *.log at any depth like gitignore', () => {
        const config: SolidActionsConfig = {
            workflows: [],
            deploy: { exclude: ['*.log'] },
        };
        const { matcher } = buildDeployMatcher('/nonexistent', config);
        expect(matcher.ignores('app.log')).toBe(true);
        expect(matcher.ignores('logs/deep/nested/app.log')).toBe(true);
    });

    // NOTE (spec contradiction — see report): the spec's Testing section asks
    // for `dist/` default + `!dist/keep.js` -> keep.js re-included. That is
    // impossible under true gitignore semantics, which the spec also mandates
    // ("matches the gitignore mental model"): git itself cannot re-include a
    // file whose parent directory is excluded by a trailing-slash pattern
    // (verified with `git check-ignore`). The `ignore` package faithfully
    // mirrors git here. So with the spec-mandated `dist/` default, `!dist/keep.js`
    // does NOT re-include. We assert the real, gitignore-faithful behavior and
    // additionally show that ordered negation DOES work when the earlier
    // exclusion targets the directory's contents (`dist/*`) rather than the dir.
    it('ordered negation follows true gitignore semantics for an excluded directory', () => {
        const config: SolidActionsConfig = {
            workflows: [],
            deploy: { exclude: ['!dist/keep.js'] },
        };
        const { matcher } = buildDeployMatcher('/nonexistent', config);
        // dist/ (a default) excludes the directory; git/ignore cannot re-include
        // a file under it, so keep.js stays excluded.
        expect(matcher.ignores('dist/other.js')).toBe(true);
        expect(matcher.ignores('dist/keep.js')).toBe(true);
    });

    it('ordered negation re-includes when the earlier rule targets dir contents', () => {
        // Standard ordered gitignore: exclude a (non-default) directory's
        // contents with `build/*`, then re-include one file with `!build/keep.js`.
        // Later patterns win. (We use `build`, not a default like `dist`, because
        // a default `dist/` excludes the directory itself and git semantics then
        // forbid re-including anything under it — see the note above.)
        const config: SolidActionsConfig = {
            workflows: [],
            deploy: { exclude: ['build/*', '!build/keep.js'] },
        };
        const { matcher } = buildDeployMatcher('/nonexistent', config);
        expect(matcher.ignores('build/other.js')).toBe(true);
        expect(matcher.ignores('build/keep.js')).toBe(false);
    });

    it('applies .gitignore only when deploy.gitignore is true and the file exists', () => {
        const root = makeTmpDir();
        try {
            fs.writeFileSync(path.join(root, '.gitignore'), 'secret-dir/\n*.bak\n');

            // gitignore: true -> applied
            const on = buildDeployMatcher(root, { workflows: [], deploy: { gitignore: true } });
            expect(on.matcher.ignores('secret-dir/x')).toBe(true);
            expect(on.matcher.ignores('foo.bak')).toBe(true);
            expect(on.summary.gitignoreApplied).toBe(true);

            // gitignore: false -> not applied
            const off = buildDeployMatcher(root, { workflows: [], deploy: { gitignore: false } });
            expect(off.matcher.ignores('foo.bak')).toBe(false);
            expect(off.summary.gitignoreApplied).toBe(false);

            // absent deploy block -> not applied
            const none = buildDeployMatcher(root, { workflows: [] });
            expect(none.matcher.ignores('foo.bak')).toBe(false);
            expect(none.summary.gitignoreApplied).toBe(false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('reports gitignoreApplied=false when opted in but no .gitignore exists', () => {
        const root = makeTmpDir();
        try {
            const { summary } = buildDeployMatcher(root, { workflows: [], deploy: { gitignore: true } });
            expect(summary.gitignoreApplied).toBe(false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('isIgnoredDirectory (trailing-slash semantics)', () => {
    it('prunes default and configured dirs regardless of trailing slash', () => {
        const config: SolidActionsConfig = {
            workflows: [],
            deploy: { exclude: ['web/'] },
        };
        const { matcher } = buildDeployMatcher('/nonexistent', config);
        expect(isIgnoredDirectory('node_modules', matcher)).toBe(true);
        expect(isIgnoredDirectory('node_modules/', matcher)).toBe(true);
        expect(isIgnoredDirectory('web', matcher)).toBe(true);
        expect(isIgnoredDirectory('web/', matcher)).toBe(true);
    });

    it('prunes a nested ignored dir', () => {
        const config: SolidActionsConfig = {
            workflows: [],
            deploy: { exclude: ['build/cache/'] },
        };
        const { matcher } = buildDeployMatcher('/nonexistent', config);
        expect(isIgnoredDirectory('build/cache', matcher)).toBe(true);
    });

    it('does not prune a normal dir or the root', () => {
        const { matcher } = buildDeployMatcher('/nonexistent', null);
        expect(isIgnoredDirectory('src', matcher)).toBe(false);
        expect(isIgnoredDirectory('', matcher)).toBe(false);
    });
});

describe('planDeployFiles (walker)', () => {
    let root: string;

    beforeEach(() => {
        root = makeTmpDir();
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('returns expected surviving relative POSIX paths', () => {
        writeFile(root, 'package.json', '{}');
        writeFile(root, 'src/index.ts', '');
        writeFile(root, 'src/lib/util.ts', '');
        writeFile(root, 'solidactions.yaml', '');

        const { files } = planDeployFiles(root, { workflows: [] });
        const sorted = [...files].sort();
        expect(sorted).toEqual([
            'package.json',
            'solidactions.yaml',
            'src/index.ts',
            'src/lib/util.ts',
        ]);
    });

    it('prunes an ignored directory and does not descend into it (decoy)', () => {
        writeFile(root, 'src/index.ts', '');
        // Decoy: node_modules with a deeply nested file that must never appear.
        writeFile(root, 'node_modules/pkg/deep/nested/decoy.js', 'DECOY');

        const { files } = planDeployFiles(root, { workflows: [] });
        expect(files).toContain('src/index.ts');
        expect(files.some(f => f.startsWith('node_modules/'))).toBe(false);
        expect(files).not.toContain('node_modules/pkg/deep/nested/decoy.js');
    });

    it('excludes .env at root even with no deploy config', () => {
        writeFile(root, '.env', 'SECRET=1');
        writeFile(root, 'index.js', '');

        const { files } = planDeployFiles(root, null);
        expect(files).not.toContain('.env');
        expect(files).toContain('index.js');
    });

    it('negation cannot defeat the Layer-1 hard deny of .env', () => {
        writeFile(root, '.env', 'SECRET=1');
        const config: SolidActionsConfig = {
            workflows: [],
            deploy: { exclude: ['!.env'] },
        };
        const { files } = planDeployFiles(root, config);
        expect(files).not.toContain('.env');
    });

    it('does not add empty directories (intentional behavior change)', () => {
        writeFile(root, 'keep.txt', '');
        fs.mkdirSync(path.join(root, 'empty-dir'), { recursive: true });

        const { files } = planDeployFiles(root, { workflows: [] });
        expect(files).toContain('keep.txt');
        expect(files.some(f => f.startsWith('empty-dir'))).toBe(false);
    });

    it('reports summary fields correctly', () => {
        fs.writeFileSync(path.join(root, '.gitignore'), '*.bak\n');
        writeFile(root, 'a.ts', '');
        const config: SolidActionsConfig = {
            workflows: [],
            deploy: { exclude: ['web/', '*.tmp'], gitignore: true },
        };
        const { summary } = planDeployFiles(root, config);
        expect(summary.gitignoreApplied).toBe(true);
        expect(summary.excludeRuleCount).toBe(2);
        expect(summary.symlinksSkipped).toEqual([]);
    });

    it('skips symlinks (file and dir) and reports them in summary', () => {
        writeFile(root, 'real.txt', 'hello');
        fs.mkdirSync(path.join(root, 'realdir'), { recursive: true });
        writeFile(root, 'realdir/inner.txt', 'x');

        let symlinksCreated = false;
        try {
            fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'link.txt'));
            fs.symlinkSync(path.join(root, 'realdir'), path.join(root, 'linkdir'));
            symlinksCreated = true;
        } catch {
            // Symlink creation may require privileges on some platforms; skip then.
            return;
        }

        if (!symlinksCreated) return;

        const { files, summary } = planDeployFiles(root, { workflows: [] });
        // Real content is included.
        expect(files).toContain('real.txt');
        expect(files).toContain('realdir/inner.txt');
        // Symlinks are not included as files...
        expect(files).not.toContain('link.txt');
        // ...nor descended into.
        expect(files.some(f => f.startsWith('linkdir/'))).toBe(false);
        // ...and are reported.
        expect(summary.symlinksSkipped.sort()).toEqual(['link.txt', 'linkdir']);
    });
});

describe('Windows-style path normalization', () => {
    it('normalizes \\ separators to / before matching', () => {
        const { matcher } = buildDeployMatcher('/nonexistent', null);
        const winPath = 'node_modules\\pkg\\index.js';
        const posix = winPath.split('\\').join('/');
        expect(matcher.ignores(posix)).toBe(true);
        expect(isIgnoredDirectory('node_modules\\pkg'.split('\\').join('/'), matcher)).toBe(true);
    });
});

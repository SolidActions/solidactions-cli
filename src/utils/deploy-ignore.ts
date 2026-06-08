import fs from 'fs';
import path from 'path';
import ignore, { Ignore } from 'ignore';
import { SolidActionsConfig } from './env';

/**
 * Layer-2 matcher defaults (gitignore syntax). These are excluded unless a later
 * pattern (deploy.exclude or .gitignore) re-includes them via a `!` negation.
 */
export const DEFAULT_DEPLOY_IGNORES: string[] = [
    'node_modules/',
    '.git/',
    'dist/',
    'vendor/',
];

/**
 * Layer-1 hard deny — matched against the *basename* of a path. Never
 * re-includable by any matcher negation. Covers:
 *   - `.env` and any `.env.*` (secret-leak fix). Anchored so `.envrc` and
 *     `environment.ts` do NOT match.
 *   - `.steps-deploy.tar.gz` / `.steps-deploy.zip` (our own deploy artifacts,
 *     written into sourceDir while we walk).
 */
export const HARD_DENY_BASENAMES: RegExp = /^(?:\.env(?:$|\..*)|\.steps-deploy\.(?:tar\.gz|zip))$/;

/**
 * True if a path is hard-denied (Layer 1). Checked before the matcher so that
 * no `!` negation in deploy.exclude or .gitignore can re-include it.
 * Tests the basename of the (POSIX) path.
 */
export function isHardDenied(relPosixPath: string): boolean {
    const base = relPosixPath.split('/').pop() ?? '';
    return HARD_DENY_BASENAMES.test(base);
}

/**
 * Build the Layer-2 ignore matcher from defaults + deploy.exclude + optional
 * .gitignore. Patterns are added in order; with negations, later patterns win
 * (standard ordered gitignore semantics).
 */
export function buildDeployMatcher(sourceDir: string, config: SolidActionsConfig | null): {
    matcher: Ignore;
    summary: { gitignoreApplied: boolean; excludeRuleCount: number };
} {
    const matcher = ignore();

    // 1. Defaults.
    matcher.add(DEFAULT_DEPLOY_IGNORES);

    // 2. deploy.exclude entries.
    const exclude = config?.deploy?.exclude ?? [];
    const excludeRuleCount = exclude.length;
    if (excludeRuleCount > 0) {
        matcher.add(exclude);
    }

    // 3. .gitignore, only when opted in and the file exists.
    let gitignoreApplied = false;
    if (config?.deploy?.gitignore === true) {
        const gitignorePath = path.join(sourceDir, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
            matcher.add(fs.readFileSync(gitignorePath, 'utf8'));
            gitignoreApplied = true;
        }
    }

    return { matcher, summary: { gitignoreApplied, excludeRuleCount } };
}

/**
 * True if a directory should be pruned (not descended into). The `ignore`
 * package only matches trailing-slash dir patterns (e.g. `node_modules/`) when
 * the tested path itself carries a trailing slash, so we normalize the dir path
 * to exactly one trailing slash before testing. This also still matches plain
 * (non-trailing-slash) patterns like a bare `foo`.
 */
export function isIgnoredDirectory(relPosixDir: string, matcher: Ignore): boolean {
    const stripped = relPosixDir.replace(/\/+$/, '');
    if (stripped === '') {
        return false;
    }
    return matcher.ignores(stripped + '/');
}

/**
 * Walk sourceDir, returning { files, summary }. files = relative POSIX paths to
 * include, with Layer-1 hard deny + Layer-2 matcher applied and ignored
 * directories pruned (so we never read into a 400 MB .venv). Symlinks (file and
 * directory) are skipped and collected in summary.symlinksSkipped.
 */
export function planDeployFiles(sourceDir: string, config: SolidActionsConfig | null): {
    files: string[];
    summary: { gitignoreApplied: boolean; excludeRuleCount: number; symlinksSkipped: string[] };
} {
    const { matcher, summary } = buildDeployMatcher(sourceDir, config);

    const files: string[] = [];
    const symlinksSkipped: string[] = [];

    const toPosix = (p: string): string => p.split(path.sep).join('/');

    const walk = (absDir: string, relDir: string): void => {
        const entries = fs.readdirSync(absDir, { withFileTypes: true });
        for (const entry of entries) {
            const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
            const relPosix = toPosix(relPath);
            const absPath = path.join(absDir, entry.name);

            // Layer 1 — hard deny (files and dirs), independent of the matcher.
            if (isHardDenied(relPosix)) {
                continue;
            }

            if (entry.isSymbolicLink()) {
                // Skip symlinks (both file and dir); never follow.
                symlinksSkipped.push(relPosix);
                continue;
            }

            if (entry.isDirectory()) {
                // Layer 2 — prune ignored directories before descending.
                if (isIgnoredDirectory(relPosix, matcher)) {
                    continue;
                }
                walk(absPath, relPath);
            } else if (entry.isFile()) {
                // Layer 2 — matcher for files.
                if (matcher.ignores(relPosix)) {
                    continue;
                }
                files.push(relPosix);
            }
            // Other entry types (sockets, fifos, etc.) are ignored.
        }
    };

    walk(sourceDir, '');

    return {
        files,
        summary: {
            gitignoreApplied: summary.gitignoreApplied,
            excludeRuleCount: summary.excludeRuleCount,
            symlinksSkipped,
        },
    };
}

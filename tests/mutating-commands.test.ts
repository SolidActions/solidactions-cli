// Issue #1437, Task 1: every leaf CLI command must be explicitly classified
// as read or write in src/utils/mutating-commands.ts. The completeness test
// below walks dist/command-manifest.json (the build artifact) so a newly
// added command that forgets to be classified fails CI immediately.
import { afterEach, describe, expect, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import {
    MUTATING_COMMANDS,
    READONLY_COMMANDS,
    isMutatingCommand,
    setActiveCommandPath,
    getActiveCommandPath,
    activeCommandIsMutating,
} from '../src/utils/mutating-commands';

const MANIFEST_PATH = path.resolve(__dirname, '../dist/command-manifest.json');

interface ManifestCommand {
    path: string[];
    hidden: boolean;
}

function classifiableLeafPaths(): string[] {
    expect(fs.existsSync(MANIFEST_PATH)).toBe(true); // run `npm run build` first
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const commands: ManifestCommand[] = manifest.commands;

    const isStrictPrefixOfSome = (candidate: ManifestCommand): boolean =>
        commands.some((other) =>
            other.path.length > candidate.path.length
            && candidate.path.every((segment, i) => other.path[i] === segment));

    return commands
        .filter((c) => !isStrictPrefixOfSome(c))
        // Hidden leaves (e.g. the deprecated `skill run` alias) must still be classified —
        // only excluding them let `skill run` fall through the fail-safe to MUTATING
        // unnoticed (#1437). `help` is commander's own auto-generated leaf and is never
        // routed through requireConfigWithWorkspace, so it stays excluded.
        .filter((c) => c.path[c.path.length - 1] !== 'help')
        .map((c) => c.path.join(' '));
}

describe('mutating-commands classification', () => {
    afterEach(() => {
        setActiveCommandPath(undefined);
    });

    describe('completeness against the built command manifest', () => {
        it('classifies every leaf, non-help command as mutating or read-only', () => {
            const leafPaths = classifiableLeafPaths();

            const unclassified = leafPaths.filter(
                (p) => !MUTATING_COMMANDS.has(p) && !READONLY_COMMANDS.has(p),
            );

            expect(
                unclassified,
                `The following commands are not classified in either MUTATING_COMMANDS or `
                + `READONLY_COMMANDS in src/utils/mutating-commands.ts: ${unclassified.join(', ')}. `
                + `A new command must be explicitly classified in src/utils/mutating-commands.ts.`,
            ).toEqual([]);
        });
    });

    describe('MUTATING_COMMANDS and READONLY_COMMANDS', () => {
        it('are disjoint — no path is classified as both mutating and read-only', () => {
            const overlap = [...MUTATING_COMMANDS].filter((p) => READONLY_COMMANDS.has(p));

            expect(overlap).toEqual([]);
        });
    });

    describe('isMutatingCommand', () => {
        it('returns true for a known mutating path', () => {
            expect(isMutatingCommand(['project', 'deploy'])).toBe(true);
        });

        it('returns true for `database pull` with no options (fail safe: unobserved flags never guess read from absence)', () => {
            expect(isMutatingCommand(['database', 'pull'])).toBe(true);
        });

        it('returns false for `database pull` with options and no --writable (flag-sensitive refinement: plain pull is a read)', () => {
            expect(isMutatingCommand(['database', 'pull'], {})).toBe(false);
        });

        it('returns true for `database pull --writable` (flag-sensitive refinement: --writable is a server write)', () => {
            expect(isMutatingCommand(['database', 'pull'], { writable: true })).toBe(true);
        });

        it('returns false for a known read-only path', () => {
            expect(isMutatingCommand(['project', 'view'])).toBe(false);
        });

        it('returns true for an unknown path (fail safe: unclassified commands are treated as writes)', () => {
            expect(isMutatingCommand(['some', 'brand-new-command'])).toBe(true);
        });
    });

    describe('setActiveCommandPath / getActiveCommandPath / activeCommandIsMutating', () => {
        it('has no active path recorded before anything is set', () => {
            expect(getActiveCommandPath()).toBeUndefined();
        });

        it('records the path passed to setActiveCommandPath', () => {
            setActiveCommandPath(['project', 'deploy']);

            expect(getActiveCommandPath()).toEqual(['project', 'deploy']);
        });

        it('clears the recorded path when passed undefined', () => {
            setActiveCommandPath(['project', 'deploy']);

            setActiveCommandPath(undefined);

            expect(getActiveCommandPath()).toBeUndefined();
        });

        it('reports the active command as mutating when a mutating path is recorded', () => {
            setActiveCommandPath(['project', 'deploy']);

            expect(activeCommandIsMutating()).toBe(true);
        });

        it('reports the active command as not mutating when a read-only path is recorded', () => {
            setActiveCommandPath(['project', 'view']);

            expect(activeCommandIsMutating()).toBe(false);
        });

        it('reports false when no active command has been recorded', () => {
            expect(activeCommandIsMutating()).toBe(false);
        });
    });
});

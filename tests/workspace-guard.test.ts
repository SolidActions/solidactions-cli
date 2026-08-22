import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { makeTmpEnv } from './helpers';
import {
    decideWorkspaceGuard,
    getStateFilePath,
    isCwdInferredWorkspace,
    readLastUsedWorkspace,
    writeLastUsedWorkspace,
} from '../src/utils/workspace-guard';
import type { ResolvedConfig } from '../src/utils/config';

const GLOBAL_PATH = '/home/u/.solidactions/config.json';

// A mode-0o500 (no-write) directory does not stop root from writing into it, so the
// permission-failure tests below would pass vacuously (never actually hitting the
// error path) if run as root. Skip them in that case rather than let them silently
// assert nothing.
const isRoot = process.getuid !== undefined && process.getuid() === 0;

function sources(workspaceId: ResolvedConfig['sources']['workspaceId']): ResolvedConfig['sources'] {
    return {
        host: null,
        apiKey: null,
        workspace: null,
        workspaceId,
    };
}

describe('isCwdInferredWorkspace', () => {
    it('is not inferred when the source is "cli" (workspace override flag)', () => {
        expect(isCwdInferredWorkspace(sources('cli'), GLOBAL_PATH)).toBe(false);
    });

    it('is not inferred when the source is "env" (SOLIDACTIONS_WORKSPACE_ID)', () => {
        expect(isCwdInferredWorkspace(sources('env'), GLOBAL_PATH)).toBe(false);
    });

    it('is not inferred when the source is the global config path', () => {
        expect(isCwdInferredWorkspace(sources(GLOBAL_PATH), GLOBAL_PATH)).toBe(false);
    });

    it('is not inferred when the source is the global config path with a trailing slash / .. segment', () => {
        const noisyGlobalPath = path.join(path.dirname(GLOBAL_PATH), 'nested', '..', 'config.json') + '/';
        expect(isCwdInferredWorkspace(sources(noisyGlobalPath), GLOBAL_PATH)).toBe(false);
    });

    it('is inferred when the source is some other filesystem path (a local project config)', () => {
        expect(isCwdInferredWorkspace(sources('/work/project/.solidactions/config.json'), GLOBAL_PATH)).toBe(true);
    });

    it('is not inferred when the source is null (nothing resolved)', () => {
        expect(isCwdInferredWorkspace(sources(null), GLOBAL_PATH)).toBe(false);
    });
});

describe('state file: getStateFilePath', () => {
    it('joins the given home dir with .solidactions/state.json', () => {
        expect(getStateFilePath('/home/u')).toBe(path.join('/home/u', '.solidactions', 'state.json'));
    });
});

describe('state file: read/write round trip', () => {
    it('round-trips a written entry through read', () => {
        const env = makeTmpEnv();
        try {
            writeLastUsedWorkspace({ workspaceId: 'ws-123', label: 'acme/prod-ws', at: '2026-08-19T00:00:00.000Z' }, env.home);
            const result = readLastUsedWorkspace(env.home);
            expect(result).toEqual({ workspaceId: 'ws-123', label: 'acme/prod-ws', at: '2026-08-19T00:00:00.000Z' });
        } finally {
            env.cleanup();
        }
    });

    it('returns null when the state file is missing', () => {
        const env = makeTmpEnv();
        try {
            expect(readLastUsedWorkspace(env.home)).toBeNull();
        } finally {
            env.cleanup();
        }
    });

    it('returns null when the state file contains invalid JSON', () => {
        const env = makeTmpEnv();
        try {
            const dir = path.join(env.home, '.solidactions');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'state.json'), '{not valid json');
            expect(readLastUsedWorkspace(env.home)).toBeNull();
        } finally {
            env.cleanup();
        }
    });

    it('returns null when the state file contains a JSON array', () => {
        const env = makeTmpEnv();
        try {
            const dir = path.join(env.home, '.solidactions');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(['not', 'an', 'object']));
            expect(readLastUsedWorkspace(env.home)).toBeNull();
        } finally {
            env.cleanup();
        }
    });

    it('returns null when the JSON object has no string workspaceId', () => {
        const env = makeTmpEnv();
        try {
            const dir = path.join(env.home, '.solidactions');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ label: 'no id here' }));
            expect(readLastUsedWorkspace(env.home)).toBeNull();
        } finally {
            env.cleanup();
        }
    });

    it('returns null when the state file is empty (zero bytes)', () => {
        const env = makeTmpEnv();
        try {
            const dir = path.join(env.home, '.solidactions');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'state.json'), '');
            expect(readLastUsedWorkspace(env.home)).toBeNull();
        } finally {
            env.cleanup();
        }
    });

    it('returns null when the state file contains a JSON string at the root', () => {
        const env = makeTmpEnv();
        try {
            const dir = path.join(env.home, '.solidactions');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify('hello'));
            expect(readLastUsedWorkspace(env.home)).toBeNull();
        } finally {
            env.cleanup();
        }
    });

    it('returns null when the state file contains a JSON number at the root', () => {
        const env = makeTmpEnv();
        try {
            const dir = path.join(env.home, '.solidactions');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(42));
            expect(readLastUsedWorkspace(env.home)).toBeNull();
        } finally {
            env.cleanup();
        }
    });

    it('returns null when workspaceId is present but not a string', () => {
        const env = makeTmpEnv();
        try {
            const dir = path.join(env.home, '.solidactions');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ workspaceId: 12345 }));
            expect(readLastUsedWorkspace(env.home)).toBeNull();
        } finally {
            env.cleanup();
        }
    });

    it('creates the .solidactions dir when writing into a HOME that does not exist yet', () => {
        const env = makeTmpEnv();
        try {
            const freshHome = path.join(env.home, 'not-yet-created');
            writeLastUsedWorkspace({ workspaceId: 'ws-456' }, freshHome);
            expect(fs.existsSync(path.join(freshHome, '.solidactions', 'state.json'))).toBe(true);
            expect(readLastUsedWorkspace(freshHome)).toEqual({ workspaceId: 'ws-456' });
        } finally {
            env.cleanup();
        }
    });

    // These next two tests cover two distinct failure paths inside writeLastUsedWorkspace's
    // single try/catch: writing into an existing-but-read-only dir (fs.writeFileSync fails),
    // and creating the dir itself failing (fs.mkdirSync fails, because the parent is
    // unwritable). A future refactor that splits the mkdir and write steps should keep both
    // covered.
    it.skipIf(isRoot)('does not throw when the write fails (read-only .solidactions dir)', () => {
        const env = makeTmpEnv();
        try {
            const dir = path.join(env.home, '.solidactions');
            fs.mkdirSync(dir, { recursive: true, mode: 0o500 });
            expect(() => writeLastUsedWorkspace({ workspaceId: 'ws-789' }, env.home)).not.toThrow();
        } finally {
            fs.chmodSync(path.join(env.home, '.solidactions'), 0o700);
            env.cleanup();
        }
    });

    it.skipIf(isRoot)('does not throw when mkdirSync itself fails (.solidactions absent, unwritable parent)', () => {
        const env = makeTmpEnv();
        try {
            const unwritableHome = path.join(env.home, 'locked-home');
            fs.mkdirSync(unwritableHome, { mode: 0o500 });
            expect(fs.existsSync(path.join(unwritableHome, '.solidactions'))).toBe(false);
            expect(() => writeLastUsedWorkspace({ workspaceId: 'ws-999' }, unwritableHome)).not.toThrow();
        } finally {
            fs.chmodSync(path.join(env.home, 'locked-home'), 0o700);
            env.cleanup();
        }
    });
});

describe('decideWorkspaceGuard', () => {
    it('resolvedWorkspaceId falsy -> none', () => {
        expect(
            decideWorkspaceGuard({
                resolvedWorkspaceId: undefined,
                lastUsedWorkspaceId: 'ws-last',
                cwdInferred: true,
                mutating: true,
            }),
        ).toBe('none');
    });

    it('cwdInferred is false -> none', () => {
        expect(
            decideWorkspaceGuard({
                resolvedWorkspaceId: 'ws-resolved',
                lastUsedWorkspaceId: 'ws-last',
                cwdInferred: false,
                mutating: true,
            }),
        ).toBe('none');
    });

    it('lastUsedWorkspaceId falsy, mutating true (fresh install, first write) -> warn-no-baseline', () => {
        expect(
            decideWorkspaceGuard({
                resolvedWorkspaceId: 'ws-resolved',
                lastUsedWorkspaceId: undefined,
                cwdInferred: true,
                mutating: true,
            }),
        ).toBe('warn-no-baseline');
    });

    it('lastUsedWorkspaceId falsy, mutating false (reads stay frictionless, first run) -> none', () => {
        expect(
            decideWorkspaceGuard({
                resolvedWorkspaceId: 'ws-resolved',
                lastUsedWorkspaceId: undefined,
                cwdInferred: true,
                mutating: false,
            }),
        ).toBe('none');
    });

    it('resolved === lastUsed -> none', () => {
        expect(
            decideWorkspaceGuard({
                resolvedWorkspaceId: 'ws-same',
                lastUsedWorkspaceId: 'ws-same',
                cwdInferred: true,
                mutating: true,
            }),
        ).toBe('none');
    });

    it('resolved !== lastUsed, mutating false -> warn', () => {
        expect(
            decideWorkspaceGuard({
                resolvedWorkspaceId: 'ws-a',
                lastUsedWorkspaceId: 'ws-b',
                cwdInferred: true,
                mutating: false,
            }),
        ).toBe('warn');
    });

    it('resolved !== lastUsed, mutating true -> confirm', () => {
        expect(
            decideWorkspaceGuard({
                resolvedWorkspaceId: 'ws-a',
                lastUsedWorkspaceId: 'ws-b',
                cwdInferred: true,
                mutating: true,
            }),
        ).toBe('confirm');
    });

    // Deliberate, not accidental: a corrupt state.json reads as null (same as absent), and a
    // null baseline for a mutating CWD-inferred command takes the 'warn-no-baseline' branch —
    // warning is the conservative answer for an unknown baseline. Pinned here so a future
    // change that special-cases "corrupt" differently from "absent" has to update this test
    // deliberately, not by accident.
    it('a corrupt state.json is treated as no baseline: warns rather than silently proceeding', () => {
        const env = makeTmpEnv();
        try {
            const dir = path.join(env.home, '.solidactions');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'state.json'), '{not valid json');

            const lastUsed = readLastUsedWorkspace(env.home);
            expect(lastUsed).toBeNull();

            expect(
                decideWorkspaceGuard({
                    resolvedWorkspaceId: 'ws-resolved',
                    lastUsedWorkspaceId: lastUsed?.workspaceId,
                    cwdInferred: true,
                    mutating: true,
                }),
            ).toBe('warn-no-baseline');
        } finally {
            env.cleanup();
        }
    });
});

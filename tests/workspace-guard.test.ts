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

    it('does not throw when the write fails (read-only .solidactions dir)', () => {
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

    it('lastUsedWorkspaceId falsy (first run, do not nag) -> none', () => {
        expect(
            decideWorkspaceGuard({
                resolvedWorkspaceId: 'ws-resolved',
                lastUsedWorkspaceId: undefined,
                cwdInferred: true,
                mutating: true,
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
});

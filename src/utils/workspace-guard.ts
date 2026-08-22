// src/utils/workspace-guard.ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ResolvedConfig } from './config';

const STATE_DIR_NAME = '.solidactions';
const STATE_FILE_NAME = 'state.json';

/**
 * True when the resolved workspaceId came from a project-local .solidactions/config.json
 * discovered by walking up from the CWD — i.e. it was INFERRED from where the user happens
 * to be standing, not stated explicitly.
 *
 * `sources.workspaceId` is one of:
 * - 'cli'  — the -w/--workspace-override flag -> not inferred
 * - 'env'  — SOLIDACTIONS_WORKSPACE_ID -> not inferred
 * - the global config path -> not inferred (deliberately pinned via `workspace set`)
 * - any OTHER filesystem path -> a project-local config found by the upward walk -> INFERRED
 * - null -> nothing resolved -> not inferred
 */
export function isCwdInferredWorkspace(
    sources: ResolvedConfig['sources'],
    globalConfigPath: string,
): boolean {
    const source = sources.workspaceId;
    if (source === null || source === 'cli' || source === 'env') {
        return false;
    }
    return path.resolve(source) !== path.resolve(globalConfigPath);
}

export interface LastUsedWorkspace {
    workspaceId: string;
    label?: string;   // display label, e.g. 'acme/prod-ws' — cosmetic only
    at?: string;      // ISO timestamp
}

/** Path to the state file, given a home dir. */
export function getStateFilePath(homeDir: string = os.homedir()): string {
    return path.join(homeDir, STATE_DIR_NAME, STATE_FILE_NAME);
}

/** Read the recorded last-written-to workspace. Returns null when absent, unreadable, or malformed. */
export function readLastUsedWorkspace(homeDir: string = os.homedir()): LastUsedWorkspace | null {
    const filePath = getStateFilePath(homeDir);
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return null;
        }
        if (typeof raw.workspaceId !== 'string') {
            return null;
        }
        return raw as LastUsedWorkspace;
    } catch {
        return null;
    }
}

/**
 * Record the workspace a command just wrote to. Callers must only invoke this for mutating
 * commands — a read must never consume the change that gates a write confirmation. Never
 * throws — a failure to persist must not break a command.
 *
 * Atomic write mirroring writeConfigFile in src/utils/config.ts: write to `<path>.tmp`, then
 * fs.renameSync into place; create the parent dir with mode 0o700 if missing. Unlike config.json,
 * this file holds no secret (just a workspace UUID and a cosmetic label), so it is written with
 * the default file mode rather than 0o600.
 */
export function writeLastUsedWorkspace(entry: LastUsedWorkspace, homeDir: string = os.homedir()): void {
    try {
        const filePath = getStateFilePath(homeDir);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        const tmp = `${filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
        fs.renameSync(tmp, filePath);
    } catch {
        // Advisory state only — never let a persistence failure break a command.
    }
}

export type WorkspaceGuardAction = 'none' | 'warn' | 'confirm' | 'warn-no-baseline';

/**
 * Decision table:
 * | condition                                                     | result             |
 * |------------------------------------------------------------------|--------------------|
 * | resolvedWorkspaceId falsy                                      | 'none'             |
 * | cwdInferred is false                                           | 'none'             |
 * | lastUsedWorkspaceId falsy, mutating true (fresh install, first write) | 'warn-no-baseline' |
 * | lastUsedWorkspaceId falsy, mutating false (reads stay frictionless)   | 'none'             |
 * | resolved === lastUsed                                          | 'none'             |
 * | resolved !== lastUsed, mutating false                          | 'warn'             |
 * | resolved !== lastUsed, mutating true                           | 'confirm'          |
 */
export function decideWorkspaceGuard(input: {
    resolvedWorkspaceId: string | undefined;
    lastUsedWorkspaceId: string | undefined;
    cwdInferred: boolean;
    mutating: boolean;
}): WorkspaceGuardAction {
    if (!input.resolvedWorkspaceId) {
        return 'none';
    }
    if (!input.cwdInferred) {
        return 'none';
    }
    if (!input.lastUsedWorkspaceId) {
        return input.mutating ? 'warn-no-baseline' : 'none';
    }
    if (input.resolvedWorkspaceId === input.lastUsedWorkspaceId) {
        return 'none';
    }
    return input.mutating ? 'confirm' : 'warn';
}

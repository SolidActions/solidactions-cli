import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { findInstalledSkillDirs, isSkillDirCurrent } from './skills';

// One switch suppresses the complete nudge system, including the background
// update refresh. This is intentionally broader than muting the four lines:
// automation that opts out should get neither output nor surprise egress.
export const NUDGE_SUPPRESSION_ENV = 'SOLIDACTIONS_NO_AGENT_NUDGES';
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CLAIM_TTL_MS = 10 * 60 * 1000;
export const UPDATE_CACHE_FILE = 'agent-update-check.json';
export const UPDATE_CLAIM_SUFFIX = '.claim';

interface UpdateCache {
    checkedAt: string;
    latestVersion?: string;
}

export interface FreshnessOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    now?: Date;
    currentVersion: string;
    launchUpdateCheck?: (cacheFile: string, claimFile: string) => void;
}

export interface FreshnessResult {
    lines: string[];
    updateCacheFile: string;
    updateCache: UpdateCache | null;
    shouldRefreshUpdateCache: boolean;
}

function safeOneLine(value: string): string {
    return value.replace(/[\u0000-\u001f\u007f]/g, '?');
}

function parseVersion(version: string): { core: bigint[]; prerelease: string[] } | null {
    const identifier = '[0-9A-Za-z-]+';
    const match = version.match(new RegExp(
        `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)`
        + `(?:-(${identifier}(?:\\.${identifier})*))?`
        + `(?:\\+(${identifier}(?:\\.${identifier})*))?$`,
    ));
    if (!match) return null;
    const prerelease = match[4]?.split('.') ?? [];
    if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
        return null;
    }
    return {
        core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
        prerelease,
    };
}

/** True only when `candidate` is a valid semver newer than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
    const left = parseVersion(candidate);
    const right = parseVersion(current);
    if (!left || !right) return false;

    for (let i = 0; i < 3; i += 1) {
        if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i];
    }

    if (left.prerelease.length === 0 || right.prerelease.length === 0) {
        return left.prerelease.length === 0 && right.prerelease.length > 0;
    }

    const length = Math.max(left.prerelease.length, right.prerelease.length);
    for (let i = 0; i < length; i += 1) {
        const a = left.prerelease[i];
        const b = right.prerelease[i];
        if (a === undefined || b === undefined) return a !== undefined;
        if (a === b) continue;
        const aNumeric = /^\d+$/.test(a);
        const bNumeric = /^\d+$/.test(b);
        if (aNumeric && bNumeric) return BigInt(a) > BigInt(b);
        if (aNumeric !== bNumeric) return !aNumeric;
        return a > b;
    }
    return false;
}

function readUpdateCache(cacheFile: string): UpdateCache | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Partial<UpdateCache>;
        if (typeof parsed.checkedAt !== 'string') return null;
        if (parsed.latestVersion !== undefined && typeof parsed.latestVersion !== 'string') return null;
        return { checkedAt: parsed.checkedAt, latestVersion: parsed.latestVersion };
    } catch {
        return null;
    }
}

function findProjectRoot(startDir: string): string | null {
    let dir = path.resolve(startDir);
    while (true) {
        if (fs.existsSync(path.join(dir, 'solidactions.yaml'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

export function isCoworkSandbox(env: NodeJS.ProcessEnv): boolean {
    // Best-effort heuristic: Cowork does not publish a stable detection
    // contract. False positives can be suppressed with the one nudge opt-out.
    if (env.CLAUDE_CODE_IS_COWORK === '1') return true;
    return env.CLAUDE_CODE_ENTRYPOINT === 'local-agent' && env.SANDBOX_RUNTIME === '1';
}

export function collectAgentFreshness(options: FreshnessOptions): FreshnessResult {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const env = options.env ?? process.env;
    const homeDir = options.homeDir ?? os.homedir();
    const now = options.now ?? new Date();
    const updateCacheFile = path.join(homeDir, '.solidactions', UPDATE_CACHE_FILE);
    const suppressed = env[NUDGE_SUPPRESSION_ENV] === '1';

    if (suppressed) {
        return {
            lines: [],
            updateCacheFile,
            updateCache: null,
            shouldRefreshUpdateCache: false,
        };
    }

    const lines: string[] = [];
    const updateCache = readUpdateCache(updateCacheFile);
    if (updateCache?.latestVersion && isNewerVersion(updateCache.latestVersion, options.currentVersion)) {
        lines.push(
            `AGENT NOTE: CLI ${safeOneLine(options.currentVersion)} outdated (${safeOneLine(updateCache.latestVersion)} available); newer versions add verbs not visible in this --help. Run: npm i -g @solidactions/cli`,
        );
    }

    const checkedAt = updateCache ? Date.parse(updateCache.checkedAt) : Number.NaN;
    const shouldRefreshUpdateCache = !Number.isFinite(checkedAt)
        || now.getTime() - checkedAt >= UPDATE_CHECK_INTERVAL_MS
        || checkedAt > now.getTime();

    const projectRoot = findProjectRoot(cwd);
    const installedDirs = projectRoot ? findInstalledSkillDirs(projectRoot) : [];
    if (projectRoot && installedDirs.length === 0) {
        lines.push('AGENT NOTE: Install SolidActions skills for this project. Run: solidactions ai init');
    } else if (projectRoot) {
        const staleDir = installedDirs.find((dir) => !isSkillDirCurrent(dir));
        if (staleDir) {
            lines.push(
                `AGENT NOTE: Refresh stale SolidActions skills at ${safeOneLine(staleDir)}. Run: solidactions ai init --update`,
            );
        }
    }

    if (projectRoot && installedDirs.length > 0 && isCoworkSandbox(env)) {
        const skillsDir = installedDirs[0];
        const safePath = safeOneLine(skillsDir);
        lines.push(
            `AGENT NOTE: skills at ${safePath} are not auto-loaded in this environment — read ${safePath}/solidactions-*.md (or ${safePath}/*/SKILL.md) before proceeding`,
        );
    }

    return { lines, updateCacheFile, updateCache, shouldRefreshUpdateCache };
}

function writeUpdateCheckStarted(cacheFile: string, cache: UpdateCache | null, now: Date): void {
    const dir = path.dirname(cacheFile);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const next: UpdateCache = { checkedAt: now.toISOString() };
    if (cache?.latestVersion) next.latestVersion = cache.latestVersion;
    const tempFile = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    fs.renameSync(tempFile, cacheFile);
}

/** Atomically own a refresh, or retake a claim abandoned beyond its TTL. */
export function claimUpdateCheck(claimFile: string, now: Date): boolean {
    fs.mkdirSync(path.dirname(claimFile), { recursive: true, mode: 0o700 });

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            // flag: wx maps to O_CREAT | O_EXCL: exactly one concurrent caller wins.
            fs.writeFileSync(claimFile, `${now.toISOString()}\n`, { flag: 'wx', mode: 0o600 });
            return true;
        } catch (error: any) {
            if (error?.code !== 'EEXIST') throw error;
            if (attempt > 0) return false;

            let stale = false;
            try {
                stale = now.getTime() - fs.statSync(claimFile).mtimeMs > UPDATE_CLAIM_TTL_MS;
            } catch (statError: any) {
                if (statError?.code === 'ENOENT') continue;
                throw statError;
            }
            if (!stale) return false;

            try {
                fs.unlinkSync(claimFile);
            } catch (unlinkError: any) {
                if (unlinkError?.code !== 'ENOENT') throw unlinkError;
            }
        }
    }
    return false;
}

export function launchDetachedUpdateCheck(cacheFile: string, claimFile: string): void {
    const worker = path.join(__dirname, 'agent-update-worker.js');
    const child = spawn(process.execPath, [worker, cacheFile, claimFile], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    });
    child.on('error', () => {
        try { fs.unlinkSync(claimFile); } catch { /* best effort */ }
    });
    child.unref();
}

/** Emit all applicable lines to stderr. Every failure is deliberately ignored. */
export function emitAgentFreshnessNudges(options: FreshnessOptions): void {
    try {
        const result = collectAgentFreshness(options);
        for (const line of result.lines) process.stderr.write(`${line}\n`);

        if (result.shouldRefreshUpdateCache) {
            const now = options.now ?? new Date();
            const claimFile = `${result.updateCacheFile}${UPDATE_CLAIM_SUFFIX}`;
            // O_EXCL elects one owner. A live claim skips this invocation;
            // an abandoned claim becomes eligible for takeover after its TTL.
            if (claimUpdateCheck(claimFile, now)) {
                try {
                    writeUpdateCheckStarted(result.updateCacheFile, result.updateCache, now);
                    (options.launchUpdateCheck ?? launchDetachedUpdateCheck)(result.updateCacheFile, claimFile);
                } catch (error) {
                    try { fs.unlinkSync(claimFile); } catch { /* best effort */ }
                    throw error;
                }
            }
        }
    } catch {
        // Nudges are advisory: read-only commands, JSON output, and scripts must
        // continue even when HOME is unwritable or state is malformed.
    }
}
